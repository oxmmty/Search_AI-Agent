const { chromium } = require('playwright');
const cheerio = require('cheerio');

const { tagListing, autoScroll, cleanNum, joinUrl } = require('./common');
const Estate = require('../models/estate');
/* ======================= CONFIG ======================= */

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
    console.log(`before waiting url=${searchUrl}`);
    await page.waitForSelector(".HomeViews .HomeCardsContainer, .HomeCardsContainer", { timeout: 45_000 });
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

async function scrapeAllPagesForCity(context, cityPath) {
  console.log(`Starting to scrape city: ${cityPath}`);
  
  // Build URL for first page (no terms, just city)
  const baseUrl = `${BASE_URL}${cityPath}`;
  const page = await context.newPage();
  
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    console.log(`Navigated to base URL: ${baseUrl}`);
    
    await page.waitForSelector(".HomeViews .HomeCardsContainer, .HomeCardsContainer", { timeout: 45_000 });
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
      const pageUrl = `${baseUrl}/page-${i}`;
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

async function scrapeRedfin() {
  console.log('Starting Redfin scraper with new flow...');
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

module.exports = { scrapeRedfin };
