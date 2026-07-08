export const REFINED_RATINGS = [
  "great_deal",
  "good_deal",
  "fair_deal",
  "bad_deal",
  "overpriced",
  "duplicate_listing",
  "bundle_mixed",
  "accessory_only",
  "wrong_category",
  "irrelevant",
  "wtb_service",
  "skip",
  "spam",
  "bad_pricer",
  "bought",
  "not_spam",
  "unmarked"
];

const WTB_SERVICE_PATTERN = /\b(?:wtb|want to buy|looking to buy|looking for|buy back|buyback|cashout|trade in|we buy|i buy|purchase all|selling your|send me what you have|fast offer|best rates)\b/i;
const SERVICE_PATTERN = /\b(?:repair|service|servicing|diagnostic|diagnostics|upgrade service|cleaning service|data recovery|installation|custom build service|quote only|enquire|pm for quote)\b/i;
const ACCESSORY_PATTERN = /\b(?:front panel|side panel|glass panel|wood panel|panel only|riser|vertical gpu kit|bracket|mount|adapter|cable|screws?|dust filter|mesh kit|cover|tray|extension|upgrade kit)\b/i;
const ACCESSORY_ONLY_PATTERN = /\b(?:only|not\s+(?:the\s+)?full|add-?on|accessor(?:y|ies))\b/i;
const BUNDLE_PATTERN = /\b(?:bundle|combo|whole set|all at once|mixed parts|parts lot|assorted|bunch of|take all|pc parts)\b/i;
const SCHOOL_BOOK_PATTERN = /\b(?:grade\s?\d|textbook|workbook|assessment book|english|mathematics|math|computer science subject|kkis|tuition|worksheet)\b/i;
const COLLECTIBLE_PATTERN = /\b(?:rare collectibles?|vintage|retro|showpiece|decorative display|movie props?|studio exhibit|teaching tools?|training aids?|no power cable|working status unknown)\b/i;
const BROKEN_PATTERN = /\b(?:faulty|spoilt|not working|for parts|no hard\s?drive|no hdd|no battery|cracked|broken|unable to test|as-is|own risk)\b/i;
const FULL_PC_PATTERN = /\b(?:full build|custom pc|gaming pc|desktop pc|prebuilt|pre-built|workstation|plug and play|windows 11 ready)\b/i;

const CATEGORY_RULES = [
  ["pc case accessory", /\b(?:panel only|vertical gpu kit|riser|bracket|mount|dust filter|mesh kit)\b|\b(?:front panel|side panel|glass panel|wood panel)\b.{0,60}\bonly\b|\bonly\b.{0,60}\b(?:front panel|side panel|glass panel|wood panel)\b/i],
  ["pc case", /\b(?:dan\s?a3|a3-?matx|a4-?h2o|o11|nr200|terra|jonsbo|d31|d32|d33|d41|fractal|phanteks|xt\s?m3|lian li|case|chassis|casing|m-?atx case|matx case|itx case|sff case)\b/i],
  ["graphics card", /\b(?:rtx|gtx|radeon|rx\s?\d{3,4}|graphics card|gpu\b|geforce|arc\s?[ab]\d{3})\b/i],
  ["processor", /\b(?:ryzen|intel core|core i[3579]|processor|cpu\b|9800x3d|7800x3d|5600x|12400f|14600k)\b/i],
  ["motherboard", /\b(?:motherboard|mobo|b450|b550|b650|x570|x670|a520|a620|z690|z790|h610|h670|am4|am5|lga\s?\d{4})\b/i],
  ["memory", /\b(?:ram|ddr3|ddr4|ddr5|sodimm|so-dimm|memory stick|dimm)\b/i],
  ["storage", /\b(?:ssd|nvme|m\.2|hdd|hard drive|sata|storage|mx500|870 evo)\b/i],
  ["power supply", /\b(?:psu|power supply|sfx|atx\s?3\.0|atx\s?3\.1|\d{3,4}\s?w\b|gold rated|bronze rated|platinum rated)\b/i],
  ["pc cooling", /\b(?:aio|cooler|heatsink|radiator|case fan|rgb fan|reverse fan|reverse blade|sl120|tl120|120mm|140mm|d30|uni fan)\b/i],
  ["laptop", /\b(?:laptop|notebook|macbook|thinkpad|chromebook|latitude|inspiron|satellite)\b/i],
  ["keyboard", /\b(?:keyboard|keycap|switches|monsgeek|wooting|aula|epomaker)\b/i],
  ["monitor", /\b(?:monitor|ultrawide|display|screen)\b/i],
  ["phone", /\b(?:iphone|samsung galaxy|pixel|mobile phone)\b/i]
];

export function normalizeRefinedRating(rating) {
  const value = String(rating || "").trim().toLowerCase();
  if (value === "good") return "good_deal";
  if (value === "skip") return "irrelevant";
  return REFINED_RATINGS.includes(value) ? value : "";
}

export function inferPreciseCategory(input = {}, fallback = "") {
  const text = typeof input === "string" ? input : listingText(input);
  if (WTB_SERVICE_PATTERN.test(text) || SERVICE_PATTERN.test(text)) return "service/wtb";
  if (SCHOOL_BOOK_PATTERN.test(text)) return "irrelevant";
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(text)) return category;
  }
  return fallback || "general";
}

