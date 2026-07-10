import { addActivity, getWatchedSearches, readJson, upsertWatchedSearch, writeJson } from "./store.js";
import { notifyAlert } from "./notifier.js";
import { isBaselineSafeScrape, normalizeScrapeResult } from "./scrapeResult.js";
import {
  canSendGlobalSummary,
  createScrapeHealthEvent,
  formatScrapeHealthIndividual,
  formatScrapeHealthSummary,
  recordGlobalSummarySent,
  recordHealthEvent,
  recordHealthRecovery,
  scrapeHealthSettings
} from "./scrapeHealth.js";

export class SearchScheduler {
  constructor(runWatchedSearch) {
    this.runWatchedSearch = runWatchedSearch;
    this.timer = null;
    this.running = false;
    this.activeRun = null;
    this.lastRunAt = null;
    this.nextRunAt = null;
  }

  async start() {
    const config = await readJson("config");
    if (!config.scheduler?.enabled) return this.status(config);
    this.scheduleNext(config);
    return this.status(config);
  }

  async configure(input) {
    const config = await readJson("config");
    const next = {
      ...config,
      scheduler: {
        ...config.scheduler,
        enabled: input.enabled === undefined ? config.scheduler?.enabled : Boolean(input.enabled),
        intervalMinutes: clampNumber(input.intervalMinutes ?? input.interval_minutes ?? config.scheduler?.intervalMinutes ?? 30, 5, 1440),
        jitterSeconds: clampNumber(input.jitterSeconds ?? input.jitter_seconds ?? config.scheduler?.jitterSeconds ?? 45, 0, 600),
        interWatchDelaySeconds: clampNumber(input.interWatchDelaySeconds ?? input.inter_watch_delay_seconds ?? config.scheduler?.interWatchDelaySeconds ?? 0, 0, 600),
        maxRunMinutes: clampNumber(input.maxRunMinutes ?? input.max_run_minutes ?? config.scheduler?.maxRunMinutes ?? 30, 1, 240)
      }
    };
    await writeJson("config", next);
    if (next.scheduler.enabled) this.scheduleNext(next);
    else this.pause();
    return this.status(next);
  }

