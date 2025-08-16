require('dotenv').config();

const { chromium } = require('playwright');
const cheerio = require('cheerio');
const { z } = require('zod');

const { DAMAGE_KEYWORDS, DAMAGE_KEYWORDS_SEARCH, SALE_TYPE_KEYWORDS } = require('../constants/keywords');
const Estate = require('../models/estate');
/* ======================= CONFIG ======================= */

const BASE_URL = "https://www.zillow.com";
const CITY_PATHS = [
  "/marietta-ga/**PAGENUM**?searchQueryState=%7B%22isMapVisible%22%3Atrue%2C%22mapBounds%22%3A%7B%22north%22%3A34.19669604371047%2C%22south%22%3A33.73084946437998%2C%22east%22%3A-84.22997176757812%2C%22west%22%3A-84.83147323242187%7D%2C%22mapZoom%22%3A11%2C%22filterState%22%3A%7B%22sort%22%3A%7B%22value%22%3A%22globalrelevanceex%22%7D%2C%22att%22%3A%7B%22value%22%3A%22**KEYWORD**%22%7D%7D%2C%22isListVisible%22%3Atrue%2C%22category%22%3A%22cat1%22%2C%22usersSearchTerm%22%3A%22Marietta%20GA%20homes%22%2C%22regionSelection%22%3A%5B%7B%22regionId%22%3A12562%2C%22regionType%22%3A6%7D%5D**PAGE**%7D",
  "/kennesaw-ga/**PAGENUM**?searchQueryState=%7B%22isMapVisible%22%3Atrue%2C%22mapBounds%22%3A%7B%22north%22%3A34.09858746703286%2C%22south%22%3A33.865713596150016%2C%22east%22%3A-84.47014013378907%2C%22west%22%3A-84.77089086621095%7D%2C%22mapZoom%22%3A12%2C%22filterState%22%3A%7B%22sort%22%3A%7B%22value%22%3A%22globalrelevanceex%22%7D%2C%22att%22%3A%7B%22value%22%3A%22**KEYWORD**%22%7D%7D%2C%22isListVisible%22%3Atrue%2C%22category%22%3A%22cat1%22%2C%22usersSearchTerm%22%3A%22Kennesaw%20GA%20homes%22%2C%22regionSelection%22%3A%5B%7B%22regionId%22%3A32287%2C%22regionType%22%3A6%7D%5D**PAGE**%7D",
  "/roswell-ga/**PAGENUM**?searchQueryState=%7B%22isMapVisible%22%3Atrue%2C%22mapBounds%22%3A%7B%22north%22%3A34.161406912699626%2C%22south%22%3A33.92870552138021%2C%22east%22%3A-84.19754913378907%2C%22west%22%3A-84.49829986621094%7D%2C%22mapZoom%22%3A12%2C%22filterState%22%3A%7B%22sort%22%3A%7B%22value%22%3A%22globalrelevanceex%22%7D%2C%22att%22%3A%7B%22value%22%3A%22**KEYWORD**%22%7D%7D%2C%22isListVisible%22%3Atrue%2C%22category%22%3A%22cat1%22%2C%22usersSearchTerm%22%3A%22Roswell%20GA%20homes%22%2C%22regionSelection%22%3A%5B%7B%22regionId%22%3A54219%2C%22regionType%22%3A6%7D%5D**PAGE**%7D",
  "/alpharetta-ga/**PAGENUM**?searchQueryState=%7B%22isMapVisible%22%3Atrue%2C%22mapBounds%22%3A%7B%22north%22%3A34.214780729497065%2C%22south%22%3A33.98222610416543%2C%22east%22%3A-84.12167513378904%2C%22west%22%3A-84.42242586621092%7D%2C%22mapZoom%22%3A12%2C%22filterState%22%3A%7B%22sort%22%3A%7B%22value%22%3A%22globalrelevanceex%22%7D%2C%22att%22%3A%7B%22value%22%3A%22**KEYWORD**%22%7D%7D%2C%22isListVisible%22%3Atrue%2C%22category%22%3A%22cat1%22%2C%22usersSearchTerm%22%3A%22Alpharetta%20GA%20homes%22%2C%22regionSelection%22%3A%5B%7B%22regionId%22%3A16733%2C%22regionType%22%3A6%7D%5D**PAGE**%7D",
  "/milton-ga/**PAGENUM**?searchQueryState=%7B%22isMapVisible%22%3Atrue%2C%22mapBounds%22%3A%7B%22north%22%3A34.24789642529053%2C%22south%22%3A34.01543296254785%2C%22east%22%3A-84.17039513378906%2C%22west%22%3A-84.47114586621093%7D%2C%22mapZoom%22%3A12%2C%22filterState%22%3A%7B%22sort%22%3A%7B%22value%22%3A%22globalrelevanceex%22%7D%2C%22att%22%3A%7B%22value%22%3A%22**KEYWORD**%22%7D%7D%2C%22isListVisible%22%3Atrue%2C%22category%22%3A%22cat1%22%2C%22usersSearchTerm%22%3A%22Milton%2C%20GA%22%2C%22regionSelection%22%3A%5B%7B%22regionId%22%3A395772%2C%22regionType%22%3A6%7D%5D**PAGE**%7D",
  "/sandy-springs-ga/**PAGENUM**?searchQueryState=%7B%22isMapVisible%22%3Atrue%2C%22mapBounds%22%3A%7B%22north%22%3A34.05979460886536%2C%22south%22%3A33.826814367146035%2C%22east%22%3A-84.20244063378904%2C%22west%22%3A-84.50319136621091%7D%2C%22mapZoom%22%3A12%2C%22filterState%22%3A%7B%22sort%22%3A%7B%22value%22%3A%22globalrelevanceex%22%7D%2C%22att%22%3A%7B%22value%22%3A%22**KEYWORD**%22%7D%7D%2C%22isListVisible%22%3Atrue%2C%22category%22%3A%22cat1%22%2C%22usersSearchTerm%22%3A%22Sandy%20Springs%20GA%20homes%22%2C%22regionSelection%22%3A%5B%7B%22regionId%22%3A13709%2C%22regionType%22%3A6%7D%5D**PAGE**%7D",
  "/dunwoody-ga/**PAGENUM**?searchQueryState=%7B%22isMapVisible%22%3Atrue%2C%22mapBounds%22%3A%7B%22north%22%3A34.001260954709686%2C%22south%22%3A33.88477032385096%2C%22east%22%3A-84.23126881689454%2C%22west%22%3A-84.38164418310548%7D%2C%22mapZoom%22%3A13%2C%22filterState%22%3A%7B%22sort%22%3A%7B%22value%22%3A%22globalrelevanceex%22%7D%2C%22att%22%3A%7B%22value%22%3A%22**KEYWORD**%22%7D%7D%2C%22isListVisible%22%3Atrue%2C%22category%22%3A%22cat1%22%2C%22usersSearchTerm%22%3A%22Dunwoody%20GA%20homes%22%2C%22regionSelection%22%3A%5B%7B%22regionId%22%3A49352%2C%22regionType%22%3A6%7D%5D**PAGE**%7D",
  "/buckhead-forest-atlanta-ga/**PAGENUM**?searchQueryState=%7B%22isMapVisible%22%3Atrue%2C%22mapBounds%22%3A%7B%22north%22%3A33.85453182467832%2C%22south%22%3A33.8399541291447%2C%22east%22%3A-84.3677920396118%2C%22west%22%3A-84.38658896038817%7D%2C%22mapZoom%22%3A16%2C%22filterState%22%3A%7B%22sort%22%3A%7B%22value%22%3A%22globalrelevanceex%22%7D%2C%22att%22%3A%7B%22value%22%3A%22**KEYWORD**%22%7D%7D%2C%22isListVisible%22%3Atrue%2C%22category%22%3A%22cat1%22%2C%22usersSearchTerm%22%3A%22Buckhead%20Forest%20GA%20homes%22%2C%22regionSelection%22%3A%5B%7B%22regionId%22%3A269277%2C%22regionType%22%3A8%7D%5D**PAGE**%7D",
  "/brookhaven-ga/**PAGENUM**?searchQueryState=%7B%22isMapVisible%22%3Atrue%2C%22mapBounds%22%3A%7B%22north%22%3A33.9311925591979%2C%22south%22%3A33.81460606602331%2C%22east%22%3A-84.25339481689454%2C%22west%22%3A-84.40377018310548%7D%2C%22mapZoom%22%3A13%2C%22filterState%22%3A%7B%22sort%22%3A%7B%22value%22%3A%22globalrelevanceex%22%7D%2C%22att%22%3A%7B%22value%22%3A%22**KEYWORD**%22%7D%7D%2C%22isListVisible%22%3Atrue%2C%22category%22%3A%22cat1%22%2C%22usersSearchTerm%22%3A%22Brookhaven%20GA%20homes%22%2C%22regionSelection%22%3A%5B%7B%22regionId%22%3A23302%2C%22regionType%22%3A6%7D%5D**PAGE**%7D",
  "/johns-creek-ga/**PAGENUM**?searchQueryState=%7B%22isMapVisible%22%3Atrue%2C%22mapBounds%22%3A%7B%22north%22%3A34.15418003403049%2C%22south%22%3A33.92145878600409%2C%22east%22%3A-84.04156413378905%2C%22west%22%3A-84.34231486621093%7D%2C%22mapZoom%22%3A12%2C%22filterState%22%3A%7B%22sort%22%3A%7B%22value%22%3A%22globalrelevanceex%22%7D%2C%22att%22%3A%7B%22value%22%3A%22**KEYWORD**%22%7D%7D%2C%22isListVisible%22%3Atrue%2C%22category%22%3A%22cat1%22%2C%22usersSearchTerm%22%3A%22Johns%20Creek%2C%20GA%22%2C%22regionSelection%22%3A%5B%7B%22regionId%22%3A397383%2C%22regionType%22%3A6%7D%5D**PAGE**%7D",
  "/woodstock-ga/**PAGENUM**?searchQueryState=%7B%22isMapVisible%22%3Atrue%2C%22mapBounds%22%3A%7B%22north%22%3A34.24584148279504%2C%22south%22%3A34.013372360831504%2C%22east%22%3A-84.35113763378907%2C%22west%22%3A-84.65188836621094%7D%2C%22mapZoom%22%3A12%2C%22filterState%22%3A%7B%22sort%22%3A%7B%22value%22%3A%22globalrelevanceex%22%7D%2C%22att%22%3A%7B%22value%22%3A%22**KEYWORD**%22%7D%7D%2C%22isListVisible%22%3Atrue%2C%22category%22%3A%22cat1%22%2C%22usersSearchTerm%22%3A%22Woodstock%2C%20GA%22%2C%22regionSelection%22%3A%5B%7B%22regionId%22%3A48573%2C%22regionType%22%3A6%7D%5D**PAGE**%7D",
  "/vinings-ga/**PAGENUM**?searchQueryState=%7B%22isMapVisible%22%3Atrue%2C%22mapBounds%22%3A%7B%22north%22%3A33.92631694995768%2C%22south%22%3A33.80972379284081%2C%22east%22%3A-84.39240581689452%2C%22west%22%3A-84.54278118310546%7D%2C%22mapZoom%22%3A13%2C%22filterState%22%3A%7B%22sort%22%3A%7B%22value%22%3A%22globalrelevanceex%22%7D%2C%22att%22%3A%7B%22value%22%3A%22**KEYWORD**%22%7D%7D%2C%22isListVisible%22%3Atrue%2C%22category%22%3A%22cat1%22%2C%22usersSearchTerm%22%3A%22Vinings%2C%20GA%22%2C%22regionSelection%22%3A%5B%7B%22regionId%22%3A396606%2C%22regionType%22%3A6%7D%5D**PAGE**%7D"
];

