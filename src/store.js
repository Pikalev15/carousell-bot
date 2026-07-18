import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "data");
const dbPath = process.env.CAROUSELL_DB_PATH || path.join(dataDir, "carousell-bot.db");
let transactionDepth = 0;
let storeVersion = 0;
let derivedListingsVersion = 0;

const derivedListingsCollections = new Set(["listings", "filters", "sellers", "labels", "config", "trainingModel"]);

const jsonPaths = {
  listings: path.join(dataDir, "listings.json"),
  filters: path.join(dataDir, "filters.json"),
  sellers: path.join(dataDir, "seller-blacklist.json"),
  config: path.join(dataDir, "config.json"),
  labels: path.join(dataDir, "labels.json"),
  searches: path.join(dataDir, "search-history.json"),
  trainingModel: path.join(dataDir, "training-model.json"),
  watchedSearches: path.join(dataDir, "watched-searches.local.json"),
  alerts: path.join(dataDir, "alerts.local.json"),
  activity: path.join(dataDir, "activity.local.json")
};

const db = openDatabase();
if (db) {
  ensureSchema();
  migrateJsonIfNeeded();
}

export function getDatabase() {
  return db;
}

export function closeDatabase() {
  db?.close();
}

export function getStoreVersion() {
  return storeVersion;
}

export function getDerivedListingsVersion() {
  return derivedListingsVersion;
}

export async function readJson(name) {
  return readCollection(name);
}

export async function writeJson(name, value) {
  writeCollection(name, value);
}

export async function getState() {
  const [listings, filters, sellers, config, labels, trainingModel, searches, watchedSearches, alerts] = await Promise.all([
    readJson("listings"),
    readJson("filters"),
    readJson("sellers"),
    readJson("config"),
    readJson("labels"),
    readJson("trainingModel"),
    readJson("searches"),
    getWatchedSearches(),
    getAlerts()
  ]);
  return { listings, filters, sellers, config, labels, trainingModel, searches, watchedSearches, alerts, storeVersion, derivedListingsVersion };
}

export function upsertListing(listing) {
  if (!db) return upsertJsonListing(listing);
  const now = new Date().toISOString();
  const existing = listing.id ? getListingById(listing.id) : getListingByCarousellId(listing.carousell_id);
  const next = {
    ...existing,
    ...listing,
    id: existing?.id || listing.id
  };
  if (!next.id) {
    next.id = nextListingId();
  }

  db.prepare(`
    INSERT INTO listings (
      id, carousell_id, title, description, category, condition, seller_id, seller_name,
      seller_rating, location, current_price, scraped_at, payload
    )
    VALUES (@id, @carousell_id, @title, @description, @category, @condition, @seller_id, @seller_name,
      @seller_rating, @location, @current_price, @scraped_at, @payload)
    ON CONFLICT(id) DO UPDATE SET
      carousell_id = excluded.carousell_id,
      title = excluded.title,
      description = excluded.description,
      category = excluded.category,
      condition = excluded.condition,
      seller_id = excluded.seller_id,
      seller_name = excluded.seller_name,
      seller_rating = excluded.seller_rating,
      location = excluded.location,
      current_price = excluded.current_price,
      scraped_at = excluded.scraped_at,
      payload = excluded.payload
  `).run(listingRow(next));

  if (!existing || Number(existing.current_price || 0) !== Number(next.current_price || 0)) {
    addPriceHistory(next.id, next.current_price, now);
  }

  bumpStoreVersion("listings");
  return getListingById(next.id);
}

