import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const duplicateUiUrl = new URL("../public/duplicate-ui.js", import.meta.url);

test("dashboard defers heavy hidden-view renders", async () => {
  const source = await readFile(duplicateUiUrl, "utf8");
  assert.match(source, /function viewIsActive\(view\)/);
  assert.match(source, /deferredViewRenders\.add\("listings"\)/);
  assert.match(source, /installDeferredViewRenderers\(\)/);
  assert.match(source, /renderDeferredView\(view\)/);
});

test("listing and search grids render in bounded batches", async () => {
  const source = await readFile(duplicateUiUrl, "utf8");
  assert.match(source, /const LISTING_RENDER_BATCH = 48/);
  assert.match(source, /rendered\.slice\(0, listingRenderLimit\)/);
  assert.match(source, /rendered\.slice\(0, searchRenderLimit\)/);
  assert.match(source, /data-render-more=/);
});

test("text filters are debounced instead of rebuilding grids on every keystroke", async () => {
  const source = await readFile(duplicateUiUrl, "utf8");
  assert.match(source, /FILTER_RENDER_DEBOUNCE_MS = 120/);
  assert.match(source, /event\.stopImmediatePropagation\(\)/);
  assert.match(source, /scheduleViewRender\(view, eventName === "input"/);
});
