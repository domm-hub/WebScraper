const FirecrawlApp = require("firecrawl").default || require("firecrawl");
const cheerio = require("cheerio");

const VERCEL_APP_URL = process.env.VERCEL_APP_URL;
const SCRAPER_SECRET = process.env.SCRAPER_SECRET;
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || "";
const TOR_PROXY_HTTP = process.env.TOR_PROXY_HTTP || "";

function enableHttpProxy() {
  if (!TOR_PROXY_HTTP) {
    return;
  }
  try {
    const http = require("http");
    const https = require("https");
    const { HttpProxyAgent } = require("http-proxy-agent");
    const { HttpsProxyAgent } = require("https-proxy-agent");

    const httpAgent = new HttpProxyAgent(TOR_PROXY_HTTP);
    const httpsAgent = new HttpsProxyAgent(TOR_PROXY_HTTP);

    const origHttpRequest = http.request;
    const origHttpsRequest = https.request;

    http.request = function (options, ...rest) {
      if (options && typeof options === "object") {
        const hostname = options.hostname || options.host || options.address;
        if (!options.agent && hostname && !isPrivateAddress(hostname)) {
          options.agent = httpAgent;
        }
      }
      return origHttpRequest.call(this, options, ...rest);
    };

    https.request = function (options, ...rest) {
      if (options && typeof options === "object") {
        const hostname = options.hostname || options.host;
        if (!options.agent && hostname && !isPrivateAddress(hostname)) {
          options.agent = httpsAgent;
        }
      }
      return origHttpsRequest.call(this, options, ...rest);
    };

    log("INFO", `HTTP proxy routing enabled via ${TOR_PROXY_HTTP}.`);
  } catch (err) {
    log("WARN", `Could not enable HTTP proxy: ${err.message}`);
  }
}

function isPrivateAddress(host) {
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host.startsWith("192.168.") ||
    host.startsWith("10.") ||
    host.startsWith("172.")
  );
}

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

async function triggerDigest() {
  log("INFO", "Triggering daily digest check...");
  try {
    const response = await fetch(`${VERCEL_APP_URL}/api/digest`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SCRAPER_SECRET}`,
        "Content-Type": "application/json",
      },
    });
    const body = await response.json();
    log("INFO", `Digest response: ${JSON.stringify(body)}`);
  } catch (err) {
    log("WARN", `Digest trigger failed: ${err.message}`);
  }
}

async function triggerPrune() {
  log("INFO", "Triggering history prune check...");
  try {
    const response = await fetch(`${VERCEL_APP_URL}/api/prune`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SCRAPER_SECRET}`,
        "Content-Type": "application/json",
      },
    });
    const body = await response.json();
    log("INFO", `Prune response: ${JSON.stringify(body)}`);
  } catch (err) {
    log("WARN", `Prune trigger failed: ${err.message}`);
  }
}

const SIMILAR_REFRESH_MS = 6 * 60 * 60 * 1000;

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "for", "with", "from", "that", "this",
  "you", "your", "new", "all", "in", "on", "of", "to", "egp", "edition",
]);

function buildSearchQuery(product) {
  const title = (product.last_title || "").trim();
  if (title) {
    const words = title
      .replace(/[^A-Za-z0-9\s]/g, " ")
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w.toLowerCase()))
      .slice(0, 5)
      .join(" ");
    if (words) {
      return words;
    }
  }
  return product.asin;
}

function needsSimilarRefresh(product) {
  if (!product.similar_fetched_at) {
    return true;
  }
  const fetchedAt = Date.parse(product.similar_fetched_at);
  if (isNaN(fetchedAt)) {
    return true;
  }
  return Date.now() - fetchedAt > SIMILAR_REFRESH_MS;
}

