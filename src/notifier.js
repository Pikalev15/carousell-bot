import { nextRuntimeId } from "./runtimeIds.js";
import { createAlert, readJson, writeJson } from "./store.js";

const TELEGRAM_API = "https://api.telegram.org";
export const TELEGRAM_COMMANDS = [
  { command: "search", description: "Search Carousell: /search gpu" },
  { command: "watch", description: "Monitor a query or category" },
  { command: "unwatch", description: "Pause a monitor" },
  { command: "status", description: "Show scheduler and monitors" },
  { command: "deals", description: "Show current top deals" },
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
          const reply = await handleCommand({ ...parsed, type: "callback", id: callback.id, chatId, message: callback.message, data: callback.data }, { chatId, config }).catch((error) => `Action failed: ${error.message}`);
          if (reply && typeof reply === "object" && reply.message) {
            const replyMarkup = reply.replyMarkup || reply.reply_markup;
            const result = await sendTelegramMessage(reply.message, config, { chatId, replyMarkup }).catch((error) => ({ ok: false, error: error.message }));
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
        const reply = await handleCommand(text, { chatId, message, config }).catch((error) => `Command failed: ${error.message}`);
        if (reply) await sendTelegramMessage(reply, config, { chatId });
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
  const [prefix, action, listingId] = String(data || "").split(":");
  if (prefix !== "cb" || !action || !listingId) return { action: "", listingId: 0 };
  return { action, listingId: Number(listingId) };
}

export async function notifyAlert(input) {
  const alert = input;
  const result = await sendTelegramMessage(formatAlertMessage(alert), null, { replyMarkup: alertInlineKeyboard(alert) }).catch((error) => ({
    ok: false,
    error: error.message
  }));
  await recordTelegramStatus(result);
  const next = createAlert({
    ...alert,
    id: alert.id || nextRuntimeId(),
    sent_at: result.ok ? new Date().toISOString() : null,
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