export function analyzeListingRelevance(listing = {}, query = "") {
  const text = listingText(listing);
  const title = String(listing.title || "").toLowerCase();
  const queryText = String(query || listing.query || "").toLowerCase();
  const category = inferPreciseCategory(listing, listing.category || "general");
  const reasons = [];
  const flags = [];
  let score = 72;
  let type = "standard_listing";

  if (WTB_SERVICE_PATTERN.test(text) || SERVICE_PATTERN.test(text)) {
    score -= 55;
    type = "wtb_or_service";
    flags.push("wtb_or_service");
    reasons.push("Looks like WTB/buyback/service, not a normal selling post");
  }

  if (SCHOOL_BOOK_PATTERN.test(text)) {
    score -= 60;
    type = "irrelevant";
    flags.push("irrelevant_school_book");
    reasons.push("Looks like a school/book listing, not PC hardware");
  }

  if (COLLECTIBLE_PATTERN.test(text)) {
    score -= 32;
    flags.push("collectible_or_display_item");
    reasons.push("Retro/collectible/display wording lowers hardware relevance");
  }

  if (BROKEN_PATTERN.test(text)) {
    score -= 25;
    flags.push("faulty_or_for_parts");
    reasons.push("Faulty/for-parts wording needs manual checking");
  }

  if (ACCESSORY_PATTERN.test(text)) {
    score -= ACCESSORY_ONLY_PATTERN.test(text) ? 30 : 18;
    type = "accessory_only";
    flags.push("accessory_only");
    reasons.push("Accessory or add-on part, not a full component");
  }

  if (BUNDLE_PATTERN.test(text)) {
    score -= 12;
    type = type === "standard_listing" ? "bundle_or_mixed_parts" : type;
    flags.push("bundle_or_mixed_parts");
    reasons.push("Bundle/mixed-parts listing should not share medians with one component");
  }

  if (FULL_PC_PATTERN.test(text) && /\b(?:case|fan|ram|ssd|motherboard|gpu|cpu|computer parts)\b/i.test(queryText)) {
    score -= 22;
    flags.push("full_build_when_part_search");
    reasons.push("Full PC ad appearing in a parts search");
  }

  if (queryText) {
    const queryTokens = queryText.match(/[a-z0-9]{3,}/g) || [];
    const matched = queryTokens.filter((token) => title.includes(token) || text.includes(token));
    if (queryTokens.length && matched.length === 0) {
      score -= 20;
      flags.push("weak_query_match");
      reasons.push("Weak match to the active query");
    } else if (matched.length >= Math.min(2, queryTokens.length)) {
      score += 10;
      reasons.push("Strong query match");
    }
  }

  if (Array.isArray(listing.variations) && listing.variations.length > 0) score += 8;
  if (Array.isArray(listing.image_urls) && listing.image_urls.length > 0) score += 6;
  if (String(listing.description || "").length >= 80) score += 6;
  if (Number(listing.duplicate_count || 1) > 1) flags.push("has_similar_listings");

  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score: clamped,
    type,
    category,
    flags: [...new Set(flags)],
    reasons: reasons.slice(0, 6)
  };
}

export function labelTrainingEffect(rating) {
  const normalized = normalizeRefinedRating(rating);
  const effects = {
    great_deal: { polarity: 1, strength: 2, relevance: 100, dealQuality: 100 },
    good_deal: { polarity: 1, strength: 1.5, relevance: 92, dealQuality: 88 },
    fair_deal: { polarity: 1, strength: 0.75, relevance: 80, dealQuality: 65 },
    bought: { polarity: 1, strength: 2.25, relevance: 100, dealQuality: 100 },
    not_spam: { polarity: 1, strength: 0.6, relevance: 75, dealQuality: 55 },
    bad_deal: { polarity: -1, strength: 1.4, relevance: 78, dealQuality: 15 },
    overpriced: { polarity: -1, strength: 1.2, relevance: 80, dealQuality: 10 },
    duplicate_listing: { polarity: -1, strength: 0.75, relevance: 55, dealQuality: 35 },
    bundle_mixed: { polarity: -1, strength: 0.75, relevance: 58, dealQuality: 40 },
    accessory_only: { polarity: -1, strength: 0.9, relevance: 52, dealQuality: 35 },
    wrong_category: { polarity: -1, strength: 1.6, relevance: 18, dealQuality: 20 },
    irrelevant: { polarity: -1, strength: 1.8, relevance: 8, dealQuality: 5 },
    wtb_service: { polarity: -1, strength: 2, relevance: 5, dealQuality: 5 },
    spam: { polarity: -1, strength: 2, relevance: 5, dealQuality: 5 },
    bad_pricer: { polarity: -1, strength: 1.5, relevance: 30, dealQuality: 10 }
  };
  return effects[normalized] || { polarity: 0, strength: 0, relevance: 50, dealQuality: 50 };
}

function listingText(listing = {}) {
  return `${listing.title || ""} ${listing.description || ""} ${listing.category || ""}`.toLowerCase();
}
