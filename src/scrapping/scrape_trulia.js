const { chromium } = require('playwright');
const cheerio = require('cheerio');

const { runWithConcurrency, processSourcesToTags, tagListing, autoScroll, cleanNum, joinUrl } = require('./common');
const { SALE_TYPE_KEYWORDS, DAMAGE_KEYWORDS_SEARCH } = require('../constants/keywords');
const Estate = require('../models/estate');
/* ======================= CONFIG ======================= */

const BASE_URL = "https://www.trulia.com";
const CITY_PATHS = [
  "/for_sale/Marietta,GA",
  "/GA/Kennesaw",
  "/for_sale/Roswell,GA",
  "/for_sale/Alpharetta,GA",
  "/for_sale/Milton,GA",
  "/for_sale/Sandy_Springs,GA",
  "/for_sale/Dunwoody,GA",
  "/GA/Atlanta,Buckhead_Village",
  "/for_sale/Brookhaven,GA",
  "/for_sale/Johns_Creek,GA",
  "/for_sale/Woodstock,GA",
  "/for_sale/Vinings,GA"
];


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



/** build Trulia search URL like /for_sale/City,ST/<keyword>_keyword */
function buildRemarkUrl(cityPath, remark, page) {
  return `${BASE_URL}${cityPath.replace(/\/$/, "")}/${encodeURIComponent(remark)}_keyword${page>1 ? `/${page}_p` :''}`;
}

/* ===================== PARSING ===================== */

function parseCard($, card) {
  const c = $(card);
  // Link
  const href =
    c.find('a[data-testid="property-card-link"]').attr('href') ||
    c.find('[data-testid="property-card-carousel-container"] a[href]').attr('href') ||
    c.find('.PropertyCard a[href]').attr('href') ||
    c.find("a[href^='/home/']").attr('href') ||
    "";
  const link = joinUrl(BASE_URL, href);

  // Image
  const image_url =
    c.find('[data-testid^="property-image-"] img').first().attr('src') ||
    c.find('.property-card-media img').first().attr('src') ||
    c.find('img.image').first().attr('src') ||
    null;

  // Price
  let priceText =
    c.find('[data-testid="property-price"]').first().attr('title') ||
    c.find('[data-testid="property-price"]').first().text() ||
    null;
  priceText = priceText ? priceText.trim() : null;
  const price = cleanNum(priceText);

  // Address
  let address = c.find('[data-testid="property-address"]').first().text() || null;
  if (address) {
    address = address.replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ').trim();
  }

  // Beds / Baths
  const bedsText =
    c.find('[data-testid="property-beds"] strong').first().text().trim() ||
    c.find('[data-testid="property-beds"]').first().text().trim() ||
    null;
  const bathsText =
    c.find('[data-testid="property-baths"] strong').first().text().trim() ||
    c.find('[data-testid="property-baths"]').first().text().trim() ||
    null;
  const beds = cleanNum(bedsText);
  const baths = cleanNum(bathsText);

  // Sqft
  let sqftText =
    c.find('[data-testid="property-floorSpace"]').first().text().trim() ||
    c.find('[data-testid="property-sqft"]').first().text().trim() ||
    null;
  if (!sqftText) {
    const detailsText = c.find('[data-testid="property-card-details"]').text();
    const m = detailsText && detailsText.match(/([\d,.]+)\s*(?:sq\s?ft|sqft)/i);
    if (m) sqftText = m[1];
  }
  const sqft = cleanNum(sqftText);

  // Description (summary line on card)
  let description =
    c.find('[data-testid="property-card-listing-summary"]').first().text().trim() ||
    c.attr('aria-label') ||
    null;
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

  $('ul[data-testid="search-result-list-container"] > li').each((_, li) => {
    const el = $(li);

    const isCard =
      el.is('[data-testid^="srp-home-card"]') ||
      el.find('[data-testid="home-card-sale"], .PropertyCard, [data-testid="property-card-link"]').length > 0;

    if (!isCard) return;

    const listing = parseCard($, li);
    if (listing) results.push(listing);
  });

  return results;
}

function extractRemarksFromHtml(html) {
  const $ = cheerio.load(html);
  const selectors = [
    '[data-testid="home-description-text-description-text"]',
    '[data-testid="home-description-text"]',
    '[data-testid="home-description-content"]',
    '[data-testid="home-description"]'
  ];

  for (const sel of selectors) {
    const el = $(sel).first();
    if (el.length) {
      const clone = el.clone();
      clone.find('br').replaceWith(' ');
      clone.find('p').each((_, p) => {
        const $p = $(p);
        $p.after(' ');
      });

      const text = clone.text().replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').trim();
      if (text) return text;
    }
  }

  return null;
}

/* ===================== BROWSER HELPERS ===================== */

// NOTE: Removed all waitForSelector calls and any scrolling.
// We just load the HTML and parse whatever is there.

/** Fetch description HTML without waiting for selectors */
async function fetchListingDescription(context, link) {
  if (!link) return null;
  const page = await context.newPage();
  try {
    await page.goto(link, { waitUntil: "domcontentloaded", timeout: 60_000 });
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
    const html = await page.content();
    const listings = parseSearchHtml(html);

    console.log(`url = ${searchUrl}, listings length is = `+listings?.length);
    // If no items found, return empty array (per requirement)
    if (!Array.isArray(listings) || listings.length === 0) return [];
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
    // await page.waitForSelector(".HomeViews .HomeCardsContainer, .HomeCardsContainer", { timeout: 45_000 });
    await autoScroll(page);

    const html = await page.content();
    const lastPage = getPageNumber(html);
    let listings = parseSearchHtml(html);

    console.log(`url=${url}, pages=${lastPage}`)
    for(let i = 2; i <= lastPage; i++){
      const results = scrapeSearchPage(context, buildRemarkUrl(city, term, i));
      listings = [...listings, ...results];
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
    // NO headless: keep visible browser
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      userAgent: HEADERS["User-Agent"],
      locale: "en-US",
      extraHTTPHeaders: HEADERS,
      viewport: { width: 1366, height: 900 },
    });
    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(60_000);

    // 1) Build search URLs for all terms
    const searchInfo = terms.map(t => ({ term: t, city: cityPath }));
    console.log(`Searching ${searchInfo.length} queries...`);

    // 2) Scrape each search page SEQUENTIALLY (no multithreading)
    const pagesListings = [];
    for (const { term, city } of searchInfo) {
      const results = await scrapeSearchPages(context, city, term);
      const taggedSources = results.map(r => ({ ...r, sources: [term] }));
      pagesListings.push(taggedSources);
    }

    // 3) Aggregate + dedupe by link
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

    // 4) Enrich: fetch full description for each listing SEQUENTIALLY
    const enriched = [];
    for (const lst of listings) {
      const desc = await fetchListingDescription(context, lst.link);
      enriched.push({ ...lst, description: desc ?? lst.description ?? null });
    }

    // 5) Tag each listing SEQUENTIALLY
    const tagged = [];
    for (const item of enriched) {
      const t = await tagListing(item);
      tagged.push(t);
    }

    // 6) Filter: keep only items with at least one tag
    const filtered = tagged.filter(l => (l.damage_tags.length + l.saletype_tags.length) > 0);

    return filtered;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

/* ===================== RUN (example) ===================== */

async function scrapeTrulia() {
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

  console.log(`\nKept ${results.length} listings with ≥1 matching keyword.`);
}

module.exports = { scrapeTrulia };
