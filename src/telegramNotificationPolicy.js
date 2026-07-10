const DEFAULT_TIMEZONE = "Asia/Singapore";

export const TELEGRAM_ALERT_DEFAULTS = {
  enabled: true,
  mode: "smart",
  minInstantScore: 75,
  maxInstantPerHour: 5,
  recentInstantAlerts: [],
  quietHours: {
    enabled: true,
    start: "23:00",
    end: "07:30",
    timezone: DEFAULT_TIMEZONE,
    allowUrgentDeals: false,
    urgentScoreThreshold: 95
  },
  digest: {
    enabled: true,
    time: "07:45",
    maxItems: 10,
    minScore: 60
  }
};

const MODE_ORDER = ["smart", "instant", "digest_only"];
const MODE_LABELS = {
  smart: "Smart",
  instant: "Instant",
  digest_only: "Digest only"
};

export function telegramAlertSettings(config = {}) {
  const raw = config.telegramAlerts || config.telegramSettings || {};
  const quiet = raw.quietHours || raw.quiet_hours || {};
  const digest = raw.digest || {};
  return {
    enabled: raw.enabled === undefined ? TELEGRAM_ALERT_DEFAULTS.enabled : Boolean(raw.enabled),
    mode: normalizeMode(raw.mode),
    minInstantScore: clampNumber(raw.minInstantScore ?? raw.min_instant_score ?? TELEGRAM_ALERT_DEFAULTS.minInstantScore, 0, 100),
    maxInstantPerHour: clampNumber(raw.maxInstantPerHour ?? raw.max_instant_per_hour ?? TELEGRAM_ALERT_DEFAULTS.maxInstantPerHour, 0, 100),
    recentInstantAlerts: normalizeRecentInstants(raw.recentInstantAlerts || raw.recent_instant_alerts),
    quietHours: {
      enabled: quiet.enabled === undefined ? TELEGRAM_ALERT_DEFAULTS.quietHours.enabled : Boolean(quiet.enabled),
      start: normalizeTime(quiet.start ?? TELEGRAM_ALERT_DEFAULTS.quietHours.start, TELEGRAM_ALERT_DEFAULTS.quietHours.start),
      end: normalizeTime(quiet.end ?? TELEGRAM_ALERT_DEFAULTS.quietHours.end, TELEGRAM_ALERT_DEFAULTS.quietHours.end),
      timezone: String(quiet.timezone || quiet.time_zone || TELEGRAM_ALERT_DEFAULTS.quietHours.timezone).trim() || DEFAULT_TIMEZONE,
      allowUrgentDeals: quiet.allowUrgentDeals === undefined && quiet.allow_urgent_deals === undefined
        ? TELEGRAM_ALERT_DEFAULTS.quietHours.allowUrgentDeals
        : Boolean(quiet.allowUrgentDeals ?? quiet.allow_urgent_deals),
      urgentScoreThreshold: clampNumber(quiet.urgentScoreThreshold ?? quiet.urgent_score_threshold ?? TELEGRAM_ALERT_DEFAULTS.quietHours.urgentScoreThreshold, 0, 100)
    },
    digest: {
      enabled: digest.enabled === undefined ? TELEGRAM_ALERT_DEFAULTS.digest.enabled : Boolean(digest.enabled),
      time: normalizeTime(digest.time ?? digest.sendTime ?? digest.send_time ?? TELEGRAM_ALERT_DEFAULTS.digest.time, TELEGRAM_ALERT_DEFAULTS.digest.time),
      maxItems: clampNumber(digest.maxItems ?? digest.max_items ?? TELEGRAM_ALERT_DEFAULTS.digest.maxItems, 1, 30),
      minScore: clampNumber(digest.minScore ?? digest.min_score ?? TELEGRAM_ALERT_DEFAULTS.digest.minScore, 0, 100)
    }
  };
}

export function mergeTelegramAlertSettings(config = {}, patch = {}) {
  const current = telegramAlertSettings(config);
  const quietPatch = patch.quietHours || patch.quiet_hours || {};
  const digestPatch = patch.digest || {};
  const next = telegramAlertSettings({
    telegramAlerts: {
      ...current,
      ...patch,
      quietHours: { ...current.quietHours, ...quietPatch },
      digest: { ...current.digest, ...digestPatch }
    }
  });
  return {
    ...config,
    telegramAlerts: next
  };
}

