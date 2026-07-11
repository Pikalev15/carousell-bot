import test from "node:test";
import assert from "node:assert/strict";
import { extractDescription, extractListingsFromHtml, extractLocation, parseCardText } from "../src/carousellSearch.js";
import { parseMoney } from "../src/currency.js";
import { estimateMsrp } from "../src/msrpSearch.js";

test("parses seller, age, title, condition from search card text", () => {
  const parsed = parseCardText(`
    sellername123
    33 minutes ago
    Buyer Protection
    White ATX PC Case with RGB Fans and AIO Cooler
    S$300
    Like new
  `);

  assert.equal(parsed.sellerName, "sellername123");
  assert.equal(parsed.listedAgeMinutes, 33);
  assert.equal(parsed.title, "White ATX PC Case with RGB Fans and AIO Cooler");
  assert.equal(parsed.condition, "Like new");
});

test("converts USD prices to SGD", () => {
  assert.equal(parseMoney("USD 100").sgd, 135);
  assert.equal(parseMoney("US$200").sgd, 270);
});

test("extracts the actual listing description section", () => {
  const body = `
    haoxuans6661970
    33 minutes ago
    Buyer Protection
    White ATX PC Case with RGB Fans and AIO Cooler
    S$300
    Like new
    Description
    Case is Thermaltake "The Tower 300", power supply is 850W gold rated from Deepcool, cpu cooler is an AIO cooler from Corsair and the motherboard is an Asrock A620M Pro with WiFi

    Dm prices if you are interested, can negotiate
    Meet-up
  `;

  assert.equal(
    extractDescription(body, "", "White ATX PC Case with RGB Fans and AIO Cooler"),
    'Case is Thermaltake "The Tower 300", power supply is 850W gold rated from Deepcool, cpu cooler is an AIO cooler from Corsair and the motherboard is an Asrock A620M Pro with WiFi\nDm prices if you are interested, can negotiate'
  );
});

test("extracts location from Carousell meetup section", () => {
  const body = `
    Description
    Lightly used case.
    Meet-up
    Admiralty MRT Station
    Delivery
    Seller's custom delivery
  `;

  assert.equal(extractLocation(body), "Admiralty MRT Station");
});

test("extracts location from Carousell deal method section", () => {
  const body = `
    Deal method
    Meet-up
    One Duchess
    Buyer Protection
  `;

  assert.equal(extractLocation(body), "One Duchess");
});

test("extracts location from map links", () => {
  const links = [
    {
      text: "One Duchess",
      href: "https://www.google.com/maps/place/1.32497485,103.80845555"
    }
  ];

  assert.equal(extractLocation("", "", "", links), "One Duchess");
});

test("extracts location from seller-written description", () => {
  const description = "Self collect at 731690/Admiralty MRT. Can deliver to your place at my convenience for additional $5.";

  assert.equal(extractLocation("", "", description), "731690/Admiralty MRT");
});

test("extracts real listing photos and filters out avatars/logos", () => {
  const html = '<a href="/p/test-item-123"><img src="https://media.carousell.sg/photo1.jpg"><img src="https://media.carousell.sg/avatar-icon.png">Test Item S$100</a>';
  const [listing] = extractListingsFromHtml(html, "test");
  assert.deepEqual(listing.image_urls, ["https://media.carousell.sg/photo1.jpg"]);
});

test("normalizes protocol-relative and root-relative image URLs", () => {
  const html = '<a href="/p/test-item-456"><img src="//media.carousell.sg/photo2.jpg"><img src="/images/photo3.jpg">Another Item S$50</a>';
  const [listing] = extractListingsFromHtml(html, "test");
  assert.deepEqual(listing.image_urls, [
    "https://media.carousell.sg/photo2.jpg",
    "https://www.carousell.sg/images/photo3.jpg"
  ]);
});

test("estimates MSRP from Google search text and converts USD", () => {
  const result = estimateMsrp("Official price US$100. Used listing $50 on Carousell.", [
    { text: "Official store", href: "https://example.com/product" }
  ]);

  assert.equal(result.msrp, 135);
  assert.equal(result.source, "https://example.com/product");
});
