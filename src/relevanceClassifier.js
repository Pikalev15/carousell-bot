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
const BROKEN_PATTERN = /\b(?:faulty|spoilt|not working|for parts|no hard\s?drive|no hdd|no battery|no power cable|working status unknown|status unknown|untested|cracked|broken|unable to test|as-is|own risk)\b/i;
const FULL_PC_PATTERN = /\b(?:full build|custom pc|gaming pc|desktop pc|prebuilt|pre-built|workstation|plug and play|windows 11 ready)\b/i;
const QUERY_STOP_WORDS = new Set(["a", "an", "and", "for", "in", "of", "on", "the", "to", "with", "used", "new", "sale"]);

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
    const queryMatch = analyzeQueryMatch(listing, queryText);
    if (queryMatch.score < 25) {
      score -= 20;
      flags.push("weak_query_match");
      reasons.push("Weak match to the active query");
    } else if (queryMatch.score >= 75) {
      score += 10;
      reasons.push("Strong query match");
    }
    flags.push(...queryMatch.flags);
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

export function analyzeQueryMatch(listing = {}, query = "") {
  const parsed = parseSearchQuery(query);
  const queryTokens = parsed.tokens;
  if (!queryTokens.length && !parsed.exclusions.length && parsed.intent === "any" && !parsed.category) {
    return { score: 100, coverage: 1, matched_tokens: [], missing_tokens: [], excluded_matches: [], intent: parsed.intent, flags: [], summary: "No query restrictions" };
  }

  const title = searchableText(listing.title);
  const description = searchableText(listing.description);
  const category = searchableText(listing.category);
  const allText = `${title} ${description} ${category}`.trim();
  const titleCompact = title.replaceAll(" ", "");
  const allCompact = allText.replaceAll(" ", "");
  const matched = [];
  const missing = [];
  let earned = 0;
  let possible = 0;

  for (const token of queryTokens) {
    const weight = /\d/.test(token) ? 1.7 : token.length >= 5 ? 1.25 : 1;
    possible += weight;
    if (hasSearchToken(title, titleCompact, token)) {
      earned += weight;
      matched.push(token);
    } else if (hasSearchToken(allText, allCompact, token)) {
      earned += weight * 0.55;
      matched.push(token);
    } else {
      missing.push(token);
    }
  }

  const coverage = possible ? earned / possible : 0;
  let score = queryTokens.length ? coverage * 82 : 70;
  const normalizedQuery = queryTokens.join(" ");
  if (title.includes(normalizedQuery) || titleCompact.includes(queryTokens.join(""))) score += 18;

  const expectedCategory = parsed.category || inferQueryCategory(parsed.search_text);
  const actualCategory = inferPreciseCategory(listing, listing.category || "general");
  const flags = [];
  const excludedMatches = parsed.exclusions.filter((token) => hasSearchToken(allText, allCompact, token));
  if (excludedMatches.length) {
    score -= 100;
    flags.push("excluded_term_match");
  }
  if (expectedCategory && actualCategory === expectedCategory) score += 12;
  else if (expectedCategory && isCategoryConflict(expectedCategory, actualCategory)) {
    score -= 35;
    flags.push("query_category_mismatch");
  }

  const queryWantsAccessory = ACCESSORY_PATTERN.test(String(query || ""));
  if (!queryWantsAccessory && actualCategory === "pc case accessory") {
    score -= 30;
    flags.push("unwanted_accessory");
  }
  if (WTB_SERVICE_PATTERN.test(listingText(listing)) || SERVICE_PATTERN.test(listingText(listing))) {
    score -= 50;
    flags.push("query_wtb_or_service");
  }

  const intentResult = evaluateSearchIntent(parsed.intent, actualCategory, listing);
  score += intentResult.adjustment;
  flags.push(...intentResult.flags);

  const finalScore = Math.max(0, Math.min(100, Math.round(score)));

  return {
    score: finalScore,
    coverage: Number(coverage.toFixed(3)),
    matched_tokens: [...new Set(matched)],
    missing_tokens: missing,
    excluded_matches: excludedMatches,
    intent: parsed.intent,
    expected_category: expectedCategory || null,
    actual_category: actualCategory,
    flags: [...new Set(flags)],
    summary: queryMatchSummary(finalScore, matched, missing, excludedMatches, parsed.intent)
  };
}

export function querySearchTokens(value = "") {
  return parseSearchQuery(value).tokens;
}