export function evaluateTelegramAlertPolicy(alert = {}, config = {}, at = new Date()) {
  const settings = telegramAlertSettings(config);
  if (!appliesToListingAlert(alert)) return { action: "send", reason: "non_listing_alert", settings };
  if (!settings.enabled) return { action: "skip", reason: "telegram_alerts_disabled", settings };

  if (settings.mode === "digest_only") return { action: "queue", reason: "digest_only", settings };

  const score = alertScore(alert);
  const urgent = settings.quietHours.allowUrgentDeals && score >= settings.quietHours.urgentScoreThreshold;
  if (settings.quietHours.enabled && isQuietHoursActive(settings, at) && !urgent) {
    return { action: "queue", reason: "quiet_hours", settings };
  }

  if (settings.mode === "smart" && alert.type !== "price_drop" && score < settings.minInstantScore) {
    return { action: "queue", reason: "below_instant_threshold", settings };
  }

  const recent = recentInstantAlerts(settings, at);
  if (settings.maxInstantPerHour > 0 && recent.length >= settings.maxInstantPerHour) {
    return { action: "queue", reason: "hourly_rate_limit", settings };
  }

  return { action: "send", reason: urgent ? "urgent_quiet_hours_bypass" : "instant_allowed", settings };
}

export function withRecordedTelegramInstant(config = {}, at = new Date()) {
  const settings = telegramAlertSettings(config);
  return mergeTelegramAlertSettings(config, {
    recentInstantAlerts: [...recentInstantAlerts(settings, at), at.toISOString()]
  });
}

export function isQueuedTelegramAlert(alert = {}) {
  return alert && alert.delivery_status === "queued" && !alert.sent_at && !alert.error;
}

export function selectTelegramDigestAlerts(alerts = [], config = {}) {
  const settings = telegramAlertSettings(config);
  const queued = alerts.filter(isQueuedTelegramAlert).filter(appliesToListingAlert);
  const sorted = [...queued].sort((a, b) => {
    return alertScore(b) - alertScore(a)
      || new Date(b.queued_at || b.created_at || 0).getTime() - new Date(a.queued_at || a.created_at || 0).getTime();
  });
  const eligible = sorted.filter((alert) => alert.type === "price_drop" || alertScore(alert) >= settings.digest.minScore);
  const selected = eligible.slice(0, settings.digest.maxItems);
  const selectedIds = new Set(selected.map((alert) => String(alert.id || alert.alert_key || `${alert.type}:${alert.listing_id}`)));
  const skipped = queued.filter((alert) => !selectedIds.has(String(alert.id || alert.alert_key || `${alert.type}:${alert.listing_id}`)));
  return { queued, eligible, selected, skipped, settings };
}

export function formatTelegramDigestMessage(selected = [], totalQueued = selected.length, config = {}) {
  const settings = telegramAlertSettings(config);
  const header = [
    "🌅 Overnight Carousell Digest",
    `Top ${selected.length} of ${totalQueued} queued listing${totalQueued === 1 ? "" : "s"}`,
    `Min score ${settings.digest.minScore}+ | Sorted by deal score`
  ].join("\n");
  const body = selected.map((alert, index) => {
    const score = alert.score ? ` | Score ${alert.score}` : "";
    const price = alert.price ? `S$${Number(alert.price || 0).toLocaleString()}` : "S$?";
    const location = alert.location ? ` | ${alert.location}` : "";
    const reason = alert.reason || alert.queue_reason || alert.explanation || "Queued during quiet hours";
    const url = alert.listing_url || "";
    return [`${index + 1}. ${alert.title || "Untitled listing"} — ${price}${score}${location}`, reason, url].filter(Boolean).join("\n");
  }).join("\n\n");
  return `${header}\n\n${body}`.trim().slice(0, 3900);
}

