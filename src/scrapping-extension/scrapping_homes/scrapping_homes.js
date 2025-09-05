require('../database');

const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const Estate = require('./estate_homes');
const { joinUrl, cleanNum, tagListing, processSourcesToTags } = require('../common');

const BASE_URL = "https://www.homes.com";

function parseCard($, card) {
    const c = $(card);
    const linkHref =
        c.find('.embla__container a[href]').first().attr('href') ||
        c.find('.for-sale-content-container a[href]').first().attr('href') ||
        '';
    const link = joinUrl(BASE_URL, linkHref);

    // ---- IMAGE ----
    // Images can be lazy: prefer data-image or data-defer-src; avoid spacer gifs.
    const img = c.find('.embla__slide__img.image-container, .image-container, img').first();
    let image_url =
        img.attr('data-image') ||
        img.attr('data-defer-src') ||
        img.attr('data-src') ||
        img.attr('src') ||
        null;
    if (image_url && /\/assets\/images\/spacer\.gif$/i.test(image_url)) {
        // spacer; try another attribute on the same element or next slide
        const altSrc =
            img.attr('data-image') ||
            img.attr('data-defer-src') ||
            null;
        image_url = altSrc || null;
    }
    if (image_url) image_url = joinUrl(BASE_URL, image_url);

    // ---- PRICE ----
    const priceText = (c.find('.for-sale-content-container .price-container').first().text() || '').trim() || null;
    const price = cleanNum(priceText);

    // ---- STATS (beds, baths, sqft) ----
    let beds = null, baths = null, sqft = null;
    c.find('.for-sale-content-container .detailed-info-container li').each((_, li) => {
        const t = ($(li).text() || '').trim();
        if (!t) return;

        const num = cleanNum(t); // your helper: should parse "3 Beds" -> 3, "2,256 Sq Ft" -> 2256
        const lower = t.toLowerCase();

        if (beds == null && /bed/.test(lower)) beds = num ?? beds;
        else if (baths == null && /bath/.test(lower)) baths = num ?? baths;
        else if (sqft == null && /(sq\.?\s*ft|sqft|square\s*feet)/.test(lower)) sqft = num ?? sqft;
    });

    // ---- ADDRESS ----
    const address =
        (c.find('.for-sale-content-container .property-name').first().text() || '').trim() ||
        (c.find('.for-sale-content-container a address').first().text() || '').trim() ||
        (c.find('.embla__container a[aria-label]').first().attr('aria-label') || '').trim() ||
        null;

    // ---- DESCRIPTION ----
    // Prefer property-description; else combine all non-agent text under description-container.
    let description = null;
    const descBlock = c.find('.for-sale-content-container .description-container').first();

    if (descBlock.length) {
        const primary = descBlock.find('.property-description').toArray().map(p => $(p).text().trim()).filter(Boolean);
        if (primary.length) {
            description = primary.join(' ');
        } else {
            // include paragraphs except agent details
            const ps = descBlock.find('p:not(.agent-detail)').toArray().map(p => $(p).text().trim()).filter(Boolean);
            if (ps.length) description = ps.join(' ');
        }
    }

    if (!description) {
        // last-resort fallbacks (avoid agent detail)
        description =
            (c.find('.property-description').first().text() || '').trim() ||
            (c.find('[aria-label]').first().attr('aria-label') || '').trim() ||
            null;
    }

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
    const cards = $(".placards-list .placard-container");

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
        '#ldp-description-text',
        '.ldp-description-text',
        '.ldp-description-text-container',
        '.about-this-home',
        '.remarksContainer',
        "[data-rf-test-id='listingRemarks']",
        '.marketingRemarks'
    ];

    for (const sel of selectors) {
        const text = grab(sel);
        if (text) return text;
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
                            { new: true }
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
                // if (item.description && item.description.trim()) {
                //     console.log(`  📝 Processing description for tags...`);
                //     taggedItem = await tagListing(item);
                // } else {
                    // console.log(`  ⚠️  No description found, skipping description tags`);
                    taggedItem = { ...item, damage_tags: [], saletype_tags: [], recommendation: "No description." };
                // }

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
    processHtmlFilesAndUpdateDescriptions,
    extractRemarksFromHtml,
    processAllItemsForTags
};



(async () => {
    // await processHtmlFilesFromFolder('./src/scrapping_homes/homes_scrapping');
    // await getDetailUrls();
    // await processHtmlFilesAndUpdateDescriptions('./src/scrapping_homes/homes_scrapping_descriptions');
    await processAllItemsForTags();
})();

