require('dotenv').config();

const { chromium } = require('playwright');
const cheerio = require('cheerio');
const { z } = require('zod');

const { DAMAGE_KEYWORDS, SALE_TYPE_KEYWORDS } = require('../constants/keywords');
const Estate = require('../models/estate');
/* ======================= CONFIG ======================= */

const BASE_URL = "https://www.remax.com";
const CITY_PATHS = [
  "/homes-for-sale/ga/marietta/city/1349756",
  "/homes-for-sale/ga/kennesaw/city/1343192",
  "/homes-for-sale/ga/roswell/city/1367284",
  "/homes-for-sale/ga/alpharetta/city/1301696",
  "/homes-for-sale/ga/milton/city/1351670",
  "/homes-for-sale/ga/sandy-springs/city/1368516",
  "/homes-for-sale/ga/dunwoody/city/1324768",
  "/homes-for-sale/ga/buckhead/city/1311626",
  "/homes-for-sale/ga/brookhaven/city/1310944",
  "/homes-for-sale/ga/johns-creek/city/1342425",
  "/homes-for-sale/ga/woodstock/city/1384176",
  "/homes-for-sale/ga/vinings/city/1379612"
];

/** How many listing detail pages to open in parallel */
const DETAIL_CONCURRENCY = 3;
/** How many LLM calls in parallel (if using LLM) */
const TAG_CONCURRENCY = 4;

/* ===================== HEADERS ===================== */

const HEADERS = {
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.remax.com/",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Priority": "u=0, i",
  "Sec-Ch-Ua": "\"Not)A;Brand\";v=\"8\", \"Chromium\";v=\"138\", \"Google Chrome\";v=\"138\"",
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": "\"Windows\"",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
};

/* =================== HELPERS =================== */

function cleanNum(text) {
  if (!text) return null;
  const m = /[\d.]+/.exec(text.replace(/,/g, ""));
  if (!m) return null;
  const val = Number(m[0]);
  return Number.isFinite(val) ? Math.trunc(val) : null;
}

