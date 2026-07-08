import test from "node:test";
import assert from "node:assert/strict";
import { applyScopedDuplicateInfo, duplicateImageIdentity, DUPLICATE_GROUP_LOOKBACK_DAYS } from "../src/duplicateGroups.js";

const baseDate = "2026-07-08T00:00:00.000Z";

function listing(overrides) {
  return {
    id: overrides.id,
    title: overrides.title || "RTX 3070 Gaming X Trio",
    category: overrides.category || "graphics card",
    seller_id: overrides.seller_id || "seller-a",
    current_price: overrides.current_price || 300,
    scraped_at: overrides.scraped_at || baseDate,
    image_urls: overrides.image_urls || [],
    ...overrides
  };
}

test("different image paths with identical query strings are not grouped", () => {
  const query = "?impolicy=resize&width=640&height=640&quality=80";
  const items = applyScopedDuplicateInfo([
    listing({ id: 1, seller_id: "seller-a", image_urls: [`https://media.karousell.com/media/photos/products/photo-a.jpg${query}`] }),
    listing({ id: 2, seller_id: "seller-b", image_urls: [`https://media.karousell.com/media/photos/products/photo-b.jpg${query}`] })
  ]);

  assert.notEqual(duplicateImageIdentity(items[0].image_urls[0]), duplicateImageIdentity(items[1].image_urls[0]));
  assert.equal(items[0].duplicate_count, 1);
  assert.equal(items[1].duplicate_count, 1);
  assert.notEqual(items[0].duplicate_group_id, items[1].duplicate_group_id);
});

test("same image path with different query strings is grouped", () => {
  const path = "https://media.karousell.com/media/photos/products/shared-photo.jpg";
  const items = applyScopedDuplicateInfo([
    listing({ id: 1, image_urls: [`${path}?impolicy=resize&width=320`] }),
    listing({ id: 2, image_urls: [`${path}?impolicy=resize&width=960`] })
  ]);

  assert.equal(duplicateImageIdentity(items[0].image_urls[0]), duplicateImageIdentity(items[1].image_urls[0]));
  assert.equal(items[0].duplicate_group_id, items[1].duplicate_group_id);
  assert.equal(items[0].duplicate_count, 2);
  assert.equal(items[1].duplicate_count, 2);
});

test("image match alone does not group unrelated categories", () => {
  const path = "https://media.karousell.com/media/photos/products/shared-photo.jpg";
  const items = applyScopedDuplicateInfo([
    listing({ id: 1, category: "graphics card", title: "RTX 3070", image_urls: [path] }),
    listing({ id: 2, category: "pc case", title: "Lian Li Dan A3", image_urls: [path] })
  ]);

  assert.equal(items[0].duplicate_count, 1);
  assert.equal(items[1].duplicate_count, 1);
});

test("old listings outside the lookback window are not grouped", () => {
  const path = "https://media.karousell.com/media/photos/products/shared-photo.jpg";
  const items = applyScopedDuplicateInfo([
    listing({ id: 1, scraped_at: "2026-07-08T00:00:00.000Z", image_urls: [path] }),
    listing({ id: 2, scraped_at: "2026-05-01T00:00:00.000Z", image_urls: [path] })
  ]);

  assert.equal(DUPLICATE_GROUP_LOOKBACK_DAYS, 30);
  assert.equal(items[0].duplicate_count, 1);
  assert.equal(items[1].duplicate_count, 1);
});
