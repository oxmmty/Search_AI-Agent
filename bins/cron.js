const cron = require("node-cron");
const { scrapeRedfin } = require("../src/scrapping/scrape_redfin");
const { scrapeTrulia } = require("../src/scrapping/scrape_trulia");
const { scrapeHomes } = require("../src/scrapping/scrape_homes");
const { scrapeRemax } = require("../src/scrapping/scrape_remax");
const { scrapeColdwellbankerhomes } = require("../src/scrapping/scrape_coldwellbankerhomes");
const { scrapeMovoto } = require("../src/scrapping/scrape_movoto");
const { scrapeZillow } = require("../src/scrapping/scrape_zillow");
const Estate = require("../src/models/estate");

// cron.schedule("0 0 * * *", () => {

  console.log("Running scrapping real estates websites");

  Promise.all([
    scrapeZillow().then(() => console.log('scraping zillow has finished')),
    // scrapeMovoto().then(() => console.log('scraping movoto has finished')),
    // scrapeColdwellbankerhomes().then(() => console.log('scraping Coldwellbankerhomes has finished')),
    // scrapeRemax().then(() => console.log('scraping Remax has finished')),
    // scrapeHomes().then(() => console.log('scraping Homes has finished')),
    // scrapeTrulia().then(() => console.log('scraping Trulia has finished')),
    // scrapeRedfin().then(() => console.log('scraping Redfin has finished'))
  ]).then(results => {
    console.log('All scraping jobs settled.');

    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
    Estate.deleteMany({ createdAt: { $lt: twelveHoursAgo } }).catch(e => console.log(e));
  }).catch(e => console.log(e));
// }, {
//   timezone: "America/New_York",
// });
