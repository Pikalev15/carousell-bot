import { getDatabase, readJson, writeJson } from "./store.js";

let lastRuntimeId = 0;

export function nextRuntimeId() {
  const timePart = Date.now() * 1000;
  const randomPart = Math.floor(Math.random() * 1000);
  const candidate = timePart + randomPart;
  lastRuntimeId = candidate > lastRuntimeId ? candidate : lastRuntimeId + 1;
  return lastRuntimeId;
}

export function markAlertPayloadsRead(alerts = [], readAt = new Date().toISOString()) {
  let marked = 0;
  const nextAlerts = (Array.isArray(alerts) ? alerts : []).map((alert) => {
    if (alert?.read_at) return alert;
    marked += 1;
    return { ...alert, read_at: readAt };
  });
  return { alerts: nextAlerts, marked, read_at: readAt };
}

export async function markAllAlertsRead({ readAt = new Date().toISOString() } = {}) {
  const database = getDatabase();
  if (!database) {
    const current = await readJson("alerts");
    const result = markAlertPayloadsRead(current, readAt);
    if (result.marked > 0) await writeJson("alerts", result.alerts);
    return { marked: result.marked, read_at: result.read_at };
  }

  const rows = database.prepare("SELECT id, payload FROM alerts WHERE read_at IS NULL ORDER BY created_at DESC, id DESC").all();
  if (rows.length === 0) return { marked: 0, read_at: readAt };

  database.exec("BEGIN");
  try {
    const update = database.prepare("UPDATE alerts SET read_at = ?, payload = ? WHERE id = ?");
    for (const row of rows) {
      const payload = safeJson(row.payload, {});
      const nextPayload = { ...payload, read_at: payload.read_at || readAt };
      update.run(nextPayload.read_at, JSON.stringify(nextPayload), row.id);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return { marked: rows.length, read_at: readAt };
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value || "null") ?? fallback;
  } catch {
    return fallback;
  }
}
