require('../database');

const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const Estate = require('./estate_zillow');
const { joinUrl, cleanNum, tagListing, processSourcesToTags } = require('../common');

const BASE_URL = "https://www.zillow.com";

function parseCard($, card) {
    const el = $(card);
  
    // Detail page link
    const detailLink = el.find("a[data-test='property-card-link']").attr("href") || "";
  
    // Address
    const address = el.find("a[data-test='property-card-link'] address").text().trim();
  
    // Price
    let price = el.find("[data-test='property-card-price']").text().trim();
    price = price.replace(/[^0-9]/g, "");
    price = price ? parseInt(price, 10) : 0;
  
    // Beds / Baths / Space
    let beds = 0, baths = 0, space = 0;
    const detailsText = el.find("ul").text().toLowerCase();
  
    const bedMatch = detailsText.match(/(\d+)\s*bd/);
    if (bedMatch) beds = parseInt(bedMatch[1], 10);
  
    const bathMatch = detailsText.match(/(\d+(\.\d+)?)\s*ba/);
    if (bathMatch) baths = parseFloat(bathMatch[1]);
  
    const spaceMatch = detailsText.match(/([\d,]+)\s*sqft/);
    if (spaceMatch) {
      space = parseInt(spaceMatch[1].replace(/,/g, ""), 10);
    } else {
      const acreMatch = detailsText.match(/([\d.]+)\s*acre/);
      if (acreMatch) {
        space = parseFloat(acreMatch[1]);
      }
    }
  
    // Image
    const imageUrl =
      el.find("picture source").attr("srcset") ||
      el.find("img").attr("src") ||
      "";
  
    return {
      image_url: imageUrl,
      address,
      price,
      beds,
      baths,
      space,
      link: detailLink
    };
  }

function parseSearchHtml(html) {
    const $ = cheerio.load(html);
    const results = [];
    const cards = $("div#grid-search-results > ul.photo-cards li article[ data-test='property-card']");

    console.log(`cards length is = ` + cards.length);
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

/**
 * Process HTML files and update database descriptions
 * @param {string} folderPath - Path to folder containing HTML files
 */
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
                            { new: true }
                        );

                        if (result) {
                            console.log(`✅ Successfully updated record: ${recordId}`);
                            updated++;

                            try {
                                const item = await Estate.findById(recordId);
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
                                let sourceTags = { damage_tags: [...item.damage_tags], saletype_tags: [...item.saletype_tags] };
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
                                }
                            } catch (e) {
                            }
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
                        sources: [fileInfo.keyword.toLowerCase()]
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

/**
 * Process HTML files and update database descriptions with ID mapping
 * Maps origin IDs (from HTML filenames) to current IDs (from detail_urls.json) using links
 * @param {string} folderPath - Path to folder containing HTML files
 * @param {string} originJsonPath - Path to detail_urls_origin.json
 * @param {string} currentJsonPath - Path to detail_urls.json
 */