export function bulkUpsertListings(listings) {
  if (!db) {
    const current = readCollection("listings");
    const byId = new Map(current.map((item, index) => [Number(item.id), index]));
    const byCarousellId = new Map(current.map((item, index) => [item.carousell_id, index]));
    let nextId = Math.max(0, ...current.map((item) => Number(item.id || 0))) + 1;
    const results = [];
    for (const listing of listings || []) {
      const idIndex = listing.id ? byId.get(Number(listing.id)) : undefined;
      const carousellIndex = listing.carousell_id ? byCarousellId.get(listing.carousell_id) : undefined;
      const existingIndex = idIndex ?? carousellIndex;
      const existing = existingIndex === undefined ? null : current[existingIndex];
      const next = { ...existing, ...listing, id: existing?.id || listing.id || nextId++ };
      if (existingIndex === undefined) {
        const index = current.length;
        current.push(next);
        byId.set(Number(next.id), index);
        byCarousellId.set(next.carousell_id, index);
      } else {
        current[existingIndex] = next;
      }
      results.push(next);
    }
    if (results.length) writeCollection("listings", current);
    return results;
  }
  return runTransaction(() => listings.map((item) => upsertListing(item)));
}

export function getListingById(id) {
  if (!db) return readCollection("listings").find((listing) => Number(listing.id) === Number(id)) || null;
  const row = db.prepare("SELECT payload FROM listings WHERE id = ?").get(Number(id));
  return row ? normalizeStoredListingPrice(parsePayload(row.payload)) : null;
}

export function getListingByCarousellId(carousellId) {
  if (!carousellId) return null;
  if (!db) return readCollection("listings").find((listing) => listing.carousell_id === carousellId) || null;
  const row = db.prepare("SELECT payload FROM listings WHERE carousell_id = ?").get(carousellId);
  return row ? normalizeStoredListingPrice(parsePayload(row.payload)) : null;
}

export function addPriceHistory(listingId, price, recordedAt = new Date().toISOString()) {
  if (!listingId || Number(price || 0) < 0) return null;
  if (!db) return null;
  const previous = db.prepare("SELECT price FROM price_history WHERE listing_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 1").get(Number(listingId));
  if (previous && Number(previous.price) === Number(price)) return previous;
  return db.prepare("INSERT INTO price_history (listing_id, price, recorded_at) VALUES (?, ?, ?)").run(Number(listingId), Number(price || 0), recordedAt);
}

export function getPriceHistory(listingId) {
  if (!db) return [];
  return db
    .prepare("SELECT listing_id, price, recorded_at FROM price_history WHERE listing_id = ? ORDER BY recorded_at ASC, id ASC")
    .all(Number(listingId));
}

export function getWatchedSearches() {
  if (!db) return readJsonFile("watchedSearches", []);
  return db
    .prepare("SELECT payload FROM watched_searches ORDER BY active DESC, updated_at DESC")
    .all()
    .map((row) => parsePayload(row.payload));
}

export function getWatchedSearch(id) {
  if (!db) return getWatchedSearches().find((item) => Number(item.id) === Number(id)) || null;
  const row = db.prepare("SELECT payload FROM watched_searches WHERE id = ?").get(Number(id));
  return row ? parsePayload(row.payload) : null;
}

export function upsertWatchedSearch(input) {
  if (!db) return upsertJsonWatchedSearch(input);
  const now = new Date().toISOString();
  const existing = input.id ? getWatchedSearch(input.id) : null;
  const next = {
    id: existing?.id || input.id || nextWatchedSearchId(),
    query: String(input.query || existing?.query || "").trim(),
    price_ceiling: input.price_ceiling === "" || input.price_ceiling === null || input.price_ceiling === undefined ? null : Number(input.price_ceiling),
    category: String(input.category || existing?.category || "").trim(),
    kind: input.kind || existing?.kind || "query",
    terms: normalizeStringList(input.terms ?? existing?.terms),
    urls: normalizeStringList(input.urls ?? existing?.urls),
    active: input.active === undefined ? existing?.active ?? true : Boolean(input.active),
    created_at: existing?.created_at || now,
    updated_at: now,
    last_run_at: input.last_run_at || existing?.last_run_at || null,
    last_result_count: input.last_result_count ?? existing?.last_result_count ?? null,
    last_health_alert_at: input.last_health_alert_at || existing?.last_health_alert_at || null
  };
  if (!next.query) throw new Error("query is required");
  db.prepare(`
    INSERT INTO watched_searches (id, query, price_ceiling, category, active, created_at, updated_at, last_run_at, payload)
    VALUES (@id, @query, @price_ceiling, @category, @active, @created_at, @updated_at, @last_run_at, @payload)
    ON CONFLICT(id) DO UPDATE SET
      query = excluded.query,
      price_ceiling = excluded.price_ceiling,
      category = excluded.category,
      active = excluded.active,
      updated_at = excluded.updated_at,
      last_run_at = excluded.last_run_at,
      payload = excluded.payload
  `).run(watchedSearchRow(next));
  bumpStoreVersion("watchedSearches");
  return getWatchedSearch(next.id);
}

