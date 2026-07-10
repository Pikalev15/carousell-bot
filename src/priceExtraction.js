import { parseMoney } from "./currency.js";

const MONEY_PATTERN = /(?:S\$|SGD|US\$|USD|\$)\s?[\d,]+(?:\.\d+)?/i;
const NEGATIVE_PRICE_CONTEXT = /\b(?:deliver|delivery|shipping|ship|shipped|courier|postage|mailing|additional|add(?:ed)?\s?on|add-on|top\s?up|top-up|deposit|reservation|reserve|downpayment|down payment|installment|instalment|monthly|per month|voucher|coupon|discount|cashback|rebate|off|save|saved|saving|warranty|repair|service fee|labou?r|diagnostic|cleaning|upgrade service|delivery fee|shipping fee|platform fee)\b|%/i;
const STRONG_SELLING_CONTEXT = /\b(?:real|actual|selling|sell(?:ing)?\s?price|letting go|letgo|take(?: all)?|deal(?: price)?|asking|ask|price|priced|nett|net|firm|fixed|nego|negotiable|self collect(?:ion)?|pickup|pick up|meet(?:up|-up)?)\b/i;

export function extractLikelySellingPriceFromText(value) {
  const lines = String(value || "")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 80);

  for (const line of lines) {
    const price = extractPriceFromCandidate(line);
    if (price) return price;
  }

  const compact = lines.join("\n");
  for (const match of compact.matchAll(new RegExp(MONEY_PATTERN.source, "gi"))) {
    const context = compact.slice(Math.max(0, match.index - 70), match.index + match[0].length + 70);
    if (!STRONG_SELLING_CONTEXT.test(context)) continue;
    if (NEGATIVE_PRICE_CONTEXT.test(context)) continue;
    const price = parsePrice(match[0], context);
    if (price) return price;
  }

  return 0;
}

function extractPriceFromCandidate(line) {
  if (!MONEY_PATTERN.test(line)) return 0;
  if (NEGATIVE_PRICE_CONTEXT.test(line)) return 0;
  if (!STRONG_SELLING_CONTEXT.test(line)) return 0;

  const match = line.match(MONEY_PATTERN);
  if (!match) return 0;
  return parsePrice(match[0], line);
}

function parsePrice(raw, context = "") {
  const money = parseMoney(raw, { defaultCurrency: /\b(?:usd|us\$)\b/i.test(context) ? "USD" : "SGD" });
  const sgdPrice = money?.sgd;
  if (sgdPrice) {
    const price = Math.round(Number(sgdPrice));
    if (price > 1 && price < 100000) return price;
  }
  const cleanNum = raw.replace(/[^0-9.]/g, "");
  const price = Math.round(Number(cleanNum || 0));
  return price > 1 && price < 100000 ? price : 0;
}
