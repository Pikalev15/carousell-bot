import { getDatabase, readJson, writeJson } from "./store.js";

let lastRuntimeId = 0;

export function nextRuntimeId() {
  const candidate = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  if (candidate <= lastRuntimeId) {
    lastRuntimeId += 1;
  } else {
    lastRuntimeId = candidate;
  }
  return lastRuntimeId;
}

export function markAlertPayloadsRead(alerts = [], readAt = new Date().toISOString()) {
  const nextAlerts = (Array.isArray(alerts) ? alerts : []).map((alert) => {
    if (!alert || typeof alert !== "object") return alert;
    if (alert.read_at) return alert;
    return { ...alert, read_at: readAt };
  });
  const marked = nextAlerts.reduce((total, alert, index) => {
    const before = alerts?.[index];
    return total + (before && typeof before === "object" && !before.read_at && nextAlerts[index]?.read_at === readAt ? 1 : 0);
  }, 0);
  return { alerts: nextAlerts, marked, read_at: readAt };
}

export async function markAllAlertsRead(options = {}) {
  const readAt = options.readAt || new Date().toISOString();
  const db = getDatabase();
  if (db) return markAllDatabaseAlertsRead(db, readAt);

  const current = await readJson("alerts");
  const result = markAlertPayloadsRead(current, readAt);
  if (result.marked > 0) await writeJson("alerts", result.alerts);
  return { marked: result.marked, read_at: result.read_at };
}

function markAllDatabaseAlertsRead(db, readAt) {
  const rows = db.prepare("SELECT id, payload FROM alerts WHERE read_at IS NULL").all();
  if (!rows.length) return { marked: 0, read_at: readAt };

  db.exec("BEGIN");
  try {
    const update = db.prepare("UPDATE alerts SET read_at = ?, payload = ? WHERE id = ?");
    for (const row of rows) {
      const payload = safeJson(row.payload) || {};
      const nextPayload = { ...payload, read_at: readAt };
      update.run(readAt, JSON.stringify(nextPayload), row.id);
    }
    db.exec("COMMIT");
    return { marked: rows.length, read_at: readAt };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function safeJson(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}
