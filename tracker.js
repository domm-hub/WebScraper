const FirecrawlApp = require("firecrawl").default || require("firecrawl");
const cheerio = require("cheerio");

const VERCEL_APP_URL = process.env.VERCEL_APP_URL;
const SCRAPER_SECRET = process.env.SCRAPER_SECRET;

function log(level, message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
  return Math.floor(Math.random() * 3000) + 3000;
}

async function fetchTrackingJobs() {
  log("INFO", "Fetching tracking jobs from backend...");
  const response = await fetch(`${VERCEL_APP_URL}/api/products`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${SCRAPER_SECRET}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to fetch products: HTTP ${response.status} - ${body}`
    );
  }

  const products = await response.json();
  log("INFO", `Retrieved ${products.length} product(s) to track.`);
  return products;
}

async function postUpdate(payload) {
  log("INFO", `Posting update for ASIN: ${payload.asin}`);
  const response = await fetch(`${VERCEL_APP_URL}/api/update`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SCRAPER_SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    log("ERROR", `Update POST failed: HTTP ${response.status} - ${body}`);
    return false;
  }

  log("INFO", `Update accepted for ASIN: ${payload.asin}`);
  return true;
}

function hasCaptcha($) {
  return $('input[id="captchacharacters"]').length > 0;
}

function extractPrice($) {
  const wholeTag = $(".a-price-whole").first();
  const fracTag = $(".a-price-fraction").first();

  if (wholeTag.length === 0) {
    return null;
  }

  const whole = (wholeTag.contents().first().text() || wholeTag.text()).replace(
    /[^0-9]/g,
    ""
  );
  const fraction = fracTag.length
    ? fracTag.text().replace(/[^0-9]/g, "")
    : "00";

  if (!whole) {
    return null;
  }

  return parseFloat(`${whole}.${fraction}`);
}

function extractAvailability($) {
  if ($("#outOfStock").length > 0) {
    return false;
  }

  const availabilityEl = $("#availability");
  if (availabilityEl.length > 0) {
    const text = availabilityEl.text().toLowerCase();
    if (
      text.includes("currently unavailable") ||
      text.includes("out of stock") ||
      text.includes("temporarily out of stock")
    ) {
      return false;
    }
    if (text.includes("in stock") || text.includes("left in stock")) {
      return true;
    }
  }

  return true;
}

function extractTitle($) {
  const el = $("#productTitle");
  return el.length ? el.text().trim() : null;
}

async function scrapeProduct(firecrawl, product) {
  const url = product.url;
  log("INFO", `Scraping via Firecrawl: ${url}`);

  let result;
  try {
    result = await firecrawl.scrape(url, { formats: ["html"] });
  } catch (err) {
    log("ERROR", `Firecrawl request failed for ASIN ${product.asin}: ${err.message}`);
    throw err;
  }

  if (!result || (!result.html && !result.success)) {
    log(
      "WARN",
      `No usable HTML for ASIN ${product.asin}. Error: ${
        result && result.error ? result.error : "unknown"
      }`
    );
    return {
      asin: product.asin,
      price: null,
      is_available: null,
      title: null,
      captcha_hit: false,
    };
  }

  const html = result.html;
  const $ = cheerio.load(html);

  if (hasCaptcha($)) {
    log("WARN", `CAPTCHA detected for ASIN: ${product.asin}. Skipping.`);
    return {
      asin: product.asin,
      price: null,
      is_available: false,
      title: null,
      captcha_hit: true,
    };
  }

  const is_available = extractAvailability($);
  log(
    "INFO",
    `ASIN ${product.asin} availability: ${is_available ? "IN STOCK" : "OUT OF STOCK"}`
  );

  let price = null;
  if (is_available) {
    price = extractPrice($);
    log(
      "INFO",
      price !== null
        ? `ASIN ${product.asin} extracted price: $${price}`
        : `No price element found for ASIN: ${product.asin}`
    );
  }

  const title = extractTitle($);

  return {
    asin: product.asin,
    price,
    is_available,
    title,
    captcha_hit: false,
  };
}

async function runScraper() {
  log("INFO", "=== Scraper run starting ===");

  if (!VERCEL_APP_URL || !SCRAPER_SECRET) {
    log("ERROR", "Missing VERCEL_APP_URL or SCRAPER_SECRET env vars. Aborting.");
    process.exit(1);
  }

  let products;
  try {
    products = await fetchTrackingJobs();
  } catch (err) {
    log("ERROR", `Could not fetch tracking jobs: ${err.message}`);
    process.exit(1);
  }

  if (!products || products.length === 0) {
    log("INFO", "No products to track. Exiting.");
    return;
  }

  const firecrawl = new FirecrawlApp();
  const results = [];

  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    log(
      "INFO",
      `Processing [${i + 1}/${products.length}]: ${product.asin}`
    );

    try {
      const result = await scrapeProduct(firecrawl, product);
      results.push(result);

      await postUpdate({
        asin: result.asin,
        price: result.price,
        is_available: result.is_available,
        title: result.title,
        captcha_hit: result.captcha_hit,
      });
    } catch (err) {
      log(
        "ERROR",
        `Error scraping ASIN ${product.asin}: ${err.message}`
      );
      results.push({
        asin: product.asin,
        price: null,
        is_available: false,
        title: null,
        captcha_hit: false,
        error: err.message,
      });

      await postUpdate({
        asin: product.asin,
        price: null,
        is_available: false,
        title: null,
        captcha_hit: false,
      }).catch((postErr) => {
        log("ERROR", `Failed to post error update: ${postErr.message}`);
      });
    }

    if (i < products.length - 1) {
      const delay = randomDelay();
      log("INFO", `Waiting ${delay}ms before next product...`);
      await sleep(delay);
    }
  }

  log("INFO", `=== Scraper run complete. Processed ${results.length} product(s). ===`);
}

(async () => {
  try {
    await runScraper();
  } catch (err) {
    log("ERROR", `Fatal scraper error: ${err.message}`);
    process.exit(1);
  }
})();