import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { server } from "../src/server.js";

test("serves health and listings endpoints", async () => {
  const labelsSnapshot = await readFile("data/labels.json", "utf8");
  const searchesSnapshot = await readFile("data/search-history.json", "utf8");
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const health = await fetch(`http://localhost:${port}/api/health`).then((response) => response.json());
    const listingsResponse = await fetch(`http://localhost:${port}/api/listings`);
    const listings = await listingsResponse.json();
    const search = await fetch(`http://localhost:${port}/api/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "MacBook" })
    }).then((response) => response.json());
    const label = await fetch(`http://localhost:${port}/api/feedback/label`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ listing_id: 1, rating: "good", asked_price: 1180 })
    }).then((response) => response.json());

    assert.equal(health.ok, true);
    assert.equal(Array.isArray(listings), true, JSON.stringify(listings));
    assert.ok(listings.length > 0);
    assert.equal(search.query, "MacBook");
    assert.equal(Array.isArray(search.results), true);
    assert.equal(label.user_rating, "good");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await writeFile("data/labels.json", labelsSnapshot, "utf8");
    await writeFile("data/search-history.json", searchesSnapshot, "utf8");
  }
});
