import test from "node:test";
import assert from "node:assert/strict";
import { analyzeListingRelevance, analyzeQueryMatch, extractModelFamilies, inferPreciseCategory, labelTrainingEffect, normalizeRefinedRating, parseSearchQuery, querySearchTokens } from "../src/relevanceClassifier.js";

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

test("matches reordered model tokens and compact model numbers", () => {
  const reordered = analyzeQueryMatch({ title: "ASUS GeForce RTX 3070 Dual OC 8GB" }, "3070 rtx");
  const compact = analyzeQueryMatch({ title: "MSI RTX3070 Ventus graphics card" }, "rtx 3070");
  assert.ok(reordered.score >= 90);
  assert.ok(compact.score >= 80);
  assert.deepEqual(querySearchTokens("the RTX-3070 for sale"), ["rtx", "3070"]);
});

test("penalizes wrong categories, accessories, and description-only weak matches", () => {
  const gpu = analyzeQueryMatch({ title: "NVIDIA RTX 3070 Founders Edition", category: "graphics card" }, "rtx 3070");
  const riser = analyzeQueryMatch({ title: "Vertical GPU riser kit for RTX 3070", category: "pc case accessory" }, "rtx 3070");
  const caseListing = analyzeQueryMatch({ title: "Lian Li PC case", description: "Fits RTX 3070", category: "pc case" }, "rtx 3070");
  assert.ok(gpu.score > riser.score);
  assert.ok(gpu.score > caseListing.score);
  assert.ok(riser.flags.includes("query_category_mismatch") || riser.flags.includes("unwanted_accessory"));
});

test("parses exclusions, category directives, and search intent", () => {
  const parsed = parseSearchQuery('rtx 3070 -riser -"vertical kit" type:component category:gpu');
  assert.equal(parsed.search_text, "rtx 3070");
  assert.deepEqual(parsed.exclusions, ["riser", "vertical", "kit"]);
  assert.equal(parsed.intent, "component");
  assert.equal(parsed.category, "graphics card");
});

test("exclusions and intent remove otherwise strong false positives", () => {
  const fullGpu = analyzeQueryMatch({ title: "RTX 3070 graphics card", category: "graphics card" }, "rtx 3070 -riser type:component");
  const riser = analyzeQueryMatch({ title: "RTX 3070 vertical riser kit", category: "pc case accessory" }, "rtx 3070 -riser type:component");
  assert.ok(fullGpu.score >= 80);
  assert.equal(riser.score, 0);
  assert.ok(riser.flags.includes("excluded_term_match"));
});

test("extracts product model families separately from generic tokens", () => {
  assert.deepEqual(extractModelFamilies({ title: "ASUS RTX 4070 Ti Super 16GB" }), ["rtx 4070 ti super"]);
  assert.deepEqual(extractModelFamilies({ title: "AMD Ryzen 7 7800X3D CPU" }), ["ryzen 7 7800x3d"]);
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