export function deleteWatchedSearch(id) {
  if (!db) {
    const current = getWatchedSearches();
    const next = current.filter((item) => Number(item.id) !== Number(id));
    writeJsonFile("watchedSearches", next);
    const removed = current.length - next.length;
    if (removed > 0) bumpStoreVersion("watchedSearches");
    return removed;
  }
  const changes = db.prepare("DELETE FROM watched_searches WHERE id = ?").run(Number(id)).changes;
  if (changes > 0) bumpStoreVersion("watchedSearches");
  return changes;
}

export function updateWatchedSearchRun(id, lastRunAt = new Date().toISOString()) {
  const watched = getWatchedSearch(id);
  if (!watched) return null;
  return upsertWatchedSearch({ ...watched, last_run_at: lastRunAt });
}

export function getAlerts({ unreadOnly = false, limit = 40 } = {}) {
  if (!db) {
    const alerts = readJsonFile("alerts", []);
    return alerts.filter((alert) => !unreadOnly || !alert.read_at).slice(0, limit);
  }
  const where = unreadOnly ? "WHERE read_at IS NULL" : "";
  return db
    .prepare(`SELECT payload FROM alerts ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(Number(limit))
    .map((row) => parsePayload(row.payload));
}

export function createAlert(input) {
  if (!db) return upsertJsonAlert(input);
  const now = new Date().toISOString();
  const next = {
    ...input,
    id: input.id || Date.now(),
    type: input.type || "deal",
    title: input.title || "Carousell alert",
    message: input.message || "",
    listing_id: input.listing_id || null,
    listing_url: input.listing_url || null,
    watch_id: input.watch_id || null,
    created_at: input.created_at || now,
    read_at: input.read_at || null,
    sent_at: input.sent_at || null,
    error: input.error || null
  };
  db.prepare(`
    INSERT INTO alerts (id, type, title, message, listing_id, watch_id, created_at, read_at, sent_at, payload)
    VALUES (@id, @type, @title, @message, @listing_id, @watch_id, @created_at, @read_at, @sent_at, @payload)
    ON CONFLICT(id) DO UPDATE SET read_at = excluded.read_at, sent_at = excluded.sent_at, payload = excluded.payload
  `).run(alertRow(next));
  bumpStoreVersion("alerts");
  return next;
}

export function markAlertsRead() {
  const readAt = new Date().toISOString();
  if (!db) {
    const alerts = readJsonFile("alerts", []);
    let marked = 0;
    const nextAlerts = alerts.map((alert) => {
      if (!alert || typeof alert !== "object" || alert.read_at) return alert;
      marked += 1;
      return { ...alert, read_at: readAt };
    });
    if (marked > 0) {
      writeJsonFile("alerts", nextAlerts);
      bumpStoreVersion("alerts");
    }
    return { marked, read_at: readAt };
  }

  let result;
  try {
    result = db.prepare(`
      UPDATE alerts
      SET read_at = ?,
          payload = json_set(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END, '$.read_at', ?)
      WHERE read_at IS NULL
    `).run(readAt, readAt);
  } catch {
    const rows = db.prepare("SELECT id, payload FROM alerts WHERE read_at IS NULL").all();
    if (!rows.length) return { marked: 0, read_at: readAt };
    runTransaction((items) => {
      const update = db.prepare("UPDATE alerts SET read_at = ?, payload = ? WHERE id = ?");
      for (const row of items) {
        const payload = parsePayload(row.payload) || {};
        update.run(readAt, JSON.stringify({ ...payload, read_at: readAt }), row.id);
      }
    }, rows);
    result = { changes: rows.length };
  }
  bumpStoreVersion("alerts");
  return { marked: Number(result.changes || 0), read_at: readAt };
}

export function addActivity(input) {
  if (!db) return appendJsonActivity(input);
  const next = {
    ...input,
    id: input.id || Date.now(),
    type: input.type || "event",
    title: input.title || "Activity",
    detail: input.detail || "",
    timestamp: input.timestamp || new Date().toISOString(),
    listing_id: input.listing_id || null,
    watch_id: input.watch_id || null
  };
  db.prepare(`
    INSERT INTO activity (id, type, title, detail, timestamp, listing_id, watch_id, payload)
    VALUES (@id, @type, @title, @detail, @timestamp, @listing_id, @watch_id, @payload)
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload
  `).run(activityRow(next));
  bumpStoreVersion("activity");
  return next;
}

export function getActivity(limit = 50) {
  if (!db) return readJsonFile("activity", []).slice(0, limit);
  return db.prepare("SELECT payload FROM activity ORDER BY timestamp DESC, id DESC LIMIT ?").all(Number(limit)).map((row) => parsePayload(row.payload));
}

function openDatabase() {
  if (!DatabaseSync) return null;
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const database = new DatabaseSync(dbPath);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS listings (
      id INTEGER PRIMARY KEY,
      carousell_id TEXT UNIQUE,
      title TEXT NOT NULL,
      description TEXT,
      category TEXT,
      condition TEXT,
      seller_id TEXT,
      seller_name TEXT,
      seller_rating REAL,
      location TEXT,
      current_price REAL,
      scraped_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS filters (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      phrase TEXT NOT NULL,
      reason TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sellers (
      seller_id TEXT PRIMARY KEY,
      seller_name TEXT,
      reason TEXT,
      blocked_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS labels (
      listing_id INTEGER PRIMARY KEY,
      user_rating TEXT NOT NULL,
      asked_price REAL,
      negotiated_price REAL,
      timestamp TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS search_history (
      id INTEGER PRIMARY KEY,
      query TEXT NOT NULL,
      mode TEXT NOT NULL,
      timestamp TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS training_model (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS watched_searches (
      id INTEGER PRIMARY KEY,
      query TEXT NOT NULL,
      price_ceiling REAL,
      category TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT,
      updated_at TEXT,
      last_run_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER NOT NULL,
      price REAL NOT NULL,
      recorded_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT,
      listing_id INTEGER,
      watch_id INTEGER,
      created_at TEXT,
      read_at TEXT,
      sent_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT,
      timestamp TEXT,
      listing_id INTEGER,
      watch_id INTEGER,
      payload TEXT NOT NULL
    );
  `);
}

