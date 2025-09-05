require('../database');

const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const Estate = require('./estate_realtor');
const { joinUrl, cleanNum, processSourcesToTags } = require('../common');

const BASE_URL = "https://www.realtor.com";


function parseCard($, card) {
    const c = $(card);

    // ---- LINK (from card-content anchor) ----
    const href =
        c.find('[data-testid="card-content"] a[href]').first().attr("href") ||
        c.find('a.LinkComponent_anchor__JMkHs[href]').first().attr("href") ||
        "";
    const link = joinUrl(BASE_URL, href);

    // ---- IMAGE (prefer visible <img>, fall back to data-src) ----
    let image_url =
        c.find('img[data-testid="picture-img"][src]').first().attr("src") ||
        c.find('img[data-testid="picture-img"][data-src]').first().attr("data-src") ||
        c.find("picture img[src]").first().attr("src") ||
        null;
    if (image_url && image_url.startsWith("//")) image_url = "https:" + image_url;

    // ---- PRICE ----
    const priceText = c.find('[data-testid="card-price"]').first().text();
    const price = cleanNum(priceText);

    // ---- BEDS / BATHS / SQFT ----
    const beds = cleanNum(
        c.find('[data-testid="property-meta-beds"] [data-testid="meta-value"]').first().text()
    );
    const baths = cleanNum(
        c.find('[data-testid="property-meta-baths"] [data-testid="meta-value"]').first().text()
    );
    const sqft = cleanNum(
        c.find('[data-testid="property-meta-sqft"] [data-testid="meta-value"]').first().text()
    );

    // ---- ADDRESS (line 1 + line 2) ----
    const addr1 = c.find('[data-testid="card-address-1"]').first().text();
    const addr2 = c.find('[data-testid="card-address-2"]').first().text();
    const address = [addr1, addr2].filter(Boolean).join(", ");

    // description is from detail page; leave null here
    const description = null;

    return {
        image_url: image_url || null,
        address: address || null,
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
    const cards = $('section[data-testid="property-list"] > div').not('.ads_container');   // exclude ads

    console.log(`cards length is = ` + cards.length);
    cards.each((_, card) => {
        const listing = parseCard($, card);
        results.push(listing);
    });

    return results;
}

async function processAllItemsForTags() {
    try {
        console.log('\n🏷️  Processing all database items for tag generation...');
        
        // Get all items from the database
        const allItems = await Estate.find({});
        console.log(`📋 Found ${allItems.length} items in database`);
        
        if (allItems.length === 0) {
            console.log('❌ No items found in database');
            return { processed: 0, updated: 0, errors: 0 };
        }
        
        let processed = 0;
        let updated = 0;
        let errors = 0;
        
        // Process each item
        for (const item of allItems) {
            try {
                console.log(`\n📄 Processing item: ${item.address || item._id}`);
                
                // Generate tags from sources using processSourcesToTags
                let sourceTags = { damage_tags: [], saletype_tags: [] };
                if (item.sources && item.sources.length > 0) {
                    console.log(`  🏷️  Processing sources for tags: ${item.sources.join(', ')}`);
                    sourceTags = processSourcesToTags(item.sources);
                } else {
                    console.log(`  ⚠️  No sources found, skipping source tags`);
                }
                
                // Merge and deduplicate tags
                const mergedTags = {
                    damage_tags: Array.from(new Set([
                        ...(sourceTags.damage_tags || [])
                    ])),
                    saletype_tags: Array.from(new Set([
                        ...(sourceTags.saletype_tags || [])
                    ]))
                };
                
                console.log(`  🏷️  Generated tags:`);
                console.log(`     Damage tags: ${mergedTags.damage_tags.length > 0 ? mergedTags.damage_tags.join(', ') : 'None'}`);
                console.log(`     Sale type tags: ${mergedTags.saletype_tags.length > 0 ? mergedTags.saletype_tags.join(', ') : 'None'}`);
                // console.log(`     Recommendation: ${recommendation}`);
                
                // Update the database record
                try {
                    const result = await Estate.findByIdAndUpdate(
                        item._id,
                        {
                            damage_tags: mergedTags.damage_tags,
                            saletype_tags: mergedTags.saletype_tags
                        },
                        { new: true }
                    );
                    
                    if (result) {
                        console.log(`  ✅ Successfully updated item: ${item._id}`);
                        updated++;
                    } else {
                        console.log(`  ⚠️  Item not found: ${item._id}`);
                    }
                    
                } catch (dbError) {
                    console.error(`  ❌ Database error updating item ${item._id}:`, dbError.message);
                    errors++;
                }
                
                processed++;
                
                // Add a small delay to avoid overwhelming the system
                await new Promise(resolve => setTimeout(resolve, 100));
                
            } catch (itemError) {
                console.error(`  ❌ Error processing item ${item._id}:`, itemError.message);
                errors++;
            }
        }
        
        console.log(`\n🎉 Tag processing completed!`);
        console.log(`📊 Summary:`);
        console.log(`   Items processed: ${processed}`);
        console.log(`   Items updated: ${updated}`);
        console.log(`   Errors: ${errors}`);
        
        return { processed, updated, errors };
        
    } catch (error) {
        console.error('❌ Error in processAllItemsForTags:', error.message);
        throw error;
    }
}


async function getDetailUrls() {
    console.log('Starting to process Alpharetta listings with missing descriptions...');

    try {
        // Find records from db with filter: { link: {$regex: "alpharetta" }, description: null }
        const listings = await Estate.find({
            description: null
        });

        console.log(`Found ${listings.length} listings with missing descriptions`);

        if (listings.length === 0) {
            console.log('No listings found with missing descriptions');
            return [];
        }

        const detailUrls = listings.map(listing => ({ _id: listing._id, link: listing.link }));

        // Save the array to a JSON file
        const jsonFilePath = path.join(__dirname, 'detail_urls.json');
        fs.writeFileSync(jsonFilePath, JSON.stringify(detailUrls, null, 2), 'utf8');
        console.log(`✅ Saved ${detailUrls.length} detail URLs to: ${jsonFilePath}`);

        return detailUrls;

    } catch (error) {
        console.error('❌ Error in getDetailUrls:', error.message);
        throw error;
    }
}

/**
 * Process HTML files from a folder and extract real estate data
 * @param {string} folderPath - Path to folder containing HTML files
 */
async function processHtmlFilesFromFolder(folderPath) {
    try {
        // Check if folder exists
        if (!fs.existsSync(folderPath)) {
            throw new Error(`Folder does not exist: ${folderPath}`);
        }

        // Get all HTML files in the folder
        const files = fs.readdirSync(folderPath)
            .filter(file => file.endsWith('.html'))
            .sort();

        console.log(`Found ${files.length} HTML files in folder: ${folderPath}`);

        if (files.length === 0) {
            console.log('No HTML files found in the specified folder');
            return;
        }

        // Group files by city for processing
        const cityGroups = new Map();

        for (const file of files) {
            // Extract city and keyword from filename
            // Format: 'zillow_tab7_marietta_renovate_page1_to10.html'

            if (file.endsWith('.html')) {
                const city = file.split('_')[2];
                const keyword = file.split('_')[3];

                if (!cityGroups.has(city)) {
                    cityGroups.set(city, []);
                }

                cityGroups.get(city).push({
                    filename: file,
                    keyword: keyword,
                    filepath: path.join(folderPath, file)
                });
            } else {
                console.log(`Warning: Could not parse filename: ${file}`);
            }
        }

        console.log(`\nGrouped files by city:`);
        for (const [city, files] of cityGroups) {
            console.log(`  ${city}: ${files.length} files`);
        }

        // Process each city
        for (const [city, cityFiles] of cityGroups) {
            console.log(`\n=== Processing city: ${city} ===`);

            const cityListings = [];

            // Process each file for this city
            for (const fileInfo of cityFiles) {
                console.log(`  Processing file: ${fileInfo.filename}`);

                try {
                    // Read HTML file
                    const htmlContent = fs.readFileSync(fileInfo.filepath, 'utf8');

                    // Parse HTML using existing function
                    const listings = parseSearchHtml(htmlContent);

                    // Set sources to keyword from filename
                    const listingsWithSource = listings.map(listing => ({
                        ...listing,
                        sources: [fileInfo.keyword]
                    }));

                    cityListings.push(...listingsWithSource);

                    console.log(`    ✓ Parsed ${listings.length} listings with keyword: ${fileInfo.keyword}`);

                } catch (error) {
                    console.error(`    ❌ Error processing file ${fileInfo.filename}:`, error.message);
                }
            }

            // Remove duplicates by address for this city
            const uniqueByLink = new Map();
            for (const listing of cityListings) {
                if (listing.address) {
                    const existing = uniqueByLink.get(listing.link);
                    if (existing) {
                        // Merge sources if duplicate found
                        existing.sources = Array.from(new Set([...existing.sources, ...listing.sources]));
                    } else {
                        uniqueByLink.set(listing.link, listing);
                    }
                }
            }

            const uniqueListings = Array.from(uniqueByLink.values());
            console.log(`  ✓ Found ${cityListings.length} total listings, ${uniqueListings.length} unique by address`);

            // Save unique listings to database
            if (uniqueListings.length > 0) {
                try {
                    // Save to database
                    const savedListings = await Estate.insertMany(uniqueListings);
                    console.log(`  ✓ Saved ${savedListings.length} listings to database for ${city}`);
                } catch (error) {
                    console.error(`  ❌ Error saving to database for ${city}:`, error.message);
                }
            }
        }

        console.log(`\n✅ Completed processing all HTML files from folder: ${folderPath}`);

    } catch (error) {
        console.error('❌ Error in processHtmlFilesFromFolder:', error.message);
        throw error;
    }
}


module.exports = {
    parseCard,
    parseSearchHtml,
    processHtmlFilesFromFolder,
    getDetailUrls,
    processAllItemsForTags
};



(async () => {
    // await processHtmlFilesFromFolder('./src/scrapping_realtor/realtor_scrapping');
    // await getDetailUrls();
    await processAllItemsForTags();
})();

