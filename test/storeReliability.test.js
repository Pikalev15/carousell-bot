import test from "node:test";
import assert from "node:assert/strict";
import { markAlertPayloadsRead, nextRuntimeId } from "../src/storeReliability.js";

test("nextRuntimeId is monotonic under rapid calls", () => {
  const ids = Array.from({ length: 2000 }, () => nextRuntimeId());
  assert.equal(new Set(ids).size, ids.length);
  for (let index = 1; index < ids.length; index += 1) {
    assert.ok(ids[index] > ids[index - 1]);
  }
});

test("markAlertPayloadsRead marks every unread alert without dropping old alerts", () => {
  const alerts = Array.from({ length: 750 }, (_, index) => ({
    id: index + 1,
    title: `Alert ${index + 1}`,
    read_at: index % 3 === 0 ? "2026-01-01T00:00:00.000Z" : null
  }));
  const result = markAlertPayloadsRead(alerts, "2026-07-10T00:00:00.000Z");
  assert.equal(result.alerts.length, 750);
  assert.equal(result.marked, 500);
  assert.equal(result.alerts.every((alert) => alert.read_at), true);
  assert.equal(result.alerts[0].read_at, "2026-01-01T00:00:00.000Z");
  assert.equal(result.alerts[1].read_at, "2026-07-10T00:00:00.000Z");
});