export function parseSearchQuery(value = "", options = {}) {
  const source = String(value || "").trim();
  const terms = [];
  const exclusions = [];
  let intent = normalizeSearchIntent(options.intent || "");
  let category = "";
  const parts = source.match(/(?:[^\s"]+|"[^"]*")+/g) || [];

  for (const rawPart of parts) {
    const part = rawPart.replace(/^"|"$/g, "").trim();
    if (!part) continue;
    const directive = part.match(/^(?:type|intent):(.+)$/i);
    if (directive) {
      intent = normalizeSearchIntent(directive[1]);
      continue;
    }
    const categoryDirective = part.match(/^category:(.+)$/i);
    if (categoryDirective) {
      category = normalizeCategoryDirective(categoryDirective[1]);
      continue;
    }
    if (part.startsWith("-") && part.length > 1) {
      exclusions.push(...rawSearchTokens(part.slice(1)));
      continue;
    }
    terms.push(part);
  }

  const searchText = terms.join(" ").trim();
  return {
    raw: source,
    search_text: searchText,
    tokens: rawSearchTokens(searchText),
    exclusions: [...new Set(exclusions)],
    intent,
    category
  };
}

export function extractModelFamilies(listing = {}) {
  const text = String(`${listing.title || ""} ${listing.category || ""}`).toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  const patterns = [
    /\b(?:rtx|gtx)\s*\d{3,4}(?:\s*(?:ti\s*super|super|ti))?\b/g,
    /\brx\s*\d{3,4}(?:\s*(?:xtx|xt))?\b/g,
    /\bryzen\s*[3579]\s*\d{4}[a-z0-9]*\b/g,
    /\b(?:core\s*)?i[3579]\s*\d{4,5}[a-z]{0,2}\b/g,
    /\b(?:ddr[345])\s*\d{1,3}\s*gb\b/g,
    /\b\d{3,4}\s*gb\s*(?:ssd|nvme)\b|\b[1248]\s*tb\s*(?:ssd|nvme)\b/g
  ];
  const matches = patterns.flatMap((pattern) => text.match(pattern) || []);
  return [...new Set(matches.map(normalizeModelFamily))].slice(0, 8);
}

function normalizeModelFamily(value) {
  return String(value || "")
    .replace(/\b(rtx|gtx|rx)(?=\d)/g, "$1 ")
    .replace(/\b(ryzen)(?=[3579])/g, "$1 ")
    .replace(/\b(i[3579])(?=\d)/g, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
}

function rawSearchTokens(value = "") {
  const normalized = searchableText(value);
  return [...new Set((normalized.match(/[a-z]+|\d+[a-z]*|[a-z]+\d+[a-z0-9]*/g) || [])
    .filter((token) => token.length >= 2 && !QUERY_STOP_WORDS.has(token)))];
}

function normalizeSearchIntent(value = "") {
  const intent = String(value || "").toLowerCase().replaceAll("-", "_").trim();
  const aliases = {
    parts: "component",
    part: "component",
    components: "component",
    full: "full_pc",
    pc: "full_pc",
    build: "full_pc",
    accessories: "accessory"
  };
  const normalized = aliases[intent] || intent;
  return ["component", "full_pc", "accessory"].includes(normalized) ? normalized : "any";
}

function normalizeCategoryDirective(value = "") {
  const aliases = {
    gpu: "graphics card",
    cpu: "processor",
    ram: "memory",
    ssd: "storage",
    case: "pc case",
    cooling: "pc cooling",
    psu: "power supply"
  };
  const key = String(value || "").toLowerCase().replaceAll("_", " ").trim();
  return aliases[key] || key;
}

function evaluateSearchIntent(intent, category, listing) {
  if (!intent || intent === "any") return { adjustment: 0, flags: [] };
  const flags = [];
  const fullPc = FULL_PC_PATTERN.test(listingText(listing));
  const accessory = category === "pc case accessory" || ACCESSORY_PATTERN.test(String(listing.title || ""));
  if (intent === "accessory") return accessory ? { adjustment: 18, flags } : { adjustment: -55, flags: ["intent_mismatch"] };
  if (intent === "full_pc") return fullPc ? { adjustment: 18, flags } : { adjustment: -55, flags: ["intent_mismatch"] };
  if (intent === "component") {
    if (fullPc || accessory || category === "service/wtb") return { adjustment: -55, flags: ["intent_mismatch"] };
    return { adjustment: 12, flags };
  }
  return { adjustment: 0, flags };
}

function queryMatchSummary(score, matched, missing, excluded, intent) {
  if (excluded.length) return `Excluded term matched: ${excluded.join(", ")}`;
  const parts = [`${score}/100 relevance`];
  if (matched.length) parts.push(`matched ${[...new Set(matched)].join(", ")}`);
  if (missing.length) parts.push(`missing ${missing.join(", ")}`);
  if (intent && intent !== "any") parts.push(`${intent.replaceAll("_", " ")} intent`);
  return parts.join(" | ");
}

function searchableText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/([a-z])(?=\d)|([0-9])(?=[a-z])/g, "$1$2 ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasSearchToken(text, compact, token) {
  return (` ${text} `).includes(` ${token} `) || (token.length >= 4 && compact.includes(token.replaceAll(" ", "")));
}

function inferQueryCategory(query) {
  const text = String(query || "");
  if (/\b(?:gpu|graphics card|rtx|gtx|geforce|radeon|rx\s?\d{3,4})\b/i.test(text)) return "graphics card";
  if (/\b(?:cpu|processor|ryzen|core\s?i[3579])\b/i.test(text)) return "processor";
  if (/\b(?:motherboard|mobo)\b/i.test(text)) return "motherboard";
  if (/\b(?:ram|memory|ddr[345])\b/i.test(text)) return "memory";
  if (/\b(?:ssd|nvme|hard drive|hdd)\b/i.test(text)) return "storage";
  if (/\b(?:monitor|display|ultrawide)\b/i.test(text)) return "monitor";
  if (/\b(?:pc case|computer case|chassis|casing)\b/i.test(text)) return "pc case";
  return "";
}

function isCategoryConflict(expected, actual) {
  if (!actual || actual === "general") return false;
  if (expected === "pc case" && actual === "pc case accessory") return true;
  const hardware = new Set(["graphics card", "processor", "motherboard", "memory", "storage", "power supply", "pc cooling", "pc case", "pc case accessory", "monitor", "laptop", "phone"]);
  return hardware.has(expected) && hardware.has(actual) && expected !== actual;
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
