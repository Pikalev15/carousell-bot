import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { server } from "../src/server.js";

test("serves health and listings endpoints", async () => {
  const labelsSnapshot = await readFile("data/labels.json", "utf8");
  const searchesSnapshot = await readFile("data/search-history.json", "utf8");
  const modelSnapshot = await readFile("data/training-model.json", "utf8");
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const health = await fetch(`http://localhost:${port}/api/health`).then((response) => response.json());
    const listingsResponse = await fetch(`http://localhost:${port}/api/listings`);
    const listings = await listingsResponse.json();
    const allListings = await fetch(`http://localhost:${port}/api/listings?include_filtered=true`).then((response) => response.json());
    const pricedListings = await fetch(`http://localhost:${port}/api/listings?include_filtered=true&min_price=900&max_price=1200`).then((response) => response.json());
    const recentListings = await fetch(`http://localhost:${port}/api/listings?include_filtered=true&max_age_hours=24`).then((response) => response.json());
    const search = await fetch(`http://localhost:${port}/api/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "MacBook", mode: "local" })
    }).then((response) => response.json());
    const label = await fetch(`http://localhost:${port}/api/feedback/label`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ listing_id: 1, rating: "good", asked_price: 1180 })
    }).then((response) => response.json());
    const spamLabel = await fetch(`http://localhost:${port}/api/feedback/label`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ listing_id: 4, rating: "spam", asked_price: 999 })
    }).then((response) => response.json());
    const badDealLabel = await fetch(`http://localhost:${port}/api/feedback/label`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ listing_id: 2, rating: "bad_deal", asked_price: 980 })
    }).then((response) => response.json());
    const model = await fetch(`http://localhost:${port}/api/training/model`).then((response) => response.json());

    assert.equal(health.ok, true);
    assert.equal(Array.isArray(listings), true, JSON.stringify(listings));
    assert.ok(listings.length > 0);
    assert.equal(listings.some((listing) => listing.current_price === 0), false);
    assert.ok(allListings.length >= listings.length);
    assert.equal(allListings.some((listing) => listing.location === "Carousell SG"), false);
    assert.equal(pricedListings.every((listing) => listing.current_price >= 900 && listing.current_price <= 1200), true);
    assert.equal(recentListings.every((listing) => (listing.listed_age_minutes ?? listing.days_listed * 1440) <= 1440), true);
    assert.equal(search.query, "MacBook");
    assert.equal(Array.isArray(search.results), true);
    assert.equal(label.user_rating, "good");
    assert.equal(spamLabel.user_rating, "spam");
    assert.equal(badDealLabel.user_rating, "bad_deal");
    assert.ok(model.example_count >= 3);
    assert.ok(model.bad_deal_count >= 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await writeFile("data/labels.json", labelsSnapshot, "utf8");
    await writeFile("data/search-history.json", searchesSnapshot, "utf8");
    await writeFile("data/training-model.json", modelSnapshot, "utf8");
  }
});
