import { getDatabase } from "../src/store.js";

const db = getDatabase();
const counts = {
  listings: db.prepare("SELECT COUNT(*) AS count FROM listings").get().count,
  filters: db.prepare("SELECT COUNT(*) AS count FROM filters").get().count,
  sellers: db.prepare("SELECT COUNT(*) AS count FROM sellers").get().count,
  labels: db.prepare("SELECT COUNT(*) AS count FROM labels").get().count,
  searches: db.prepare("SELECT COUNT(*) AS count FROM search_history").get().count,
  watchedSearches: db.prepare("SELECT COUNT(*) AS count FROM watched_searches").get().count,
  priceHistory: db.prepare("SELECT COUNT(*) AS count FROM price_history").get().count
};

console.log(JSON.stringify({ ok: true, database: db.name, counts }, null, 2));
