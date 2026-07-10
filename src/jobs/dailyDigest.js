import { addActivity, getWatchedSearches, readJson } from "../store.js";
import { buildTopDealsBySearch } from "../services/dealScorer.js";
import { getDigestEmailConfig, normalizeDigestSendTime, sendDigestEmail } from "../services/emailService.js";
import { renderTopDealsDigest } from "../services/digestRenderer.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SINGAPORE_OFFSET_MS = 8 * 60 * 60 * 1000;

export class DailyDigestJob {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.logger = options.logger || console;
    this.sendEmail = options.sendEmail || sendDigestEmail;
    this.timer = null;
    this.running = false;
    this.lastRunDate = "";
  }

  start() {
    this.stop();
    this.scheduleNext().catch((error) => this.logger.error?.(`[dailyDigest] Could not schedule digest: ${error.message}`));
    return this.status();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  status(now = new Date()) {
    return {
      running: this.running,
      configured: getDigestEmailConfig(this.env).configured,
      sendTime: normalizeSendTime(this.env.DIGEST_SEND_TIME),
      nextRunAt: this.nextRunAt || nextRunDate(now, normalizeSendTime(this.env.DIGEST_SEND_TIME)).toISOString(),
      lastRunDate: this.lastRunDate || null
    };
  }

  async runNow(now = new Date()) {
    if (this.running) return { skipped: true, reason: "Digest already running" };
    const runDate = localDateKey(now);
    if (this.lastRunDate === runDate) return { skipped: true, reason: "Digest already ran today" };

    this.running = true;
    try {
      const result = await runDailyDigest({ now, env: this.env, logger: this.logger, sendEmail: this.sendEmail });
      this.lastRunDate = runDate;
      return result;
    } finally {
      this.running = false;
    }
  }

  async scheduleNext(now = new Date()) {
    const appConfig = await readJson("config").catch(() => ({}));
    const sendTime = normalizeSendTime(appConfig.digestEmail?.sendTime || this.env.DIGEST_SEND_TIME);
    const next = nextRunDate(now, sendTime);
    this.nextRunAt = next.toISOString();
    const delayMs = Math.max(1000, next.getTime() - new Date(now).getTime());
    this.timer = setTimeout(() => {
      this.runNow(new Date())
        .catch((error) => {
          this.logger.error?.(`[dailyDigest] Failed: ${error.message}`);
        })
        .finally(() => this.scheduleNext(new Date(Date.now() + 1000)).catch((error) => this.logger.error?.(`[dailyDigest] Could not reschedule digest: ${error.message}`)));
    }, delayMs);
    this.timer.unref?.();
  }
}

export function createDailyDigestJob(options = {}) {
  return new DailyDigestJob(options);
}

export async function runDailyDigest({ now = new Date(), env = process.env, logger = console, sendEmail = sendDigestEmail } = {}) {
  const appConfig = await readJson("config");
  const emailConfig = getDigestEmailConfig(env, appConfig.digestEmail);
  if (!emailConfig.enabled) {
    logger.info?.("[dailyDigest] Email digest is paused; skipping.");
    return { skipped: true, reason: "Email digest is paused" };
  }
  if (!emailConfig.configured) {
    const reason = `Missing ${emailConfig.missing.join(", ")}`;
    logger.warn?.(`[dailyDigest] Skipping email digest. ${reason}.`);
    return { skipped: true, reason };
  }

  const [listings, filters, watchedSearches] = await Promise.all([
    readJson("listings"),
    readJson("filters"),
    getWatchedSearches()
  ]);
  const enabledSearches = watchedSearches.filter((search) => search.active !== false);
  if (enabledSearches.length === 0) {
    logger.info?.("[dailyDigest] No enabled saved searches; skipping.");
    return { skipped: true, reason: "No enabled saved searches" };
  }

  const sections = buildTopDealsBySearch({
    listings,
    searches: enabledSearches,
    filters,
    config: appConfig,
    now
  });

  if (sections.length === 0) {
    logger.info?.("[dailyDigest] No qualifying deals in the last 24 hours; skipping email.");
    addActivity({ type: "email_digest", title: "Top Deals digest skipped", detail: "No qualifying deals in the last 24 hours", timestamp: new Date(now).toISOString() });
    return { skipped: true, reason: "No qualifying deals" };
  }

  const message = renderTopDealsDigest({ sections, generatedAt: now });
  const dealCount = sections.reduce((total, section) => total + section.deals.length, 0);
  try {
    const sent = await sendEmail(message, { config: emailConfig, env });
    logger.info?.(`[dailyDigest] Sent ${dealCount} deals to ${emailConfig.to}.`);
    addActivity({ type: "email_digest", title: "Top Deals digest sent", detail: `${dealCount} deals sent to ${emailConfig.to}`, timestamp: new Date(now).toISOString() });
    return { sent: true, dealCount, searchCount: sections.length, messageId: sent?.messageId || null };
  } catch (error) {
    logger.error?.(`[dailyDigest] Email send failed: ${error.message}`);
    addActivity({ type: "email_digest_error", title: "Top Deals digest failed", detail: error.message, timestamp: new Date(now).toISOString() });
    throw error;
  }
}

export function normalizeSendTime(value) {
  return normalizeDigestSendTime(value);
}

export function nextRunDate(now = new Date(), sendTime = "08:00") {
  const [hour, minute] = normalizeSendTime(sendTime).split(":").map(Number);
  const current = new Date(now);
  const singaporeNow = new Date(current.getTime() + SINGAPORE_OFFSET_MS);
  const year = singaporeNow.getUTCFullYear();
  const month = singaporeNow.getUTCMonth();
  const date = singaporeNow.getUTCDate();
  let nextUtcMs = Date.UTC(year, month, date, hour, minute, 0, 0) - SINGAPORE_OFFSET_MS;
  if (nextUtcMs <= current.getTime()) nextUtcMs += DAY_MS;
  return new Date(nextUtcMs);
}

function localDateKey(value) {
  const singaporeDate = new Date(new Date(value).getTime() + SINGAPORE_OFFSET_MS);
  return `${singaporeDate.getUTCFullYear()}-${String(singaporeDate.getUTCMonth() + 1).padStart(2, "0")}-${String(singaporeDate.getUTCDate()).padStart(2, "0")}`;
}
