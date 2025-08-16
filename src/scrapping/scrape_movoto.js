require('dotenv').config();

const { chromium } = require('playwright');
const cheerio = require('cheerio');
const { z } = require('zod');

const { DAMAGE_KEYWORDS, SALE_TYPE_KEYWORDS } = require('../constants/keywords');
const Estate = require('../models/estate');
/* ======================= CONFIG ======================= */

const BASE_URL = "https://www.movoto.com";
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
  "/vinings-ga"
];

/** How many listing detail pages to open in parallel */
const DETAIL_CONCURRENCY = 1;
/** How many LLM calls in parallel (if using LLM) */
const TAG_CONCURRENCY = 1;

/* ===================== HEADERS ===================== */

const HEADERS = {
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.movoto.com/",
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
 * https://www.coldwellbankerhomes.com/ga/marietta/keyw-investor/
 * */
function buildRemarkUrl(cityPath, remark, page) {
  return `${BASE_URL}${cityPath.replace(/\/$/, "")}${page>1 ? `p-${page}` : ''}`;
}

/* ===================== PARSING ===================== */

function parseCard($, card) {
  const c = $(card);
  const clean = (s = '') => s.replace(/\s+/g, ' ').trim();

  console.log('in card ================');
  // ---------- JSON-LD inside the card ----------
  const safeParse = (txt) => {
    if (!txt) return null;
    try { return JSON.parse(txt); } catch {
      try { return JSON.parse(txt.replace(/[\u2028\u2029]/g, '')); } catch { return null; }
    }
  };

  const ldNodes = [];
  c.find('script[type="application/ld+json"]').each((_, s) => {
    const raw = $(s).contents().text();
    const parsed = safeParse(raw);
    if (!parsed) return;
    if (Array.isArray(parsed)) ldNodes.push(...parsed);
    else ldNodes.push(parsed);
  });

  const pickType = (arr, typeName) =>
    arr.find(n => {
      const t = n?.['@type'];
      const types = Array.isArray(t) ? t.map(String) : t ? [String(t)] : [];
      return types.some(tt => tt.toLowerCase() === typeName.toLowerCase());
    });

  const nodeResidence = pickType(ldNodes, 'SingleFamilyResidence') || null;
  const nodeProduct   = pickType(ldNodes, 'Product') || null;

  // ---------- LINK ----------
  const linkHref =
    nodeProduct?.offers?.url ||
    nodeProduct?.url ||
    nodeResidence?.url ||
    c.find('.mvt-cardproperty-info a[href]').first().attr('href') ||
    c.find('a[href]').first().attr('href') ||
    '';

  const link = joinUrl(BASE_URL, linkHref);

  // ---------- IMAGE ----------
  const firstStrOrFirst = (v) => {
    if (!v) return null;
    if (Array.isArray(v)) return v[0] || null;
    if (typeof v === 'string') return v;
    return null;
  };

  let image_url =
    firstStrOrFirst(nodeProduct?.image) ||
    firstStrOrFirst(nodeResidence?.image) ||
    c.find('.mvt-cardproperty-photo img').first().attr('src') ||
    null;

  if (image_url && image_url.startsWith('//')) image_url = 'https:' + image_url;

  // ---------- PRICE ----------
  const priceFromJson = nodeProduct?.offers?.price ?? null;
  const priceTextDom = clean(c.find('.mvt-cardproperty-info .price').first().text() || '');
  const price = priceFromJson != null ? Number(priceFromJson) : cleanNum(priceTextDom);

  // ---------- ADDRESS ----------
  const addressDom = clean(c.find('.mvt-cardproperty-info address').first().text() || '');
  const addressJson =
    clean(nodeResidence?.name || nodeProduct?.name || '') || null;
  const address = addressDom || addressJson || null;

  // ---------- STATS (beds, baths, sqft) ----------
  let beds = null, baths = null, sqft = null;

  // Extract from UL: items like "3 Bd", "2 Ba", "1,851 Sq Ft"
  c.find('.mvt-cardproperty-info ul li').each((_, li) => {
    const t = clean($(li).text() || '');
    if (!t) return;
    if (beds == null && /\b(bd|bed|beds)\b/i.test(t)) {
      beds = cleanNum(t);
    } else if (baths == null && /\b(ba|bath|baths)\b/i.test(t)) {
      baths = cleanNum(t);
    } else if (sqft == null && /(sq\.?\s*ft|sqft|square\s*feet)/i.test(t)) {
      sqft = cleanNum(t);
    }
  });

  // ---------- DESCRIPTION ----------
  // Movoto card typically has no remarks; JSON-LD description is often just the address
  // so we leave description null and fetch from detail page elsewhere.
  const description = null;

  console.log({
    image_url: image_url || null,
    address,
    price,
    beds,
    baths,
    space: sqft ? `${sqft} sqft` : "",
    link,
    description,
    sources: undefined,
  })

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
  const cards = $(".search-grid .mvt-cardproperty");

  console.log(`cards length is = `+cards.length);
  cards.each((_, card) => {
    const listing = parseCard($, card);
    results.push(listing);
  });

  return results;
}

function extractRemarksFromHtml(html) {
  const $ = cheerio.load(html);
  const raw = $('.dpp-desc-content').first().text();
  const text = raw
    .replace(/\u00A0/g, ' ')   // nbsp -> space
    .replace(/\s+/g, ' ')      // collapse whitespace
    .trim();

  return text;
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
    await page.waitForSelector(".dpp-desc-content", { timeout: 15_000 }).catch(() => {});
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
  const nums = $('.mvt-pagination__list a')
    .toArray()
    .map(li => $(li).text().trim())
    .filter(t => /^\d+$/.test(t));

  return nums.length ? parseInt(nums[nums.length - 1], 10) : 0; // last numeric page
}

async function scrapeSearchPage(context, searchUrl) {
  const page = await context.newPage();
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(".search-grid .mvt-cardproperty", { timeout: 45_000 });
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
    console.log('before waiting');
    await page.waitForSelector(".search-grid .mvt-cardproperty", { timeout: 45_000 });
    console.log('after waiting');
    await autoScroll(page);

    const html = await page.content();
    const lastPage = getPageNumber(html);
    console.log(`url=${url}, pages=${lastPage}`)
    const listings = parseSearchHtml(html);

    for(let i = 2; i <= lastPage; i++){
      const results = await scrapeSearchPage(context, buildRemarkUrl(city, term, i)).catch(e => console.log(c));
      listings.concat(results);
    }

    return listings;
  } catch (e) {
    return [];
  } finally {
    await page.close().catch(() => {});
  }
}

async function scrapeAndTagAll(cityPaths) {
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

    // 2) scrape each search page
    const pagesListings = await runWithConcurrency(cityPaths, 3, async ( city ) => {
      const results = await scrapeSearchPages(context, city, "");
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

async function scrapeMovoto() {
  const data = await scrapeAndTagAll(CITY_PATHS);
  const uniqueByAddress = Array.from(
    new Map(data.map(item => [item.address, item])).values()
  );

  results.push(...uniqueByAddress);
  Estate.insertMany(uniqueByAddress).catch(e => console.log(e));
}

module.exports = { scrapeMovoto };