export function telegramSettingsSummary(config = {}) {
  const settings = telegramAlertSettings(config);
  const scheduler = config.scheduler || {};
  const nextMode = nextTelegramMode(settings.mode);
  return [
    "⚙️ Telegram Bot Settings",
    "",
    `Notifications: ${settings.enabled ? MODE_LABELS[settings.mode] || settings.mode : "Off"}`,
    `Next mode button: ${MODE_LABELS[nextMode] || nextMode}`,
    `Instant threshold: ${settings.minInstantScore}+`,
    `Max instant alerts: ${settings.maxInstantPerHour === 0 ? "unlimited" : `${settings.maxInstantPerHour}/hour`}`,
    `Quiet hours: ${settings.quietHours.enabled ? `${settings.quietHours.start}–${settings.quietHours.end}` : "Off"} (${settings.quietHours.timezone})`,
    `Urgent DND bypass: ${settings.quietHours.allowUrgentDeals ? `On at ${settings.quietHours.urgentScoreThreshold}+` : `Off (${settings.quietHours.urgentScoreThreshold}+)`}`,
    `Morning digest: ${settings.digest.enabled ? `${settings.digest.time}, top ${settings.digest.maxItems}, min score ${settings.digest.minScore}+` : "Off"}`,
    `Search interval: ${Number(scheduler.intervalMinutes || 30)} min`,
    "",
    "Commands:",
    "/settings mode smart|instant|digest",
    "/settings interval 5|10|15|30|60",
    "/settings dnd on|off|23:00 07:30",
    "/settings digest on|off|07:45|now",
    "/settings threshold 75",
    "/settings maxhour 5",
    "/settings minscore 60",
    "/settings top 10",
    "/settings urgent on|off|95",
    "/settings block faulty, no display, spoilt"
  ].join("\n");
}

export function telegramSettingsKeyboard(config = {}) {
  const settings = telegramAlertSettings(config);
  const scheduler = config.scheduler || {};
  const nextMode = nextTelegramMode(settings.mode);
  return {
    inline_keyboard: [
      [
        { text: `Mode → ${MODE_LABELS[nextMode] || nextMode}`, callback_data: "tgset:mode" },
        { text: settings.enabled ? "Alerts On" : "Alerts Off", callback_data: "tgset:enabled" }
      ],
      [
        { text: settings.quietHours.enabled ? "DND On" : "DND Off", callback_data: "tgset:dnd" },
        { text: settings.digest.enabled ? "Digest On" : "Digest Off", callback_data: "tgset:digest" }
      ],
      [
        { text: settings.quietHours.allowUrgentDeals ? "Urgent bypass On" : "Urgent bypass Off", callback_data: "tgset:urgent" },
        { text: "Send digest now", callback_data: "tgset:digest_now" }
      ],
      [
        { text: "Instant -5", callback_data: "tgset:threshold_down" },
        { text: `Instant ${settings.minInstantScore}+`, callback_data: "tgset:noop" },
        { text: "Instant +5", callback_data: "tgset:threshold_up" }
      ],
      [
        { text: "Max/hour -1", callback_data: "tgset:maxhour_down" },
        { text: `Max ${settings.maxInstantPerHour}/h`, callback_data: "tgset:noop" },
        { text: "Max/hour +1", callback_data: "tgset:maxhour_up" }
      ],
      [
        { text: "Digest score -5", callback_data: "tgset:digest_score_down" },
        { text: `Digest ${settings.digest.minScore}+`, callback_data: "tgset:noop" },
        { text: "Digest score +5", callback_data: "tgset:digest_score_up" }
      ],
      [
        { text: "Digest top -1", callback_data: "tgset:digest_top_down" },
        { text: `Top ${settings.digest.maxItems}`, callback_data: "tgset:noop" },
        { text: "Digest top +1", callback_data: "tgset:digest_top_up" }
      ],
      [
        { text: "5m", callback_data: "tgset:interval_set:5" },
        { text: "10m", callback_data: "tgset:interval_set:10" },
        { text: "15m", callback_data: "tgset:interval_set:15" },
        { text: "30m", callback_data: "tgset:interval_set:30" },
        { text: "60m", callback_data: "tgset:interval_set:60" }
      ],
      [
        { text: "Interval -5", callback_data: "tgset:interval_down" },
        { text: `Current ${Number(scheduler.intervalMinutes || 30)}m`, callback_data: "tgset:noop" },
        { text: "Interval +5", callback_data: "tgset:interval_up" }
      ],
      [
        { text: "DND 23:00–07:30", callback_data: "tgset:dnd_default" },
        { text: "Digest 07:45", callback_data: "tgset:digest_default" }
      ]
    ]
  };
}