  pause() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
  }

  async runNow() {
    if (this.running) {
      return { ...this.status(await readJson("config")), running: true, activeRun: this.activeRun };
    }

    const runConfig = await readJson("config");
    const schedulerConfig = runConfig.scheduler || {};
    const startedAt = new Date().toISOString();
    const runId = `scrape-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.running = true;
    this.activeRun = { id: runId, started_at: startedAt, status: "running" };
    addActivity({ type: "scrape_run", title: "Scheduler run started", detail: "Running active watched searches", timestamp: startedAt });

    try {
      const watches = (await getWatchedSearches()).filter((watch) => watch.active && !isWatchMuted(watch));
      const deadlineMs = Date.now() + clampNumber(schedulerConfig.maxRunMinutes ?? 30, 1, 240) * 60 * 1000;
      const results = [];
      const healthEvents = [];
      const notifyEvents = [];
      const recoveryEvents = [];

      for (const watch of watches) {
        if (Date.now() > deadlineMs) {
          addActivity({ type: "scrape_run_limit", title: "Scheduler run duration limit reached", detail: `${results.length}/${watches.length} watched searches completed`, watch_id: watch.id });
          break;
        }
        await delay(Number(schedulerConfig.interWatchDelaySeconds || 0) + randomJitter(schedulerConfig.jitterSeconds));
        const watchStartedAt = new Date().toISOString();
        const startedMs = Date.now();
        try {
          const raw = await this.runWatchedSearch(watch);
          const normalized = normalizeScrapeResult({
            ...raw,
            watch_id: raw?.watch_id ?? watch.id,
            query: raw?.query || watch.query,
            duration_ms: raw?.duration_ms ?? Date.now() - startedMs,
            started_at: raw?.started_at || watchStartedAt,
            finished_at: raw?.finished_at || new Date().toISOString()
          });
          const event = createScrapeHealthEvent(watch, normalized, runConfig);
          const recorded = event ? recordHealthEvent(event, runConfig) : null;
          if (recorded?.event) healthEvents.push(recorded.event);
          if (recorded?.notify) notifyEvents.push(recorded.event);

          const recovery = !event ? recordHealthRecovery(watch, normalized, runConfig) : null;
          if (recovery) {
            recoveryEvents.push(recovery);
            notifyEvents.push(recovery);
          }

          if (isBaselineSafeScrape(normalized) && !event) {
            upsertWatchedSearch({ ...watch, last_result_count: normalized.result_count, last_run_at: normalized.finished_at });
          } else {
            upsertWatchedSearch({ ...watch, last_run_at: normalized.finished_at });
          }

          results.push({ ...normalized, health_event: event || null });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const normalized = normalizeScrapeResult({
            status: "failed",
            ok: false,
            watch_id: watch.id,
            query: watch.query,
            error: message,
            duration_ms: Date.now() - startedMs,
            started_at: watchStartedAt,
            finished_at: new Date().toISOString()
          });
          const event = createScrapeHealthEvent(watch, normalized, runConfig);
          const recorded = event ? recordHealthEvent(event, runConfig) : null;
          if (recorded?.event) healthEvents.push(recorded.event);
          if (recorded?.notify) notifyEvents.push(recorded.event);
          results.push({ ...normalized, health_event: event || null });
          upsertWatchedSearch({ ...watch, last_run_at: normalized.finished_at });
          addActivity({
            type: "scrape_error",
            title: `Watched search failed: ${watch.query}`,
            detail: message,
            watch_id: watch.id
          });
        }
      }

      this.lastRunAt = new Date().toISOString();
      const failed = results.filter((result) => !result.ok).length;
      const warning = healthEvents.filter((event) => event.severity === "warning").length;
      const successful = results.filter((result) => result.ok && !result.health_event).length;
      const summary = {
        run_id: runId,
        started_at: startedAt,
        finished_at: this.lastRunAt,
        total_watches: watches.length,
        successful,
        warnings: warning,
        failed,
        duration_ms: Date.now() - new Date(startedAt).getTime()
      };

      await sendHealthNotifications(notifyEvents, summary, runConfig);

      addActivity({
        type: "scrape_run",
        title: "Scheduler run finished",
        detail: `${results.length}/${watches.length} watched searches checked; ${successful} successful, ${warning} warnings, ${failed} failed`,
        timestamp: this.lastRunAt
      });

      // Re-read before writing so settings changed during a long scrape are not overwritten.
      const latestConfig = await readJson("config");
      await writeJson("config", {
        ...latestConfig,
        scheduler: {
          ...latestConfig.scheduler,
          lastRunAt: this.lastRunAt
        }
      });

      return { results, health_events: healthEvents, recovery_events: recoveryEvents, ...summary, ...this.status(await readJson("config")) };
    } finally {
      this.running = false;
      this.activeRun = null;
      const latest = await readJson("config");
      if (latest.scheduler?.enabled) this.scheduleNext(latest);
    }
  }

  status(config) {
    const scheduler = config?.scheduler || {};
    return {
      enabled: Boolean(scheduler.enabled),
      running: this.running,
      activeRun: this.activeRun,
      intervalMinutes: Number(scheduler.intervalMinutes || 30),
      jitterSeconds: Number(scheduler.jitterSeconds || 0),
      interWatchDelaySeconds: Number(scheduler.interWatchDelaySeconds || 0),
      maxRunMinutes: Number(scheduler.maxRunMinutes || 30),
      lastRunAt: this.lastRunAt || scheduler.lastRunAt || null,
      nextRunAt: this.nextRunAt || scheduler.nextRunAt || null
    };
  }

  scheduleNext(config) {
    this.pause();
    const intervalMs = clampNumber(config.scheduler?.intervalMinutes || 30, 5, 1440) * 60 * 1000;
    const jitterMs = randomJitter(config.scheduler?.jitterSeconds) * 1000;
    const delayMs = intervalMs + jitterMs;
    this.nextRunAt = new Date(Date.now() + delayMs).toISOString();
    this.timer = setTimeout(() => {
      this.runNow().catch((error) => {
        addActivity({ type: "scrape_error", title: "Scheduler run failed", detail: error.message });
      });
    }, delayMs);
  }
}

async function sendHealthNotifications(events, summary, config) {
  const settings = scrapeHealthSettings(config);
  if (!events.length || settings.notificationMode === "off") return;

  if (settings.notificationMode === "summary") {
    const healthEvents = events.filter((event) => event.type !== "recovery");
    const recoveries = events.filter((event) => event.type === "recovery");
    if (healthEvents.length && canSendGlobalSummary(config)) {
      await notifyAlert({
        type: "scrape_health_summary",
        title: `Scrape health summary (${healthEvents.length})`,
        message: formatScrapeHealthSummary(healthEvents, summary),
        alert_key: `scrape_health_summary:${summary.run_id}`
      });
      recordGlobalSummarySent();
    }
    for (const recovery of recoveries) {
      await notifyAlert({
        type: "scrape_health_recovery",
        title: `Scrape recovered: ${recovery.query || recovery.watch_id}`,
        message: formatScrapeHealthIndividual(recovery),
        watch_id: recovery.watch_id,
        alert_key: recovery.fingerprint
      });
    }
    return;
  }

  for (const event of events) {
    await notifyAlert({
      type: event.type === "recovery" ? "scrape_health_recovery" : "scrape_health",
      title: event.type === "recovery" ? `Scrape recovered: ${event.query || event.watch_id}` : `Scrape health: ${event.query || event.watch_id || event.type}`,
      message: formatScrapeHealthIndividual(event),
      watch_id: event.watch_id,
      alert_key: event.fingerprint
    });
  }
}

function isWatchMuted(watch) {
  return watch?.muted_until && new Date(watch.muted_until).getTime() > Date.now();
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function randomJitter(maxSeconds = 0) {
  const max = Math.max(0, Number(maxSeconds || 0));
  return Math.round(Math.random() * max);
}

function delay(seconds) {
  return new Promise((resolve) => setTimeout(resolve, Number(seconds || 0) * 1000));
}
