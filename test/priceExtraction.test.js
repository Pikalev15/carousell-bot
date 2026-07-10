import test from "node:test";
import assert from "node:assert/strict";
import { extractLikelySellingPriceFromText } from "../src/priceExtraction.js";

test("keeps listing price and ignores same-day delivery surcharge", () => {
  const text = `
    S$365
    Listing price is fixed
    Description
    Mint condition, check feedback if you have any doubts!
    Free Tracked Courier: 1-2 days delivery via Qxpress / Ninja Van (FOC).
    Same-Day Delivery: Available via Lalamove / GrabExpress at +$15.
    Self-Collection: Available at my convenience.
  `;

  assert.equal(extractLikelySellingPriceFromText(text), 365);
});

test("does not treat delivery-only amounts as an item price", () => {
  assert.equal(
    extractLikelySellingPriceFromText("Same-Day Delivery: Available via Lalamove / GrabExpress at +$15."),
    0
  );
  assert.equal(extractLikelySellingPriceFromText("Courier delivery fee S$8"), 0);
});

test("still extracts explicit selling prices", () => {
  assert.equal(extractLikelySellingPriceFromText("Actual selling price is S$280 firm."), 280);
  assert.equal(extractLikelySellingPriceFromText("Take all for $45, pickup today."), 45);
});
