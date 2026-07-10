import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { dashboardAuthHeaders, warnIfDashboardUnauthenticated } from "./dashboardAuth.js";
import { startTelegramCommandPolling } from "./notifier.js";
import { readJson } from "./store.js";
import { server, dailyDigest, buildListings, handleTelegramCommand as coreHandleTelegramCommand } from "./server.js";
import { installPlusRuntime } from "./plusRuntime.js";

const port = Number(process.env.PORT || 3000);
const [originalHandler] = server.listeners("request");
const plusRuntime = installPlusRuntime({
  server,
  originalHandler,
  buildListings,
  coreHandleTelegramCommand
});
let started = false;

export { server };
export const handleTelegramCommand = plusRuntime.handleTelegramCommand;

export function startServer() {
  if (started) return server;
  started = true;
  warnIfDashboardUnauthenticated();
  server.listen(port, () => {
    console.log(`Carousell Bot running at http://localhost:${port}`);
    console.log("Unified routes enabled: core API, Plus dashboard API, exports, start URLs, scoped listings, and Telegram training");
  });
  startOriginalScheduler().catch((error) => console.warn(`Scheduler failed to start: ${error.message}`));
  dailyDigest.start();
  startTelegramCommandPolling(handleTelegramCommand).catch((error) => console.warn(`Telegram command polling failed: ${error.message}`));
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
    request.headers = { host: `localhost:${port}`, "content-type": "application/json", ...dashboardAuthHeaders() };

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
          if (this.statusCode >= 400) return reject(new Error(raw || `Original handler failed (${this.statusCode})`));
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
}
