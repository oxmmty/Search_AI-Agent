const { chromium } = require('playwright');
const cheerio = require('cheerio');

const { tagListing, autoScroll, cleanNum, joinUrl } = require('./common');
const Estate = require('../models/estate');
/* ======================= CONFIG ======================= */

const BASE_URL = "https://www.coldwellbankerhomes.com";
const CITY_PATHS = [
  "/ga/marietta",
  "/ga/kennesaw",
  "/ga/roswell",
  "/ga/alpharetta",
  "/ga/milton",
  "/ga/sandy-springs",
  "/ga/dunwoody",
  "/ga/buckhead",
  "/ga/brookhaven",
  "/ga/johns-creek",
  "/ga/woodstock",
  "/ga/vinings"
];

const HEADERS = {
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.coldwellbankerhomes.com/",
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

/* ===================== PARSING ===================== */

function parseCard($, card) {
  const c = $(card);
  // ---- LINK ----
  const linkHref =
    c.attr('data-detailurl') ||
    c.find('.prop-pix a[href]').first().attr('href') ||
    c.find('.prop-info .address a[href]').first().attr('href') ||
    '';
  const link = joinUrl(BASE_URL, linkHref);

  // ---- IMAGE ----
  const pickFromSrcset = (srcset) => {
    if (!srcset) return null;
    const best = srcset
      .split(',')
      .map(s => s.trim())
      .map(s => {
        const [url, size] = s.split(/\s+/);
        // take numeric width/descriptors as scale; fallback to 1
        const scale = parseFloat((size || '').replace(/[^\d.]/g, '')) || 1;
        return { url, scale };
      })
      .sort((a, b) => b.scale - a.scale)[0];
    return best?.url || null;
  };
  const isPlaceholder = (u) => !u || /spacer|1\.gif|not-available/i.test(u);

  let image_url = null;
  const imgEls = c.find('.photo-listing img').toArray();
  for (const el of imgEls) {
    const node = $(el);
    const candidates = [
      node.attr('data-src-psr'),
      node.attr('data-src'),
      node.attr('src'),
      pickFromSrcset(node.attr('data-srcset-psr')),
      pickFromSrcset(node.attr('data-srcset')),
      pickFromSrcset(node.attr('srcset')),
    ].filter(Boolean);
    const chosen = candidates.find(u => !isPlaceholder(u));
    if (chosen) {
      image_url = chosen;
      break;
    }
  }
  if (image_url && image_url.startsWith('//')) image_url = 'https:' + image_url;
  if (image_url) image_url = joinUrl(BASE_URL, image_url);
  // ---- PRICE ----
  const priceText =
    (c.find('.price .price-normal, .price-block .price-normal, .price .price, .price-block .price')
      .first()
      .text() || '')
      .trim() || null;
  const price = cleanNum(priceText);
  // ---- ADDRESS ----
  const address =
    (c.find('.address .address-price-heading').first().text() || '')
      .replace(/\s+/g, ' ')
      .trim() || null;
  // ---- STATS (beds, baths, sqft) ----
  let beds = null, baths = null, sqft = null;

  const bedsVal = (c.find('.description-highlights .highlights li.beds .val').first().text() || '').trim();
  if (bedsVal) beds = cleanNum(bedsVal);

  const bathsTotalVal = (c.find('.description-highlights .highlights li.total-bath .val').first().text() || '').trim();
  const bathsFullVal = (c.find('.description-highlights .highlights li.full-bath .val').first().text() || '').trim();
  if (bathsTotalVal) baths = cleanNum(bathsTotalVal);
  else if (bathsFullVal) baths = cleanNum(bathsFullVal);
  // Sq Ft might appear in different lists; scan likely containers
  c.find('.description-highlights .highlights li, .description-summary li, .address-price-etc, .prop-info')
    .each((_, li) => {
      if (sqft != null) return;
      const t = ($(li).text() || '').trim();
      if (/(sq\.?\s*ft|square\s*feet)/i.test(t)) {
        const n = cleanNum(t);
        if (n) sqft = n;
      }
    });
  // No description on card in this layout; fetch from detail page
  const description = null;

  const result = {
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

  return result;
}

function parseSearchHtml(html) {
  const $ = cheerio.load(html);
  const results = [];
  const cards = $(".search-list .property-snapshot-psr-panel");

  cards.each((_, card) => {
    const listing = parseCard($, card);
    results.push(listing);
  });

  return results.filter(l => l && l.address);
}

function extractRemarksFromHtml(html) {
  const $ = cheerio.load(html);
  const clean = (s = '') => s.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();

  const safeParse = (txt) => {
    if (!txt) return null;
    try {
      return JSON.parse(txt);
    } catch {
      try {
        return JSON.parse(txt.replace(/[\u2028\u2029]/g, ''));
      } catch {
        return null;
      }
    }
  };

  const getTypes = (node) => {
    if (!node) return [];
    const t = node['@type'];
    if (!t) return [];
    return Array.isArray(t) ? t.map(String) : [String(t)];
  };

  const pickDescFromNode = (node) => {
    if (!node || typeof node !== 'object') return null;
    if (typeof node.description === 'string' && clean(node.description)) return clean(node.description);
    if (node.mainEntity && typeof node.mainEntity.description === 'string' && clean(node.mainEntity.description)) {
      return clean(node.mainEntity.description);
    }
    return null;
  };

  const scripts = $('script[type="application/ld+json"]').toArray()
    .map(s => $(s).contents().text())
    .filter(txt => /"@graph"\s*:/.test(txt || ''));

  for (const raw of scripts) {
    const data = safeParse(raw);
    if (!data || !data['@graph']) continue;

    const graph = Array.isArray(data['@graph']) ? data['@graph'] : [data['@graph']];

    for (const node of graph) {
      const types = getTypes(node).map(t => t.toLowerCase());
      if (types.includes('realestatelisting')) {
        const d = pickDescFromNode(node);
        if (d) return d;
      }
    }

    for (const node of graph) {
      const types = getTypes(node).map(t => t.toLowerCase());
      if (types.includes('product')) {
        const d = pickDescFromNode(node);
        if (d) return d;
      }
    }

    for (const node of graph) {
      const d = pickDescFromNode(node);
      if (d) return d;
    }
  }

  return null;
}

/* ===================== BROWSER HELPERS ===================== */

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

/* ===================== SCRAPE + AGGREGATE ===================== */

async function saveListingsToDB(listings, cityPath) {
  const savedListings = [];
  
  for (const listing of listings) {
    try {
      // Add city info to listing
      listing.city = cityPath;
      listing.sources = [cityPath];
      
      // Save to DB and get the saved document with _id
      const savedListing = await Estate.create(listing);
      savedListings.push(savedListing);
      console.log(`Saved listing: ${listing.address} with ID: ${savedListing._id}`);
    } catch (e) {
      console.error(`Error saving listing ${listing.address}:`, e.message);
    }
  }
  
  console.log(`Successfully saved ${savedListings.length} listings to database for this page`);
  return savedListings;
}

function getPageNumber(html){
  const $ = cheerio.load(html);
  const nums = $('ul.propertysearch-results-pager li')
    .toArray()
    .map(li => $(li).text().trim())
    .filter(t => /^\d+$/.test(t));

  return nums.length ? parseInt(nums[nums.length - 1], 10) : 0; // last numeric page
}

async function scrapeSearchPage(context, searchUrl) {
  const page = await context.newPage();
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(".search-list .property-snapshot-psr-panel", { timeout: 45_000 });
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

async function scrapeAllPagesForCity(context, cityPath) {
  console.log(`Starting to scrape city: ${cityPath}`);
  
  // Build URL for first page (no terms, just city)
  const baseUrl = `${BASE_URL}${cityPath}`;
  const page = await context.newPage();
  
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    console.log(`Navigated to base URL: ${baseUrl}`);
    
    await page.waitForSelector(".search-list .property-snapshot-psr-panel", { timeout: 45_000 });
    console.log(`Found listing cards on base page`);
    
    await autoScroll(page);
    
    const html = await page.content();
    const lastPage = getPageNumber(html);
    console.log(`City: ${cityPath}, Total pages: ${lastPage}`);
    
    const allSavedListings = [];
    
    // Process first page
    let firstPageListings = parseSearchHtml(html);
    console.log(`Page 1: ${firstPageListings.length} listings`);
    
    // Save first page listings to DB immediately
    const savedFirstPage = await saveListingsToDB(firstPageListings, cityPath);
    allSavedListings.push(...savedFirstPage);
    
    // Scrape and save remaining pages one by one
    if (lastPage > 1) {
      for (let i = 2; i <= lastPage; i++) {
        const pageUrl = `${baseUrl}?sortId=${i}&offset=${24*(i-1)}`;
        const results = await scrapeSearchPage(context, pageUrl);
        console.log(`Page ${i}: ${results.length} listings`);
        
        // Save this page's listings to DB immediately
        const savedPageListings = await saveListingsToDB(results, cityPath);
        allSavedListings.push(...savedPageListings);
      }
    }
    
    console.log(`City ${cityPath}: Total listings saved to DB: ${allSavedListings.length}`);
    return allSavedListings;
    
  } catch (e) {
    console.error(`Error scraping city ${cityPath}:`, e.message);
    return [];
  } finally {
    await page.close().catch(() => {});
  }
}

async function scrapeAndProcessCity(context, cityPath) {
  console.log(`\n=== Processing City: ${cityPath} ===`);
  
  // 1. Scrape all pages for this city and save to DB per page
  const savedListings = await scrapeAllPagesForCity(context, cityPath);
  if (savedListings.length === 0) {
    console.log(`No listings found for city: ${cityPath}`);
    return [];
  }
  
  console.log(`All pages scraped and saved to database. Total listings: ${savedListings.length}`);
  
  // 2. Fetch descriptions for each listing and update DB
  console.log(`Fetching descriptions for ${savedListings.length} listings...`);
  for (let i = 0; i < savedListings.length; i++) {
    const listing = savedListings[i];
    try {
      const description = await fetchListingDescription(context, listing.link);
      if (description) {
        // Update the listing object
        listing.description = description;
        
        // Update in database
        await Estate.findByIdAndUpdate(listing._id, { description });
        console.log(`Updated description for listing ${i + 1}/${savedListings.length}: ${listing.address}`);
      }
    } catch (e) {
      console.error(`Error fetching description for ${listing.address}:`, e.message);
    }
  }
  
  // 3. Apply tagging and update DB records
  console.log(`Applying tags to ${savedListings.length} listings...`);
  for (let i = 0; i < savedListings.length; i++) {
    const listing = savedListings[i];
    try {
      // Get tags using tagListing function
      const tagged = await tagListing(listing);
      
      // Update listing object
      listing.damage_tags = tagged.damage_tags || [];
      listing.saletype_tags = tagged.saletype_tags || [];
      listing.recommendation = tagged.recommendation || '';
      
      // Update in database
      await Estate.findByIdAndUpdate(listing._id, {
        damage_tags: listing.damage_tags,
        saletype_tags: listing.saletype_tags,
        recommendation: listing.recommendation
      });
      
      console.log(`Applied tags for listing ${i + 1}/${savedListings.length}: ${listing.address}`);
      console.log(`  Damage tags: ${listing.damage_tags.join(', ')}`);
      console.log(`  Sale type tags: ${listing.saletype_tags.join(', ')}`);
      
    } catch (e) {
      console.error(`Error applying tags for ${listing.address}:`, e.message);
    }
  }
  
  console.log(`=== Completed processing city: ${cityPath} ===\n`);
  return savedListings;
}

async function scrapeAndTagAll() {
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

    const allResults = [];
    
    // Loop through each city path
    for (const cityPath of CITY_PATHS) {
      const cityResults = await scrapeAndProcessCity(context, cityPath);
      allResults.push(...cityResults);
    }
    
    console.log(`\nTotal processing completed. Processed ${allResults.length} listings across all cities.`);
    return allResults;
    
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

/* ===================== RUN (example) ===================== */

async function scrapeColdwellbankerhomes() {
  console.log('Starting Coldwell Banker Homes scraper with new flow...');
  const results = await scrapeAndTagAll();
  
  // Filter results to show only those with tags
  const taggedResults = results.filter(l => 
    (l.damage_tags && l.damage_tags.length > 0) || 
    (l.saletype_tags && l.saletype_tags.length > 0)
  );
  
  console.log(`\nScraping completed!`);
  console.log(`Total listings processed: ${results.length}`);
  console.log(`Listings with tags: ${taggedResults.length}`);
  console.log(`Listings without tags: ${results.length - taggedResults.length}`);
}

module.exports = { scrapeColdwellbankerhomes };
