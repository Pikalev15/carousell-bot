import { parseMoney } from "./currency.js";

const MONEY_PATTERN = /(?:S\$|SGD|US\$|USD|\$)\s?[\d,]+(?:\.\d+)?/i;
const NEGATIVE_PRICE_CONTEXT = /\b(?:deliver|delivery|shipping|ship|shipped|courier|postage|mailing|lalamove|grabexpress|ninja van|qxpress|additional|add(?:ed)?\s?on|add-on|surcharge|top\s?up|top-up|deposit|reservation|reserve|downpayment|down payment|installment|instalment|monthly|per month|voucher|coupon|discount|cashback|rebate|off|save|saved|saving|warranty|repair|service fee|labou?r|diagnostic|cleaning|upgrade service|delivery fee|shipping fee|platform fee)\b|%/i;
const STRONG_SELLING_CONTEXT = /\b(?:real|actual|selling|sell(?:ing)?\s?price|letting go|letgo|take(?: all)?|deal(?: price)?|asking|ask|listing price|item price|price|priced|nett|net|firm|fixed|nego|negotiable|self collect(?:ion)?|pickup|pick up|meet(?:up|-up)?)\b/i;
const SURCHARGE_PREFIX = /\+\s*(?:S\$|SGD|US\$|USD|\$)\s?[\d,]+(?:\.\d+)?/i;

export function extractLikelySellingPriceFromText(value) {
  const lines = String(value || "")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 120);

  const candidates = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const match of line.matchAll(new RegExp(MONEY_PATTERN.source, "gi"))) {
      const before = line.slice(Math.max(0, match.index - 3), match.index);
      const neighborhood = [lines[index - 1], line, lines[index + 1]].filter(Boolean).join(" ");
      const candidate = buildCandidate(match[0], line, neighborhood, before);
      if (candidate) candidates.push(candidate);
    }
  }

  if (!candidates.length) return 0;
  candidates.sort((a, b) => b.confidence - a.confidence || b.price - a.price);
  return candidates[0].price;
}

function buildCandidate(raw, line, neighborhood, before = "") {
  if (/\+\s*$/.test(before) || SURCHARGE_PREFIX.test(line)) return null;
  if (NEGATIVE_PRICE_CONTEXT.test(line)) return null;

  const strongOnLine = STRONG_SELLING_CONTEXT.test(line);
  const strongNearby = STRONG_SELLING_CONTEXT.test(neighborhood);
  if (!strongOnLine && !strongNearby) return null;

  const price = parsePrice(raw, neighborhood);
  if (!price) return null;

  let confidence = strongOnLine ? 80 : 55;
  if (/\b(?:listing price|item price|actual price|selling price|asking price)\b/i.test(neighborhood)) confidence += 25;
  if (/\b(?:fixed|firm|nett|net)\b/i.test(neighborhood)) confidence += 10;
  if (/^\s*(?:S\$|SGD|US\$|USD|\$)/i.test(line)) confidence += 5;
  if (NEGATIVE_PRICE_CONTEXT.test(neighborhood)) confidence -= 35;

  return { price, confidence };
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
