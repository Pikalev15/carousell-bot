import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "data");
const dbPath = process.env.CAROUSELL_DB_PATH || path.join(dataDir, "carousell-bot.db");

const jsonPaths = {
  listings: path.join(dataDir, "listings.json"),
  filters: path.join(dataDir, "filters.json"),
  sellers: path.join(dataDir, "seller-blacklist.json"),
  config: path.join(dataDir, "config.json"),
  labels: path.join(dataDir, "labels.json"),
  searches: path.join(dataDir, "search-history.json"),
  trainingModel: path.join(dataDir, "training-model.json")
};

const db = openDatabase();
ensureSchema();
migrateJsonIfNeeded();

export function getDatabase() {
  return db;
}

export function closeDatabase() {
  db.close();
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
  return { listings, filters, sellers, config, labels, trainingModel, searches, watchedSearches, alerts };
}

export function upsertListing(listing) {
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

  return getListingById(next.id);
}

export function bulkUpsertListings(listings) {
  const tx = db.transaction((items) => items.map((item) => upsertListing(item)));
  return tx(listings);
}

export function getListingById(id) {
  const row = db.prepare("SELECT payload FROM listings WHERE id = ?").get(Number(id));
  return row ? parsePayload(row.payload) : null;
}

export function getListingByCarousellId(carousellId) {
  if (!carousellId) return null;
  const row = db.prepare("SELECT payload FROM listings WHERE carousell_id = ?").get(carousellId);
  return row ? parsePayload(row.payload) : null;
}

export function addPriceHistory(listingId, price, recordedAt = new Date().toISOString()) {
  if (!listingId || Number(price || 0) < 0) return null;
  const previous = db.prepare("SELECT price FROM price_history WHERE listing_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 1").get(Number(listingId));
  if (previous && Number(previous.price) === Number(price)) return previous;
  return db.prepare("INSERT INTO price_history (listing_id, price, recorded_at) VALUES (?, ?, ?)").run(Number(listingId), Number(price || 0), recordedAt);
}

export function getPriceHistory(listingId) {
  return db
    .prepare("SELECT listing_id, price, recorded_at FROM price_history WHERE listing_id = ? ORDER BY recorded_at ASC, id ASC")
    .all(Number(listingId));
}

export function getWatchedSearches() {
  return db
    .prepare("SELECT payload FROM watched_searches ORDER BY active DESC, updated_at DESC")
    .all()
    .map((row) => parsePayload(row.payload));
}

export function getWatchedSearch(id) {
  const row = db.prepare("SELECT payload FROM watched_searches WHERE id = ?").get(Number(id));
  return row ? parsePayload(row.payload) : null;
}