function migrateJsonIfNeeded() {
  const migrated = db.prepare("SELECT value FROM config WHERE key = '__json_migrated'").get();
  if (migrated) return;
  runTransaction(() => {
    writeCollection("listings", readJsonFile("listings", []));
    writeCollection("filters", readJsonFile("filters", []));
    writeCollection("sellers", readJsonFile("sellers", []));
    writeCollection("labels", readJsonFile("labels", []));
    writeCollection("searches", readJsonFile("searches", []));
    writeCollection("config", withConfigDefaults(readJsonFile("config", {})));
    writeCollection("trainingModel", readJsonFile("trainingModel", {}));
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('__json_migrated', ?)").run(new Date().toISOString());
  });
}

function readCollection(name) {
  if (!db) {
    if (name === "config") return withConfigDefaults(readJsonFile("config", {}));
    if (name === "trainingModel") return readJsonFile("trainingModel", {});
    const value = readJsonFile(name, []);
    return name === "listings" ? value.map(normalizeStoredListingPrice) : value;
  }
  if (name === "listings") return db.prepare("SELECT payload FROM listings ORDER BY id ASC").all().map((row) => normalizeStoredListingPrice(parsePayload(row.payload)));
  if (name === "filters") return db.prepare("SELECT payload FROM filters ORDER BY id ASC").all().map((row) => parsePayload(row.payload));
  if (name === "sellers") return db.prepare("SELECT payload FROM sellers ORDER BY blocked_at DESC, seller_id ASC").all().map((row) => parsePayload(row.payload));
  if (name === "labels") return db.prepare("SELECT payload FROM labels ORDER BY timestamp ASC").all().map((row) => parsePayload(row.payload));
  if (name === "searches") return db.prepare("SELECT payload FROM search_history ORDER BY timestamp DESC, id DESC").all().map((row) => parsePayload(row.payload));
  if (name === "config") return withConfigDefaults(parsePayload(db.prepare("SELECT value FROM config WHERE key = 'main'").get()?.value || "{}"));
  if (name === "trainingModel") return parsePayload(db.prepare("SELECT value FROM training_model WHERE key = 'main'").get()?.value || "{}");
  throw new Error(`Unknown store collection: ${name}`);
}

