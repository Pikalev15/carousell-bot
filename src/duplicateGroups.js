import { createHash } from "node:crypto";

export const DUPLICATE_GROUP_LOOKBACK_DAYS = 30;
export const DUPLICATE_GROUP_LOOKBACK_MS = DUPLICATE_GROUP_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
const MIN_TITLE_TOKEN_OVERLAP = 2;

export function applyScopedDuplicateInfo(listings = [], options = {}) {
  const groups = buildScopedDuplicateGroups(listings, options);
  return listings.map((listing) => ({
    ...listing,
    ...(groups.get(Number(listing.id)) || singleDuplicateInfo(listing))
  }));
}

export function buildScopedDuplicateGroups(listings = [], options = {}) {
  const lookbackMs = Math.max(1, Number(options.lookbackMs || DUPLICATE_GROUP_LOOKBACK_MS));
  const candidates = Array.isArray(listings) ? listings : [];
  const adjacency = new Map(candidates.map((listing) => [Number(listing.id), new Set()]));

  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const a = candidates[i];
      const b = candidates[j];
      if (!areDuplicateCandidates(a, b, lookbackMs)) continue;
      if (!hasDuplicateEvidence(a, b)) continue;
      adjacency.get(Number(a.id))?.add(Number(b.id));
      adjacency.get(Number(b.id))?.add(Number(a.id));
    }
  }

  const byId = new Map(candidates.map((listing) => [Number(listing.id), listing]));
  const visited = new Set();
  const output = new Map();
  let groupIndex = 1;

  for (const listing of candidates) {
    const id = Number(listing.id);
    if (visited.has(id)) continue;
    const component = collectComponent(id, adjacency, visited).map((itemId) => byId.get(itemId)).filter(Boolean);
    if (component.length < 2) {
      output.set(id, singleDuplicateInfo(listing));
      continue;
    }
    const sorted = component.sort((a, b) => getListingTime(b) - getListingTime(a));
    const groupId = `dup-${groupIndex}`;
    groupIndex += 1;
    sorted.forEach((item, index) => {
      output.set(Number(item.id), {
        duplicate_group_id: groupId,
        duplicate_count: sorted.length,
        duplicate_role: index === 0 ? "primary" : "secondary"
      });
    });
  }

  return output;
}

export function duplicateImageIdentity(rawUrl) {
  const text = String(rawUrl || "").trim();
  if (!text) return "";
  try {
    const parsed = new URL(text);
    const path = `${parsed.hostname.toLowerCase()}${decodeURIComponent(parsed.pathname)}`;
    return createHash("sha256").update(path).digest("hex").slice(0, 24);
  } catch {
    const stripped = text.split("?")[0];
    return createHash("sha256").update(stripped).digest("hex").slice(0, 24);
  }
}

export function duplicateGroupHistogram(listings = []) {
  const counts = new Map();
  for (const listing of listings) {
    const key = listing.duplicate_group_id || `single-${listing.id}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const histogram = { 1: 0, 2: 0, 3: 0, "4+": 0 };
  for (const size of counts.values()) {
    if (size >= 4) histogram["4+"] += 1;
    else histogram[size] = (histogram[size] || 0) + 1;
  }
  return histogram;
}

function areDuplicateCandidates(a, b, lookbackMs) {
  if (!sameCategory(a, b)) return false;
  if (!withinLookbackWindow(a, b, lookbackMs)) return false;
  return sameSeller(a, b) || titleTokenOverlap(a, b) >= MIN_TITLE_TOKEN_OVERLAP;
}

function hasDuplicateEvidence(a, b) {
  if (sameCarousellId(a, b)) return true;
  const overlap = titleTokenOverlap(a, b);
  if (sameSeller(a, b) && overlap >= MIN_TITLE_TOKEN_OVERLAP) return true;
  if (imageIdentityOverlap(a, b) && (sameSeller(a, b) || overlap >= MIN_TITLE_TOKEN_OVERLAP)) return true;
  return false;
}

function sameCarousellId(a, b) {
  return Boolean(a.carousell_id && b.carousell_id && String(a.carousell_id) === String(b.carousell_id));
}

function sameCategory(a, b) {
  return normalizeText(a.category || "general") === normalizeText(b.category || "general");
}

function sameSeller(a, b) {
  const aSeller = normalizeText(a.seller_id || a.seller_name || "");
  const bSeller = normalizeText(b.seller_id || b.seller_name || "");
  return Boolean(aSeller && bSeller && aSeller === bSeller);
}

function withinLookbackWindow(a, b, lookbackMs) {
  const aTime = getListingTime(a);
  const bTime = getListingTime(b);
  if (!aTime || !bTime) return true;
  return Math.abs(aTime - bTime) <= lookbackMs;
}

function getListingTime(listing) {
  const value = listing.listed_at || listing.scraped_at || listing.updated_at || listing.created_at || "";
  const time = value ? new Date(value).getTime() : 0;
  if (Number.isFinite(time) && time > 0) return time;
  if (listing.days_listed !== null && listing.days_listed !== undefined) {
    return Date.now() - Number(listing.days_listed || 0) * 24 * 60 * 60 * 1000;
  }
  return 0;
}

function imageIdentityOverlap(a, b) {
  const aKeys = new Set((a.original_image_urls || a.image_urls || []).map(duplicateImageIdentity).filter(Boolean));
  if (!aKeys.size) return false;
  return (b.original_image_urls || b.image_urls || []).some((url) => aKeys.has(duplicateImageIdentity(url)));
}

function titleTokenOverlap(a, b) {
  const aTokens = new Set(titleTokens(a.title));
  if (!aTokens.size) return 0;
  return titleTokens(b.title).filter((token) => aTokens.has(token)).length;
}

function titleTokens(title) {
  return normalizeText(title)
    .split(" ")
    .filter((token) => token.length > 1 && !["with", "and", "for", "the", "only", "brand", "new"].includes(token));
}

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function collectComponent(startId, adjacency, visited) {
  const stack = [startId];
  const result = [];
  while (stack.length) {
    const id = stack.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    result.push(id);
    for (const next of adjacency.get(id) || []) {
      if (!visited.has(next)) stack.push(next);
    }
  }
  return result;
}

function singleDuplicateInfo(listing) {
  return { duplicate_group_id: `single-${listing.id}`, duplicate_count: 1, duplicate_role: "primary" };
}
