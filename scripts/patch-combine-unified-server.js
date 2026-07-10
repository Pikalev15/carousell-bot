import { readFile, writeFile } from "node:fs/promises";

const files = {
  server: new URL("../src/server.js", import.meta.url),
  serverUnified: new URL("../src/server-unified.js", import.meta.url),
  serverPlus: new URL("../src/server-plus.js", import.meta.url),
  packageJson: new URL("../package.json", import.meta.url),
  defaultRuntimeTest: new URL("../test/defaultRuntime.test.js", import.meta.url)
};

async function main() {
  await patchServerJs();
  await patchRuntimeShims();
  await patchPackageJson();
  await patchDefaultRuntimeTest();
  console.log("Combined unified runtime into src/server.js beta layout.");
  console.log("Next: node --check src/server.js && npm test");
}

async function patchServerJs() {
  let source = await readFile(files.server, "utf8");

  if (!source.includes('import { Readable } from "node:stream";')) {
    source = source.replace('import http from "node:http";\n', 'import http from "node:http";\nimport { Readable } from "node:stream";\n');
  }

  source = source.replace(
    'import { fileURLToPath, pathToFileURL } from "node:url";',
    'import { fileURLToPath, pathToFileURL } from "node:url";'
  );

  source = source.replace(
    'import { authorizeDashboardRequest, warnIfDashboardUnauthenticated } from "./dashboardAuth.js";',
    'import { authorizeDashboardRequest, dashboardAuthHeaders, warnIfDashboardUnauthenticated } from "./dashboardAuth.js";'
  );

  if (!source.includes('import { installPlusRuntime } from "./plusRuntime.js";')) {
    source = source.replace(
      'import { SearchScheduler } from "./scheduler.js";\n',
      'import { SearchScheduler } from "./scheduler.js";\nimport { installPlusRuntime } from "./plusRuntime.js";\nimport { aggregateWatchedSearchDiagnostics, attachScrapeMetadataToSearchSummary } from "./serverSearchDiagnostics.js";\n'
    );
  }

  source = source.replace(
    /if \(import\.meta\.url === pathToFileURL\(process\.argv\[1\] \|\| ""\)\.href\) \{\n  warnIfDashboardUnauthenticated\(\);\n  server\.listen\(port, \(\) => \{\n    console\.log\(`Carousell Bot running at http:\/\/localhost:\$\{port\}`\);\n  \}\);\n  scheduler\.start\(\)\.catch\(\(error\) => console\.warn\(`Scheduler failed to start: \$\{error\.message\}`\)\);\n  dailyDigest\.start\(\);\n  startTelegramCommandPolling\(handleTelegramCommand\)\.catch\(\(error\) => console\.warn\(`Telegram command polling failed: \$\{error\.message\}`\)\);\n\}\n\nexport \{ server, dailyDigest, buildListings, buildDuplicateGroups, buildMarketInsights, handleTelegramCommand, rankTelegramSearchResults, runWatchedSearch, shouldSuppressAlert \};/,
    `const [originalHandler] = server.listeners("request");
const plusRuntime = installPlusRuntime({
  server,
  originalHandler,
  buildListings,
  coreHandleTelegramCommand: handleCoreTelegramCommand
});
const handleTelegramCommand = plusRuntime.handleTelegramCommand;
let started = false;

export { server, dailyDigest, buildListings, buildDuplicateGroups, buildMarketInsights, handleTelegramCommand, rankTelegramSearchResults, runWatchedSearch, shouldSuppressAlert, startServer };

export function startServer() {
  if (started) return server;
  started = true;
  warnIfDashboardUnauthenticated();
  server.listen(port, () => {
    console.log(\`Carousell Bot running at http://localhost:\${port}\`);
    console.log("Unified routes enabled: core API, Plus dashboard API, exports, start URLs, scoped listings, and Telegram training");
  });
  startOriginalScheduler().catch((error) => console.warn(\`Scheduler failed to start: \${error.message}\`));
  dailyDigest.start();
  startTelegramCommandPolling(handleTelegramCommand).catch((error) => console.warn(\`Telegram command polling failed: \${error.message}\`));
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  startServer();
}

async function startOriginalScheduler() {
  const config = await readJson("config");
  if (!config.scheduler?.enabled) return;
  await callOriginalJson("POST", "/api/scheduler", {
    enabled: true,
    intervalMinutes: config.scheduler.intervalMinutes || 30,
    jitterSeconds: config.scheduler.jitterSeconds || 45
  });
}

async function callOriginalJson(method, url, body) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    const request = Readable.from([Buffer.from(JSON.stringify(body || {}))]);
    request.method = method;
    request.url = url;
    request.headers = { host: \`localhost:\${port}\`, "content-type": "application/json", ...dashboardAuthHeaders() };

    const response = {
      headersSent: false,
      statusCode: 200,
      writeHead(status) {
        this.headersSent = true;
        this.statusCode = status;
        return this;
      },
      write(chunk) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      },
      end(chunk) {
        try {
          if (chunk) this.write(chunk);
          const raw = Buffer.concat(chunks).toString("utf8");
          if (this.statusCode >= 400) return reject(new Error(raw || \`Original handler failed (\${this.statusCode})\`));
          resolve(raw ? JSON.parse(raw) : {});
        } catch (error) {
          reject(error);
        }
      },
      on(event, handler) {
        if (event === "error") this._onError = handler;
        return this;
      }
    };

    Promise.resolve(originalHandler(request, response)).catch(reject);
  });
}`
  );

  source = source.replace(
    /      warning: webSearch\?\.warning \|\| null,\n      results: buildListings\(state, query, \{/,
    '      warning: webSearch?.warning || null,\n      ...(webSearch || {}),\n      source: webSearch?.source || "local",\n      source_url: webSearch?.url || null,\n      added: webSearch?.added || 0,\n      updated: webSearch?.updated || 0,\n      hydration_job: webSearch?.job || null,\n      results: buildListings(state, query, {'
  );

  source = source.replace(
    /      source: webSearch\?\.source \|\| "local",\n      source_url: webSearch\?\.url \|\| null,\n      added: webSearch\?\.added \|\| 0,\n      updated: webSearch\?\.updated \|\| 0,\n      hydration_job: webSearch\?\.job \|\| null,\n      warning: webSearch\?\.warning \|\| null,\n      \.\.\.\(webSearch \|\| \{\}\),\n      source: webSearch\?\.source \|\| "local",\n      source_url: webSearch\?\.url \|\| null,\n      added: webSearch\?\.added \|\| 0,\n      updated: webSearch\?\.updated \|\| 0,\n      hydration_job: webSearch\?\.job \|\| null,/,
    '      ...(webSearch || {}),\n      source: webSearch?.source || "local",\n      source_url: webSearch?.url || null,\n      added: webSearch?.added || 0,\n      updated: webSearch?.updated || 0,\n      hydration_job: webSearch?.job || null,\n      warning: webSearch?.warning || null,'
  );

  source = source.replace(
    /    return \{\n      source: "carousell-web",\n      url: webSearch\.url,\n      added: additions\.length,\n      updated,\n      price_drops: priceDrops\.length,\n      job\n    \};/,
    `    return attachScrapeMetadataToSearchSummary({
      source: "carousell-web",
      url: webSearch.url,
      added: additions.length,
      updated,
      price_drops: priceDrops.length,
      job
    }, webSearch, { query });`
  );

  source = source.replace(
    /async function runWatchedSearch\(watch\) \{([\s\S]*?)  updateWatchedSearchRun\(watch\.id\);\n  return \{\n    watch_id: watch\.id,\n    query: watch\.query,\n    terms,\n    source: "carousell-web",\n    added: results\.reduce\(\(total, item\) => total \+ Number\(item\.added \|\| 0\), 0\),\n    updated: results\.reduce\(\(total, item\) => total \+ Number\(item\.updated \|\| 0\), 0\),\n    price_drops: results\.reduce\(\(total, item\) => total \+ Number\(item\.price_drops \|\| 0\), 0\),\n    jobs: results\.map\(\(item\) => item\.job\)\.filter\(Boolean\)\n  \};\n\}/,
    `async function runWatchedSearch(watch) {$1  updateWatchedSearchRun(watch.id);
  const summary = {
    watch_id: watch.id,
    query: watch.query,
    terms,
    source: "carousell-web",
    added: results.reduce((total, item) => total + Number(item.added || 0), 0),
    updated: results.reduce((total, item) => total + Number(item.updated || 0), 0),
    price_drops: results.reduce((total, item) => total + Number(item.price_drops || 0), 0),
    jobs: results.map((item) => item.job).filter(Boolean)
  };
  const diagnostics = aggregateWatchedSearchDiagnostics(results, {
    query: watch.query,
    watch_id: watch.id
  });
  return {
    ...summary,
    ...diagnostics,
    scrape_results: diagnostics.scrape_results
  };
}`
  );

  source = source.replace(/async function handleTelegramCommand\(text\) \{/, "async function handleCoreTelegramCommand(text) {");

  if (!source.includes("installPlusRuntime")) {
    throw new Error("server.js patch failed: plus runtime import missing");
  }
  if (!source.includes("export function startServer()")) {
    throw new Error("server.js patch failed: startServer missing");
  }
  if (!source.includes("attachScrapeMetadataToSearchSummary")) {
    throw new Error("server.js patch failed: search diagnostics helper missing");
  }
  if (!source.includes("aggregateWatchedSearchDiagnostics")) {
    throw new Error("server.js patch failed: watched diagnostics helper missing");
  }
  if (!source.includes("async function handleCoreTelegramCommand(text)")) {
    throw new Error("server.js patch failed: core Telegram handler was not renamed");
  }

  await writeFile(files.server, source);
}

async function patchRuntimeShims() {
  const guardedShim = `import { pathToFileURL } from "node:url";
import { startServer } from "./server.js";

export { server, handleTelegramCommand, startServer } from "./server.js";

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  startServer();
}
`;
  await writeFile(files.serverUnified, guardedShim);
  await writeFile(files.serverPlus, guardedShim);
}

async function patchPackageJson() {
  const pkg = JSON.parse(await readFile(files.packageJson, "utf8"));
  pkg.scripts.start = "node src/server.js";
  pkg.scripts.dev = "node src/server.js";
  pkg.scripts["start:plus"] = "node src/server.js";
  pkg.scripts["start:core"] = "node src/server.js";
  await writeFile(files.packageJson, `${JSON.stringify(pkg, null, 2)}\n`);
}

async function patchDefaultRuntimeTest() {
  let source = await readFile(files.defaultRuntimeTest, "utf8");

  if (!source.includes("serverSource")) {
    source = source.replace(
      'const serverUnifiedSource = await readFile(new URL("../src/server-unified.js", import.meta.url), "utf8");\n',
      'const serverUnifiedSource = await readFile(new URL("../src/server-unified.js", import.meta.url), "utf8");\nconst serverSource = await readFile(new URL("../src/server.js", import.meta.url), "utf8");\n'
    );
  }

  source = source.replace(
    '  assert.equal(packageJson.scripts.start, "node src/server-unified.js");\n  assert.equal(packageJson.scripts.dev, "node src/server-unified.js");\n  assert.equal(packageJson.scripts["start:core"], "node src/server.js");\n  assert.equal(packageJson.scripts["start:plus"], "node src/server-unified.js");',
    '  assert.equal(packageJson.scripts.start, "node src/server.js");\n  assert.equal(packageJson.scripts.dev, "node src/server.js");\n  assert.equal(packageJson.scripts["start:core"], "node src/server.js");\n  assert.equal(packageJson.scripts["start:plus"], "node src/server.js");'
  );

  if (!source.includes('test("server.js installs unified plus runtime"')) {
    source = source.replace(
      `test("unified runtime installs plus routes and preserves scheduler replay", () => {\n  assert.match(serverUnifiedSource, /installPlusRuntime/);\n  assert.match(serverUnifiedSource, /callOriginalJson/);\n  assert.match(serverUnifiedSource, /dashboardAuthHeaders/);\n});`,
      `test("server.js installs unified plus runtime", () => {\n  assert.match(serverSource, /installPlusRuntime/);\n  assert.match(serverSource, /callOriginalJson/);\n  assert.match(serverSource, /dashboardAuthHeaders/);\n  assert.match(serverSource, /export function startServer/);\n});\n\ntest("legacy unified and plus entrypoints are guarded shims", () => {\n  assert.match(serverUnifiedSource, /\.\/server\.js/);\n  assert.match(serverPlusSource, /\.\/server\.js/);\n  assert.match(serverUnifiedSource, /pathToFileURL/);\n  assert.match(serverPlusSource, /pathToFileURL/);\n});`
    );
  }

  await writeFile(files.defaultRuntimeTest, source);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