/** How many listing detail pages to open in parallel */
const DETAIL_CONCURRENCY = 3;
/** How many LLM calls in parallel (if using LLM) */
const TAG_CONCURRENCY = 4;

/* ===================== HEADERS ===================== */

const HEADERS = {
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.zillow.com/",
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

/**/
function buildRemarkUrl(cityPath, remark, page) {
  return `${BASE_URL}${cityPath.replace(/\/$/, "").replace("**KEYWORD**", remark).replace("**PAGE**", page > 1 ? `%2C%22pagination%22%3A%7B%22currentPage%22%3A${page}%7D` : "").replace("**PAGENUM**", page > 1 ? `${page}_p/` : "")}`;
}

/* ===================== PARSING ===================== */

function parseCard($, card) {
  const c = $(card);
  const clean = (s = '') => s.replace(/\s+/g, ' ').trim();

  // ---------- JSON-LD inside the Zillow card (helps with URL/address) ----------
  const safeParse = (txt) => {
    if (!txt) return null;
    try { return JSON.parse(txt); } catch {
      try { return JSON.parse(txt.replace(/[\u2028\u2029]/g, '')); } catch { return null; }
    }
  };
  let ld = null;
  const ldRaw = c.find('script[type="application/ld+json"]').first().contents().text();
  if (ldRaw) {
    const parsed = safeParse(ldRaw);
    if (parsed && typeof parsed === 'object') ld = parsed;
  }

  // ---------- LINK ----------
  const linkHref =
    c.find('a[data-test="property-card-link"][href]').first().attr('href') ||
    ld?.url ||
    c.find('a[href*="zillow.com/homedetails/"]').first().attr('href') ||
    '';
  const link = joinUrl(BASE_URL, linkHref);

  // ---------- IMAGE ----------
  const pickFromSrcset = (srcset) => {
    if (!srcset) return null;
    const candidates = srcset
      .split(',')
      .map(s => s.trim())
      .map(s => {
        const [url, size] = s.split(/\s+/);
        const w = size && /(\d+)/.exec(size)?.[1];
        return { url, width: w ? parseInt(w, 10) : 0 };
      })
      .filter(x => x.url)
      .sort((a, b) => b.width - a.width);
    return candidates[0]?.url || null;
  };

  // Prefer the carousel <picture> sources
  let image_url =
    pickFromSrcset(c.find('picture source[srcset]').first().attr('srcset')) ||
    c.find('picture img[src]').first().attr('src') ||
    c.find('img[alt][src]').first().attr('src') ||
    null;

  if (image_url && image_url.startsWith('//')) image_url = 'https:' + image_url;

  // ---------- PRICE ----------
  const priceText = clean(c.find('[data-test="property-card-price"]').first().text() || '');
  const price = cleanNum(priceText);

  // ---------- ADDRESS ----------
  const addressDom = clean(c.find('a[data-test="property-card-link"] address').first().text() || '');
  const address = addressDom || clean(ld?.name || '') || null;

  // ---------- STATS (beds, baths, sqft) ----------
  let beds = null, baths = null, sqft = null;
  c.find('ul[class*="HomeDetailsList"] li, ul li').each((_, el) => {
    const li = $(el);
    const label = (li.find('abbr').first().text() || '').toLowerCase();
    const valText = (li.find('b').first().text() || li.text() || '').trim();
    const num = cleanNum(valText);
    if (num == null) return;

    if (!beds && /bd|bds|bed/.test(label)) beds = num;
    else if (!baths && /\bba|bath/.test(label)) baths = num;
    else if (!sqft && /(sq\s*ft|sqft|square\s*feet)/i.test(label + ' ' + valText)) sqft = num;
  });

  // ---------- DESCRIPTION ----------
  const description = null; // fetch from detail page if needed

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
  const cards = $("div#grid-search-results ul.photo-cards li");

  console.log(`cards length is = `+cards.length);
  cards.each((_, card) => {
    const listing = parseCard($, card);
    results.push(listing);
  });

  return results;
}

function extractRemarksFromHtml(html) {
  const $ = cheerio.load(html);
  const raw = $('div[data-testid="description"]').first().text();
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
    await page.waitForSelector('div[data-testid="description"]', { timeout: 15_000 }).catch(() => {});
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
  const nums = $('div.search-pagination ul li')
    .toArray()
    .map(li => $(li).text().trim())
    .filter(t => /^\d+$/.test(t));

  return nums.length>2 ? parseInt(nums[nums.length - 2], 10) : 0; // last numeric page
}

async function scrapeSearchPage(context, searchUrl) {
  const page = await context.newPage();
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("div#grid-search-results ul.photo-cards li", { timeout: 45_000 });
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
    await page.waitForSelector("div#grid-search-results ul.photo-cards li", { timeout: 45_000 });
    console.log('after waiting');
    await autoScroll(page);

    const html = await page.content();
    console.log('page conten = ' + html)
    const lastPage = getPageNumber(html);
    console.log(`url=${url}, pages=${lastPage}`)
    const listings = parseSearchHtml(html);

    console.log(`url = ${url}, listings length is = `+listings?.length);

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
    const pagesListings = await runWithConcurrency(searchInfo, 1, async ({ term, city }) => {
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

async function scrapeZillow() {
  // Build combined terms: damage + sale-types
  const TERMS = [...DAMAGE_KEYWORDS_SEARCH, ...SALE_TYPE_KEYWORDS];
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

module.exports = { scrapeZillow };