function normalizeStoredListingPrice(listing) {
  if (!listing || listing.price_source !== "description") return listing;
  const cardPrice = Number(listing.display_price || 0);
  return {
    ...listing,
    current_price: cardPrice > 0 ? cardPrice : Number(listing.current_price || 0),
    price_source: "card"
  };
}

function writeCollection(name, value) {
  if (!db) {
    if (name === "config") writeJsonFile("config", withConfigDefaults(value));
    else if (name === "trainingModel") writeJsonFile("trainingModel", value || {});
    else writeJsonFile(name, Array.isArray(value) ? value : []);
    bumpStoreVersion(name);
    return;
  }
  if (name === "listings") replaceRows("listings", value, listingRow);
  else if (name === "filters") replaceRows("filters", value, filterRow);
  else if (name === "sellers") replaceRows("sellers", value, sellerRow);
  else if (name === "labels") replaceRows("labels", value, labelRow);
  else if (name === "searches") replaceRows("search_history", value, searchRow);
  else if (name === "config") {
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('main', ?)").run(JSON.stringify(withConfigDefaults(value)));
  } else if (name === "trainingModel") {
    db.prepare("INSERT OR REPLACE INTO training_model (key, value) VALUES ('main', ?)").run(JSON.stringify(value || {}));
  } else {
    throw new Error(`Unknown store collection: ${name}`);
  }
  bumpStoreVersion(name);
}

function replaceRows(table, rows, rowMapper) {
  const items = Array.isArray(rows) ? rows : [];
  runTransaction((values) => {
    db.prepare(`DELETE FROM ${table}`).run();
    for (const item of values) insertRow(table, rowMapper(item));
  }, items);
}

function insertRow(table, row) {
  const columns = Object.keys(row);
  const names = columns.join(", ");
  const values = columns.map((column) => `@${column}`).join(", ");
  db.prepare(`INSERT INTO ${table} (${names}) VALUES (${values})`).run(row);
}

function listingRow(listing) {
  const item = {
    ...listing,
    id: Number(listing.id || nextListingId()),
    carousell_id: listing.carousell_id || `manual-${listing.id || Date.now()}`
  };
  return {
    id: item.id,
    carousell_id: item.carousell_id,
    title: item.title || "Untitled listing",
    description: item.description || "",
    category: item.category || "electronics",
    condition: item.condition || "unknown",
    seller_id: item.seller_id || "",
    seller_name: item.seller_name || "",
    seller_rating: Number(item.seller_rating || 0),
    location: item.location || "",
    current_price: Number(item.current_price || 0),
    scraped_at: item.scraped_at || null,
    payload: JSON.stringify(item)
  };
}

function filterRow(filter) {
  return {
    id: Number(filter.id || Date.now()),
    type: filter.type || "blacklist",
    phrase: filter.phrase || "",
    reason: filter.reason || "",
    payload: JSON.stringify(filter)
  };
}

function sellerRow(seller) {
  return {
    seller_id: seller.seller_id || seller.seller_name || `seller-${Date.now()}`,
    seller_name: seller.seller_name || seller.seller_id || "",
    reason: seller.reason || "",
    blocked_at: seller.blocked_at || null,
    payload: JSON.stringify(seller)
  };
}

