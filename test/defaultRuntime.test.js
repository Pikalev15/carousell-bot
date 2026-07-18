import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const serverPlusSource = await readFile(new URL("../src/server-plus.js", import.meta.url), "utf8");
const serverUnifiedSource = await readFile(new URL("../src/server-unified.js", import.meta.url), "utf8");
const serverSource = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
const plusRuntimeSource = await readFile(new URL("../src/plusRuntime.js", import.meta.url), "utf8");
const carousellSearchSource = await readFile(new URL("../src/carousellSearch.js", import.meta.url), "utf8");
const storeSource = await readFile(new URL("../src/store.js", import.meta.url), "utf8");
const storeReliabilitySource = await readFile(new URL("../src/storeReliability.js", import.meta.url), "utf8");
const notifierSource = await readFile(new URL("../src/notifier.js", import.meta.url), "utf8");
const indexSource = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const refinedFeedbackSource = await readFile(new URL("../public/refined-feedback.js", import.meta.url), "utf8");
const duplicateUiSource = await readFile(new URL("../public/duplicate-ui.js", import.meta.url), "utf8");
const notificationCss = await readFile(new URL("../public/notification-detail.css", import.meta.url), "utf8");

test("default npm runtime uses unified server", () => {
  assert.equal(packageJson.scripts.start, "node src/server.js");
  assert.equal(packageJson.scripts.dev, "node src/server.js");
  assert.equal(packageJson.scripts["start:core"], "node src/server.js");
  assert.equal(packageJson.scripts["start:plus"], "node src/server.js");
});

test("unified server entrypoint has valid syntax", () => {
  const result = spawnSync(process.execPath, ["--check", "src/server-unified.js"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("plus server shim has valid syntax", () => {
  const result = spawnSync(process.execPath, ["--check", "src/server-plus.js"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(serverPlusSource, /\.\/server\.js/);
  assert.match(serverPlusSource, /startServer/);
});

test("plus runtime installer has valid syntax", () => {
  const result = spawnSync(process.execPath, ["--check", "src/plusRuntime.js"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(plusRuntimeSource, /installPlusRuntime/);
  assert.match(plusRuntimeSource, /markAlertsRead/);
  assert.match(plusRuntimeSource, /bulkUpsertListings\(changedListings\)/);
  assert.doesNotMatch(plusRuntimeSource, /writeJson\("listings", current\)/);
  assert.match(plusRuntimeSource, /searchDiagnosticsPayload/);
});

test("server.js installs unified plus runtime", () => {
  assert.match(serverSource, /installPlusRuntime/);
  assert.match(serverSource, /callOriginalJson/);
  assert.match(serverSource, /dashboardAuthHeaders/);
  assert.match(serverSource, /export function startServer/);
});

test("legacy unified and plus entrypoints are guarded shims", () => {
  assert.match(serverUnifiedSource, /\.\/server\.js/);
  assert.match(serverPlusSource, /\.\/server\.js/);
  assert.match(serverUnifiedSource, /pathToFileURL/);
  assert.match(serverPlusSource, /pathToFileURL/);
});

test("batch feature helper has valid syntax", () => {
  const result = spawnSync(process.execPath, ["--check", "src/batchFeatures.js"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("category median auto tune helper has valid syntax", () => {
  const result = spawnSync(process.execPath, ["--check", "src/categoryMedianAutoTune.js"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("plus hydration helper has valid syntax", () => {
  const result = spawnSync(process.execPath, ["--check", "src/plusHydration.js"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("scrape page diagnostics helper has valid syntax", () => {
  const result = spawnSync(process.execPath, ["--check", "src/scrapePageDiagnostics.js"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("store reliability helper has valid syntax", () => {
  const result = spawnSync(process.execPath, ["--check", "src/storeReliability.js"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("runtime id helper has valid syntax", () => {
  const result = spawnSync(process.execPath, ["--check", "src/runtimeIds.js"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(storeReliabilitySource, /export \{ nextRuntimeId \}/);
});

test("store core mark-read path updates all alerts directly", () => {
  const result = spawnSync(process.execPath, ["--check", "src/store.js"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(storeSource, /function markAlertsRead\(\)/);
  assert.match(storeSource, /readJsonFile\("alerts", \[\]\)/);
  assert.match(storeSource, /json_set/);
  assert.doesNotMatch(storeSource, /getAlerts\(\{ limit: 500 \}\)\.map/);
});

test("notifier uses runtime ids for persisted alerts", () => {
  const result = spawnSync(process.execPath, ["--check", "src/notifier.js"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(notifierSource, /nextRuntimeId/);
  assert.match(notifierSource, /id:\s*alert\.id \|\| nextRuntimeId\(\)/);
});

test("carousell search emits scrape diagnostics", () => {
  const result = spawnSync(process.execPath, ["--check", "src/carousellSearch.js"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(carousellSearchSource, /classifyScrapeStatus/);
  assert.match(carousellSearchSource, /result_count:\s*scrapeResult\.result_count/);
  assert.match(carousellSearchSource, /diagnostic:\s*scrapeResult\.diagnostic/);
  assert.match(carousellSearchSource, /scrape_result:\s*scrapeResult/);
});

test("refined feedback UI script has valid syntax", () => {
  const result = spawnSync(process.execPath, ["--check", "public/refined-feedback.js"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("duplicate collapse UI script has valid syntax", () => {
  const result = spawnSync(process.execPath, ["--check", "public/duplicate-ui.js"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("likes UI script has valid syntax", () => {
  const result = spawnSync(process.execPath, ["--check", "public/likes-ui.js"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("enhancement scripts are loaded exactly once", () => {
  assert.equal((indexSource.match(/src="\/duplicate-ui\.js"/g) || []).length, 1);
  assert.equal((indexSource.match(/src="\/likes-ui\.js"/g) || []).length, 1);
  assert.doesNotMatch(refinedFeedbackSource, /createElement\("script"\)/);
});

test("hydration has one client controller and alert errors are deduplicated", () => {
  assert.match(appSource, /async function pollSearchJob/);
  assert.match(appSource, /alertsMarkReadPending/);
  assert.match(appSource, /dataset\.dedupeKey/);
  assert.doesNotMatch(duplicateUiSource, /async function pollSearchJob/);
  assert.doesNotMatch(duplicateUiSource, /async function runSearch/);
});

test("UI guards placeholder prices and enables alert scrolling", () => {
  assert.match(refinedFeedbackSource, /PLACEHOLDER_PRICES/);
  assert.match(refinedFeedbackSource, /Check desc\./);
  assert.doesNotMatch(refinedFeedbackSource, /price_source === "description"/);
  assert.match(notificationCss, /\.alerts-list[\s\S]*overflow-y:\s*auto/);
  assert.match(notificationCss, /\.alerts-panel[\s\S]*overflow:\s*hidden/);
});
