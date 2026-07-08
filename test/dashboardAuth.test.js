import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function loadCoordinatorFactory() {
  const source = await readFile(new URL("../public/dashboard-auth-core.js", import.meta.url), "utf8");
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename: "dashboard-auth-core.js" });
  return context.createDashboardTokenCoordinator;
}

test("dashboard auth prompts once for concurrent 401s", async () => {
  const createDashboardTokenCoordinator = await loadCoordinatorFactory();
  let asks = 0;
  let stored = "";
  const coordinator = createDashboardTokenCoordinator({
    getStoredToken: () => stored,
    setStoredToken: (token) => {
      stored = token;
    },
    askForToken: async () => {
      asks += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "secret-token";
    }
  });

  const results = await Promise.all(Array.from({ length: 8 }, () => coordinator.acquireToken()));

  assert.equal(asks, 1);
  assert.deepEqual(results, Array(8).fill("secret-token"));
  assert.equal(stored, "secret-token");
});

test("dashboard auth cancel resolves all waiters and future 401s can prompt again", async () => {
  const createDashboardTokenCoordinator = await loadCoordinatorFactory();
  let asks = 0;
  let stored = "";
  const responses = ["", "fresh-token"];
  const coordinator = createDashboardTokenCoordinator({
    getStoredToken: () => stored,
    setStoredToken: (token) => {
      stored = token;
    },
    askForToken: async () => {
      asks += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return responses.shift() || "";
    }
  });

  const cancelled = await Promise.all(Array.from({ length: 6 }, () => coordinator.acquireToken()));
  assert.equal(asks, 1);
  assert.deepEqual(cancelled, Array(6).fill(""));
  assert.equal(stored, "");

  const later = await Promise.all(Array.from({ length: 4 }, () => coordinator.acquireToken()));
  assert.equal(asks, 2);
  assert.deepEqual(later, Array(4).fill("fresh-token"));
  assert.equal(stored, "fresh-token");
});
