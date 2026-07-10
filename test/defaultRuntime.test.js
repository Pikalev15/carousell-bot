import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const serverPlusSource = await readFile(new URL("../src/server-plus.js", import.meta.url), "utf8");
const serverUnifiedSource = await readFile(new URL("../src/server-unified.js", import.meta.url), "utf8");
const plusRuntimeSource = await readFile(new URL("../src/plusRuntime.js", import.meta.url), "utf8");
const carousellSearchSource = await readFile(new URL("../src/carousellSearch.js", import.meta.url), "utf8");
const refinedFeedbackSource = await readFile(new URL("../public/refined-feedback.js", import.meta.url), "utf8");
const notificationCss = await readFile(new URL("../public/notification-detail.css", import.meta.url), "utf8");

test("default npm runtime uses unified server", () => {
  assert.equal(packageJson.scripts.start, "node src/server-unified.js");
  assert.equal(packageJson.scripts.dev, "node src/server-unified.js");
  assert.equal(packageJson.scripts["start:core"], "node src/server.js");
  assert.equal(packageJson.scripts["start:plus"], "node src/server-unified.js");
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
  assert.match(serverPlusSource, /\.\/server-unified\.js/);
  assert.match(serverPlusSource, /startServer\(\)/);
});

test("plus runtime installer has valid syntax", () => {
  const result = spawnSync(process.execPath, ["--check", "src/plusRuntime.js"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(plusRuntimeSource, /installPlusRuntime/);
  assert.match(plusRuntimeSource, /markAllAlertsRead/);
  assert.match(plusRuntimeSource, /searchDiagnosticsPayload/);
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

test("unified runtime replays JSON request bodies as buffers", () => {
  assert.match(serverUnifiedSource, /Readable\.from\(\[Buffer\.from\(JSON\.stringify\(body \|\| \{\}\)\)\]\)/);
  assert.match(serverUnifiedSource, /chunks\.push\(typeof chunk === "string" \? Buffer\.from\(chunk\) : chunk\)/);
});

test("UI guards placeholder prices and enables alert scrolling", () => {
  assert.match(refinedFeedbackSource, /PLACEHOLDER_PRICES/);
  assert.match(refinedFeedbackSource, /Check desc\./);
  assert.match(refinedFeedbackSource, /price_source === "description"/);
  assert.match(notificationCss, /\.alerts-list[\s\S]*overflow-y:\s*auto/);
  assert.match(notificationCss, /\.alerts-panel[\s\S]*overflow:\s*hidden/);
});