async function processHtmlFilesWithIdMapping(folderPath, originJsonPath, currentJsonPath) {
    try {
        console.log(`\n🏠 Processing HTML files with ID mapping for description updates`);
        console.log(`📁 HTML Folder: ${folderPath}`);
        console.log(`📄 Origin JSON: ${originJsonPath}`);
        console.log(`📄 Current JSON: ${currentJsonPath}`);

        // Check if folders/files exist
        if (!fs.existsSync(folderPath)) {
            throw new Error(`HTML folder does not exist: ${folderPath}`);
        }
        if (!fs.existsSync(originJsonPath)) {
            throw new Error(`Origin JSON file does not exist: ${originJsonPath}`);
        }
        if (!fs.existsSync(currentJsonPath)) {
            throw new Error(`Current JSON file does not exist: ${currentJsonPath}`);
        }

        // Load JSON files
        console.log('📋 Loading JSON files...');
        const originData = JSON.parse(fs.readFileSync(originJsonPath, 'utf8'));
        const currentData = JSON.parse(fs.readFileSync(currentJsonPath, 'utf8'));
        
        console.log(`📊 Origin data: ${originData.length} records`);
        console.log(`📊 Current data: ${currentData.length} records`);

        // Create mapping from link to current ID
        console.log('🔗 Creating link-to-current-ID mapping...');
        const linkToCurrentId = new Map();
        currentData.forEach(item => {
            linkToCurrentId.set(item.link, item._id);
        });
        console.log(`✅ Created mapping for ${linkToCurrentId.size} links`);

        // Create mapping from origin ID to link
        console.log('🔗 Creating origin-ID-to-link mapping...');
        const originIdToLink = new Map();
        originData.forEach(item => {
            originIdToLink.set(item._id, item.link);
        });
        console.log(`✅ Created mapping for ${originIdToLink.size} origin IDs`);

        // Get all HTML files in the folder
        const files = fs.readdirSync(folderPath)
            .filter(file => file.endsWith('.html'))
            .sort();

        console.log(`Found ${files.length} HTML files`);

        if (files.length === 0) {
            console.log('No HTML files found in the specified folder');
            return { processed: 0, updated: 0, errors: 0, mapped: 0 };
        }

        let processed = 0;
        let updated = 0;
        let errors = 0;
        let mapped = 0;

        // Process each HTML file
        for (const file of files) {
            try {
                console.log(`\n📄 Processing file: ${file}`);

                // Extract global index and origin record ID from filename (format: "tab{globalindex}_{originId}~.html")
                const match = file.match(/tab(\d+)_([^~]+)~\.html/);
                if (!match) {
                    console.log(`⚠️  Skipping file with invalid format: ${file}`);
                    continue;
                }

                const globalIndex = parseInt(match[1]);
                const originId = match[2];
                console.log(`🔢 Global Index: ${globalIndex}`);
                console.log(`🆔 Origin ID: ${originId}`);

                // Get link from origin ID
                const link = originIdToLink.get(originId);
                if (!link) {
                    console.log(`⚠️  No link found for origin ID: ${originId}`);
                    errors++;
                    continue;
                }
                console.log(`🔗 Link: ${link}`);

                // Get current ID from link
                const currentId = linkToCurrentId.get(link);
                if (!currentId) {
                    console.log(`⚠️  No current ID found for link: ${link}`);
                    errors++;
                    continue;
                }
                console.log(`🆔 Current ID: ${currentId}`);
                mapped++;

                // Read HTML file
                const htmlContent = fs.readFileSync(path.join(folderPath, file), 'utf8');

                // Extract description from HTML
                const description = extractRemarksFromHtml(htmlContent);

                if (description) {
                    console.log(`📝 Extracted description (${description.length} characters)`);
                    console.log(`   Preview: ${description.substring(0, 100)}...`);

                    // Update database record using the current ID
                    try {
                        const result = await Estate.findByIdAndUpdate(
                            currentId,
                            { description: description }
                        );

                        if (result) {
                            console.log(`✅ Successfully updated record: ${currentId}`);
                            updated++;
                        } else {
                            console.log(`⚠️  Record not found: ${currentId}`);
                        }

                    } catch (dbError) {
                        console.error(`❌ Database error updating record ${currentId}:`, dbError.message);
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
        console.log(`   ID mappings found: ${mapped}`);
        console.log(`   Records updated: ${updated}`);
        console.log(`   Errors: ${errors}`);

        return { processed, mapped, updated, errors };

    } catch (error) {
        console.error('❌ Error in processHtmlFilesWithIdMapping:', error.message);
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
    processAllItemsForTags,
    processHtmlFilesWithIdMapping
};



(async () => {
    // await processHtmlFilesFromFolder('./src/scrapping_zillow/zillow_scrapping');
    // await getDetailUrls();

    // Process HTML files and update descriptions directly
    // console.log('🔄 Processing HTML files and updating descriptions...');
    // await processHtmlFilesAndUpdateDescriptions('./src/scrapping_zillow/zillow_scrapping_descriptions');
    // await processHtmlFilesWithIdMapping('./src/scrapping_zillow/zillow_scrapping_descriptions', 
        // './src/scrapping_zillow/detail_urls_origin.json', './src/scrapping_zillow/detail_urls.json');

    // Uncomment the line below to process all items for tags
    await processAllItemsForTags();
})();

