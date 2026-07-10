import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCRAPE_STATUSES,
  describeScrapeFailure,
  isBaselineSafeScrape,
  normalizeScrapeResult,
  resultCountFromScrape
} from "./scrapeResult.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "data");
const alertEventPath = process.env.CAROUSELL_ALERT_EVENTS_PATH || path.join(dataDir, "alert-events.local.json");
const GLOBAL_SUMMARY_FINGERPRINT = "scrape_health:summary";

export const HEALTH_EVENT_TYPES = Object.freeze({
  RESULT_DROP: "result_drop",
  ZERO_RESULTS: "zero_results",
  BLOCKED: "blocked",
  LAYOUT_CHANGED: "layout_changed",
  TIMEOUT: "timeout",
  NETWORK_ERROR: "network_error",
  FAILED: "failed",
  PARTIAL: "partial",
  RECOVERY: "recovery"
});

export function scrapeHealthSettings(config = {}) {
  const raw = config.scrapeHealthCheck || {};
  return {
    enabled: raw.enabled !== false,
    notificationMode: ["summary", "individual", "off"].includes(raw.notificationMode) ? raw.notificationMode : "summary",
    minPreviousResults: clampNumber(raw.minPreviousResults ?? 5, 1, 100000),
    minResultRatio: clampNumber(raw.minResultRatio ?? 0.2, 0, 1),
    cooldownMinutes: clampNumber(raw.cooldownMinutes ?? 360, 1, 10080),
    globalSummaryCooldownMinutes: clampNumber(raw.globalSummaryCooldownMinutes ?? 15, 1, 1440),
    repeatAfterOccurrences: clampNumber(raw.repeatAfterOccurrences ?? 3, 1, 1000),
    notifyOnRecovery: raw.notifyOnRecovery !== false
  };
}

export function createScrapeHealthEvent(watch = {}, scrapeInput = {}, config = {}) {
  const settings = scrapeHealthSettings(config);
  if (!settings.enabled) return null;
  const result = normalizeScrapeResult({ ...scrapeInput, watch_id: scrapeInput.watch_id ?? watch.id, query: scrapeInput.query || watch.query });
  const now = new Date().toISOString();
  const previous = finiteOrNull(watch.last_result_count);
  const current = resultCountFromScrape(result);

  if (result.challenge_detected || result.status === SCRAPE_STATUSES.BLOCKED) {
    return baseEvent({ severity: "error", type: HEALTH_EVENT_TYPES.BLOCKED, watch, result, current, previous, message: "Bot challenge detected", createdAt: now });
  }
  if (result.consent_page_detected) {
    return baseEvent({ severity: "error", type: HEALTH_EVENT_TYPES.BLOCKED, watch, result, current, previous, message: "Consent/login/interstitial page detected", createdAt: now });
  }
  if (result.status === SCRAPE_STATUSES.LAYOUT_CHANGED) {
    return baseEvent({ severity: "error", type: HEALTH_EVENT_TYPES.LAYOUT_CHANGED, watch, result, current, previous, message: "Search page structure was not recognized", createdAt: now });
  }
  if (result.status === SCRAPE_STATUSES.TIMEOUT) {
    return baseEvent({ severity: "error", type: HEALTH_EVENT_TYPES.TIMEOUT, watch, result, current, previous, message: "Navigation timeout", createdAt: now });
  }
  if (result.status === SCRAPE_STATUSES.NETWORK_ERROR) {
    return baseEvent({ severity: "error", type: HEALTH_EVENT_TYPES.NETWORK_ERROR, watch, result, current, previous, message: "Network error", createdAt: now });
  }
  if (!result.ok || result.status === SCRAPE_STATUSES.FAILED) {
    return baseEvent({ severity: "error", type: HEALTH_EVENT_TYPES.FAILED, watch, result, current, previous, message: describeScrapeFailure(result), createdAt: now });
  }

  if (!isBaselineSafeScrape(result) || current === null) return null;
  if (previous === null || previous < settings.minPreviousResults) return null;

  if (current === 0 && previous >= settings.minPreviousResults) {
    return baseEvent({ severity: "warning", type: HEALTH_EVENT_TYPES.ZERO_RESULTS, watch, result: { ...result, status: SCRAPE_STATUSES.ZERO_RESULTS }, current, previous, message: "Valid search returned zero results", createdAt: now });
  }

  if (current <= previous * settings.minResultRatio) {
    const dropRatio = previous > 0 ? (previous - current) / previous : null;
    return baseEvent({ severity: "warning", type: HEALTH_EVENT_TYPES.RESULT_DROP, watch, result: { ...result, status: SCRAPE_STATUSES.LOW_RESULTS }, current, previous, dropRatio, message: "Suspicious result drop", createdAt: now });
  }

  if (result.status === SCRAPE_STATUSES.PARTIAL) {
    return baseEvent({ severity: "warning", type: HEALTH_EVENT_TYPES.PARTIAL, watch, result, current, previous, message: "Partial scrape completed", createdAt: now });
  }

  return null;
}

