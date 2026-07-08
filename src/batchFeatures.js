import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyScopedDuplicateInfo } from "./duplicateGroups.js";
import { getPriceHistory, getState, getWatchedSearches, readJson, upsertWatchedSearch, writeJson } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "..", "data");
const localPaths = {
  duplicateOverrides: path.join(dataDir, "duplicate-overrides.local.json"),
  listingSnoozes: path.join(dataDir, "listing-snoozes.local.json")
};

export async function getScopedListings() {
  const state = await getState();
  return applyScopedDuplicateInfo(state.listings || [], { overrides: getDuplicateOverrides() });
}

export function getDuplicateOverrides() {
  return readLocalJson("duplicateOverrides", []);
}

export function addDuplicateOverride(listingIdA, listingIdB, action) {
  const a = Number(listingIdA);
  const b = Number(listingIdB);
  const normalized = String(action || "").toLowerCase() === "merge" ? "merge" : "split";
  if (!a || !b || a === b) throw new Error("Two different listing ids are required");
  const [left, right] = a < b ? [a, b] : [b, a];
  const overrides = getDuplicateOverrides().filter((item) => !samePair(item, left, right));
  const next = {
    listing_id_a: left,
    listing_id_b: right,
    action: normalized,
    created_at: new Date().toISOString()
  };
  overrides.push(next);
  writeLocalJson("duplicateOverrides", overrides);
  return next;
}

export async function getMergedPriceHistory(listingId, { merged = true } = {}) {
  const id = Number(listingId);
  if (!id) return [];
  if (!merged) return decorateHistory(getPriceHistory(id));

  const listings = await getScopedListings();
  const listing = listings.find((item) => Number(item.id) === id);
  if (!listing) return decorateHistory(getPriceHistory(id));
  const ids = listings
    .filter((item) => item.duplicate_group_id === listing.duplicate_group_id)
    .map((item) => Number(item.id));
  const sourceIds = ids.length ? ids : [id];
  return decorateHistory(sourceIds.flatMap((sourceId) => getPriceHistory(sourceId)))
    .sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime() || Number(a.listing_id) - Number(b.listing_id))
    .map((point, index, rows) => ({
      ...point,
      source_listing_id: Number(point.listing_id),
      relist_transition: index > 0 && Number(rows[index - 1].listing_id) !== Number(point.listing_id)
    }));
}

export async function getSellerReputationHistory(sellerId) {
  const seller = String(sellerId || "");
  const [listings, labels] = await Promise.all([getScopedListings(), readJson("labels")]);
  const sellerListings = listings.filter((listing) => String(listing.seller_id || listing.seller_name || "") === seller);
  const labelById = new Map((labels || []).map((label) => [Number(label.listing_id), label]));
  const labelCounts = {};
  let labelled = 0;
  let relistMembers = 0;
  const relistGroups = new Set();

  for (const listing of sellerListings) {
    const label = labelById.get(Number(listing.id));
    if (label) {
      labelled += 1;
      const rating = label.refined_rating || label.user_rating || label.rating || "unknown";
      labelCounts[rating] = (labelCounts[rating] || 0) + 1;
    }
    if (Number(listing.duplicate_count || 1) > 1) {
      relistMembers += 1;
      relistGroups.add(listing.duplicate_group_id);
    }
  }

  const total = sellerListings.length;
  return {
    seller_id: seller,
    total_listings: total,
    labelled_count: labelled,
    label_counts: labelCounts,
    relist_listing_count: relistMembers,
    relist_group_count: relistGroups.size,
    relist_ratio: total ? relistMembers / total : 0
  };
}

export async function createExportBundle() {
  const [watchedSearches, filters, config] = await Promise.all([getWatchedSearches(), readJson("filters"), readJson("config")]);
  return {
    exported_at: new Date().toISOString(),
    version: 1,
    watchedSearches,
    filters,
    config: sanitizeConfigForExport(config)
  };
}

