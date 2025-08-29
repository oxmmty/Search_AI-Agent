const { chromium } = require('playwright');
const cheerio = require('cheerio');

const { tagListing, autoScroll, cleanNum, joinUrl } = require('./common');
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

const DETAIL_CONCURRENCY = 3;

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
  const nums = $('ul.d-pagination li')
    .toArray()
    .map(li => $(li).text().trim())
    .filter(t => /^\d+$/.test(t));

  return nums.length ? parseInt(nums[nums.length - 1], 10) : 0; // last numeric page
}

async function scrapeSearchPage(context, searchUrl) {
  console.log(`in sub page ${searchUrl}`);
  const page = await context.newPage();
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    console.log(`before waiting url=${searchUrl}`);
    await page.waitForSelector("ul.d-search-results-listing-cards li.d-search-results-listing-card-item", { timeout: 45_000 });
    console.log(`after waiting url=${searchUrl}`);
    await autoScroll(page);

    const html = await page.content();
    const listings = parseSearchHtml(html);

    console.log(`url = ${searchUrl}, listings length is = `+listings?.length);
    return listings;
  } catch (e) {
    console.error(`Error scraping page ${searchUrl}:`, e.message);
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
    
    await page.waitForSelector("ul.d-search-results-listing-cards li.d-search-results-listing-card-item", { timeout: 45_000 });
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
    for (let i = 2; i <= lastPage; i++) {
      const pageUrl = `${baseUrl}?pageNumber=${i}`;
      const results = await scrapeSearchPage(context, pageUrl);
      console.log(`Page ${i}: ${results.length} listings`);
      
      // Save this page's listings to DB immediately
      const savedPageListings = await saveListingsToDB(results, cityPath);
      allSavedListings.push(...savedPageListings);
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
  let savedListings = [];
  if(!cityPath.includes('marietta')){
    savedListings = await scrapeAllPagesForCity(context, cityPath);
    if (savedListings.length === 0) {
      console.log(`No listings found for city: ${cityPath}`);
      return [];
    }
  }else{
    savedListings = await Estate.find().sort({ createdAt: -1 }).lean();
  }

  console.log(`All pages scraped and saved to database. Total listings: ${savedListings.length}`);
  
  // 2. Fetch descriptions for each listing and update DB
  console.log(`Fetching descriptions for ${savedListings.length} listings...`);
  for (let i = 0; i < savedListings.length; i++) {
    if(cityPath.includes('marietta') && i < 329){
      continue;
    }
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
      viewport: { width: 1366, height: 900 }
    });
    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(60_000);

    const allResults = [];
    
    // Loop through each city path
    for (const cityPath of CITY_PATHS) {
      try {
        const cityResults = await scrapeAndProcessCity(context, cityPath);
        allResults.push(...cityResults);
      } catch (error) {
        console.error(`❌ Error processing city ${cityPath}:`, error.message);
        // Continue with next city
      }
    }
    
    console.log(`\nTotal processing completed. Processed ${allResults.length} listings across all cities.`);
    return allResults;
    
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

/* ===================== RUN (example) ===================== */

async function scrapeRemax() {
  console.log('Starting RE/MAX scraper with new flow...');
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

module.exports = { scrapeRemax };
