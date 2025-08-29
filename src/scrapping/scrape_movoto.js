const { chromium } = require('playwright');
const cheerio = require('cheerio');

const { runWithConcurrency, processSourcesToTags, tagListing, autoScroll, cleanNum, joinUrl } = require('./common');
const { SALE_TYPE_KEYWORDS, DAMAGE_KEYWORDS_SEARCH } = require('../constants/keywords');
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
const DETAIL_CONCURRENCY = 3;

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


function buildRemarkUrl(cityPath, remark, page) {
  return `${BASE_URL}${cityPath.replace(/\/$/, "")}${page>1 ? `p-${page}` : ''}`;
}

/* ===================== PARSING ===================== */

function parseCard($, card) {
  const c = $(card);
  const clean = (s = '') => s.replace(/\s+/g, ' ').trim();

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
    console.log(`before waiting url=${searchUrl}`);
    await page.waitForSelector(".search-grid .mvt-cardproperty", { timeout: 45_000 });
    console.log(`after waiting url=${searchUrl}`);
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
    console.log(`before waiting city=${city}, term=${term}, url=${url}`);
    await page.waitForSelector(".search-grid .mvt-cardproperty", { timeout: 45_000 });
    console.log(`after waiting city=${city}, term=${term}, url=${url}`);
    await autoScroll(page);

    const html = await page.content();
    const lastPage = getPageNumber(html);
    console.log(`url=${url}, pages=${lastPage}`)
    const listings = parseSearchHtml(html);
    console.log(`url=${url}, listings length is = `+listings?.length);

    for(let i = 2; i <= lastPage; i++){
      const results = scrapeSearchPage(context, buildRemarkUrl(city, term, i));
      listings.push(...results);
    }
    console.log(`url=${url}, total listings length is = `+listings?.length);

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
    browser = await chromium.launch({ headless: false });
    context = await browser.newContext({
      userAgent: HEADERS["User-Agent"],
      locale: "en-US",
      extraHTTPHeaders: HEADERS,
      viewport: { width: 1366, height: 900 },
    });
    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(60_000);

    const pagesListings = [];
    for(const city of cityPaths) {
      const results = await scrapeSearchPages(context, city, "");
      console.log(`results are ${results}`)
      // attach source term to each
      pagesListings.push(...results.map(r => ({ ...r, sources: [city] })));
    }

    console.log(`Total listings found: ${pagesListings.length}`);

    // 3) aggregate + dedupe by link (pagesListings is now a flat array)
    const byLink = new Map();
    for (const listing of pagesListings) {
      const existing = byLink.get(listing.link);
      if (existing) {
        existing.sources = Array.from(new Set([...(existing.sources || []), ...(listing.sources || [])]));
      } else {
        byLink.set(listing.link, listing);
      }
    }
    let listings = Array.from(byLink.values());
    console.log(`Found ${listings.length} unique listings across queries.`);

    // Process listings with concurrency to improve performance
    listings = await runWithConcurrency(
      listings,
      DETAIL_CONCURRENCY,
      async (listing) => {
        // Fetch description
        const desc = await fetchListingDescription(context, listing.link);
        listing.description = desc ?? listing.description ?? null;

        // Get tags from LLM and sources
        const llmTags = await tagListing(listing);
        const sourceTags = processSourcesToTags(listing.sources);
        
        // Merge tags from both sources
        const mergedDamageTags = Array.from(new Set([
          ...(llmTags.damage_tags || []),
          ...(sourceTags.damage_tags || [])
        ]));
        
        const mergedSaleTypeTags = Array.from(new Set([
          ...(llmTags.saletype_tags || []),
          ...(sourceTags.saletype_tags || [])
        ]));
        
        // Update listing with tags
        listing.damage_tags = mergedDamageTags;
        listing.saletype_tags = mergedSaleTypeTags;
        listing.recommendation = llmTags.recommendation;
        
        return listing;
      }
    );

    // 6) filter: keep only items with at least one tag
    const filtered = listings.filter(l => (l.damage_tags.length + l.saletype_tags.length) > 0);
    console.log(`filtered listings length is = `+filtered?.length);

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
