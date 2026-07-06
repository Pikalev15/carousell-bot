import test from "node:test";
import assert from "node:assert/strict";
import { extractDescription, extractRealPriceFromDescription, parseCardText } from "../src/carousellSearch.js";

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