function joinUrl(base, href) {
  if (!href) return "";
  if (/^https?:\/\//i.test(href)) return href;
  return `${base.replace(/\/$/, "")}/${href.replace(/^\//, "")}`;
}

/** 
 * https://www.homes.com/marietta-ga/p2/?kws=is-as
 * */
function buildRemarkUrl(cityPath, remark, page) {
  return `${BASE_URL}${cityPath.replace(/\/$/, "")}?searchQuery={"filters":{"keywords":"${encodeURIComponent(remark)}"},"pageNumber":${page}}`;
}

/* ===================== PARSING ===================== */

function parseCard($, card) {
  const c = $(card);

  // ---- LINK ----
  const linkHref =
    c.find('[data-testid="d-listing-card-image-link"][href]').attr('href') ||
    c.find('[data-testid="d-listing-card-address-link"][href]').attr('href') ||
    c.find('a.d-listing-card-address[href]').attr('href') ||
    c.find('a[href]').first().attr('href') ||
    '';
  const link = joinUrl(BASE_URL, linkHref);

  // ---- IMAGE ----
  const img = c.find('img.d-listing-card-image,[data-testid="d-listing-card-image"]').first();

  const pickFromSrcset = (srcset) => {
    if (!srcset) return null;
    const best = srcset
      .split(',')
      .map(s => s.trim())
      .map(s => {
        const [url, size] = s.split(/\s+/);
        const scale = parseFloat(size) || (/\d+w/.test(size || '') ? parseFloat(size) : 1);
        return { url, scale: Number.isFinite(scale) ? scale : 1 };
      })
      .sort((a, b) => b.scale - a.scale)[0];
    return best?.url || null;
  };

  let image_url =
    img.attr('src') ||
    img.attr('data-src') ||
    pickFromSrcset(img.attr('srcset')) ||
    pickFromSrcset(img.attr('data-srcset')) ||
    null;

  if (image_url && image_url.startsWith('//')) image_url = 'https:' + image_url;

  // ---- PRICE ----
  const priceText = (c.find('[data-testid="d-listing-card-price"]').first().text() || '').trim() || null;
  const price = cleanNum(priceText);

  // ---- ADDRESS ----
  const address =
    (c.find('[data-testid="d-listing-card-address"]').first().text() || '').trim() ||
    null;

  // ---- STATS (beds, baths, sqft) ----
  let beds = null, baths = null, sqft = null;
  c.find('.d-listing-card-stats .d-listing-card-stat, [data-testid="d-listing-card-state"] .d-listing-card-stat')
    .each((_, el) => {
      const p = $(el);
      const fullText = (p.text() || '').trim();
      const strongText = (p.find('strong').first().text() || '').trim();
      const num = cleanNum(strongText || fullText);
      const lower = fullText.toLowerCase();

      if (beds == null && /bed/.test(lower)) beds = num ?? beds;
      else if (baths == null && /bath/.test(lower)) baths = num ?? baths;
      else if (sqft == null && /(sq\.?\s*ft|sqft|square\s*feet)/.test(lower)) sqft = num ?? sqft;
    });

  // No description on listing card in this layout; fetch on detail page instead
  const description = null;
  // console.log({
  //   image_url: image_url || null,
  //   address,
  //   price,
  //   beds,
  //   baths,
  //   space: sqft ? `${sqft} sqft` : "",
  //   link,
  //   description,
  //   sources: undefined,
  // });

  return {
    image_url: image_url || null,
    address,
    price,
    beds,
    baths,
    space: sqft ? `${sqft} sqft` : "",
    link,
    description,
    sources: undefined,
  };
}


function parseSearchHtml(html) {
  const $ = cheerio.load(html);
  const results = [];
  const cards = $("ul.d-search-results-listing-cards li.d-search-results-listing-card-item");

  // console.log(`cards length is = `+cards.length);
  cards.each((_, card) => {
    const listing = parseCard($, card);
    results.push(listing);
  });

  return results;
}

function extractRemarksFromHtml(html) {
  const $ = cheerio.load(html);
  const clean = (s = '') => s.replace(/\s+/g, ' ').trim();

  const grab = (sel) => {
    const el = $(sel).first();
    if (!el.length) return '';
    const ps = el.find('p').toArray().map(p => clean($(p).text())).filter(Boolean);
    return ps.length ? ps.join(' ') : clean(el.text());
  };

  // New layout first, then legacy fallbacks
  const selectors = [
    'p[data-testid="d-listing-remarks"]',
  ];

  for (const sel of selectors) {
    const text = grab(sel);
    if (text) return text;
  }

  return null;
}

/* ===================== BROWSER HELPERS ===================== */

async function autoScroll(page, { step = 1000, pauseMs = 600, maxSteps = 15 } = {}) {
  for (let i = 0; i < maxSteps; i++) {
    await page.evaluate(s => window.scrollBy(0, s), step);
    await page.waitForTimeout(pauseMs);
  }
}

async function fetchListingDescription(context, link) {
  if (!link) return null;
  const page = await context.newPage();
  try {
    await page.goto(link, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("p[data-testid='d-listing-remarks']", { timeout: 15_000 }).catch(() => {});
    const html = await page.content();
    return extractRemarksFromHtml(html);
  } catch (e) {
    console.warn(`remark fetch failed for ${link}:`, (e?.message));
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let i = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) break;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

/* ===================== TAGGING ===================== */

const DAMAGE_CANON = DAMAGE_KEYWORDS.map(k => k.toLowerCase());
const SALE_CANON = SALE_TYPE_KEYWORDS.map(k => k.toLowerCase());

// Lazy-load ESM-only @langchain/openai and cache single instance
let getLLM;
{
  let llmSingleton = null;
  getLLM = async () => {
    if (!llmSingleton) {
      const { ChatOpenAI } = await import('@langchain/openai');
      llmSingleton = new ChatOpenAI({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        apiKey: process.env.OPENAI_API_KEY || "",
        temperature: 0
      });
    }
    return llmSingleton;
  };
}

/** fast fallback tagging (no LLM required) */
function heuristicTags(description) {
  const t = (description || "").toLowerCase();
  const damage = DAMAGE_CANON.filter(k => t.includes(k));
  const sale = SALE_CANON.filter(k => t.includes(k));
  // handle "tlc" variants (normalize)
  if (/\bneeds\s+tlc\b/i.test(description) && !damage.includes("tlc")) damage.push("tlc");
  if (/\bneeds\s+tlc\b/i.test(description) && !sale.includes("needs tlc")) sale.push("needs tlc");
  return {
    damage_tags: Array.from(new Set(damage)),
    saletype_tags: Array.from(new Set(sale)),
  };
}

/** LLM structured tagging (optional) */
const ResultSchema = z.object({
  damage: z.array(z.enum(DAMAGE_CANON)),
  sale_types: z.array(z.enum(SALE_CANON)),
  rationale: z.string(),
});

async function llmTags(description) {
  const prompt = [
    { role: "system", content: "Tag real-estate descriptions with exact allowed lowercase keywords only. Prefer high precision." },
    {
      role: "user",
      content: [
        "ALLOWED DAMAGE:",
        ...DAMAGE_CANON.map(k => `- ${k}`),
        "",
        "ALLOWED SALE TYPES:",
        ...SALE_CANON.map(k => `- ${k}`),
        "",
        "OUTPUT JSON with fields: damage[], sale_types[], rationale",
        "DESCRIPTION:",
        description,
      ].join("\n"),
    },
  ];
  const llm = await getLLM();
  const out = await llm.withStructuredOutput(ResultSchema).invoke(prompt);
  const uniq = a => Array.from(new Set(a));
  return {
    damage_tags: uniq(out.damage),
    saletype_tags: uniq(out.sale_types),
    recommendation: out.rationale,
  };
}

async function tagListing(item) {
  const text = item.description || "";
  if (!text.trim()) return { ...item, damage_tags: [], saletype_tags: [], recommendation: "No description." };

  if (!process.env.OPENAI_API_KEY) {
    // heuristic only
    const h = heuristicTags(text);
    return { ...item, ...h, recommendation: "Heuristic tags (no LLM key provided)." };
  }

  try {
    const res = await llmTags(text);
    // merge in any obvious heuristics that LLM might miss (optional)
    const h = heuristicTags(text);
    return {
      ...item,
      damage_tags: Array.from(new Set([...res.damage_tags, ...h.damage_tags])),
      saletype_tags: Array.from(new Set([...res.saletype_tags, ...h.saletype_tags])),
      recommendation: res.recommendation || "LLM tags",
    };
  } catch (e) {
    console.warn("LLM tagging failed; falling back to heuristic:", (e?.message));
    const h = heuristicTags(text);
    return { ...item, ...h, recommendation: "" };
  }
}

/* ===================== SCRAPE + AGGREGATE ===================== */

function getPageNumber(html){
  const $ = cheerio.load(html);
  const nums = $('ul.d-pagination li')
    .toArray()
    .map(li => $(li).text().trim())
    .filter(t => /^\d+$/.test(t));

  return nums.length ? parseInt(nums[nums.length - 1], 10) : 0; // last numeric page
}

async function scrapeSearchPage(context, searchUrl) {
  const page = await context.newPage();
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("ul.d-search-results-listing-cards li.d-search-results-listing-card-item", { timeout: 45_000 });
    await autoScroll(page);

    const html = await page.content();
    const listings = parseSearchHtml(html);

    console.log(`url = ${searchUrl}, listings length is = `+listings?.length);
    return listings;
  } catch (e) {
    return [];
  } finally {
    await page.close().catch(() => {});
  }
}

async function scrapeSearchPages(context, city, term) {
  const url = buildRemarkUrl(city, term, 1)
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // console.log('before waiting');
    await page.waitForSelector("ul.d-search-results-listing-cards li.d-search-results-listing-card-item", { timeout: 45_000 });
    // console.log('after waiting');
    await autoScroll(page);

    const html = await page.content();
    const lastPage = getPageNumber(html);
    // console.log(`url=${url}, pages=${lastPage}`)
    const listings = parseSearchHtml(html);

    for(let i = 2; i <= lastPage; i++){
      const results = scrapeSearchPage(context, buildRemarkUrl(city, term, i));
      listings.concat(results);
    }

    return listings;
  } catch (e) {
    return [];
  } finally {
    await page.close().catch(() => {});
  }
}

async function scrapeAndTagAll(cityPath, terms) {
  let browser = null;
  let context = null;

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      userAgent: HEADERS["User-Agent"],
      locale: "en-US",
      extraHTTPHeaders: HEADERS,
      viewport: { width: 1366, height: 900 },
    });
    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(60_000);

    // 1) build search URLs for all terms
    const searchInfo = terms.map(t => ({ term: t, city: cityPath }));
    console.log(`Searching ${searchInfo.length} queries...`);
    console.log(searchInfo);

    // 2) scrape each search page
    const pagesListings = await runWithConcurrency(searchInfo, 3, async ({ term, city }) => {
      const results = await scrapeSearchPages(context, city, term);
      // attach source term to each
      return results.map(r => ({ ...r, sources: [term] }));
    });

    console.log(pagesListings);

    // 3) aggregate + dedupe by link
    const byLink = new Map();
    for (const arr of pagesListings) {
      for (const l of arr) {
        const existing = byLink.get(l.link);
        if (existing) {
          existing.sources = Array.from(new Set([...(existing.sources || []), ...(l.sources || [])]));
        } else {
          byLink.set(l.link, l);
        }
      }
    }
    let listings = Array.from(byLink.values());
    console.log(`Found ${listings.length} unique listings across queries.`);

    // 4) enrich: fetch full description for each listing
    listings = await runWithConcurrency(listings, DETAIL_CONCURRENCY, async (lst) => {
      const desc = await fetchListingDescription(context, lst.link);
      return { ...lst, description: desc ?? lst.description ?? null };
    });

    // 5) tag each listing
    const tagged = await runWithConcurrency(listings, TAG_CONCURRENCY, tagListing);

    // 6) filter: keep only items with at least one tag
    const filtered = tagged.filter(l => (l.damage_tags.length + l.saletype_tags.length) > 0);

    return filtered;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

/* ===================== RUN (example) ===================== */

async function scrapeRemax() {
  // Build combined terms: damage + sale-types
  const TERMS = ["damage", ...SALE_TYPE_KEYWORDS];
  const results = [];

  for (const CITY_PATH of CITY_PATHS) {
    const data = await scrapeAndTagAll(CITY_PATH, TERMS);
    
    const uniqueByAddress = Array.from(
      new Map(data.map(item => [item.address, item])).values()
    );
    results.push(...uniqueByAddress);
    Estate.insertMany(uniqueByAddress).catch(e => console.log(e));
  }

  // Print to console
  console.log(`\nKept ${results.length} listings with ≥1 matching keyword.`);
}

module.exports = { scrapeRemax };
