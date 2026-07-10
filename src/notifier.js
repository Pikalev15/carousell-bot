import { nextRuntimeId } from "./runtimeIds.js";
import { addActivity, createAlert, getAlerts, readJson, writeJson } from "./store.js";
import {
  alertIdentity,
  evaluateTelegramAlertPolicy,
  formatTelegramDigestMessage,
  mergeTelegramAlertSettings,
  nextTelegramDigestDate,
  normalizeMode,
  normalizeTime,
  selectTelegramDigestAlerts,
  telegramAlertSettings,
  telegramSettingsKeyboard,
  telegramSettingsSummary,
  withRecordedTelegramInstant
} from "./telegramNotificationPolicy.js";

const TELEGRAM_API = "https://api.telegram.org";
const DIGEST_RESCHEDULE_MS = 5 * 60 * 1000;
let digestTimer = null;
let digestSchedulerStarted = false;

export const TELEGRAM_COMMANDS = [
  { command: "search", description: "Search Carousell: /search gpu" },
  { command: "watch", description: "Monitor a query or category" },
  { command: "unwatch", description: "Pause a monitor" },
  { command: "status", description: "Show scheduler and monitors" },
  { command: "deals", description: "Show current top deals" },
  { command: "settings", description: "Tune Telegram alerts and quiet hours" },
  { command: "help", description: "Show command help" }
];

export async function sendTelegramMessage(message, config = null, options = {}) {
  const appConfig = config || (await readJson("config"));
  const telegram = appConfig.telegram || {};
  const token = String(telegram.botToken || telegram.bot_token || "").trim();
  const chatId = String(options.chatId || telegram.chatId || telegram.chat_id || "").trim();
  if (!telegram.enabled || !token || !chatId) {
    return { ok: false, skipped: true, reason: "Telegram is not configured" };
  }

  const body = {
    chat_id: chatId,
    text: message,
    disable_web_page_preview: true
  };
  const replyMarkup = options.replyMarkup || options.reply_markup;
  if (replyMarkup) body.reply_markup = replyMarkup;

  const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.description || `Telegram sendMessage failed (${response.status})`);
  }
  return { ok: true, payload };
}

