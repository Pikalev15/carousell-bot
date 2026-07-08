import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCarousellSearchUrl,
  cleanImageUrls,
  dataCompleteness,
  enrichListingData,
  extractVariations,
  flattenListingForExport,
  inferListingCategory,
  parseCarousellUrl,
  parseStartUrls,
  searchBodyFromStartUrls,
  toCsv
} from "../src/listingDataQuality.js";

test("parses Carousell category URLs into clean category queries", () => {
  const parsed = parseCarousellUrl("https://www.carousell.sg/categories/computers-tech-213/computer-parts-1821");
  assert.equal(parsed.kind, "category_url");
  assert.equal(parsed.query, "computer parts");
});

test("parses search URL filters into backend body", () => {
  const body = searchBodyFromStartUrls({
    startUrls: ["https://www.carousell.sg/search/rtx%203070?price_start=200&price_end=400&location_name=Bishan&condition_v2=USED&range=10&sort_by=price,ascending"]
  });
  assert.equal(body.query, "rtx 3070");
  assert.equal(body.min_price, "200");
  assert.equal(body.max_price, "400");
  assert.equal(body.location, "Bishan");
  assert.equal(body.search_options.condition, "USED");
  assert.equal(body.search_options.range, "10");
  assert.equal(body.search_options.sort_by, "price,ascending");
});

test("detects mixed startUrl batches", () => {
  const parsed = parseStartUrls([
    "https://www.carousell.sg/search/lian%20li",
    "https://www.carousell.sg/categories/mobile-phones-gadgets-215/mobile-phones-5707"
  ]);
  assert.equal(parsed.mode, "mixed");
  assert.equal(parsed.items.length, 2);
});

test("builds filtered Carousell search URLs", () => {
  const url = buildCarousellSearchUrl("computer parts", {
    min_price: 10,
    max_price: 100,
    location: "Tampines",
    range: 8,
    condition: "USED",
    sort_by: "time_created,descending"
  });
  assert.ok(url.includes("/search/computer%20parts?"));
  assert.ok(url.includes("price_start=10"));
  assert.ok(url.includes("location_name=Tampines"));
  assert.ok(url.includes("condition_v2=USED"));
});

test("cleans profile and avatar images while keeping product photos", () => {
  const cleaned = cleanImageUrls([
    "https://media.karousell.com/media/photos/profiles/2024/01/seller.jpg",
    "https://media.karousell.com/media/photos/products/2026/01/gpu.jpg",
    "https://example.com/avatar-icon.png",
    "//media.carousell.sg/media/photos/products/2026/01/case.webp"
  ]);
  assert.deepEqual(cleaned, [
    "https://media.carousell.sg/media/photos/products/2026/01/case.webp",
    "https://media.karousell.com/media/photos/products/2026/01/gpu.jpg"
  ]);
});

test("infers useful PC categories", () => {
  assert.equal(inferListingCategory("MSI RTX 3070 Ventus 2X 8GB"), "graphics card");
  assert.equal(inferListingCategory("Gigabyte B550M DS3H AC AM4 motherboard"), "motherboard");
  assert.equal(inferListingCategory("Lian Li Dan A3 mATX case wood front"), "pc case");
});

test("extracts important product variations", () => {
  const variations = extractVariations({
    title: "RTX 3070 Ti 8GB with Ryzen 5 5600X, 32GB DDR4, 1TB NVMe, ATX case, 750W PSU",
    description: "Includes 120mm reverse fans"
  });
  const values = Object.fromEntries(variations.map((item) => [item.name, item.value]));
  assert.equal(values.gpu_model, "RTX 3070 TI");
  assert.equal(values.cpu_model, "Ryzen 5 5600X");
  assert.equal(values.ram, "32GB");
  assert.equal(values.storage, "1TB");
  assert.equal(values.case_size, "ATX");
  assert.equal(values.psu_wattage, "750W");
  assert.equal(values.fan_orientation, "reverse");
});

test("enriches listings with category, primary image, variations, and completeness", () => {
  const enriched = enrichListingData({
    id: 1,
    title: "RTX 3070 8GB GPU",
    description: "Working GPU with box. Self collect at Bishan.",
    current_price: 280,
    seller_name: "seller",
    location: "Bishan",
    condition: "good",
    carousell_url: "https://www.carousell.sg/p/test-123",
    image_urls: ["https://media.karousell.com/media/photos/products/2026/01/gpu.jpg"]
  });
  assert.equal(enriched.category, "graphics card");
  assert.equal(enriched.primary_image, "https://media.karousell.com/media/photos/products/2026/01/gpu.jpg");
  assert.ok(enriched.variations.some((item) => item.name === "gpu_model" && item.value === "RTX 3070"));
  assert.ok(enriched.data_completeness.percent >= 80);
});

test("CSV export escapes commas, quotes, and newlines", () => {
  const csv = toCsv([{ title: "GPU, \"good\"\nnew line", price: 280 }], ["title", "price"]);
  assert.equal(csv, 'title,price\n"GPU, ""good""\nnew line",280');
});

test("flattenListingForExport includes quality fields", () => {
  const row = flattenListingForExport({
    id: 1,
    title: "Lian Li Dan A3 mATX case",
    description: "Full case with accessories, not just panel.",
    current_price: 85,
    location: "Hougang",
    condition: "good",
    carousell_url: "https://www.carousell.sg/p/test-123",
    image_urls: ["https://media.karousell.com/media/photos/products/2026/01/case.jpg"],
    score: { deal_score: 74, confidence_score: 80, image_score: 100, risk_flags: [] }
  });
  assert.equal(row.category, "pc case");
  assert.equal(row.deal_score, 74);
  assert.equal(row.confidence_score, 80);
  assert.ok(row.data_completeness_percent > 0);
});
