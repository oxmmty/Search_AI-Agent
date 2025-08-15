const { chromium } = require('playwright');
const cheerio = require('cheerio');
const { z } = require('zod');

const { DAMAGE_KEYWORDS, SALE_TYPE_KEYWORDS } = require('../constants/keywords');
const Estate = require('../models/estate');
/* ======================= CONFIG ======================= */

const BASE_URL = "https://www.homes.com";
const CITY_PATHS = [
  "/marietta-ga",
  "/kennesaw-ga",
  "/roswell-ga",
  "/alpharetta-ga",
  "/milton-ga",
  "/sandy-springs-ga",
  "/dunwoody-ga",
  "/buckhead-ga",
  "/brookhaven-ga",
  "/johns-creek-ga",
  "/woodstock-ga",
  "/atlanta-ga/vinings-neighborhood"
];


/** How many listing detail pages to open in parallel */
const DETAIL_CONCURRENCY = 3;
/** How many LLM calls in parallel (if using LLM) */
const TAG_CONCURRENCY = 4;

/* ===================== HEADERS ===================== */

const HEADERS = {
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.homes.com/",
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

/** https://www.homes.com/marietta-ga/p2/?kws=is-as*/
function buildRemarkUrl(cityPath, remark, page) {
  return `${BASE_URL}${cityPath.replace(/\/$/, "")}${page>1 ? `/p${page}` :''}?kws=${encodeURIComponent(remark)}`;
}

/* ===================== PARSING ===================== */

function parseCard($, card) {
  const c = $(card);
  const linkHref =
    c.find('.embla__container a[href]').first().attr('href') ||
    c.find('.for-sale-content-container a[href]').first().attr('href') ||
    '';
  const link = joinUrl(BASE_URL, linkHref);

  // ---- IMAGE ----
  // Images can be lazy: prefer data-image or data-defer-src; avoid spacer gifs.
  const img = c.find('.embla__slide__img.image-container, .image-container, img').first();
  let image_url =
    img.attr('data-image') ||
    img.attr('data-defer-src') ||
    img.attr('data-src') ||
    img.attr('src') ||
    null;
  if (image_url && /\/assets\/images\/spacer\.gif$/i.test(image_url)) {
    // spacer; try another attribute on the same element or next slide
    const altSrc =
      img.attr('data-image') ||
      img.attr('data-defer-src') ||
      null;
    image_url = altSrc || null;
  }
  if (image_url) image_url = joinUrl(BASE_URL, image_url);

  // ---- PRICE ----
  const priceText = (c.find('.for-sale-content-container .price-container').first().text() || '').trim() || null;
  const price = cleanNum(priceText);

  // ---- STATS (beds, baths, sqft) ----
  let beds = null, baths = null, sqft = null;
  c.find('.for-sale-content-container .detailed-info-container li').each((_, li) => {
    const t = ($(li).text() || '').trim();
    if (!t) return;

    const num = cleanNum(t); // your helper: should parse "3 Beds" -> 3, "2,256 Sq Ft" -> 2256
    const lower = t.toLowerCase();

    if (beds == null && /bed/.test(lower)) beds = num ?? beds;
    else if (baths == null && /bath/.test(lower)) baths = num ?? baths;
    else if (sqft == null && /(sq\.?\s*ft|sqft|square\s*feet)/.test(lower)) sqft = num ?? sqft;
  });

  // ---- ADDRESS ----
  const address =
    (c.find('.for-sale-content-container .property-name').first().text() || '').trim() ||
    (c.find('.for-sale-content-container a address').first().text() || '').trim() ||
    (c.find('.embla__container a[aria-label]').first().attr('aria-label') || '').trim() ||
    null;

  // ---- DESCRIPTION ----
  // Prefer property-description; else combine all non-agent text under description-container.
  let description = null;
  const descBlock = c.find('.for-sale-content-container .description-container').first();

  if (descBlock.length) {
    const primary = descBlock.find('.property-description').toArray().map(p => $(p).text().trim()).filter(Boolean);
    if (primary.length) {
      description = primary.join(' ');
    } else {
      // include paragraphs except agent details
      const ps = descBlock.find('p:not(.agent-detail)').toArray().map(p => $(p).text().trim()).filter(Boolean);
      if (ps.length) description = ps.join(' ');
    }
  }

  if (!description) {
    // last-resort fallbacks (avoid agent detail)
    description =
      (c.find('.property-description').first().text() || '').trim() ||
      (c.find('[aria-label]').first().attr('aria-label') || '').trim() ||
      null;
  }

  if (description) description = description.replace(/\s+/g, ' ').trim();

  return {
    image_url,
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
  const cards = $(".placards-list .placard-container");

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
    '#ldp-description-text',
    '.ldp-description-text',
    '.ldp-description-text-container',
    '.about-this-home',
    '.remarksContainer',
    "[data-rf-test-id='listingRemarks']",
    '.marketingRemarks'
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
    await page.waitForSelector(".about-this-home", { timeout: 15_000 }).catch(() => {});
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
  const pages = $('.PageNumbers .ButtonLabel');

  if (pages.length === 0) {
    return 0;
  }

  return parseInt(pages.last().text().trim(), 10) || 0;
}

async function scrapeSearchPage(context, searchUrl) {
  const page = await context.newPage();
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(".placards-list", { timeout: 45_000 });
    await autoScroll(page);

    const html = await page.content();
    const listings = parseSearchHtml(html);
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
    await page.waitForSelector(".placards-list .placard-container", { timeout: 45_000 });
    await autoScroll(page);

    const html = await page.content();
    const lastPage = getPageNumber(html);
    const listings = parseSearchHtml(html);

    console.log(`url=${url}, pages=${lastPage}`)
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

    // 2) scrape each search page
    const pagesListings = await runWithConcurrency(searchInfo, 3, async ({ term, city }) => {
      const results = await scrapeSearchPages(context, city, term);
      // attach source term to each
      return results.map(r => ({ ...r, sources: [term] }));
    });

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

async function scrapeHomes() {
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

module.exports = { scrapeHomes };