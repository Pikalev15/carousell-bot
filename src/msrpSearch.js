import { parseMoney } from "./currency.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
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

async function newBrowserPage() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error("playwright is not installed. Run npm install.");
  }

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"]
  });
  const page = await browser.newPage({
    locale: "en-SG",
    timezoneId: "Asia/Singapore",
    userAgent: USER_AGENT
  });
  return { browser, page };
}
