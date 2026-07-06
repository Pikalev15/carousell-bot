import test from "node:test";
import assert from "node:assert/strict";
import { extractDescription, extractLocation, extractRealPriceFromDescription, parseCardText } from "../src/carousellSearch.js";
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

test("extracts actual price from description when card price is placeholder", () => {
  assert.equal(extractRealPriceFromDescription("Placeholder price. Actual price is S$280 firm."), 280);
  assert.equal(extractRealPriceFromDescription("Take all for $45, pickup today."), 45);
});

test("converts USD prices to SGD", () => {
  assert.equal(parseMoney("USD 100").sgd, 135);
  assert.equal(parseMoney("US$200").sgd, 270);
  assert.equal(extractRealPriceFromDescription("Actual price is USD 100 firm."), 135);
});

test("does not treat delivery fees or deposits as item prices", () => {
  assert.equal(extractRealPriceFromDescription("Self collect at Admiralty MRT. Can deliver for additional $5."), 0);
  assert.equal(extractRealPriceFromDescription("$20 deposit for meetup deal. NO DEPOSIT=NO DEAL."), 0);
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

test("estimates MSRP from Google search text and converts USD", () => {
  const result = estimateMsrp("Official price US$100. Used listing $50 on Carousell.", [
    { text: "Official store", href: "https://example.com/product" }
  ]);

  assert.equal(result.msrp, 135);
  assert.equal(result.source, "https://example.com/product");
});
