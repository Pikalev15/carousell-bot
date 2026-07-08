import test from "node:test";
import assert from "node:assert/strict";
import { analyzeListingRelevance, inferPreciseCategory, labelTrainingEffect, normalizeRefinedRating } from "../src/relevanceClassifier.js";

test("classifies Lian Li Dan A3 as pc case before graphics card", () => {
  assert.equal(inferPreciseCategory({ title: "Lian Li Dan A3 mATX Case Black with Wood Panel" }), "pc case");
});

test("classifies vertical GPU kit as case accessory", () => {
  assert.equal(inferPreciseCategory({ title: "Lian Li A3-mATX Vertical GPU Kit Gen 4 PCI-E Riser" }), "pc case accessory");
  const relevance = analyzeListingRelevance({ title: "Lian Li A3-mATX Vertical GPU Kit Gen 4 PCI-E Riser", description: "Riser kit only, not the full case" }, "lian li dan a3");
  assert.equal(relevance.type, "accessory_only");
  assert.ok(relevance.flags.includes("accessory_only"));
  assert.ok(relevance.score < 70);
});

test("detects buyback posts as WTB/service", () => {
  const relevance = analyzeListingRelevance({ title: "BUY BACK PC PARTS", description: "Looking to buy GPUs CPUs RAM SSD. Send me what you have for a fast offer." }, "computer parts");
  assert.equal(inferPreciseCategory({ title: "BUY BACK PC PARTS", description: "Looking to buy GPUs CPUs RAM SSD" }), "service/wtb");
  assert.equal(relevance.type, "wtb_or_service");
  assert.ok(relevance.flags.includes("wtb_or_service"));
  assert.ok(relevance.score < 35);
});

test("detects irrelevant school book listings", () => {
  const relevance = analyzeListingRelevance({ title: "Brand New KKIS Grade 1 English Math Computer Science Books", description: "Workbook bundle for young learners." }, "computer parts");
  assert.equal(inferPreciseCategory({ title: "Grade 1 Computer Science workbook" }), "irrelevant");
  assert.equal(relevance.type, "irrelevant");
  assert.ok(relevance.flags.includes("irrelevant_school_book"));
  assert.ok(relevance.score < 25);
});

test("marks retro laptop collectibles as lower relevance", () => {
  const relevance = analyzeListingRelevance({ title: "Retro Dell Latitude laptop vintage showpiece", description: "No power cable, working status unknown, for teaching tools and movie props." }, "computer parts");
  assert.ok(relevance.flags.includes("collectible_or_display_item"));
  assert.ok(relevance.flags.includes("faulty_or_for_parts"));
  assert.ok(relevance.score < 50);
});

test("normalizes legacy feedback labels", () => {
  assert.equal(normalizeRefinedRating("good"), "good_deal");
  assert.equal(normalizeRefinedRating("skip"), "irrelevant");
  assert.equal(normalizeRefinedRating("duplicate_listing"), "duplicate_listing");
  assert.equal(normalizeRefinedRating("unknown_label"), "");
});

test("assigns training effects for refined labels", () => {
  assert.equal(labelTrainingEffect("great_deal").polarity, 1);
  assert.equal(labelTrainingEffect("wtb_service").polarity, -1);
  assert.ok(labelTrainingEffect("wtb_service").strength > labelTrainingEffect("bad_deal").strength);
});
