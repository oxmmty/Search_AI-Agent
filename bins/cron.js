const cron = require("node-cron");
const { scrapeRedfin } = require("../src/scrapping/scrape_redfin");

// cron.schedule("30 4 * * 4", () => {
  console.log("Running scrapping real estates websites");
  scrapeRedfin().then(() => {
    console.log('cron was over');
  }).catch((err) => {
    console.error(err);
  });
// }, {
//   timezone: "America/New_York",
// });
