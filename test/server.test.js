import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("serves core and roadmap API endpoints", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "carousell-bot-"));
  process.env.CAROUSELL_DB_PATH = path.join(tempDir, "test.db");
  const cacheKey = Date.now();
  await assert.doesNotReject(() => import("../src/store.js"));
  const { server, handleTelegramCommand, rankTelegramSearchResults, runWatchedSearch, shouldSuppressAlert } = await import(`../src/server.js?db=${cacheKey}`);
  const { closeDatabase, createAlert } = await import("../src/store.js");
  const { notifyAlert, formatAlertMessage } = await import("../src/notifier.js");
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const health = await getJson(`${base}/api/health`);
    const listings = await getJson(`${base}/api/listings`);
    const allListings = await getJson(`${base}/api/listings?include_filtered=true`);
    const pricedListings = await getJson(`${base}/api/listings?include_filtered=true&min_price=900&max_price=1200`);
    const recentListings = await getJson(`${base}/api/listings?include_filtered=true&max_age_hours=24`);
    const search = await post(`${base}/api/search`, { query: "MacBook", mode: "local" });
    const label = await post(`${base}/api/feedback/label`, { listing_id: 1, rating: "good", asked_price: 1180 });
    const spamLabel = await post(`${base}/api/feedback/label`, { listing_id: 4, rating: "spam", asked_price: 999 });
    const badDealLabel = await post(`${base}/api/feedback/label`, { listing_id: 2, rating: "bad_deal", asked_price: 980 });
    const model = await getJson(`${base}/api/training/model`);
    const priceHistory = await getJson(`${base}/api/listings/1/price-history`);
    const reputation = await getJson(`${base}/api/sellers/seller-100/reputation`);
    const watch = await post(`${base}/api/watchlist`, { query: "lian li", price_ceiling: 120, category: "pc parts", active: true });
    const presets = await patch(`${base}/api/config/category-presets`, { name: "Computers & Tech", terms: "gpu, rtx, custom nas" });
    const categoryWatch = await post(`${base}/api/watchlist`, { query: "Computers & Tech", active: true });
    const callbackLabel = await handleTelegramCommand({ type: "callback", action: "bad_deal", listingId: 1, id: "cb-1", chatId: "42" });
    const callbackBlock = await handleTelegramCommand({ type: "callback", action: "block", listingId: 1, id: "cb-2", chatId: "42" });
    const callbackWatch = await handleTelegramCommand({ type: "callback", action: "watch", listingId: 1, id: "cb-3", chatId: "42" });
    const pausedWatch = await patch(`${base}/api/watchlist/${watch.id}`, { active: false });
    const watchlist = await getJson(`${base}/api/watchlist`);
    const scheduler = await post(`${base}/api/scheduler`, { enabled: false, intervalMinutes: 15, jitterSeconds: 2 });
    const alerts = await getJson(`${base}/api/alerts`);
    const marked = await post(`${base}/api/alerts/mark-read`, {});
    const activity = await getJson(`${base}/api/activity`);
    const telegram = await post(`${base}/api/config/telegram`, { enabled: false, botToken: "12345:testtoken", chatId: "42" });
    const telegramPreserved = await post(`${base}/api/config/telegram`, { enabled: false, botToken: "", chatId: "99" });
    const telegramTest = await post(`${base}/api/telegram/test`, {});
    const fakeDealNotification = await notifyAlert({ type: "new_deal", title: "Fake deal", message: "Test notification path", listing_id: 0 });
    const failedAlertDoesNotSuppress = shouldSuppressAlert({ type: "new_deal", listing_id: 0, watch_id: null });
    createAlert({
      type: "restock",
      title: "Sent deal",
      listing_id: 999,
      watch_id: 42,
      alert_key: "restock:42:999:once",
      sent_at: new Date().toISOString(),
      error: null
    });
    const sentAlertSuppresses = shouldSuppressAlert({ type: "restock", listing_id: 999, watch_id: 42, alert_key: "restock:42:999:once" });
    const fakeDealWithLink = await notifyAlert({
      type: "new_deal",
      title: "Fake deal with link",
      message: "Test notification path",
      listing_id: 5,
      listing_url: "https://www.carousell.sg/p/fake-deal-5"
    });
    const alertsAfterLinkedNotification = await getJson(`${base}/api/alerts`);
    const config = await getJson(`${base}/api/config`);
    const telegramGpuRanked = rankTelegramSearchResults([
      {
        id: 900,
        title: "Lian Li A3-mATX Vertical GPU Kit Gen 4 PCI-E Riser",
        description: "Riser kit only, not a graphics card",
        category: "pc case accessory",
        current_price: 65,
        score: { deal_score: 80 }
      },
      {
        id: 901,
        title: "Nvidia GeForce RTX 3070 Graphics Card",
        description: "Used RTX 3070 GPU in good working condition",
        category: "graphics card",
        current_price: 250,
        score: { deal_score: 45 }
      }
    ], "gpu");

    assert.equal(health.ok, true);
    assert.equal(Array.isArray(listings), true, JSON.stringify(listings));
    assert.ok(listings.length > 0);
    assert.equal(listings.some((listing) => listing.current_price === 0), false);
    assert.ok(allListings.length >= listings.length);
    assert.equal(allListings.some((listing) => listing.location === "Carousell SG"), false);
    assert.ok(allListings.every((listing) => listing.market_insight));
    assert.ok(allListings.every((listing) => listing.duplicate_group_id));
    assert.ok(allListings.some((listing) => listing.score?.explanation?.components));
    assert.equal(pricedListings.every((listing) => listing.current_price >= 900 && listing.current_price <= 1200), true);
    assert.equal(recentListings.every((listing) => (listing.listed_age_minutes ?? listing.days_listed * 1440) <= 1440), true);
    assert.equal(search.query, "MacBook");
    assert.equal(Array.isArray(search.results), true);
    assert.equal(label.user_rating, "good");
    assert.equal(spamLabel.user_rating, "spam");
    assert.equal(badDealLabel.user_rating, "bad_deal");
    assert.ok(model.example_count >= 3);
    assert.ok(model.bad_deal_count >= 1);
    assert.ok(model.seller_stats);
    assert.equal(Array.isArray(priceHistory), true);
    assert.equal(reputation.seller_id, "seller-100");
    assert.equal(watch.query, "lian li");
    assert.deepEqual(presets["Computers & Tech"], ["gpu", "rtx", "custom nas"]);
    assert.equal(categoryWatch.kind, "category");
    assert.ok(categoryWatch.terms.includes("gpu"));
    assert.ok(categoryWatch.terms.includes("custom nas"));
    assert.match(callbackLabel, /Marked bad deal/);
    assert.match(callbackBlock, /Blocked/);
    assert.match(callbackWatch, /Watching similar/);
    assert.equal(pausedWatch.active, false);
    assert.equal(watchlist.some((item) => item.id === watch.id), true);
    assert.equal(scheduler.enabled, false);
    assert.equal(typeof alerts.unread, "number");
    assert.equal(typeof marked.marked, "number");
    assert.equal(Array.isArray(activity), true);
    assert.equal(telegram.botTokenConfigured, true);
    assert.equal(telegramPreserved.botTokenConfigured, true);
    assert.equal(telegramPreserved.chatId, "99");
    assert.equal(telegramTest.ok, false);
    assert.match(telegramTest.reason || telegramTest.error, /Telegram/i);
    assert.equal(fakeDealNotification.result.ok, false);
    assert.equal(fakeDealNotification.alert.error.includes("Telegram"), true);
    assert.equal(failedAlertDoesNotSuppress, false);
    assert.equal(sentAlertSuppresses, true);
    assert.match(runWatchedSearch.toString(), /awaitHydration:\s*true/);
    assert.equal(fakeDealWithLink.alert.listing_url, "https://www.carousell.sg/p/fake-deal-5");
    assert.ok(alertsAfterLinkedNotification.alerts.some((alert) => alert.listing_url === "https://www.carousell.sg/p/fake-deal-5"));
    assert.match(
      formatAlertMessage({ type: "new_deal", title: "Fake deal with link", message: "msg", listing_url: "https://www.carousell.sg/p/fake-deal-5" }),
      /https:\/\/www\.carousell\.sg\/p\/fake-deal-5/
    );
    assert.equal(telegramGpuRanked[0].id, 901);
    assert.equal(config.telegram.botTokenConfigured, true);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    closeDatabase();
    await rm(tempDir, { recursive: true, force: true });
  }
});

function getJson(url) {
  return requestJson("GET", url);
}

function post(url, body) {
  return requestJson("POST", url, body);
}

function patch(url, body) {
  return requestJson("PATCH", url, body);
}

function requestJson(method, url, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? "" : JSON.stringify(body);
    const request = http.request(url, {
      method,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        connection: "close"
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          const parsed = raw ? JSON.parse(raw) : {};
          if (response.statusCode >= 400) {
            reject(new Error(parsed.error || `Request failed (${response.statusCode})`));
            return;
          }
          resolve(parsed);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}