export function upsertWatchedSearch(input) {
  const now = new Date().toISOString();
  const existing = input.id ? getWatchedSearch(input.id) : null;
  const next = {
    id: existing?.id || input.id || nextWatchedSearchId(),
    query: String(input.query || existing?.query || "").trim(),
    price_ceiling: input.price_ceiling === "" || input.price_ceiling === null || input.price_ceiling === undefined ? null : Number(input.price_ceiling),
    category: String(input.category || existing?.category || "").trim(),
    active: input.active === undefined ? existing?.active ?? true : Boolean(input.active),
    created_at: existing?.created_at || now,
    updated_at: now,
    last_run_at: input.last_run_at || existing?.last_run_at || null
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
  return getWatchedSearch(next.id);
}

export function deleteWatchedSearch(id) {
  return db.prepare("DELETE FROM watched_searches WHERE id = ?").run(Number(id)).changes;
}

export function updateWatchedSearchRun(id, lastRunAt = new Date().toISOString()) {
  const watched = getWatchedSearch(id);
  if (!watched) return null;
  return upsertWatchedSearch({ ...watched, last_run_at: lastRunAt });
}

export function getAlerts({ unreadOnly = false, limit = 40 } = {}) {
  const where = unreadOnly ? "WHERE read_at IS NULL" : "";
  return db
    .prepare(`SELECT payload FROM alerts ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(Number(limit))
    .map((row) => parsePayload(row.payload));
}

export function createAlert(input) {
  const now = new Date().toISOString();
  const next = {
    id: input.id || Date.now(),
    type: input.type || "deal",
    title: input.title || "Carousell alert",
    message: input.message || "",
    listing_id: input.listing_id || null,
    watch_id: input.watch_id || null,
    created_at: input.created_at || now,
    read_at: input.read_at || null,
    sent_at: input.sent_at || null
  };
  db.prepare(`
    INSERT INTO alerts (id, type, title, message, listing_id, watch_id, created_at, read_at, sent_at, payload)
    VALUES (@id, @type, @title, @message, @listing_id, @watch_id, @created_at, @read_at, @sent_at, @payload)
    ON CONFLICT(id) DO UPDATE SET read_at = excluded.read_at, sent_at = excluded.sent_at, payload = excluded.payload
  `).run(alertRow(next));
  return next;
}

export function markAlertsRead() {
  const readAt = new Date().toISOString();
  const alerts = getAlerts({ limit: 500 }).map((alert) => ({ ...alert, read_at: alert.read_at || readAt }));
  const tx = db.transaction((items) => {
    for (const alert of items) db.prepare("UPDATE alerts SET read_at = ?, payload = ? WHERE id = ?").run(alert.read_at, JSON.stringify(alert), alert.id);
  });
  tx(alerts);
  return { marked: alerts.length, read_at: readAt };
}

export function addActivity(input) {
  const next = {
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
  return next;
}

export function getActivity(limit = 50) {
  return db.prepare("SELECT payload FROM activity ORDER BY timestamp DESC, id DESC LIMIT ?").all(Number(limit)).map((row) => parsePayload(row.payload));
}

function openDatabase() {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const database = new Database(dbPath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
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
  const tx = db.transaction(() => {
    writeCollection("listings", readJsonFile("listings", []));
    writeCollection("filters", readJsonFile("filters", []));
    writeCollection("sellers", readJsonFile("sellers", []));
    writeCollection("labels", readJsonFile("labels", []));
    writeCollection("searches", readJsonFile("searches", []));
    writeCollection("config", withConfigDefaults(readJsonFile("config", {})));
    writeCollection("trainingModel", readJsonFile("trainingModel", {}));
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('__json_migrated', ?)").run(new Date().toISOString());
  });
  tx();
}

function readCollection(name) {
  if (name === "listings") return db.prepare("SELECT payload FROM listings ORDER BY id ASC").all().map((row) => parsePayload(row.payload));
  if (name === "filters") return db.prepare("SELECT payload FROM filters ORDER BY id ASC").all().map((row) => parsePayload(row.payload));
  if (name === "sellers") return db.prepare("SELECT payload FROM sellers ORDER BY blocked_at DESC, seller_id ASC").all().map((row) => parsePayload(row.payload));
  if (name === "labels") return db.prepare("SELECT payload FROM labels ORDER BY timestamp ASC").all().map((row) => parsePayload(row.payload));
  if (name === "searches") return db.prepare("SELECT payload FROM search_history ORDER BY timestamp DESC, id DESC").all().map((row) => parsePayload(row.payload));
  if (name === "config") return withConfigDefaults(parsePayload(db.prepare("SELECT value FROM config WHERE key = 'main'").get()?.value || "{}"));
  if (name === "trainingModel") return parsePayload(db.prepare("SELECT value FROM training_model WHERE key = 'main'").get()?.value || "{}");
  throw new Error(`Unknown store collection: ${name}`);
}

function writeCollection(name, value) {
  if (name === "listings") return replaceRows("listings", value, listingRow);
  if (name === "filters") return replaceRows("filters", value, filterRow);
  if (name === "sellers") return replaceRows("sellers", value, sellerRow);
  if (name === "labels") return replaceRows("labels", value, labelRow);
  if (name === "searches") return replaceRows("search_history", value, searchRow);
  if (name === "config") {
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('main', ?)").run(JSON.stringify(withConfigDefaults(value)));
    return;
  }
  if (name === "trainingModel") {
    db.prepare("INSERT OR REPLACE INTO training_model (key, value) VALUES ('main', ?)").run(JSON.stringify(value || {}));
    return;
  }
  throw new Error(`Unknown store collection: ${name}`);
}

function replaceRows(table, rows, rowMapper) {
  const items = Array.isArray(rows) ? rows : [];
  const tx = db.transaction((values) => {
    db.prepare(`DELETE FROM ${table}`).run();
    for (const item of values) insertRow(table, rowMapper(item));
  });
  tx(items);
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
    ...alert,
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
  return Number(db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM listings").get().id);
}

function nextWatchedSearchId() {
  return Number(db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM watched_searches").get().id);
}

function readJsonFile(name, fallback) {
  const filePath = jsonPaths[name];
  if (!filePath || !existsSync(filePath)) return fallback;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function parsePayload(value) {
  return JSON.parse(value || "null");
}

function withConfigDefaults(config) {
  return {
    ...(config || {}),
    telegram: {
      botToken: "",
      chatId: "",
      enabled: false,
      ...config?.telegram
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
