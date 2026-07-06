export const USD_TO_SGD = 1.35;

export function convertToSgd(amount, currency = "SGD") {
  const value = Number(amount || 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(currency.toUpperCase() === "USD" ? value * USD_TO_SGD : value);
}

export function parseMoney(value, options = {}) {
  const text = String(value || "");
  const patterns = [
    { currency: "USD", pattern: /(?:US\$|USD)\s?([\d,]+(?:\.\d+)?)/i },
    { currency: "SGD", pattern: /(?:S\$|SGD)\s?([\d,]+(?:\.\d+)?)/i },
    { currency: options.defaultCurrency || "SGD", pattern: /(?:^|[^\w])\$\s?([\d,]+(?:\.\d+)?)/i }
  ];

  for (const { currency, pattern } of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const amount = Number(match[1].replaceAll(",", ""));
    if (!Number.isFinite(amount)) continue;
    return {
      amount: Math.round(amount),
      currency,
      sgd: convertToSgd(amount, currency)
    };
  }

  return { amount: 0, currency: "", sgd: 0 };
}
