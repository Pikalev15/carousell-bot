import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const eventPath = join(tmpdir(), `carousell-alert-events-${process.pid}-${Date.now()}.json`);
process.env.CAROUSELL_ALERT_EVENTS_PATH = eventPath;
const health = await import(`../src/scrapeHealth.js?test=${Date.now()}`);

const config = {
  scrapeHealthCheck: {
    enabled: true,
    minPreviousResults: 5,
    minResultRatio: 0.2,
    cooldownMinutes: 360,
    globalSummaryCooldownMinutes: 15,
    repeatAfterOccurrences: 3,
    notifyOnRecovery: true
  }
};

test.after(() => rmSync(eventPath, { force: true }));

test("creates result-drop health events with stable fingerprints", () => {
  const watch = { id: 7, query: "SSD", last_result_count: 48 };
  const result = { status: "success", ok: true, result_count: 2, parser: "DOM + Next data", duration_ms: 14200 };
  const event = health.createScrapeHealthEvent(watch, result, config);
  assert.equal(event.type, "result_drop");
  assert.equal(event.severity, "warning");
  assert.equal(event.current_count, 2);
  assert.equal(event.previous_count, 48);
  assert.equal(event.drop_ratio.toFixed(3), "0.958");
  assert.equal(event.fingerprint, health.createAlertFingerprint(event));
});

test("does not create low-result events without a valid current result count", () => {
  const event = health.createScrapeHealthEvent({ id: 7, query: "SSD", last_result_count: 48 }, { status: "success", added: 0, updated: 0 }, config);
  assert.equal(event, null);
});

test("failed scrapes produce failure events rather than zero-result events", () => {
  const event = health.createScrapeHealthEvent({ id: 8, query: "RTX 3070", last_result_count: 31 }, { status: "blocked", ok: false, result_count: 0, challenge_detected: true }, config);
  assert.equal(event.type, "blocked");
  assert.equal(event.severity, "error");
  assert.equal(event.current_count, 0);
  assert.match(event.message, /bot challenge/i);
});

test("alert fingerprints separate different watches", () => {
  const a = health.createScrapeHealthEvent({ id: 1, query: "SSD", last_result_count: 50 }, { status: "success", ok: true, result_count: 2 }, config);
  const b = health.createScrapeHealthEvent({ id: 2, query: "SSD", last_result_count: 50 }, { status: "success", ok: true, result_count: 2 }, config);
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test("deduplicates identical alerts within cooldown and repeats after occurrence threshold", () => {
  const event = health.createScrapeHealthEvent({ id: 10, query: "MacBook", last_result_count: 40 }, { status: "layout_changed", ok: false }, config);
  const first = health.recordHealthEvent(event, config, new Date("2026-07-10T05:00:00.000Z"));
  const second = health.recordHealthEvent(event, config, new Date("2026-07-10T05:05:00.000Z"));
  const third = health.recordHealthEvent(event, config, new Date("2026-07-10T05:10:00.000Z"));
  assert.equal(first.notify, true);
  assert.equal(second.notify, false);
  assert.equal(third.notify, true);
  assert.equal(third.event.occurrence_count, 3);
});

test("creates recovery transitions after unresolved health events", () => {
  const watch = { id: 11, query: "GPU", last_result_count: 25 };
  const event = health.createScrapeHealthEvent(watch, { status: "timeout", ok: false }, config);
  health.recordHealthEvent(event, config, new Date("2026-07-10T06:00:00.000Z"));
  const recovery = health.recordHealthRecovery(watch, { status: "success", ok: true, result_count: 24 }, config, new Date("2026-07-10T06:30:00.000Z"));
  assert.equal(recovery.type, "recovery");
  assert.equal(recovery.current_count, 24);
  assert.match(recovery.message, /Recovered/i);
});

test("formats individual and summary messages with watch context", () => {
  const event = health.createScrapeHealthEvent({ id: 12, query: "SSD", last_result_count: 48 }, { status: "success", ok: true, result_count: 2, duration_ms: 14200 }, config);
  const individual = health.formatScrapeHealthIndividual(event);
  assert.match(individual, /Watch: SSD/);
  assert.match(individual, /Previous healthy result count: 48/);
  const summary = health.formatScrapeHealthSummary([event], { finished_at: "2026-07-10T05:04:00.000Z", successful: 7, warnings: 1, failed: 0 });
  assert.match(summary, /Scrape health summary/);
  assert.match(summary, /1 watched search/);
  assert.match(summary, /SSD/);
  assert.match(summary, /Successful watches: 7/);
});
