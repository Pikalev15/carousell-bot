import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateTelegramAlertPolicy,
  formatTelegramDigestMessage,
  isQuietHoursActive,
  mergeTelegramAlertSettings,
  selectTelegramDigestAlerts,
  telegramAlertSettings
} from "../src/telegramNotificationPolicy.js";

test("defaults Telegram alert settings for smart quiet-hour digests", () => {
  const settings = telegramAlertSettings({});
  assert.equal(settings.mode, "smart");
  assert.equal(settings.minInstantScore, 75);
  assert.equal(settings.quietHours.enabled, true);
  assert.equal(settings.quietHours.timezone, "Asia/Singapore");
  assert.equal(settings.digest.time, "07:45");
});

test("queues listing alerts during quiet hours without stopping detection", () => {
  const config = mergeTelegramAlertSettings({}, { quietHours: { start: "23:00", end: "07:30", timezone: "Asia/Singapore" } });
  const policy = evaluateTelegramAlertPolicy({ type: "restock", listing_id: 5, score: 91 }, config, new Date("2026-07-10T16:30:00.000Z"));
  assert.equal(isQuietHoursActive(config, new Date("2026-07-10T16:30:00.000Z")), true);
  assert.equal(policy.action, "queue");
  assert.equal(policy.reason, "quiet_hours");
});

test("sends high-score listing alerts outside quiet hours", () => {
  const config = mergeTelegramAlertSettings({}, { quietHours: { start: "23:00", end: "07:30", timezone: "Asia/Singapore" } });
  const policy = evaluateTelegramAlertPolicy({ type: "restock", listing_id: 5, score: 91 }, config, new Date("2026-07-10T04:00:00.000Z"));
  assert.equal(policy.action, "send");
});

test("selects best queued listings for Telegram digest", () => {
  const config = mergeTelegramAlertSettings({}, { digest: { maxItems: 2, minScore: 70 } });
  const alerts = [
    { id: 1, delivery_status: "queued", listing_id: 1, title: "Okay GPU", score: 72, price: 250, created_at: "2026-07-10T01:00:00Z" },
    { id: 2, delivery_status: "queued", listing_id: 2, title: "Best GPU", score: 94, price: 300, created_at: "2026-07-10T02:00:00Z" },
    { id: 3, delivery_status: "queued", listing_id: 3, title: "Weak GPU", score: 50, price: 120, created_at: "2026-07-10T03:00:00Z" },
    { id: 4, delivery_status: "sent_instant", listing_id: 4, title: "Already sent", score: 99, price: 100 }
  ];
  const selected = selectTelegramDigestAlerts(alerts, config);
  assert.deepEqual(selected.selected.map((alert) => alert.id), [2, 1]);
  assert.deepEqual(selected.skipped.map((alert) => alert.id).sort(), [3]);
  assert.match(formatTelegramDigestMessage(selected.selected, selected.queued.length, config), /Best GPU/);
});