export function createAlertFingerprint(event = {}) {
  const watchId = event.watch_id ?? "manual";
  return [
    "scrape_health",
    watchId,
    event.type || "unknown",
    event.scrape_status || "unknown",
    countBucket(event.current_count),
    countBucket(event.previous_count)
  ].join(":");
}

export function recordHealthEvent(event, config = {}, now = new Date()) {
  if (!event) return { event: null, notify: false, alertState: null };
  const settings = scrapeHealthSettings(config);
  if (!settings.enabled || settings.notificationMode === "off") return { event, notify: false, alertState: null };

  const events = readAlertEvents();
  const fingerprint = event.fingerprint || createAlertFingerprint(event);
  const timestamp = now.toISOString();
  const existing = events[fingerprint] || {
    fingerprint,
    type: event.type,
    severity: event.severity,
    watch_id: event.watch_id,
    first_seen_at: timestamp,
    last_seen_at: null,
    occurrence_count: 0,
    last_notified_at: null,
    resolved_at: null,
    payload: event
  };

  const next = {
    ...existing,
    type: event.type,
    severity: event.severity,
    watch_id: event.watch_id,
    last_seen_at: timestamp,
    occurrence_count: Number(existing.occurrence_count || 0) + 1,
    resolved_at: null,
    payload: event
  };

  const minutesSinceNotify = next.last_notified_at ? (now.getTime() - new Date(next.last_notified_at).getTime()) / 60000 : Infinity;
  const repeatDue = next.occurrence_count > 1 && next.occurrence_count % settings.repeatAfterOccurrences === 0;
  const notify = !next.last_notified_at || minutesSinceNotify >= settings.cooldownMinutes || repeatDue;
  if (notify) next.last_notified_at = timestamp;
  events[fingerprint] = next;
  writeAlertEvents(events);
  return { event: { ...event, fingerprint, occurrence_count: next.occurrence_count, last_notified_at: next.last_notified_at }, notify, alertState: next };
}

export function recordHealthRecovery(watch = {}, scrapeInput = {}, config = {}, now = new Date()) {
  const settings = scrapeHealthSettings(config);
  if (!settings.enabled || !settings.notifyOnRecovery || settings.notificationMode === "off") return null;
  const result = normalizeScrapeResult({ ...scrapeInput, watch_id: scrapeInput.watch_id ?? watch.id, query: scrapeInput.query || watch.query });
  if (!isBaselineSafeScrape(result)) return null;

  const events = readAlertEvents();
  const unresolved = Object.values(events).filter((item) => {
    if (!String(item.fingerprint || "").startsWith("scrape_health:")) return false;
    if (item.fingerprint === GLOBAL_SUMMARY_FINGERPRINT) return false;
    return String(item.watch_id ?? "") === String(watch.id ?? "") && !item.resolved_at;
  });
  if (!unresolved.length) return null;

  const timestamp = now.toISOString();
  for (const item of unresolved) {
    events[item.fingerprint] = { ...item, resolved_at: timestamp };
  }
  writeAlertEvents(events);

  return {
    severity: "info",
    type: HEALTH_EVENT_TYPES.RECOVERY,
    watch_id: watch.id ?? null,
    query: watch.query || result.query || "",
    current_count: result.result_count,
    previous_count: finiteOrNull(watch.last_result_count),
    drop_ratio: null,
    scrape_status: result.status,
    message: `Recovered after ${unresolved.reduce((sum, item) => sum + Number(item.occurrence_count || 0), 0)} unhealthy run(s)`,
    created_at: timestamp,
    fingerprint: `scrape_health:${watch.id ?? "manual"}:recovery`
  };
}

export function canSendGlobalSummary(config = {}, now = new Date()) {
  const settings = scrapeHealthSettings(config);
  if (settings.notificationMode !== "summary") return false;
  const events = readAlertEvents();
  const current = events[GLOBAL_SUMMARY_FINGERPRINT];
  if (!current?.last_notified_at) return true;
  return (now.getTime() - new Date(current.last_notified_at).getTime()) / 60000 >= settings.globalSummaryCooldownMinutes;
}

export function recordGlobalSummarySent(now = new Date()) {
  const events = readAlertEvents();
  const timestamp = now.toISOString();
  const existing = events[GLOBAL_SUMMARY_FINGERPRINT] || {
    fingerprint: GLOBAL_SUMMARY_FINGERPRINT,
    type: "summary",
    severity: "warning",
    watch_id: null,
    first_seen_at: timestamp,
    occurrence_count: 0,
    payload: {}
  };
  events[GLOBAL_SUMMARY_FINGERPRINT] = {
    ...existing,
    last_seen_at: timestamp,
    last_notified_at: timestamp,
    occurrence_count: Number(existing.occurrence_count || 0) + 1,
    resolved_at: null
  };
  writeAlertEvents(events);
}

