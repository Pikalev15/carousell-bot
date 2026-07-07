import { parseMoney } from "./currency.js";

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  process.env.GOOGLE_CHROME_BIN,
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/opt/google/chrome/chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
].filter(Boolean);

const BLOCKED_PRICE_CONTEXT = /\b(?:carousell|used|second hand|preowned|pre-owned|deposit|delivery|shipping|coupon|monthly|installment)\b/i;

export async function lookupMsrpFromGoogle(title, options = {}) {
  const query = buildMsrpQuery(title);
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en-SG&gl=sg`;
  const { page, browser } = await newBrowserPage(options);

  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    const data = await page.evaluate(() => {
      const bodyText = document.body.innerText || "";
      const links = [...document.querySelectorAll("a")]
        .map((anchor) => ({
          text: anchor.textContent?.trim() || "",
          href: anchor.href || ""
        }))
        .filter((link) => link.text && /^https?:\/\//i.test(link.href));
      return { bodyText, links };
    });
    const estimate = estimateMsrp(data.bodyText, data.links);
    return {
      title,
      query,
      url: searchUrl,
      msrp: estimate.msrp,
      currency: "SGD",
      source: estimate.source,
      evidence: estimate.evidence,
      candidates: estimate.candidates
    };
  } finally {
    await browser.close();
  }
}

export function estimateMsrp(bodyText, links = []) {
  const candidates = extractPriceCandidates(bodyText);
  const clean = candidates.filter((candidate) => !BLOCKED_PRICE_CONTEXT.test(candidate.context));
  const usable = clean.length ? clean : candidates;
  const prices = usable.map((candidate) => candidate.sgd).filter((price) => price >= 5 && price < 20000).sort((a, b) => a - b);
  const msrp = prices.length ? Math.round(prices[Math.floor(prices.length / 2)]) : 0;
  const sourceLink = links.find((link) => !/google|carousell/i.test(link.href)) || links.find((link) => !/google/i.test(link.href));
  const evidence = usable.find((candidate) => candidate.sgd === msrp) || usable[0] || null;
  return {
    msrp,
    source: sourceLink?.href || "Google search",
    evidence: evidence?.context || "",
    candidates: usable.slice(0, 8)
  };
}

function extractPriceCandidates(text) {
  const source = String(text || "");
  const pattern = /(?:S\$|SGD|US\$|USD|\$)\s?[\d,]+(?:\.\d+)?/gi;
  const candidates = [];
  let match;
  while ((match = pattern.exec(source))) {
    const context = source.slice(Math.max(0, match.index - 80), match.index + match[0].length + 80).replace(/\s+/g, " ").trim();
    const money = parseMoney(match[0], { defaultCurrency: /\b(?:usd|us\$)\b/i.test(context) ? "USD" : "SGD" });
    if (!money.sgd) continue;
    candidates.push({
      raw: match[0],
      currency: money.currency,
      amount: money.amount,
      sgd: money.sgd,
      context
    });
  }
  return candidates;
}

function buildMsrpQuery(title) {
  return `${String(title || "").replace(/\s+/g, " ").trim()} MSRP price Singapore`;
}

async function newBrowserPage(options = {}) {
  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    throw new Error("playwright-core is not installed. Run npm.cmd install.");
  }

  const executablePath = options.executablePath || (await findChromePath());
  if (!executablePath) throw new Error("Chrome or Chromium was not found. Install Google Chrome in the Linux environment or set CHROME_PATH to your Chrome executable.");

  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"]
  });
  const page = await browser.newPage({
    locale: "en-SG",
    timezoneId: "Asia/Singapore",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
  });
  return { browser, page };
}

async function findChromePath() {
  const { access } = await import("node:fs/promises");
  for (const candidate of CHROME_PATHS) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known browser path.
    }
  }
  return "";
}