async function scrapeSimilarResults(firecrawl, product) {
  const query = buildSearchQuery(product);
  const url = `https://www.amazon.eg/s?k=${encodeURIComponent(query)}`;
  log("INFO", `Scraping similar results for ${product.asin}: ${url}`);

  let result;
  try {
    result = await firecrawl.scrape(url, { formats: ["html"] });
  } catch (err) {
    log("ERROR", `Similar search failed for ${product.asin}: ${err.message}`);
    return [];
  }

  if (!result || !result.html) {
    log("WARN", `No HTML for similar search of ${product.asin}.`);
    return [];
  }

  const $ = cheerio.load(result.html);
  if (hasCaptcha($)) {
    log("WARN", `CAPTCHA on similar search for ${product.asin}.`);
    return [];
  }

  const found = [];
  $(".s-main-slot [data-asin]").each((i, el) => {
    if (found.length >= 4) {
      return false;
    }
    const $el = $(el);
    if ($el.attr("data-component-type") !== "s-search-result") {
      return;
    }
    const asin = ($el.attr("data-asin") || "").trim();
    if (!/^[A-Z0-9]{10}$/.test(asin)) {
      return;
    }
    if (asin === product.asin || found.some((f) => f.asin === asin)) {
      return;
    }

    const itemText = $el.text().toLowerCase();
    if (
      itemText.includes("currently unavailable") ||
      itemText.includes("temporarily out of stock") ||
      itemText.includes("out of stock")
    ) {
      return;
    }

    const title = $el
      .find("h2")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();
    if (!title) {
      return;
    }

    const whole = $el
      .find(".a-price-whole")
      .first()
      .text()
      .replace(/[^0-9]/g, "");
    const fraction = $el
      .find(".a-price-fraction")
      .first()
      .text()
      .replace(/[^0-9]/g, "");
    let price = null;
    if (whole) {
      price = parseFloat(`${whole}.${fraction || "00"}`);
    }

    found.push({
      asin,
      title: title.slice(0, 80),
      price,
    });
  });

  log(
    "INFO",
    `Similar result count for ${product.asin}: ${found.length}`
  );
  return found;
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
      ok: false,
      captcha_hit: true,
    };
  }

  const html = result.html;
  const $ = cheerio.load(html);

  if (hasCaptcha($)) {
    log("WARN", `CAPTCHA detected for ASIN: ${product.asin}. Skipping.`);
    return {
      asin: product.asin,
      ok: false,
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
    ok: true,
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

  enableHttpProxy();

  const firecrawl = FIRECRAWL_API_KEY
    ? new FirecrawlApp({ apiKey: FIRECRAWL_API_KEY })
    : new FirecrawlApp();
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

      if (!result.ok) {
        log(
          "WARN",
          `No usable data for ASIN ${product.asin}; keeping last known state.`
        );
        continue;
      }

      const updatePayload = {
        asin: result.asin,
        price: result.price,
        is_available: result.is_available,
        title: result.title,
        captcha_hit: result.captcha_hit,
      };

      if (
        result.is_available === false &&
        !result.captcha_hit &&
        result.title &&
        needsSimilarRefresh(product)
      ) {
        const similar = await scrapeSimilarResults(firecrawl, {
          asin: product.asin,
          last_title: result.title || product.last_title,
        });
        if (similar.length > 0) {
          updatePayload.similar_products = similar;
          updatePayload.similar_fetched_at = new Date().toISOString();
        }
      }

      await postUpdate(updatePayload);
    } catch (err) {
      log(
        "ERROR",
        `Error processing ASIN ${product.asin}: ${err.message}`
      );
      results.push({
        asin: product.asin,
        ok: false,
        error: err.message,
      });
    }

    if (i < products.length - 1) {
      const delay = randomDelay();
      log("INFO", `Waiting ${delay}ms before next product...`);
      await sleep(delay);
    }
  }

  log("INFO", `=== Scraper run complete. Processed ${results.length} product(s). ===`);

  if (results.length > 0) {
    await triggerDigest();
    await triggerPrune();
  }
}

(async () => {
  try {
    await runScraper();
  } catch (err) {
    log("ERROR", `Fatal scraper error: ${err.message}`);
    process.exit(1);
  }
})();