export function nextTelegramMode(mode) {
  const normalized = normalizeMode(mode);
  return MODE_ORDER[(MODE_ORDER.indexOf(normalized) + 1) % MODE_ORDER.length];
}

export function nextTelegramDigestDate(config = {}, from = new Date()) {
  const settings = telegramAlertSettings(config);
  const timezone = settings.quietHours.timezone || DEFAULT_TIMEZONE;
  const [hour, minute] = settings.digest.time.split(":").map(Number);
  const parts = zonedParts(from, timezone);
  let target = zonedDateToUtc({ ...parts, hour, minute, second: 0 }, timezone);
  if (target.getTime() <= from.getTime()) {
    target = zonedDateToUtc(addZonedDay({ ...parts, hour, minute, second: 0 }), timezone);
  }
  return target;
}

export function normalizeTime(value, fallback = "00:00") {
  const text = String(value || "").trim();
  const match = text.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return fallback;
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

export function normalizeMode(value) {
  const text = String(value || TELEGRAM_ALERT_DEFAULTS.mode).trim().toLowerCase().replaceAll("-", "_");
  if (["smart", "instant", "digest_only"].includes(text)) return text;
  if (text === "digest") return "digest_only";
  return TELEGRAM_ALERT_DEFAULTS.mode;
}

export function isQuietHoursActive(settingsOrConfig = {}, at = new Date()) {
  const settings = settingsOrConfig.quietHours ? settingsOrConfig : telegramAlertSettings(settingsOrConfig);
  const quiet = settings.quietHours;
  if (!quiet?.enabled) return false;
  const nowMinutes = zonedMinutesOfDay(at, quiet.timezone || DEFAULT_TIMEZONE);
  const start = timeToMinutes(quiet.start);
  const end = timeToMinutes(quiet.end);
  if (start === end) return true;
  if (start < end) return nowMinutes >= start && nowMinutes < end;
  return nowMinutes >= start || nowMinutes < end;
}

export function alertIdentity(alert = {}) {
  return [
    alert.alert_key || "",
    alert.type || "deal",
    alert.watch_id || "manual",
    alert.listing_id || "listing",
    alert.type === "price_drop" ? Number(alert.price || alert.price_to || 0) : "once"
  ].join(":");
}

export function hasExistingTelegramDelivery(alert = {}, alerts = []) {
  const identity = alertIdentity(alert);
  return alerts.some((item) => {
    if (!item || item.error) return false;
    if (alertIdentity(item) === identity) return true;
    if (alert.type === "price_drop") return false;
    return Number(item.listing_id || 0) === Number(alert.listing_id || -1)
      && String(item.type || "") === String(alert.type || "")
      && String(item.watch_id || "") === String(alert.watch_id || "");
  });
}

function appliesToListingAlert(alert = {}) {
  return Boolean(alert.listing_id) && ["new_deal", "restock", "price_drop", "deal"].includes(String(alert.type || "deal"));
}

function alertScore(alert = {}) {
  const score = Number(alert.score ?? alert.deal_score ?? 0);
  return Number.isFinite(score) ? score : 0;
}

function recentInstantAlerts(settings, at) {
  const cutoff = at.getTime() - 60 * 60 * 1000;
  return normalizeRecentInstants(settings.recentInstantAlerts).filter((iso) => new Date(iso).getTime() >= cutoff);
}

function normalizeRecentInstants(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || ""))
    .filter((item) => Number.isFinite(new Date(item).getTime()))
    .slice(-100);
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function timeToMinutes(time) {
  const [hour, minute] = normalizeTime(time).split(":").map(Number);
  return hour * 60 + minute;
}

function zonedMinutesOfDay(date, timezone) {
  const parts = zonedParts(date, timezone);
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function zonedParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const values = Object.fromEntries(formatter.formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second || 0
  };
}

function addZonedDay(parts) {
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, parts.hour, parts.minute, parts.second || 0));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second || 0
  };
}

function zonedDateToUtc(parts, timezone) {
  const utcGuess = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0));
  const offsetMs = timezoneOffsetMs(utcGuess, timezone);
  return new Date(utcGuess.getTime() - offsetMs);
}

function timezoneOffsetMs(date, timezone) {
  const parts = zonedParts(date, timezone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
  return asUtc - date.getTime();
}
