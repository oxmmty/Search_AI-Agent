require('../database');

const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const Estate = require('./estate_trulia');
const { joinUrl, cleanNum,  tagListing, processSourcesToTags } = require('../common');

const BASE_URL = "https://www.trulia.com";

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
    const firstDiv = $('div[role="main"][tabindex="-1"]').first();

    // check if it contains the ul
    firstDiv.find('ul[data-testid="search-result-list-container"] > li').each((_, li) => {
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

async function processHtmlFilesAndUpdateDescriptions(folderPath) {
    try {
        console.log(`\n🏠 Processing HTML files for description updates`);
        console.log(`📁 Folder: ${folderPath}`);

        // Check if folder exists
        if (!fs.existsSync(folderPath)) {
            throw new Error(`Folder does not exist: ${folderPath}`);
        }

        console.log(`📋 Processing HTML files with direct ID extraction from filenames`);

        // Get all HTML files in the folder
        const files = fs.readdirSync(folderPath)
            .filter(file => file.endsWith('.html'))
            .sort();

        console.log(`Found ${files.length} HTML files`);

        if (files.length === 0) {
            console.log('No HTML files found in the specified folder');
            return { processed: 0, updated: 0, errors: 0 };
        }

        let processed = 0;
        let updated = 0;
        let errors = 0;

        // Process each HTML file
        for (const file of files) {
            try {
                console.log(`\n📄 Processing file: ${file}`);

                // Extract global index and record ID from filename (format: "tab{globalindex}_{id}~.html")
                const match = file.match(/tab(\d+)_([^~]+)~\.html/);
                if (!match) {
                    console.log(`⚠️  Skipping file with invalid format: ${file}`);
                    continue;
                }

                const globalIndex = parseInt(match[1]);
                const recordId = match[2];
                console.log(`🔢 Global Index: ${globalIndex}`);
                console.log(`🆔 Record ID: ${recordId}`);

                // Read HTML file
                const htmlContent = fs.readFileSync(path.join(folderPath, file), 'utf8');

                // Extract description from HTML
                const description = extractRemarksFromHtml(htmlContent);

                if (description) {
                    console.log(`📝 Extracted description (${description.length} characters)`);
                    console.log(`   Preview: ${description.substring(0, 100)}...`);

                    // Update database record directly using the ID from filename
                    try {
                        const result = await Estate.findByIdAndUpdate(
                            recordId,
                            { description: description },
                        );

                        if (result) {
                            console.log(`✅ Successfully updated record: ${recordId}`);
                            updated++;
                        } else {
                            console.log(`⚠️  Record not found: ${recordId}`);
                        }

                    } catch (dbError) {
                        console.error(`❌ Database error updating record ${recordId}:`, dbError.message);
                        errors++;
                    }

                }

                processed++;

            } catch (fileError) {
                console.error(`❌ Error processing file ${file}:`, fileError.message);
                errors++;
            }
        }

        console.log(`\n🎉 Processing completed!`);
        console.log(`📊 Summary:`);
        console.log(`   Files processed: ${processed}`);
        console.log(`   Records updated: ${updated}`);
        console.log(`   Errors: ${errors}`);

        return { processed, updated, errors };

    } catch (error) {
        console.error('❌ Error in processHtmlFilesAndUpdateDescriptions:', error.message);
        throw error;
    }
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

                // Generate tags from description using tagListing
                let taggedItem;
                if (item.description && item.description.trim()) {
                    console.log(`  📝 Processing description for tags...`);
                    taggedItem = await tagListing(item);
                } else {
                    console.log(`  ⚠️  No description found, skipping description tags`);
                    taggedItem = { ...item, damage_tags: [], saletype_tags: [], recommendation: "No description." };
                }

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
                        ...(taggedItem.damage_tags || []),
                        ...(sourceTags.damage_tags || [])
                    ])),
                    saletype_tags: Array.from(new Set([
                        ...(taggedItem.saletype_tags || []),
                        ...(sourceTags.saletype_tags || [])
                    ]))
                };

                // Keep the recommendation from tagListing if available
                const recommendation = taggedItem.recommendation || "Tags generated from description and sources";

                console.log(`  🏷️  Generated tags:`);
                console.log(`     Damage tags: ${mergedTags.damage_tags.length > 0 ? mergedTags.damage_tags.join(', ') : 'None'}`);
                console.log(`     Sale type tags: ${mergedTags.saletype_tags.length > 0 ? mergedTags.saletype_tags.join(', ') : 'None'}`);
                console.log(`     Recommendation: ${recommendation}`);

                // Update the database record
                try {
                    const result = await Estate.findByIdAndUpdate(
                        item._id,
                        {
                            damage_tags: mergedTags.damage_tags,
                            saletype_tags: mergedTags.saletype_tags,
                            recommendation: recommendation
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
            // description: null
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
                    // console.log(JSON.stringify(listingsWithSource, null, 2));

                    console.log(`    ✓ Parsed ${listings.length} listings with keyword: ${fileInfo.keyword}`);

                } catch (error) {
                    console.error(`    ❌ Error processing file ${fileInfo.filename}:`, error.message);
                }
            }

            // Remove duplicates by address for this city
            const uniqueByLink = new Map();
            for (const listing of cityListings) {
                if (listing.link) {
                    const existing = uniqueByLink.get(listing.link);
                    if (existing) {
                        // Merge sources if duplicate found
                        existing.sources = Array.from(new Set([...existing.sources, ...listing.sources]));
                        uniqueByLink.set(existing.link, existing);
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
    processHtmlFilesAndUpdateDescriptions,
    extractRemarksFromHtml,
    processAllItemsForTags
};



(async () => {
    // console.log(cleanNum('Est. $218,300'));
    // await processHtmlFilesFromFolder('./src/scrapping_trulia/trulia_scrapping');
    // await getDetailUrls();
    // await processHtmlFilesAndUpdateDescriptions('./src/scrapping_trulia/trulia_scrapping_descriptions');
    await processAllItemsForTags();
})();