export async function startTelegramCommandPolling(handleCommand) {
  startTelegramDigestScheduler();
  let offset = 0;
  let stopped = false;
  let commandsSyncedFor = "";

  async function poll() {
    if (stopped) return;
    const config = await readJson("config");
    const telegram = config.telegram || {};
    const token = String(telegram.botToken || "").trim();
    const allowedChatId = String(telegram.chatId || "").trim();
    if (!telegram.enabled || !token || !allowedChatId) {
      setTimeout(poll, 10000);
      return;
    }

    try {
      if (commandsSyncedFor !== token) {
        await syncTelegramCommands(config).catch(() => {});
        commandsSyncedFor = token;
      }
      const response = await fetch(`${TELEGRAM_API}/bot${token}/getUpdates?timeout=25&offset=${offset}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.description || `Telegram getUpdates failed (${response.status})`);
      for (const update of payload.result || []) {
        offset = Math.max(offset, Number(update.update_id || 0) + 1);
        if (update.callback_query) {
          const callback = update.callback_query;
          const chatId = String(callback.message?.chat?.id || callback.from?.id || "");
          if (chatId !== allowedChatId) {
            await answerCallbackQuery(callback.id, "Unauthorized chat", config).catch(() => {});
            continue;
          }
          const parsed = parseTelegramCallbackData(callback.data);
          const reply = parsed.kind === "settings"
            ? await handleTelegramSettingsCallback(parsed, { chatId, config }).catch((error) => `Action failed: ${error.message}`)
            : await handleCommand({ ...parsed, type: "callback", id: callback.id, chatId, message: callback.message, data: callback.data }, { chatId, config }).catch((error) => `Action failed: ${error.message}`);
          if (reply && typeof reply === "object" && reply.message) {
            const result = await sendTelegramReply(reply, config, { chatId }).catch((error) => ({ ok: false, error: error.message }));
            const callbackText = result.ok ? reply.answer || reply.text || "Done" : `Message failed: ${result.error}`;
            await answerCallbackQuery(callback.id, callbackText || "Done", config).catch(() => {});
          } else {
            const callbackText = typeof reply === "object" ? reply.answer || reply.text || "Done" : reply;
            await answerCallbackQuery(callback.id, callbackText || "Done", config).catch(() => {});
          }
          continue;
        }
        const message = update.message || update.edited_message;
        const text = String(message?.text || "").trim();
        const chatId = String(message?.chat?.id || "");
        if (!text.startsWith("/")) continue;
        if (chatId !== allowedChatId) {
          await sendTelegramMessage("Unauthorized chat. Configure this chat ID in Carousell Bot to use commands.", config, { chatId }).catch(() => {});
          continue;
        }
        const settingsReply = await handleTelegramSettingsCommand(text, { chatId, config }).catch((error) => `Command failed: ${error.message}`);
        const reply = settingsReply || await handleCommand(text, { chatId, message, config }).catch((error) => `Command failed: ${error.message}`);
        if (reply) await sendTelegramReply(reply, config, { chatId });
      }
      await recordTelegramStatus({ ok: true });
    } catch (error) {
      await recordTelegramStatus({ ok: false, error: error.message });
    } finally {
      setTimeout(poll, 1000);
    }
  }

  poll();
  return () => {
    stopped = true;
  };
}

export function parseTelegramCommand(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("/")) return { command: "", args: "" };
  const [rawCommand, ...rest] = trimmed.split(/\s+/);
  return {
    command: rawCommand.replace(/@[\w_]+$/, "").toLowerCase(),
    args: rest.join(" ").trim()
  };
}

export function parseTelegramCallbackData(data) {
  const text = String(data || "");
  if (text.startsWith("tgset:")) {
    const [, action = ""] = text.split(":");
    return { kind: "settings", action, settingAction: action, listingId: 0 };
  }
  const [prefix, action, listingId] = text.split(":");
  if (prefix !== "cb" || !action || !listingId) return { action: "", listingId: 0 };
  return { action, listingId: Number(listingId) };
}

export async function notifyAlert(input) {
  const alert = input;
  const config = await readJson("config");
  const now = new Date();
  const existing = findExistingTelegramDelivery(alert);
  if (existing) {
    return {
      alert: existing,
      result: { ok: true, skipped: true, duplicate: true, reason: "Alert already sent, queued, or handled" }
    };
  }

  const policy = evaluateTelegramAlertPolicy(alert, config, now);
  if (policy.action === "skip") {
    const saved = createAlert({
      ...alert,
      id: alert.id || nextRuntimeId(),
      delivery_status: "skipped",
      skipped_at: now.toISOString(),
      queue_reason: policy.reason,
      sent_at: null,
      error: null
    });
    return { alert: saved, result: { ok: true, skipped: true, reason: policy.reason } };
  }

  if (policy.action === "queue") {
    const saved = createAlert({
      ...alert,
      id: alert.id || nextRuntimeId(),
      delivery_status: "queued",
      queued_at: now.toISOString(),
      queue_reason: policy.reason,
      sent_at: null,
      error: null
    });
    return { alert: saved, result: { ok: true, queued: true, reason: policy.reason } };
  }

  const result = await sendTelegramMessage(formatAlertMessage(alert), config, { replyMarkup: alertInlineKeyboard(alert) }).catch((error) => ({
    ok: false,
    error: error.message
  }));
  await recordTelegramStatus(result);
  if (result.ok) {
    await writeJson("config", withRecordedTelegramInstant(await readJson("config"), now));
  }
  const next = createAlert({
    ...alert,
    id: alert.id || nextRuntimeId(),
    delivery_status: result.ok ? "sent_instant" : "failed",
    sent_at: result.ok ? now.toISOString() : null,
    error: result.ok ? null : result.error || result.reason || "Telegram notification failed"
  });
  return { alert: next, result };
}

export function alertInlineKeyboard(alert = {}) {
  const id = Number(alert.listing_id || 0);
  if (!id) return null;
  const rows = [];
  if (alert.listing_url) rows.push([{ text: "Open", url: alert.listing_url }]);
  rows.push([
    { text: "Good", callback_data: `cb:good:${id}` },
    { text: "Bad deal", callback_data: `cb:bad_deal:${id}` },
    { text: "Spam", callback_data: `cb:spam:${id}` }
  ]);
  rows.push([
    { text: "Train more", callback_data: `cb:train:${id}` },
    { text: "Block seller", callback_data: `cb:block:${id}` },
    { text: "Watch similar", callback_data: `cb:watch:${id}` }
  ]);
  return { inline_keyboard: rows };
}

export async function answerCallbackQuery(callbackQueryId, text, config = null) {
  const appConfig = config || (await readJson("config"));
  const telegram = appConfig.telegram || {};
  const token = String(telegram.botToken || telegram.bot_token || "").trim();
  if (!telegram.enabled || !token || !callbackQueryId) return { ok: false, skipped: true };
  const response = await fetch(`${TELEGRAM_API}/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text: String(text || "Done").slice(0, 180),
      show_alert: false
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.description || `Telegram answerCallbackQuery failed (${response.status})`);
  return { ok: true, payload };
}

export async function syncTelegramCommands(config = null) {
  const appConfig = config || (await readJson("config"));
  const telegram = appConfig.telegram || {};
  const token = String(telegram.botToken || telegram.bot_token || "").trim();
  if (!telegram.enabled || !token) {
    return { ok: false, skipped: true, reason: "Telegram is not configured" };
  }

  const response = await fetch(`${TELEGRAM_API}/bot${token}/setMyCommands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commands: TELEGRAM_COMMANDS,
      scope: { type: "default" }
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.description || `Telegram setMyCommands failed (${response.status})`);
  }
  return { ok: true, payload, commands: TELEGRAM_COMMANDS };
}

export async function updateTelegramConfig(input) {
  const config = await readJson("config");
  const currentTelegram = config.telegram || {};
  const botTokenInput = input.botToken ?? input.bot_token;
  const chatIdInput = input.chatId ?? input.chat_id;
  const botToken = String(botTokenInput ?? "").trim() || currentTelegram.botToken || "";
  const chatId = String(chatIdInput ?? "").trim() || currentTelegram.chatId || "";
  const next = {
    ...config,
    telegram: {
      ...currentTelegram,
      enabled: Boolean(input.enabled),
      botToken,
      chatId,
      status: "saved",
      lastError: "",
      verifiedAt: currentTelegram.verifiedAt || null
    }
  };
  await writeJson("config", next);
  if (next.telegram.enabled && next.telegram.botToken) {
    await syncTelegramCommands(next).catch((error) => recordTelegramStatus({ ok: false, error: error.message }));
  }
  rescheduleTelegramDigest();
  return maskTelegramConfig(next.telegram);
}

export async function sendTelegramTestMessage() {
  const config = await readJson("config");
  await syncTelegramCommands(config).catch((error) => recordTelegramStatus({ ok: false, error: error.message }));
  const result = await sendTelegramMessage("Carousell Bot test notification", config).catch((error) => ({
    ok: false,
    error: error.message
  }));
  await recordTelegramStatus(result);
  return result;
}

export function maskTelegramConfig(telegram = {}) {
  const token = String(telegram.botToken || "");
  return {
    enabled: Boolean(telegram.enabled),
    botTokenConfigured: token.length > 0,
    botTokenPreview: token ? `${token.slice(0, 5)}...${token.slice(-4)}` : "",
    chatId: telegram.chatId || "",
    status: telegram.status || (telegram.verifiedAt ? "verified" : token ? "saved" : "missing"),
    lastError: telegram.lastError || "",
    verifiedAt: telegram.verifiedAt || null
  };
}

export async function handleTelegramSettingsCommand(text, context = {}) {
  const { command, args } = parseTelegramCommand(text);
  if (command !== "/settings") return null;
  return applyTelegramSettingsArgs(args, context);
}

export async function handleTelegramSettingsCallback(callback, context = {}) {
  const config = await readJson("config");
  const settings = telegramAlertSettings(config);
  const scheduler = config.scheduler || {};
  let next = config;
  let answer = "Settings updated";

  if (callback.action === "enabled") {
    next = mergeTelegramAlertSettings(config, { enabled: !settings.enabled });
  } else if (callback.action === "mode") {
    const modes = ["smart", "instant", "digest_only"];
    const mode = modes[(modes.indexOf(settings.mode) + 1) % modes.length];
    next = mergeTelegramAlertSettings(config, { mode });
  } else if (callback.action === "dnd") {
    next = mergeTelegramAlertSettings(config, { quietHours: { enabled: !settings.quietHours.enabled } });
  } else if (callback.action === "digest") {
    next = mergeTelegramAlertSettings(config, { digest: { enabled: !settings.digest.enabled } });
  } else if (callback.action === "threshold_down" || callback.action === "threshold_up") {
    const delta = callback.action.endsWith("up") ? 5 : -5;
    next = mergeTelegramAlertSettings(config, { minInstantScore: clamp(Number(settings.minInstantScore) + delta, 0, 100) });
  } else if (callback.action === "interval_down" || callback.action === "interval_up") {
    const delta = callback.action.endsWith("up") ? 5 : -5;
    next = { ...config, scheduler: { ...scheduler, intervalMinutes: clamp(Number(scheduler.intervalMinutes || 30) + delta, 5, 1440) } };
  } else if (callback.action === "digest_now") {
    const result = await sendQueuedTelegramDigest({ manual: true });
    answer = result.sent ? `Sent ${result.sent} digest listings` : result.reason || "No queued listings";
    return settingsReply(await readJson("config"), answer);
  } else {
    answer = "Unknown settings action";
  }

  await writeJson("config", next);
  rescheduleTelegramDigest();
  return settingsReply(await readJson("config"), answer);
}

export async function sendQueuedTelegramDigest({ manual = false } = {}) {
  const config = await readJson("config");
  const settings = telegramAlertSettings(config);
  if (!manual && !settings.digest.enabled) {
    return { ok: true, skipped: true, reason: "Telegram digest is disabled" };
  }

  const selection = selectTelegramDigestAlerts(getAlerts({ limit: 1000 }), config);
  const now = new Date().toISOString();
  if (!selection.selected.length) {
    for (const alert of selection.skipped) {
      createAlert({ ...alert, delivery_status: "digest_skipped", digest_skipped_at: now, skip_reason: "below_digest_threshold" });
    }
    return {
      ok: true,
      skipped: true,
      reason: selection.queued.length ? "No queued listings met the digest score threshold" : "No queued listings",
      queued: selection.queued.length,
      sent: 0
    };
  }

  const message = formatTelegramDigestMessage(selection.selected, selection.queued.length, config);
  const result = await sendTelegramMessage(message, config).catch((error) => ({ ok: false, error: error.message }));
  await recordTelegramStatus(result);
  if (!result.ok) return { ok: false, error: result.error || result.reason || "Digest send failed", queued: selection.queued.length, sent: 0 };

  for (const alert of selection.selected) {
    createAlert({ ...alert, delivery_status: "sent_digest", sent_at: now, digest_sent_at: now, error: null });
  }
  for (const alert of selection.skipped) {
    createAlert({ ...alert, delivery_status: "digest_skipped", digest_skipped_at: now, skip_reason: "not_in_top_digest" });
  }
  addActivity({ type: "telegram_digest", title: "Telegram digest sent", detail: `${selection.selected.length}/${selection.queued.length} queued listings sent`, timestamp: now });
  return { ok: true, sent: selection.selected.length, queued: selection.queued.length, skipped: selection.skipped.length };
}

export function startTelegramDigestScheduler() {
  if (digestSchedulerStarted) return () => stopTelegramDigestScheduler();
  digestSchedulerStarted = true;
  scheduleTelegramDigest();
  return () => stopTelegramDigestScheduler();
}

export function stopTelegramDigestScheduler() {
  digestSchedulerStarted = false;
  if (digestTimer) clearTimeout(digestTimer);
  digestTimer = null;
}

export function formatAlertMessage(alert) {
  const type = String(alert.type || "deal").replaceAll("_", " ");
  const link = alert.listing_url ? `\n${alert.listing_url}` : "";
  const parts = [
    alert.price ? `S$${Number(alert.price || 0).toLocaleString()}` : "",
    alert.score ? `Score ${alert.score}` : "",
    alert.score_breakdown || "",
    alert.location || "",
    alert.condition || "",
    alert.seller_name ? `Seller ${alert.seller_name}${alert.seller_rating ? ` (${alert.seller_rating} stars)` : ""}` : "",
    alert.explanation || "",
    alert.market_rating ? `Market ${alert.market_rating}` : "",
    alert.reason || ""
  ].filter(Boolean);
  const bodyMessage = alert.message && (!alert.listing_id || String(alert.type || "").startsWith("scrape_health")) ? `\n${String(alert.message).trim()}` : "";
  const description = alert.description ? `\n${String(alert.description).slice(0, 180)}` : "";
  const details = parts.length ? `\n${parts.join(" | ")}` : "";
  return `Carousell Bot ${type}: ${alert.title}${details}${bodyMessage}${description}${link}`.trim();
}

async function applyTelegramSettingsArgs(args, context = {}) {
  const config = await readJson("config");
  const text = String(args || "").trim();
  if (!text) return settingsReply(config);

  const [subcommandRaw, ...parts] = text.split(/\s+/);
  const subcommand = subcommandRaw.toLowerCase();
  const rest = parts.join(" ").trim();
  const settings = telegramAlertSettings(config);
  let next = config;
  let message = "Settings updated";

  if (["on", "off"].includes(subcommand)) {
    next = mergeTelegramAlertSettings(config, { enabled: subcommand === "on" });
  } else if (subcommand === "mode") {
    const mode = normalizeMode(parts[0]);
    next = mergeTelegramAlertSettings(config, { mode });
    message = `Notification mode set to ${mode.replace("_", " ")}`;
  } else if (["dnd", "quiet", "quiet-hours"].includes(subcommand)) {
    if (["on", "off"].includes(parts[0]?.toLowerCase())) {
      next = mergeTelegramAlertSettings(config, { quietHours: { enabled: parts[0].toLowerCase() === "on" } });
    } else {
      const start = normalizeTime(parts[0], settings.quietHours.start);
      const end = normalizeTime(parts[1], settings.quietHours.end);
      next = mergeTelegramAlertSettings(config, { quietHours: { enabled: true, start, end } });
      message = `Quiet hours set to ${start}–${end}`;
    }
  } else if (subcommand === "digest") {
    const first = parts[0]?.toLowerCase();
    if (first === "now") {
      const result = await sendQueuedTelegramDigest({ manual: true });
      return settingsReply(await readJson("config"), result.sent ? `Sent ${result.sent} queued listings.` : result.reason || "No queued listings.");
    }
    if (["on", "off"].includes(first)) {
      next = mergeTelegramAlertSettings(config, { digest: { enabled: first === "on" } });
    } else {
      const time = normalizeTime(parts[0], settings.digest.time);
      next = mergeTelegramAlertSettings(config, { digest: { enabled: true, time } });
      message = `Digest time set to ${time}`;
    }
  } else if (["interval", "minutes"].includes(subcommand)) {
    const intervalMinutes = clamp(Number(parts[0]), 5, 1440);
    next = { ...config, scheduler: { ...(config.scheduler || {}), intervalMinutes } };
    message = `Search interval set to ${intervalMinutes} minutes`;
  } else if (["threshold", "instant"].includes(subcommand)) {
    const minInstantScore = clamp(Number(parts[0]), 0, 100);
    next = mergeTelegramAlertSettings(config, { minInstantScore });
    message = `Instant threshold set to ${minInstantScore}+`;
  } else if (["minscore", "digestscore"].includes(subcommand)) {
    const minScore = clamp(Number(parts[0]), 0, 100);
    next = mergeTelegramAlertSettings(config, { digest: { minScore } });
    message = `Digest minimum score set to ${minScore}+`;
  } else if (["maxhour", "rate"].includes(subcommand)) {
    const maxInstantPerHour = clamp(Number(parts[0]), 0, 100);
    next = mergeTelegramAlertSettings(config, { maxInstantPerHour });
    message = `Max instant alerts set to ${maxInstantPerHour}/hour`;
  } else if (["top", "digesttop"].includes(subcommand)) {
    const maxItems = clamp(Number(parts[0]), 1, 30);
    next = mergeTelegramAlertSettings(config, { digest: { maxItems } });
    message = `Digest size set to top ${maxItems}`;
  } else if (["block", "filter", "blacklist"].includes(subcommand)) {
    const added = await addBlacklistFilters(rest);
    return settingsReply(await readJson("config"), added ? `Added ${added} blocked keyword${added === 1 ? "" : "s"}.` : "No new filter keywords were added.");
  } else {
    return settingsReply(config, `Unknown setting: ${subcommand}`);
  }

  await writeJson("config", next);
  rescheduleTelegramDigest();
  return settingsReply(await readJson("config"), message);
}

function settingsReply(config, prefix = "") {
  return {
    message: [prefix, telegramSettingsSummary(config)].filter(Boolean).join("\n\n"),
    replyMarkup: telegramSettingsKeyboard(config),
    answer: prefix || "Settings"
  };
}

async function sendTelegramReply(reply, config, options = {}) {
  if (reply && typeof reply === "object" && reply.message) {
    return sendTelegramMessage(reply.message, config, {
      ...options,
      replyMarkup: reply.replyMarkup || reply.reply_markup
    });
  }
  return sendTelegramMessage(String(reply), config, options);
}

async function addBlacklistFilters(value) {
  const phrases = [...new Set(String(value || "").split(/[\n,]+/).map((item) => item.trim()).filter(Boolean))];
  if (!phrases.length) return 0;
  const filters = await readJson("filters");
  const existing = new Set(filters.map((filter) => String(filter.phrase || "").toLowerCase()));
  let nextId = Math.max(0, ...filters.map((filter) => Number(filter.id || 0))) + 1;
  let added = 0;
  for (const phrase of phrases) {
    if (existing.has(phrase.toLowerCase())) continue;
    filters.push({ id: nextId, type: "blacklist", phrase, reason: "Telegram settings" });
    nextId += 1;
    added += 1;
  }
  if (added > 0) await writeJson("filters", filters);
  return added;
}

function findExistingTelegramDelivery(alert) {
  const identity = alertIdentity(alert);
  return getAlerts({ limit: 1000 }).find((item) => {
    if (!item || item.error) return false;
    if (alertIdentity(item) === identity) return true;
    if (alert.type === "price_drop") return false;
    return Number(item.listing_id || 0) === Number(alert.listing_id || -1)
      && String(item.type || "") === String(alert.type || "")
      && String(item.watch_id || "") === String(alert.watch_id || "");
  }) || null;
}

function scheduleTelegramDigest() {
  if (!digestSchedulerStarted) return;
  if (digestTimer) clearTimeout(digestTimer);
  digestTimer = null;

  readJson("config").then((config) => {
    const settings = telegramAlertSettings(config);
    if (!config.telegram?.enabled || !settings.digest.enabled) {
      digestTimer = setTimeout(scheduleTelegramDigest, DIGEST_RESCHEDULE_MS);
      digestTimer.unref?.();
      return;
    }
    const nextRun = nextTelegramDigestDate(config);
    const delayMs = Math.max(1000, Math.min(nextRun.getTime() - Date.now(), 36 * 60 * 60 * 1000));
    digestTimer = setTimeout(async () => {
      await sendQueuedTelegramDigest().catch((error) => recordTelegramStatus({ ok: false, error: error.message }));
      scheduleTelegramDigest();
    }, delayMs);
    digestTimer.unref?.();
  }).catch(() => {
    digestTimer = setTimeout(scheduleTelegramDigest, DIGEST_RESCHEDULE_MS);
    digestTimer.unref?.();
  });
}

function rescheduleTelegramDigest() {
  if (!digestSchedulerStarted) return;
  scheduleTelegramDigest();
}

async function recordTelegramStatus(result) {
  const config = await readJson("config");
  const telegram = config.telegram || {};
  const next = {
    ...config,
    telegram: {
      ...telegram,
      status: result.ok ? "verified" : "error",
      verifiedAt: result.ok ? new Date().toISOString() : telegram.verifiedAt || null,
      lastError: result.ok ? "" : result.error || result.reason || "Telegram notification failed"
    }
  };
  await writeJson("config", next);
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.round(number)));
}