function labelRow(label) {
  return {
    listing_id: Number(label.listing_id),
    user_rating: label.user_rating || "skip",
    asked_price: label.asked_price === null || label.asked_price === undefined ? null : Number(label.asked_price),
    negotiated_price: label.negotiated_price === null || label.negotiated_price === undefined ? null : Number(label.negotiated_price),
    timestamp: label.timestamp || new Date().toISOString(),
    payload: JSON.stringify(label)
  };
}

function searchRow(search) {
  return {
    id: Number(search.id || Date.now()),
    query: search.query || "",
    mode: search.mode || "web",
    timestamp: search.timestamp || new Date().toISOString(),
    payload: JSON.stringify(search)
  };
}

function watchedSearchRow(search) {
  const payload = {
    ...search,
    active: Boolean(search.active)
  };
  return {
    id: Number(search.id),
    query: search.query,
    price_ceiling: search.price_ceiling,
    category: search.category || "",
    active: search.active ? 1 : 0,
    created_at: search.created_at,
    updated_at: search.updated_at,
    last_run_at: search.last_run_at,
    payload: JSON.stringify(payload)
  };
}

function alertRow(alert) {
  return {
    id: alert.id,
    type: alert.type,
    title: alert.title,
    message: alert.message,
    listing_id: alert.listing_id,
    watch_id: alert.watch_id,
    created_at: alert.created_at,
    read_at: alert.read_at,
    sent_at: alert.sent_at,
    payload: JSON.stringify(alert)
  };
}

function activityRow(activity) {
  return {
    ...activity,
    payload: JSON.stringify(activity)
  };
}

