import { readFile, writeFile } from "node:fs/promises";

const file = new URL("../src/server.js", import.meta.url);
let source = await readFile(file, "utf8");
let changed = false;

function replaceOnce(target, replacement, label) {
  if (!source.includes(target)) {
    throw new Error(`Could not find target block for ${label}. server.js may have changed.`);
  }
  source = source.replace(target, replacement);
  changed = true;
  console.log(`patched: ${label}`);
}

if (!source.includes('from "./serverSearchDiagnostics.js"')) {
  replaceOnce(
    'import { labelPolarity, predictPreference, trainModel } from "./trainingModel.js";',
    `import { labelPolarity, predictPreference, trainModel } from "./trainingModel.js";\nimport {\n  aggregateWatchedSearchDiagnostics,\n  attachScrapeMetadataToSearchSummary\n} from "./serverSearchDiagnostics.js";`,
    "server diagnostics imports"
  );
} else {
  console.log("skip: server diagnostics imports already present");
}

if (!source.includes("status: webSearch?.status ?? null")) {
  replaceOnce(
    `      warning: webSearch?.warning || null,\n      results: buildListings(state, query, {`,
    `      warning: webSearch?.warning || null,\n      status: webSearch?.status ?? null,\n      ok: webSearch?.ok ?? null,\n      result_count: webSearch?.result_count ?? null,\n      result_count_valid: webSearch?.result_count_valid ?? false,\n      parser: webSearch?.parser ?? null,\n      anchors_found: webSearch?.anchors_found ?? null,\n      next_data_found: webSearch?.next_data_found ?? null,\n      challenge_detected: webSearch?.challenge_detected ?? false,\n      consent_page_detected: webSearch?.consent_page_detected ?? false,\n      diagnostic: webSearch?.diagnostic ?? null,\n      scrape_result: webSearch?.scrape_result ?? null,\n      scrape_results: webSearch?.scrape_results || [],\n      results: buildListings(state, query, {`,
    "/api/search diagnostics response"
  );
} else {
  console.log("skip: /api/search diagnostics response already present");
}

if (!source.includes("return attachScrapeMetadataToSearchSummary({")) {
  replaceOnce(
    `    return {\n      source: "carousell-web",\n      url: webSearch.url,\n      added: additions.length,\n      updated,\n      price_drops: priceDrops.length,\n      job\n    };`,
    `    return attachScrapeMetadataToSearchSummary({\n      source: "carousell-web",\n      url: webSearch.url,\n      added: additions.length,\n      updated,\n      price_drops: priceDrops.length,\n      job,\n      scrape_results: Array.isArray(webSearch.scrape_results) ? webSearch.scrape_results : []\n    }, webSearch, { query });`,
    "searchAndStoreWebResults metadata return"
  );
} else {
  console.log("skip: searchAndStoreWebResults metadata return already present");
}

if (!source.includes("const diagnostics = aggregateWatchedSearchDiagnostics(results")) {
  replaceOnce(
    `  updateWatchedSearchRun(watch.id);\n  return {\n    watch_id: watch.id,\n    query: watch.query,\n    terms,\n    source: "carousell-web",\n    added: results.reduce((total, item) => total + Number(item.added || 0), 0),\n    updated: results.reduce((total, item) => total + Number(item.updated || 0), 0),\n    price_drops: results.reduce((total, item) => total + Number(item.price_drops || 0), 0),\n    jobs: results.map((item) => item.job).filter(Boolean)\n  };`,
    `  updateWatchedSearchRun(watch.id);\n  const diagnostics = aggregateWatchedSearchDiagnostics(results, {\n    query: watch.query,\n    watch_id: watch.id,\n    terms\n  });\n  return {\n    watch_id: watch.id,\n    query: watch.query,\n    terms,\n    source: "carousell-web",\n    added: results.reduce((total, item) => total + Number(item.added || 0), 0),\n    updated: results.reduce((total, item) => total + Number(item.updated || 0), 0),\n    price_drops: results.reduce((total, item) => total + Number(item.price_drops || 0), 0),\n    ...diagnostics,\n    scrape_results: diagnostics.scrape_results,\n    jobs: results.map((item) => item.job).filter(Boolean)\n  };`,
    "runWatchedSearch aggregate diagnostics"
  );
} else {
  console.log("skip: runWatchedSearch aggregate diagnostics already present");
}

if (!changed) {
  console.log("server.js already has direct diagnostics wiring; no changes written");
} else {
  await writeFile(file, source);
  console.log("server.js patched. Run: node --check src/server.js && npm test");
}
