import { addActivity, getWatchedSearches, readJson, upsertWatchedSearch, writeJson } from "./store.js";
import { notifyAlert } from "./notifier.js";

export class SearchScheduler {
  constructor(runWatchedSearch) {
    this.runWatchedSearch = runWatchedSearch;
    this.timer = null;
    this.running = false;
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
        jitterSeconds: clampNumber(input.jitterSeconds ?? input.jitter_seconds ?? config.scheduler?.jitterSeconds ?? 45, 0, 600)
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
    if (this.running) return { ...this.status(await readJson("config")), running: true };
    const config = await readJson("config");
    this.running = true;
    const startedAt = new Date().toISOString();
    addActivity({ type: "scrape_run", title: "Scheduler run started", detail: "Running active watched searches", timestamp: startedAt });
    try {
      const watches = (await getWatchedSearches()).filter((watch) => watch.active);
      const results = [];
      for (const watch of watches) {
        await delay(randomJitter(config.scheduler?.jitterSeconds));
        const result = await this.runWatchedSearch(watch);
        results.push(result);
        await checkScrapeHealth(watch, result, config).catch((error) => {
          addActivity({ type: "scrape_health_error", title: "Scrape health check failed", detail: error.message, watch_id: watch.id });
        });
      }
      this.lastRunAt = new Date().toISOString();
      addActivity({
        type: "scrape_run",
        title: "Scheduler run finished",
        detail: `${watches.length} watched searches checked`,
        timestamp: this.lastRunAt
      });
      await writeJson("config", {
        ...config,
        scheduler: {
          ...config.scheduler,
          lastRunAt: this.lastRunAt
        }
      });
      return { results, ...this.status(await readJson("config")) };
    } finally {
      this.running = false;
      const latest = await readJson("config");
      if (latest.scheduler?.enabled) this.scheduleNext(latest);
    }
  }

  status(config) {
    const scheduler = config?.scheduler || {};
    return {
      enabled: Boolean(scheduler.enabled),
      running: this.running,
      intervalMinutes: Number(scheduler.intervalMinutes || 30),
      jitterSeconds: Number(scheduler.jitterSeconds || 0),
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

async function checkScrapeHealth(watch, result, config) {
  const settings = config.scrapeHealthCheck || {};
  if (settings.enabled === false) return;
  const current = Number(result.result_count ?? result.results_count ?? result.added + result.updated ?? 0);
  const previous = Number(watch.last_result_count ?? 0);
  const minPrevious = clampNumber(settings.minPreviousResults ?? 5, 1, 10000);
  const minRatio = Math.max(0, Math.min(1, Number(settings.minResultRatio ?? 0.2)));

  const nextWatch = upsertWatchedSearch({ ...watch, last_result_count: current, last_run_at: new Date().toISOString() });
  if (previous < minPrevious) return;
  if (current > previous * minRatio) return;

  const now = new Date();
  const lastAlertAt = nextWatch.last_health_alert_at ? new Date(nextWatch.last_health_alert_at) : null;
  if (lastAlertAt && now - lastAlertAt < 6 * 60 * 60 * 1000) return;

  const message = `Carousell scrape for "${watch.query}" returned unexpectedly few results (${current} vs previous ${previous}). Site structure may have changed.`;
  await notifyAlert({
    type: "scrape_health",
    title: "Scrape health warning",
    message,
    watch_id: watch.id
  });
  upsertWatchedSearch({ ...nextWatch, last_health_alert_at: now.toISOString() });
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