function nextListingId() {
  if (!db) return Math.max(0, ...readCollection("listings").map((item) => Number(item.id || 0))) + 1;
  return Number(db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM listings").get().id);
}

function nextWatchedSearchId() {
  if (!db) return Math.max(0, ...getWatchedSearches().map((item) => Number(item.id || 0))) + 1;
  return Number(db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM watched_searches").get().id);
}

function readJsonFile(name, fallback) {
  const filePath = jsonPaths[name];
  if (!filePath || !existsSync(filePath)) return fallback;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJsonFile(name, value) {
  const filePath = jsonPaths[name];
  if (!filePath) throw new Error(`Unknown JSON store: ${name}`);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runTransaction(callback, value) {
  if (transactionDepth > 0) return callback(value);
  transactionDepth += 1;
  db.exec("BEGIN");
  try {
    const result = callback(value);
    db.exec("COMMIT");
    transactionDepth -= 1;
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    transactionDepth -= 1;
    throw error;
  }
}

function bumpStoreVersion(collection) {
  storeVersion += 1;
  if (derivedListingsCollections.has(collection)) derivedListingsVersion += 1;
  return storeVersion;
}

function upsertJsonListing(listing) {
  const listings = readCollection("listings");
  const existingIndex = listings.findIndex((item) => Number(item.id) === Number(listing.id) || item.carousell_id === listing.carousell_id);
  const next = { ...listings[existingIndex], ...listing, id: listing.id || listings[existingIndex]?.id || nextListingId() };
  if (existingIndex >= 0) listings[existingIndex] = next;
  else listings.push(next);
  writeCollection("listings", listings);
  return next;
}

function upsertJsonWatchedSearch(input) {
  const watches = getWatchedSearches();
  const existingIndex = watches.findIndex((item) => Number(item.id) === Number(input.id));
  const existing = existingIndex >= 0 ? watches[existingIndex] : null;
  const now = new Date().toISOString();
  const next = {
    id: existing?.id || input.id || nextWatchedSearchId(),
    query: String(input.query || existing?.query || "").trim(),
    price_ceiling: input.price_ceiling === "" || input.price_ceiling === null || input.price_ceiling === undefined ? null : Number(input.price_ceiling),
    category: String(input.category || existing?.category || "").trim(),
    kind: input.kind || existing?.kind || "query",
    terms: normalizeStringList(input.terms ?? existing?.terms),
    urls: normalizeStringList(input.urls ?? existing?.urls),
    active: input.active === undefined ? existing?.active ?? true : Boolean(input.active),
    created_at: existing?.created_at || now,
    updated_at: now,
    last_run_at: input.last_run_at || existing?.last_run_at || null,
    last_result_count: input.last_result_count ?? existing?.last_result_count ?? null,
    last_health_alert_at: input.last_health_alert_at || existing?.last_health_alert_at || null
  };
  if (!next.query) throw new Error("query is required");
  if (existingIndex >= 0) watches[existingIndex] = next;
  else watches.push(next);
  writeJsonFile("watchedSearches", watches);
  bumpStoreVersion("watchedSearches");
  return next;
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(/[\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function upsertJsonAlert(input) {
  const alerts = readJsonFile("alerts", []);
  const now = new Date().toISOString();
  const next = {
    ...input,
    id: input.id || Date.now(),
    type: input.type || "deal",
    title: input.title || "Carousell alert",
    message: input.message || "",
    listing_id: input.listing_id || null,
    listing_url: input.listing_url || null,
    watch_id: input.watch_id || null,
    created_at: input.created_at || now,
    read_at: input.read_at || null,
    sent_at: input.sent_at || null,
    error: input.error || null
  };
  const existingIndex = alerts.findIndex((alert) => Number(alert.id) === Number(next.id));
  if (existingIndex >= 0) alerts[existingIndex] = next;
  else alerts.unshift(next);
  writeJsonFile("alerts", alerts);
  bumpStoreVersion("alerts");
  return next;
}

function appendJsonActivity(input) {
  const activity = readJsonFile("activity", []);
  const next = {
    id: input.id || Date.now(),
    type: input.type || "event",
    title: input.title || "Activity",
    detail: input.detail || "",
    timestamp: input.timestamp || new Date().toISOString(),
    listing_id: input.listing_id || null,
    watch_id: input.watch_id || null
  };
  activity.unshift(next);
  writeJsonFile("activity", activity.slice(0, 500));
  bumpStoreVersion("activity");
  return next;
}

function parsePayload(value) {
  return JSON.parse(value || "null");
}

function withConfigDefaults(config) {
  const defaultCategoryPresets = {
    "Computers & Tech": ["gaming pc", "gpu", "rtx", "lian li", "pc case", "monitor", "ssd", "motherboard"],
    "GPU Deals": ["rtx 3070", "rtx 3080", "rtx 4070", "rtx 4080", "graphics card", "gpu"],
    "Full PCs": ["gaming pc", "rtx pc", "custom pc", "mini itx pc", "sff pc"],
    "Cases & Cooling": ["lian li", "pc case", "aio cooler", "case fans", "noctua", "thermaltake"],
    "Monitors": ["gaming monitor", "144hz monitor", "240hz monitor", "ultrawide monitor", "4k monitor"],
    "Storage": ["ssd", "nvme", "m.2", "hard disk", "nas drive"]
  };
  return {
    ...(config || {}),
    categoryPresets: {
      ...defaultCategoryPresets,
      ...(config?.categoryPresets || {})
    },
    priceTargets: Array.isArray(config?.priceTargets) ? config.priceTargets : [],
    imageCache: {
      enabled: true,
      maxAgeDays: 14,
      maxFiles: 500,
      ...(config?.imageCache || {})
    },
    scrapeHealthCheck: {
      enabled: true,
      minResultRatio: 0.2,
      minPreviousResults: 5,
      ...(config?.scrapeHealthCheck || {})
    },
    telegram: {
      botToken: "",
      chatId: "",
      enabled: false,
      ...config?.telegram
    },
    digestEmail: {
      enabled: true,
      gmailUser: "",
      gmailAppPassword: "",
      emailTo: "",
      sendTime: "08:00",
      ...config?.digestEmail
    },
    scheduler: {
      enabled: false,
      intervalMinutes: 30,
      jitterSeconds: 45,
      lastRunAt: null,
      nextRunAt: null,
      running: false,
      ...config?.scheduler
    }
  };
}
