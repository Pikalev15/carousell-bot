import test from "node:test";
import assert from "node:assert/strict";
import { server } from "../src/server.js";

test("serves health and listings endpoints", async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  const health = await fetch(`http://localhost:${port}/api/health`).then((response) => response.json());
  const listings = await fetch(`http://localhost:${port}/api/listings`).then((response) => response.json());

  assert.equal(health.ok, true);
  assert.equal(Array.isArray(listings), true);
  assert.ok(listings.length > 0);

  await new Promise((resolve) => server.close(resolve));
});
