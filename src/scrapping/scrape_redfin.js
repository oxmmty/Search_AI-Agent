const { chromium } = require('playwright');
const cheerio = require('cheerio');
const { z } = require('zod');

// If ../models/estate is CommonJS (module.exports = ...):
const Estate = require('../models/estate');

const BASE_URL = "https://www.redfin.com";
const CITY_PATHS = [
  "/city/12766/GA/Marietta",
  "/city/10991/GA/Kennesaw",
  "/city/17232/GA/Roswell",
  "/city/438/GA/Alpharetta",
  "/city/33985/GA/Milton",
  "/city/17553/GA/Sandy-Springs",
  "/city/22699/GA/Dunwoody",
  "/city/3026/GA/Buckhead",
  "/city/35852/GA/Brookhaven",
  "/city/33537/GA/Johns-Creek",
  "/city/20749/GA/Woodstock",
  "/city/26520/GA/Vinings"
];

// Keywords
const DAMAGE_KEYWORDS = [
  "storm damage","tree damage","water damage","fire damage","mold","asbestos","abatement",
  "mitigation","remediation","major repairs needed","repair","tear down","fixer-upper",
  "TLC","needs updates","renovation","insurance claim",
];

const SALE_TYPE_KEYWORDS = [
  "as-is","sold as-is","cash only","investor special","flip opportunity","pre-foreclosure",
  "foreclosure","short sale","REO","probate","tax delinquent","absentee owner","vacant",
  "code violation","inheritance","divorce","needs TLC","investor special","not FHA eligible",
];

/** How many listing detail pages to open in parallel */
const DETAIL_CONCURRENCY = 3;
/** How many LLM calls in parallel (if using LLM) */
const TAG_CONCURRENCY = 4;

/* ===================== HEADERS ===================== */

const HEADERS = {
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.redfin.com/",
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

/** build Redfin search URL like /city/.../filter/remarks=... */
function buildRemarkUrl(cityPath, remark) {
  return `${BASE_URL}${cityPath.replace(/\/$/, "")}/filter/remarks=${encodeURIComponent(remark)}`;
}

/* ===================== PARSING ===================== */

function parseCard($, card) {
  const c = $(card);
  const item = c.find(".MapHomeCardReact.MapHomeCard > a").first();
  const href = item.attr("href") || "";
  const link = joinUrl(BASE_URL, href);
  const image_url = c.find(".bp-Homecard__Photo--image").first().attr("src") ?? null;
  const priceText = c.find(".bp-Homecard__Price--value").first().text().trim() || null;
  const price = cleanNum(priceText);
  const address = c.find(".bp-Homecard__Address").first().text().trim() || null;
  const bedsText = c.find(".bp-Homecard__Stats--beds").first().text().trim() || null;
  const bathsText = c.find(".bp-Homecard__Stats--baths").first().text().trim() || null;
  const beds = cleanNum(bedsText);
  const baths = cleanNum(bathsText);
  const sqftText = c.find(".bp-Homecard__LockedStat--value").first().text().trim() || null;
  const sqft = cleanNum(sqftText);

  const remarks = c.find(".ListingRemarks, .marketingRemarks, [data-rf-test-id='listingRemarks']").first();
  let description = null;
  if (remarks.length) {
    const ps = remarks.find("p").toArray().map(p => $(p).text().trim()).filter(Boolean);
    description = (ps.length ? ps.join(" ") : remarks.text()).replace(/\s+/g, " ").trim() || null;
  } else {
    description = c.attr("aria-label") || null;
  }

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
  const containers = $(".HomeViews .HomeCardsContainer, .NearbyResults .HomeCardsContainer");

  containers.each((_, container) => {
    const cards = $(container).find('[data-rf-test-name="mapHomeCard"]');
    cards.each((__, card) => { const listing = parseCard($, card); results.push(listing); });
  });

  return results;
}

function extractRemarksFromHtml(html) {
  const $ = cheerio.load(html);
  const candidates = [
    ".remarksContainer .remarks",
    "#marketingRemarks-preview .remarks",
    ".marketingRemarks .remarks",
    "[data-rf-test-id='listingRemarks'] .remarks",
    "[data-rf-test-id='listingRemarks']",
    ".remarksContainer",
  ];
  for (const sel of candidates) {
    const el = $(sel).first();
    if (el && el.length) {
      const text = el.text().replace(/\s+/g, " ").trim();
      if (text) return text;
    }
  }
  const ps = $(".remarksContainer p").toArray().map(p => $(p).text().trim()).filter(Boolean);
  if (ps.length) return ps.join(" ");
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
    await page.waitForSelector(".remarksContainer, [data-rf-test-id='listingRemarks'], .marketingRemarks", { timeout: 15_000 }).catch(() => {});
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

async function scrapeSearchPage(context, searchUrl) {
  const page = await context.newPage();
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(".HomeViews .HomeCardsContainer, .HomeCardsContainer", { timeout: 45_000 });
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
    const searchUrls = terms.map(t => ({ term: t, url: buildRemarkUrl(cityPath, t) }));
    console.log(`Searching ${searchUrls.length} queries...`);

    // 2) scrape each search page
    const pagesListings = await runWithConcurrency(searchUrls, 3, async ({ term, url }) => {
      const results = await scrapeSearchPage(context, url);
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

async function scrapeRedfin() {
  // Build combined terms: damage + sale-types
  const TERMS = ["damage", ...SALE_TYPE_KEYWORDS];
  const results = [];

  Estate.deleteMany({}).catch(e => console.log(e));

  for (const CITY_PATH of CITY_PATHS) {
    const data = await scrapeAndTagAll(CITY_PATH, TERMS);
    results.push(...data);

    Estate.insertMany(data).catch(e => console.log(e));
  }

  // Print to console
  console.log(JSON.stringify(results, null, 2));
  console.log(`\nKept ${results.length} listings with ≥1 matching keyword.`);
}

module.exports = { scrapeRedfin };