export async function importBundle(bundle) {
  if (!bundle || typeof bundle !== "object") throw new Error("Import bundle must be a JSON object");
  const watchedSearches = Array.isArray(bundle.watchedSearches) ? bundle.watchedSearches : null;
  const filters = Array.isArray(bundle.filters) ? bundle.filters : null;
  const config = bundle.config && typeof bundle.config === "object" ? bundle.config : null;
  if (!watchedSearches || !filters || !config) throw new Error("Bundle must include watchedSearches, filters, and config objects");

  for (const watch of watchedSearches) {
    if (!watch || typeof watch !== "object" || !String(watch.query || "").trim()) throw new Error("Every watched search must include a query");
  }
  for (const filter of filters) {
    if (!filter || typeof filter !== "object" || !String(filter.phrase || "").trim()) throw new Error("Every filter must include a phrase");
  }

  const currentConfig = await readJson("config");
  await writeJson("filters", filters.map((filter, index) => ({ id: filter.id || index + 1, type: filter.type || "blacklist", phrase: String(filter.phrase).trim(), reason: filter.reason || "Imported" })));
  for (const watch of watchedSearches) upsertWatchedSearch({ ...watch, id: watch.id || undefined });
  await writeJson("config", {
    ...currentConfig,
    ...sanitizeConfigForImport(config),
    telegram: currentConfig.telegram,
    scheduler: currentConfig.scheduler
  });
  return { imported: true, watchedSearches: watchedSearches.length, filters: filters.length };
}

export function setListingSnooze(listingId, durationText, config = {}) {
  const hours = Number(config.alertSnooze?.defaultHours || 24);
  const durationMs = parseDurationMs(durationText, hours * 60 * 60 * 1000);
  const until = new Date(Date.now() + durationMs).toISOString();
  const snoozes = readLocalJson("listingSnoozes", []).filter((item) => Number(item.listing_id) !== Number(listingId));
  const next = { listing_id: Number(listingId), muted_until: until, created_at: new Date().toISOString() };
  snoozes.push(next);
  writeLocalJson("listingSnoozes", snoozes);
  return next;
}

export function isListingSnoozed(listingId) {
  const now = Date.now();
  return readLocalJson("listingSnoozes", []).some((item) => Number(item.listing_id) === Number(listingId) && new Date(item.muted_until).getTime() > now);
}

export async function setWatchMute(queryOrId, durationText, config = {}) {
  const watches = await getWatchedSearches();
  const key = String(queryOrId || "").trim().toLowerCase();
  const watch = watches.find((item) => String(item.id) === key || String(item.query || "").toLowerCase() === key);
  if (!watch) throw new Error(`No watched search found for ${queryOrId}`);
  const hours = Number(config.watchMute?.defaultHours || 24);
  const mutedUntil = new Date(Date.now() + parseDurationMs(durationText, hours * 60 * 60 * 1000)).toISOString();
  return upsertWatchedSearch({ ...watch, muted_until: mutedUntil });
}

export function isWatchMuted(watch) {
  return watch?.muted_until && new Date(watch.muted_until).getTime() > Date.now();
}

export function parseDurationMs(input, fallbackMs) {
  const text = String(input || "").trim().toLowerCase();
  if (!text) return fallbackMs;
  const match = text.match(/^(\d+(?:\.\d+)?)(m|h|d)?$/);
  if (!match) return fallbackMs;
  const value = Number(match[1]);
  const unit = match[2] || "h";
  if (unit === "m") return value * 60 * 1000;
  if (unit === "d") return value * 24 * 60 * 60 * 1000;
  return value * 60 * 60 * 1000;
}

function decorateHistory(rows) {
  return (rows || []).map((row) => ({ ...row, source_listing_id: Number(row.listing_id) }));
}

function samePair(item, a, b) {
  const left = Number(item.listing_id_a ?? item.a);
  const right = Number(item.listing_id_b ?? item.b);
  return (left === a && right === b) || (left === b && right === a);
}

function sanitizeConfigForExport(config = {}) {
  const { telegram, scheduler, ...rest } = config || {};
  return rest;
}

function sanitizeConfigForImport(config = {}) {
  const { telegram, scheduler, ...rest } = config || {};
  return rest;
}

function readLocalJson(name, fallback) {
  const filePath = localPaths[name];
  if (!filePath || !existsSync(filePath)) return fallback;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeLocalJson(name, value) {
  const filePath = localPaths[name];
  if (!filePath) throw new Error(`Unknown local batch store: ${name}`);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