export function formatScrapeHealthIndividual(event = {}) {
  const label = event.query || `Watch ${event.watch_id ?? "unknown"}`;
  if (event.type === HEALTH_EVENT_TYPES.RECOVERY) return formatRecovery(event);
  const lines = [
    event.severity === "error" ? "🚫 Carousell scrape failed" : "⚠️ Scrape health warning",
    "",
    `Watch: ${label}`,
    `Status: ${humanStatus(event)}`
  ];
  if (event.current_count !== null && event.current_count !== undefined) lines.push(`Results: ${event.current_count}`);
  if (event.previous_count !== null && event.previous_count !== undefined) lines.push(`Previous healthy result count: ${event.previous_count}`);
  if (event.drop_ratio !== null && event.drop_ratio !== undefined) lines.push(`Drop: ${formatPercent(event.drop_ratio)}`);
  if (event.parser) lines.push(`Parser: ${event.parser}`);
  if (event.duration_ms) lines.push(`Duration: ${formatDuration(event.duration_ms)}`);
  lines.push(`Time: ${formatTime(event.created_at)}`);
  lines.push("");
  lines.push(event.severity === "error" ? "Results were not treated as a real zero-result search. The bot will retry later. No alert baseline was overwritten." : "The scrape completed, but returned far fewer valid listings than the previous healthy run.");
  return lines.join("\n");
}

export function formatScrapeHealthSummary(events = [], summary = {}) {
  const warnings = events.filter(Boolean);
  const lines = [
    "⚠️ Scrape health summary",
    "",
    `${warnings.length} watched search${warnings.length === 1 ? "" : "es"} need attention:`,
    ""
  ];
  warnings.forEach((event, index) => {
    lines.push(`${index + 1}. ${event.query || `Watch ${event.watch_id ?? "unknown"}`}`);
    if (event.type === HEALTH_EVENT_TYPES.RESULT_DROP || event.type === HEALTH_EVENT_TYPES.ZERO_RESULTS) {
      lines.push(`   ${event.current_count ?? "?"} results, previously ${event.previous_count ?? "?"}`);
      if (event.drop_ratio !== null && event.drop_ratio !== undefined) lines.push(`   Drop: ${formatPercent(event.drop_ratio)}`);
    } else {
      lines.push(`   ${humanStatus(event)}`);
      if (event.previous_count !== null && event.previous_count !== undefined) lines.push(`   Previous healthy count: ${event.previous_count}`);
    }
    if (event.occurrence_count > 1) lines.push(`   Seen ${event.occurrence_count} times`);
    lines.push("");
  });
  lines.push(`Run finished: ${formatTime(summary.finished_at || new Date().toISOString())}`);
  lines.push(`Successful watches: ${summary.successful ?? 0}`);
  lines.push(`Warnings: ${summary.warnings ?? warnings.filter((event) => event.severity === "warning").length}`);
  lines.push(`Failed: ${summary.failed ?? warnings.filter((event) => event.severity === "error").length}`);
  return lines.join("\n").trim();
}

function formatRecovery(event = {}) {
  return [
    "✅ Scrape recovered",
    "",
    `Watch: ${event.query || `Watch ${event.watch_id ?? "unknown"}`}`,
    `Results: ${event.current_count ?? "unknown"}`,
    event.previous_count !== null && event.previous_count !== undefined ? `Previous healthy result count: ${event.previous_count}` : "",
    event.message || "The watch recovered after unhealthy runs."
  ].filter(Boolean).join("\n");
}

function baseEvent({ severity, type, watch, result, current, previous, dropRatio = null, message, createdAt }) {
  const event = {
    severity,
    type,
    watch_id: watch.id ?? result.watch_id ?? null,
    query: watch.query || result.query || "",
    current_count: current,
    previous_count: previous,
    drop_ratio: dropRatio,
    scrape_status: result.status,
    parser: result.parser,
    duration_ms: result.duration_ms,
    message,
    created_at: createdAt,
    diagnostic: result.diagnostic || null
  };
  return { ...event, fingerprint: createAlertFingerprint(event) };
}

function humanStatus(event = {}) {
  if (event.message) return event.message;
  return String(event.scrape_status || event.type || "unknown").replaceAll("_", " ");
}

function readAlertEvents() {
  if (!existsSync(alertEventPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(alertEventPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeAlertEvents(events) {
  mkdirSync(path.dirname(alertEventPath), { recursive: true });
  writeFileSync(alertEventPath, `${JSON.stringify(events, null, 2)}\n`, "utf8");
}

function countBucket(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return "unknown";
  if (number === 0) return "0";
  if (number < 10) return String(Math.round(number));
  if (number < 100) return String(Math.round(number / 5) * 5);
  return String(Math.round(number / 25) * 25);
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function formatPercent(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function formatDuration(ms) {
  return `${(Number(ms || 0) / 1000).toFixed(1)}s`;
}

function formatTime(value) {
  const date = new Date(value || Date.now());
  if (!Number.isFinite(date.getTime())) return String(value || "unknown");
  return date.toLocaleString("en-SG", { timeZone: "Asia/Singapore", hour: "numeric", minute: "2-digit", year: "numeric", month: "2-digit", day: "2-digit" });
}
