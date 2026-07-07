import { createAlert, readJson, writeJson } from "./store.js";

const TELEGRAM_API = "https://api.telegram.org";

export async function sendTelegramMessage(message, config = null) {
  const appConfig = config || (await readJson("config"));
  const telegram = appConfig.telegram || {};
  const token = String(telegram.botToken || telegram.bot_token || "").trim();
  const chatId = String(telegram.chatId || telegram.chat_id || "").trim();
  if (!telegram.enabled || !token || !chatId) {
    return { ok: false, skipped: true, reason: "Telegram is not configured" };
  }

  const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      disable_web_page_preview: true
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.description || "Telegram sendMessage failed");
  }
  return { ok: true, payload };
}

export async function notifyAlert(input) {
  const alert = input;
  const result = await sendTelegramMessage(formatAlertMessage(alert)).catch((error) => ({
    ok: false,
    error: error.message
  }));
  const next = createAlert({ ...alert, sent_at: result.ok ? new Date().toISOString() : null });
  return { alert: next, result };
}

export async function updateTelegramConfig(input) {
  const config = await readJson("config");
  const next = {
    ...config,
    telegram: {
      ...config.telegram,
      enabled: Boolean(input.enabled),
      botToken: String(input.botToken || input.bot_token || "").trim(),
      chatId: String(input.chatId || input.chat_id || "").trim()
    }
  };
  await writeJson("config", next);
  return maskTelegramConfig(next.telegram);
}

export function maskTelegramConfig(telegram = {}) {
  const token = String(telegram.botToken || "");
  return {
    enabled: Boolean(telegram.enabled),
    botTokenConfigured: token.length > 0,
    botTokenPreview: token ? `${token.slice(0, 5)}...${token.slice(-4)}` : "",
    chatId: telegram.chatId || ""
  };
}

function formatAlertMessage(alert) {
  const type = String(alert.type || "deal").replaceAll("_", " ");
  const link = alert.listing_url ? `\n${alert.listing_url}` : "";
  return `Carousell Bot ${type}: ${alert.title}\n${alert.message || ""}${link}`.trim();
}
