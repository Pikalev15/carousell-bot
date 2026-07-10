const state = {
  listings: [],
  deals: [],
  filters: [],
  sellers: [],
  labels: [],
  searches: [],
  activity: [],
  alerts: { unread: 0, alerts: [] },
  watchlist: [],
  scheduler: {},
  config: {},
  stats: {},
  trainingModel: {},
  searchResults: [],
  lastQuery: "",
  searchJob: null,
  theme: localStorage.getItem("theme") || "dark",
  density: localStorage.getItem("density") || "comfortable"
};

const API_TIMEOUT_MS = 15000;
// Playwright-backed scraping endpoints launch a real browser, navigate, wait for
// network idle, and hydrate several listing detail pages before responding — this
// routinely takes well over 15s, so they get a much longer budget than everything else.
const SLOW_ENDPOINT_TIMEOUT_MS = 120000;
const SLOW_ENDPOINT_PATTERNS = [/^\/api\/search$/, /^\/api\/listings\/[^/]+\/refresh-details$/, /^\/api\/scheduler\/run$/, /^\/api\/digest\/test$/];

function timeoutForPath(path) {
  return SLOW_ENDPOINT_PATTERNS.some((pattern) => pattern.test(path)) ? SLOW_ENDPOINT_TIMEOUT_MS : API_TIMEOUT_MS;
}

const api = {
  async get(path) {
    return request(path);
  },
  async post(path, body) {
    return request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  },
  async delete(path) {
    return request(path, { method: "DELETE" });
  },
  async patch(path, body) {
    return request(path, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  }
};

document.querySelectorAll(".nav-button").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.view));
});

document.getElementById("refresh").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setButtonBusy(button);
  try {
    await load();
    showToast("Dashboard updated");
  } catch (error) {
    showToast(`Refresh failed: ${error.message}`, "error");
  } finally {
    resetButtonBusy(button);
  }
});
document.getElementById("theme-toggle").addEventListener("click", () => {
  state.theme = state.theme === "dark" ? "light" : "dark";
  localStorage.setItem("theme", state.theme);
  applyTheme();
});

document.getElementById("density-toggle").addEventListener("click", () => {
  state.density = state.density === "compact" ? "comfortable" : "compact";
  localStorage.setItem("density", state.density);
  applyDensity();
  renderAll();
});
document.getElementById("dashboard-search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const query = document.getElementById("dashboard-query").value.trim();
    if (!query) return;
    document.getElementById("search-input").value = query;
    showView("search");
    await runSearch("web");
  } catch (error) {
    showToast(`Search failed: ${error.message}`, "error");
  }
});
document.getElementById("listing-filter").addEventListener("change", renderListings);
document.getElementById("listing-min-price").addEventListener("input", renderListings);
document.getElementById("listing-max-price").addEventListener("input", renderListings);
document.getElementById("listing-location").addEventListener("input", renderListings);
document.getElementById("listing-recent-filter").addEventListener("change", renderListings);
document.getElementById("listing-sort").addEventListener("change", renderListings);
document.getElementById("clear-price-filters").addEventListener("click", () => {
  document.getElementById("listing-min-price").value = "1";
  document.getElementById("listing-max-price").value = "";
  document.getElementById("listing-location").value = "";
  document.getElementById("listing-recent-filter").value = "";
  renderListings();
});
document.getElementById("details-close").addEventListener("click", () => document.getElementById("details-modal").close());

document.getElementById("filter-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  try {
    const form = new FormData(formElement);
    await api.post("/api/filters/blacklist", Object.fromEntries(form.entries()));
    formElement.reset();
    await load();
  } catch (error) {
    showToast(`Filter update failed: ${error.message}`, "error");
  }
});

document.getElementById("search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await runSearch("web");
});
document.getElementById("search-min-price").addEventListener("input", renderSearch);
document.getElementById("search-max-price").addEventListener("input", renderSearch);
document.getElementById("search-location").addEventListener("input", renderSearch);
document.getElementById("search-recent-filter").addEventListener("change", renderSearch);
document.getElementById("search-sort").addEventListener("change", renderSearch);

document.getElementById("search-more").addEventListener("click", async () => {
  await runSearch("more");
});
document.getElementById("retrain-model").addEventListener("click", async () => {
  try {
    state.trainingModel = await api.post("/api/training/retrain", {});
    await load();
    showToast("Training model updated");
  } catch (error) {
    showToast(`Retrain failed: ${error.message}`, "error");
  }
});
document.getElementById("alerts-toggle").addEventListener("click", () => toggleAlerts(true));
document.getElementById("alerts-close").addEventListener("click", () => toggleAlerts(false));
document.getElementById("alerts-scrim").addEventListener("click", () => toggleAlerts(false));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") toggleAlerts(false);
});
document.addEventListener(
  "error",
  (event) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.closest(".listing-visual")) return;
    const fallback = image.dataset.fallbackSrc;
    if (fallback && image.src !== fallback) {
      image.dataset.fallbackSrc = "";
      image.src = fallback;
      return;
    }
    const visual = image.closest(".listing-visual");
    const initial = visual.dataset.imageInitial || "?";
    visual.classList.add("empty");
    visual.innerHTML = `<span>${escapeHtml(initial)}</span>`;
  },
  true
);
document.getElementById("alerts-mark-read").addEventListener("click", async () => {
  try {
    await api.post("/api/alerts/mark-read", {});
    await load();
    toggleAlerts(false);
  } catch (error) {
    showToast(`Could not mark alerts read: ${error.message}`, "error");
  }
});
document.getElementById("watchlist-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  try {
    const form = new FormData(formElement);
    await api.post("/api/watchlist", {
      query: form.get("query"),
      price_ceiling: form.get("price_ceiling"),
      category: form.get("category"),
      active: true
    });
    formElement.reset();
    await load();
    showToast("Watched search added");
  } catch (error) {
    showToast(`Watchlist update failed: ${error.message}`, "error");
  }
});
document.getElementById("preset-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  setButtonBusy(button);
  try {
    const form = new FormData(event.currentTarget);
    await api.patch("/api/config/category-presets", {
      name: "Computers & Tech",
      terms: form.get("terms")
    });
    await load();
    showToast("Preset updated");
  } catch (error) {
    showToast(`Preset update failed: ${error.message}`, "error");
  } finally {
    resetButtonBusy(button);
  }
});
document.getElementById("telegram-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  try {
    const form = new FormData(formElement);
    await api.post("/api/config/telegram", {
      botToken: form.get("botToken"),
      chatId: form.get("chatId"),
      enabled: form.get("enabled") === "true"
    });
    formElement.reset();
    await load();
    showToast("Telegram settings saved");
  } catch (error) {
    showToast(`Telegram settings failed: ${error.message}`, "error");
  }
});
document.getElementById("telegram-test").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setButtonBusy(button);
  try {
    const result = await api.post("/api/telegram/test", {});
    await load();
    showToast(result.ok ? "Telegram test sent" : result.error || result.reason || "Telegram not configured", result.ok ? "success" : "error");
  } catch (error) {
    showToast(`Telegram test failed: ${error.message}`, "error");
  } finally {
    resetButtonBusy(button);
  }
});
document.getElementById("digest-email-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  try {
    const form = new FormData(formElement);
    await api.post("/api/config/digest-email", {
      gmailUser: form.get("gmailUser"),
      gmailAppPassword: form.get("gmailAppPassword"),
      emailTo: form.get("emailTo"),
      sendTime: form.get("sendTime"),
      enabled: form.get("enabled") === "true"
    });
    formElement.elements.gmailAppPassword.value = "";
    await load();
    showToast("Email digest settings saved");
  } catch (error) {
    showToast(`Email digest settings failed: ${digestEndpointError(error)}`, "error");
  }
});
document.getElementById("digest-email-test").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setButtonBusy(button);
  try {
    const result = await api.post("/api/digest/test", {});
    await load();
    showToast(result.ok ? "Digest test email sent" : result.error || result.reason || "Digest email not configured", result.ok ? "success" : "error");
  } catch (error) {
    showToast(`Digest test failed: ${digestEndpointError(error)}`, "error");
  } finally {
    resetButtonBusy(button);
  }
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;

  if (button.dataset.blockSeller) {
    return runAction(async () => {
      await api.post(`/api/sellers/blacklist/${encodeURIComponent(button.dataset.blockSeller)}`, {
        seller_name: button.dataset.sellerName,
        reason: "Blocked from listing card"
      });
      await load();
      showToast("Seller blocked");
    }, "Block seller failed");
  }

  if (button.dataset.deleteFilter) {
    return runAction(async () => {
      await api.delete(`/api/filters/blacklist/${button.dataset.deleteFilter}`);
      await load();
      showToast("Filter deleted");
    }, "Delete filter failed");
  }

  if (button.dataset.deleteSeller) {
    return runAction(async () => {
      await api.delete(`/api/sellers/blacklist/${encodeURIComponent(button.dataset.deleteSeller)}`);
      await load();
      showToast("Seller unblocked");
    }, "Delete seller failed");
  }

  if (button.dataset.label) {
    return runBusyAction(button, async () => {
      await api.post("/api/feedback/label", {
        listing_id: Number(button.dataset.listingId),
        rating: button.dataset.label,
        asked_price: Number(button.dataset.price)
      });
      await load();
      showToast(`Marked as ${button.dataset.label.replace("_", " ")}`);
    }, "Label failed");
  }

  if (button.dataset.msrp) {
    return runBusyAction(button, async () => {
      const result = await api.post("/api/msrp/lookup", {
        title: button.dataset.title,
        price: Number(button.dataset.price)
      });
      document.querySelectorAll(`[data-msrp-result="${button.dataset.msrp}"]`).forEach((target) => {
        const evidence = result.evidence ? ` | ${result.evidence.slice(0, 120)}` : "";
        target.textContent = `MSRP ${formatMoney(result.msrp)} (${result.currency || "SGD"}) | ${result.discount_percent}% off | ${result.source}${evidence}`;
      });
    }, "MSRP lookup failed");
  }

  if (button.dataset.viewListing) {
    return runAction(async () => {
      const listing = await api.get(`/api/listings/${button.dataset.viewListing}`);
      openDetails(listing);
    }, "Listing details failed");
  }

  if (button.dataset.refreshDetails) {
    return runBusyAction(button, async () => {
      const listing = await api.post(`/api/listings/${button.dataset.refreshDetails}/refresh-details`, {});
      await load();
      openDetails(listing);
      showToast("Listing details refreshed");
    }, "Refresh details failed");
  }

  if (button.dataset.openUrl) {
    window.open(button.dataset.openUrl, "_blank", "noopener");
    return undefined;
  }

  if (button.dataset.repeatSearch) {
    return runAction(async () => {
      document.getElementById("search-input").value = button.dataset.repeatSearch;
      await runSearch("web");
    }, "Repeat search failed");
  }

  if (button.dataset.toggleWatch) {
    return runAction(async () => {
      await api.patch(`/api/watchlist/${button.dataset.toggleWatch}`, { active: button.dataset.active !== "true" });
      await load();
      showToast("Watchlist updated");
    }, "Watchlist update failed");
  }

  if (button.dataset.deleteWatch) {
    return runAction(async () => {
      await api.delete(`/api/watchlist/${button.dataset.deleteWatch}`);
      await load();
      showToast("Watched search deleted");
    }, "Delete watch failed");
  }

  if (button.dataset.runWatch) {
    return runAction(async () => {
      const watch = state.watchlist.find((item) => String(item.id) === String(button.dataset.runWatch));
      if (watch) {
        document.getElementById("search-input").value = watch.query;
        showView("search");
        await runSearch("web");
      }
    }, "Watched search failed");
  }

  if (button.dataset.schedulerToggle) {
    return runAction(async () => {
      const enabled = button.dataset.schedulerToggle !== "true";
      await api.post("/api/scheduler", { enabled, intervalMinutes: state.scheduler.intervalMinutes || 30, jitterSeconds: state.scheduler.jitterSeconds || 45 });
      await load();
      showToast(enabled ? "Scheduler activated" : "Scheduler paused");
    }, "Scheduler update failed");
  }

  if (button.dataset.schedulerRun) {
    return runBusyAction(button, async () => {
      await api.post("/api/scheduler/run", {});
      await load();
      showToast("Scheduler run complete");
    }, "Scheduler run failed");
  }
});

async function load() {
  document.body.classList.add("is-loading");
  try {
    const [listings, deals, filters, sellers, stats, labels, searches, trainingModel, alerts, watchlist, activity, scheduler, config] = await Promise.all([
      api.get("/api/listings?include_filtered=true"),
      api.get("/api/deals"),
      api.get("/api/filters/blacklist"),
      api.get("/api/sellers/blacklist"),
      api.get("/api/filters/stats"),
      api.get("/api/feedback/labels"),
      api.get("/api/search/history"),
      api.get("/api/training/model"),
      api.get("/api/alerts"),
      api.get("/api/watchlist"),
      api.get("/api/activity"),
      api.get("/api/scheduler"),
      api.get("/api/config")
    ]);
    Object.assign(state, { listings, deals, filters, sellers, stats, labels, searches, trainingModel, alerts, watchlist, activity, scheduler, config });
    if (state.lastQuery) {
      state.searchResults = applyPriceFilters(state.listings.filter((listing) => matchesQuery(listing, state.lastQuery)), "search");
    }
    renderAll();
  } catch (error) {
    document.getElementById("search-summary").textContent = `Could not reach the local server: ${error.message}`;
    showToast(`Server unavailable: ${error.message}`, "error");
  } finally {
    document.body.classList.remove("is-loading");
  }
}

function renderAll() {
  renderStats();
  renderDashboardOverview();
  renderDeals();
  renderListings();
  renderSearch();
  renderFilters();
  renderTraining();
  renderSellers();
  renderAlerts();
  renderWatchlist();
  renderActivity();
  renderScheduler();
  renderTelegram();
  renderDigestEmail();
}

async function runSearch(mode) {
  const input = document.getElementById("search-input");
  const query = input.value.trim() || state.lastQuery;
  if (!query) return;
  const submit = mode === "more" ? document.getElementById("search-more") : document.querySelector("#search-form button[type='submit']");
  setButtonBusy(submit, mode === "more" ? "Searching more" : "Searching");
  document.getElementById("search-summary").textContent = mode === "more" ? "Searching Carousell for more results..." : "Searching Carousell...";
  try {
    const payload = await api.post("/api/search", {
      query,
      mode,
      min_price: getNumberValue("search-min-price", 1),
      max_price: getNumberValue("search-max-price", null),
      location: document.getElementById("search-location").value.trim(),
      max_age_hours: getNumberValue("search-recent-filter", null),
      include_filtered: true
    });
    state.lastQuery = query;
    state.searchResults = payload.results;
    state.searches = payload.history;
    await load();
    showView("search");
    document.getElementById("search-input").value = query;
    renderSearch();
    const source = payload.source === "carousell-web" ? "Carousell web" : payload.source;
    const added = payload.added ? ` Added ${payload.added} new listings.` : "";
    const updated = payload.updated ? ` Updated ${payload.updated} existing listings.` : "";
    const warning = payload.warning ? ` ${payload.warning}` : "";
    document.getElementById("search-summary").textContent = `Found ${state.searchResults.length} visible results for "${query}" via ${source}.${added}${updated}${warning}`;
    if (payload.hydration_job?.id) {
      state.searchJob = payload.hydration_job;
      pollSearchJob(payload.hydration_job.id, query);
    }
    showToast(payload.added || payload.updated ? `Added ${payload.added || 0}, updated ${payload.updated || 0}` : "Search complete");
  } catch (error) {
    document.getElementById("search-summary").textContent = `Search failed: ${error.message}`;
    showToast(`Search failed: ${error.message}`, "error");
  } finally {
    resetButtonBusy(submit);
  }
}

async function pollSearchJob(id, query) {
  try {
    const job = await api.get(`/api/search/jobs/${id}`);
    state.searchJob = job;
    const done = Number(job.completed || 0);
    const total = Number(job.total || 0);
    if (job.status === "running" || job.status === "queued") {
      document.getElementById("search-summary").textContent = `Found ${state.searchResults.length} visible results for "${query}". Enriching details ${done}/${total}...`;
      setTimeout(() => pollSearchJob(id, query), 1800);
      return;
    }
    if (job.status === "complete") {
      await load();
      state.searchResults = applyPriceFilters(state.listings.filter((listing) => matchesQuery(listing, query)), "search");
      renderSearch();
      document.getElementById("search-summary").textContent = `Found ${state.searchResults.length} visible results for "${query}". Details enriched ${done}/${total}.`;
      showToast("Listing details enriched");
      return;
    }
    document.getElementById("search-summary").textContent = `Found ${state.searchResults.length} visible results for "${query}". Detail enrichment failed: ${job.error || "unknown error"}`;
  } catch (error) {
    showToast(`Hydration status failed: ${error.message}`, "error");
  }
}

function showView(view) {
  document.querySelectorAll(".nav-button").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  document.querySelectorAll(".view").forEach((item) => item.classList.toggle("active", item.id === view));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderStats() {
  const stats = [
    ["Listings", state.stats.total_listings],
    ["Filtered", state.stats.filtered],
    ["Bad pricers", state.stats.bad_pricers],
    ["Spam", state.stats.spam_blocked],
    ["Rules", state.stats.phrase_rules]
  ];
  document.getElementById("stats").innerHTML = stats
    .map(([label, value]) => `<div class="stat"><span class="meta">${label}</span><strong>${value ?? 0}</strong></div>`)
    .join("");
}

function renderDeals() {
  const topDeals = sortListings(state.deals, "score").slice(0, state.density === "compact" ? 6 : 4);
  document.getElementById("deals").innerHTML = topDeals.length
    ? topDeals.map(card).join("")
    : `<p class="empty-state">No deal candidates yet. Run a search or tune filters to build a focused shortlist.</p>`;
}

function renderDashboardOverview() {
  const priced = state.listings.filter((listing) => Number(listing.current_price || 0) >= 1);
  const clean = priced.filter((listing) => !listing.classification.is_filtered);
  const filtered = state.listings.filter((listing) => listing.classification.is_filtered);
  const topDeals = sortListings(state.deals, "score").slice(0, 5);
  const newestClean = sortListings(clean, "recent").slice(0, 3);
  const filterRate = state.listings.length ? Math.round((filtered.length / state.listings.length) * 100) : 0;
  const averageScore = clean.length
    ? Math.round(clean.reduce((total, listing) => total + Number(listing.score?.deal_score || 0), 0) / clean.length)
    : 0;

  document.getElementById("dashboard-pipeline").innerHTML = [
    ...topDeals.map((listing) => pipelineRow(listing, "Deal candidate", "good")),
    ...newestClean.map((listing) => pipelineRow(listing, "Fresh clean post", "info"))
  ].slice(0, 6).join("") || `<p class="empty-state compact-empty">No pipeline activity yet. Search Carousell to populate the dashboard.</p>`;

  document.getElementById("dashboard-health").innerHTML = `
    <div><span class="meta">Clean listings</span><strong>${clean.length}</strong><small>${filterRate}% filtered out</small></div>
    <div><span class="meta">Avg deal score</span><strong>${averageScore}</strong><small>Across visible posts</small></div>
    <div><span class="meta">Watch rules</span><strong>${state.filters.length}</strong><small>${state.sellers.length} sellers blocked</small></div>
    <div><span class="meta">Training labels</span><strong>${state.labels.length}</strong><small>Model feedback examples</small></div>
  `;

  document.getElementById("dashboard-activity").innerHTML = state.activity.length
    ? state.activity.slice(0, 6).map(activityRow).join("")
    : `<p class="meta">No activity yet.</p>`;
}

function pipelineRow(listing, label, tone) {
  return `
    <article class="pipeline-row">
      <div>
        <span class="badge ${tone}">${label}</span>
        <strong>${escapeHtml(listing.title)}</strong>
        <p class="meta">${formatMoney(listing.current_price)} · ${formatAge(listing)} · ${displayLocation(listing)}</p>
      </div>
      <button class="primary-action" data-view-listing="${listing.id}">Review</button>
    </article>
  `;
}

function renderListings() {
  const filter = document.getElementById("listing-filter").value;
  const listings = applyPriceFilters(state.listings, "listing").filter((listing) => {
    if (filter === "clean") return !listing.classification.is_filtered;
    if (filter === "filtered") return listing.classification.is_filtered;
    return true;
  });
  document.getElementById("listing-list").innerHTML = collapseDuplicateGroups(sortListings(listings, document.getElementById("listing-sort").value)).map(card).join("");
}

function renderSearch() {
  const results = collapseDuplicateGroups(sortListings(applyPriceFilters(state.searchResults, "search"), document.getElementById("search-sort").value));
  document.getElementById("search-results").innerHTML = results.length
    ? results.map(card).join("")
    : `<p class="empty-state">No visible listings in this price range. Try raising the max, lowering the min, or searching a more specific phrase.</p>`;
  document.getElementById("search-history").innerHTML = state.searches.length
    ? state.searches
        .slice(0, 8)
        .map(
          (search) => `
            <div class="row compact">
              <strong>${escapeHtml(search.query)}</strong>
              <span class="badge ${search.mode === "more" ? "warn" : "info"}">${search.mode}</span>
              <span class="meta">${new Date(search.timestamp).toLocaleString()}</span>
              <button data-repeat-search="${escapeHtml(search.query)}">Run</button>
            </div>
          `
        )
        .join("")
    : `<p class="meta">No searches yet.</p>`;
}

function renderFilters() {
  document.getElementById("filters").innerHTML = state.filters
    .map((filter) => `
      <div class="row">
        <strong>${escapeHtml(filter.phrase)}</strong>
        <span class="badge ${filter.type === "bad_pricer" ? "warn" : "info"}">${filter.type}</span>
        <span class="meta">${escapeHtml(filter.reason || "")}</span>
        <button data-delete-filter="${filter.id}">Remove</button>
      </div>
    `)
    .join("");
}

function renderSellers() {
  document.getElementById("sellers").innerHTML = state.sellers.length
    ? state.sellers
        .map((seller) => `
          <div class="row">
            <strong>${escapeHtml(seller.seller_name || seller.seller_id)}</strong>
            <span class="badge bad">blocked</span>
            <span class="meta">${escapeHtml(seller.reason || "")}</span>
            <button data-delete-seller="${seller.seller_id}">Unblock</button>
          </div>
        `)
        .join("")
    : `<p class="meta">No blocked sellers.</p>`;
}

function renderTraining() {
  const model = state.trainingModel || {};
  document.getElementById("training-stats").innerHTML = `
    <div><span class="meta">Examples</span><strong>${model.example_count || 0}</strong></div>
    <div><span class="meta">Good</span><strong>${model.positive_count || 0}</strong></div>
    <div><span class="meta">Bad deal</span><strong>${model.bad_deal_count || 0}</strong></div>
    <div><span class="meta">Updated</span><strong>${model.trained_at ? new Date(model.trained_at).toLocaleTimeString() : "Never"}</strong></div>
  `;
}

function renderAlerts() {
  document.getElementById("alerts-count").textContent = state.alerts.unread || 0;
  document.getElementById("alerts-count").classList.toggle("is-empty", !state.alerts.unread);
  document.getElementById("alerts-list").innerHTML = state.alerts.alerts?.length
    ? state.alerts.alerts.map((alert) => `
      <article class="alert-item ${alert.read_at ? "" : "unread"}">
        <span class="badge ${alert.type === "price_drop" ? "warn" : "good"}">${escapeHtml(String(alert.type || "deal").replaceAll("_", " "))}</span>
        <strong>${escapeHtml(alert.title)}</strong>
        <p class="meta">${escapeHtml(alert.message || "")}</p>
        <small>${formatDateTime(alert.created_at)}</small>
      </article>
    `).join("")
    : `<p class="empty-state compact-empty">No alerts yet.</p>`;
}

function renderWatchlist() {
  const terms = state.config.categoryPresets?.["Computers & Tech"] || [];
  const presetForm = document.getElementById("preset-form");
  if (presetForm) presetForm.elements.terms.value = terms.join(", ");
  document.getElementById("watchlist-list").innerHTML = state.watchlist.length
    ? state.watchlist.map((watch) => `
      <article class="watch-card">
        <div>
          <span class="badge ${watch.active ? "good" : "info"}">${watch.active ? "Active" : "Paused"}</span>
          <h3>${escapeHtml(watch.query)}</h3>
          <p class="meta">${watch.price_ceiling ? `Ceiling ${formatMoney(watch.price_ceiling)}` : "No price ceiling"}${watch.category ? ` / ${escapeHtml(watch.category)}` : ""}</p>
          <p class="meta">Last run ${watch.last_run_at ? formatDateTime(watch.last_run_at) : "never"}</p>
        </div>
        <div class="actions">
          <button class="primary-action" data-run-watch="${watch.id}">Run</button>
          <button data-toggle-watch="${watch.id}" data-active="${watch.active}">${watch.active ? "Pause" : "Activate"}</button>
          <button data-delete-watch="${watch.id}">Delete</button>
        </div>
      </article>
    `).join("")
    : `<p class="empty-state">No watched searches yet. Add one to let the scheduler look for restocks and deals.</p>`;
}

function renderActivity() {
  document.getElementById("activity-timeline").innerHTML = state.activity.length
    ? state.activity.map(activityRow).join("")
    : `<p class="empty-state">No timeline entries yet.</p>`;
}

function renderScheduler() {
  const scheduler = state.scheduler || {};
  document.getElementById("scheduler-widget").innerHTML = `
    <div>
      <span class="badge ${scheduler.enabled ? "good" : "info"}">${scheduler.enabled ? "Scheduler active" : "Scheduler paused"}</span>
      <strong>${scheduler.running ? "Running now" : scheduler.enabled ? "Watching saved searches" : "Paused"}</strong>
      <p class="meta">Last ${scheduler.lastRunAt ? formatDateTime(scheduler.lastRunAt) : "never"} / next ${scheduler.nextRunAt ? formatDateTime(scheduler.nextRunAt) : "not scheduled"}</p>
    </div>
    <div class="actions">
      <button class="primary-action" data-scheduler-run="true">Run now</button>
      <button data-scheduler-toggle="${scheduler.enabled}">${scheduler.enabled ? "Pause" : "Activate"}</button>
    </div>
  `;
}

function renderTelegram() {
  const telegram = state.config.telegram || {};
  const hasCredentials = Boolean(telegram.botTokenConfigured && telegram.chatId);
  const status = telegram.status === "error" ? "error" : telegram.verifiedAt ? "verified" : hasCredentials ? "saved" : "missing";
  const statusLabel =
    status === "verified"
      ? "Verified working"
      : status === "error"
        ? "Connection error"
        : status === "saved"
          ? "Configured, not verified"
          : "Not configured";
  const error = telegram.lastError ? `<div class="telegram-error"><span class="meta">Last error</span><strong>${escapeHtml(telegram.lastError)}</strong></div>` : "";
  document.getElementById("telegram-status").innerHTML = `
    <div class="telegram-credentials ${escapeHtml(status)}">
      <div class="credential-header">
        <span class="meta">Credentials</span>
        <span class="badge ${status === "error" ? "bad" : status === "verified" ? "good" : "info"}">${escapeHtml(statusLabel)}</span>
      </div>
      <div class="credential-grid">
        <div class="credential-line">
          <span class="credential-icon" aria-hidden="true">KEY</span>
          <div><span class="meta">Bot token</span><strong>${escapeHtml(telegram.botTokenPreview || "Missing")}</strong></div>
        </div>
        <div class="credential-line">
          <span class="credential-icon" aria-hidden="true">ID</span>
          <div><span class="meta">Chat ID</span><strong>${escapeHtml(telegram.chatId || "Missing")}</strong></div>
        </div>
      </div>
    </div>
    <div><span class="meta">Notifications</span><strong>${telegram.enabled ? "Enabled" : "Paused"}</strong></div>
    <div><span class="meta">Verified</span><strong>${telegram.verifiedAt ? formatDateTime(telegram.verifiedAt) : "Not yet"}</strong></div>
    ${error}
  `;
}

function renderDigestEmail() {
  const digest = state.config.digestEmail || {};
  const form = document.getElementById("digest-email-form");
  if (form) {
    form.elements.gmailUser.value = digest.gmailUser || "";
    form.elements.emailTo.value = digest.emailTo || "";
    form.elements.sendTime.value = digest.sendTime || "08:00";
    form.elements.enabled.value = digest.enabled === false ? "false" : "true";
  }
  const status = digest.configured ? (digest.enabled === false ? "paused" : "ready") : "missing";
  const statusLabel = status === "ready" ? "Ready" : status === "paused" ? "Paused" : "Not configured";
  const missing = Array.isArray(digest.missing) && digest.missing.length ? `<div class="telegram-error"><span class="meta">Missing</span><strong>${escapeHtml(digest.missing.join(", "))}</strong></div>` : "";
  document.getElementById("digest-email-status").innerHTML = `
    <div class="telegram-credentials ${escapeHtml(status === "ready" ? "verified" : status === "paused" ? "saved" : "error")}">
      <div class="credential-header">
        <span class="meta">Gmail SMTP</span>
        <span class="badge ${status === "ready" ? "good" : status === "paused" ? "info" : "bad"}">${escapeHtml(statusLabel)}</span>
      </div>
      <div class="credential-grid">
        <div class="credential-line">
          <span class="credential-icon" aria-hidden="true">GM</span>
          <div><span class="meta">Gmail user</span><strong>${escapeHtml(digest.gmailUser || "Missing")}</strong></div>
        </div>
        <div class="credential-line">
          <span class="credential-icon" aria-hidden="true">KEY</span>
          <div><span class="meta">App password</span><strong>${escapeHtml(digest.gmailAppPasswordPreview || "Missing")}</strong></div>
        </div>
        <div class="credential-line">
          <span class="credential-icon" aria-hidden="true">TO</span>
          <div><span class="meta">Recipient</span><strong>${escapeHtml(digest.emailTo || "Missing")}</strong></div>
        </div>
        <div class="credential-line">
          <span class="credential-icon" aria-hidden="true">AT</span>
          <div><span class="meta">Daily send time</span><strong>${escapeHtml(digest.sendTime || "08:00")}</strong></div>
        </div>
      </div>
    </div>
    <div><span class="meta">Source</span><strong>${escapeHtml(digest.source || "local config")}</strong></div>
    <div><span class="meta">Sends when</span><strong>Enabled searches have qualifying 24h deals</strong></div>
    ${missing}
  `;
}

function activityRow(item) {
  return `
    <article class="timeline-item activity-row">
      <span class="badge ${item.type === "price_drop" ? "warn" : item.type === "scrape_error" ? "bad" : "info"}">${escapeHtml(String(item.type || "event").replaceAll("_", " "))}</span>
      <span>${escapeHtml(item.title || "Activity")}</span>
      <p class="meta">${escapeHtml(item.detail || "")}</p>
      <small>${formatDateTime(item.timestamp)}</small>
    </article>
  `;
}

function card(listing) {
  const classification = listing.classification;
  const label = state.labels.find((item) => item.listing_id === listing.id);
  const dealScore = Number(listing.score?.deal_score || 0);
  const visualUrl = listingImage(listing);
  const fallbackUrl = originalListingImage(listing);
  const visual = visualUrl
    ? `<div class="listing-visual" data-image-initial="${escapeHtml(String(listing.title || "?").trim().slice(0, 1).toUpperCase() || "?")}"><img src="${escapeHtml(visualUrl)}" data-fallback-src="${escapeHtml(fallbackUrl)}" alt="" loading="lazy"></div>`
    : `<div class="listing-visual empty"><span>${escapeHtml(String(listing.title || "?").trim().slice(0, 1).toUpperCase() || "?")}</span></div>`;
  const badge = classification.is_filtered
    ? `<span class="badge bad">${classification.post_type}</span>`
    : `<span class="badge good">Score ${dealScore}</span>`;
  const score = listing.score
    ? `
      <div class="score-strip">
        <span>Deal <strong>${listing.score.deal_score}</strong></span>
        <span>Price <strong>${listing.score.price_score}</strong></span>
        <span>Preference <strong>${listing.score.training_preference}</strong></span>
      </div>
      <div class="score-meter" aria-hidden="true"><span></span></div>
    `
    : "";
  const reasons = classification.reasons.length
    ? `<ul class="reasons">${classification.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>`
    : `<p class="meta">Clean WTS listing.</p>`;
  const labelBadge = label ? `<span class="badge info">${label.user_rating}</span>` : "";
  const priceNote =
    listing.price_source === "description"
      ? `<p class="price-note">Price corrected from description. Card price was ${formatMoney(listing.display_price)}.</p>`
      : "";
  const reputation = sellerBadge(listing.seller_reputation);
  const sparkline = priceSparkline(listing.price_history);
  const market = marketBadge(listing.market_insight);
  const duplicate = Number(listing.duplicate_count || 1) > 1 ? `<span class="badge info">${Number(listing.duplicate_count) - 1} similar</span>` : "";
  const explanation = scoreExplanation(listing);

  return `
    <article class="card" style="--entry-index: ${Number(listing.id || 0) % 12}; --score: ${dealScore}">
      ${visual}
      <div class="card-header">
        <div class="listing-main">
          <p class="title">${escapeHtml(listing.title)}</p>
          <p class="listing-meta">
            <span>${sellerMarkup(listing)}</span>
            <span>${reputation}</span>
            <span>${listing.seller_rating} stars</span>
            <span>${formatAge(listing)}</span>
            <span>${displayLocation(listing)}</span>
          </p>
        </div>
        <div class="badge-stack">${badge}${market}${duplicate}${labelBadge}</div>
      </div>
      <div class="price-row">
        <div class="price">${formatMoney(listing.current_price)}</div>
        ${sparkline}
      </div>
      ${score}
      ${priceNote}
      ${explanation}
      ${reasons}
      <p class="meta" data-msrp-result="${listing.id}"></p>
      <div class="actions">
        <button class="primary-action" data-view-listing="${listing.id}">View</button>
        <button data-refresh-details="${listing.id}">Refresh</button>
        <button data-open-url="${escapeHtml(listing.carousell_url)}">Open</button>
        <button data-label="good" data-listing-id="${listing.id}" data-price="${listing.current_price}">Good</button>
        <button data-label="skip" data-listing-id="${listing.id}" data-price="${listing.current_price}">Skip</button>
        <button data-label="bad_deal" data-listing-id="${listing.id}" data-price="${listing.current_price}">Bad deal</button>
        <button data-label="bought" data-listing-id="${listing.id}" data-price="${listing.current_price}">Bought</button>
        <button data-label="spam" data-listing-id="${listing.id}" data-price="${listing.current_price}">Spam</button>
        <button data-label="not_spam" data-listing-id="${listing.id}" data-price="${listing.current_price}">Not spam</button>
        <button data-msrp="${listing.id}" data-title="${escapeHtml(listing.title)}" data-price="${listing.current_price}">MSRP</button>
        <button data-block-seller="${listing.seller_id}" data-seller-name="${escapeHtml(listing.seller_name)}">Block</button>
      </div>
    </article>
  `;
}

function openDetails(listing) {
  const variants = state.listings
    .filter((item) => listing.duplicate_group_id && item.duplicate_group_id === listing.duplicate_group_id && item.id !== listing.id)
    .slice(0, 6);
  document.getElementById("details-title").textContent = listing.title;
  document.getElementById("details-body").innerHTML = `
    <div class="detail-grid">
      <p><strong>Price</strong><span>${formatMoney(listing.current_price)}</span></p>
      <p><strong>Seller</strong><span>${sellerMarkup(listing)} (${listing.seller_rating} stars)</span></p>
      <p><strong>Location</strong><span>${displayLocation(listing)}</span></p>
      <p><strong>Condition</strong><span>${escapeHtml(listing.condition)}</span></p>
      <p><strong>Classification</strong><span>${escapeHtml(listing.classification.post_type)}</span></p>
      <p><strong>Market</strong><span>${marketInsightText(listing.market_insight)}</span></p>
      <p><strong>Why this score?</strong><span>${escapeHtml(listing.score?.explanation?.summary || "No score explanation available.")}</span></p>
      <p class="description-row"><strong>Description</strong><span>${escapeHtml(listing.description || "No description captured yet. Search this listing again to refresh details.")}</span></p>
    </div>
    ${variants.length ? `
      <div class="variant-list">
        <h3>${variants.length} similar listing${variants.length === 1 ? "" : "s"}</h3>
        ${variants.map((variant) => `
          <div class="row compact">
            <strong>${escapeHtml(variant.title)}</strong>
            <span class="meta">${formatMoney(variant.current_price)} / ${displayLocation(variant)}</span>
            <button data-open-url="${escapeHtml(variant.carousell_url)}">Open</button>
          </div>
        `).join("")}
      </div>
    ` : ""}
  `;
  document.getElementById("details-modal").showModal();
}

function matchesQuery(listing, query) {
  const text = `${listing.title} ${listing.description} ${listing.category}`.toLowerCase();
  return text.includes(query.toLowerCase());
}

function collapseDuplicateGroups(listings) {
  const seen = new Set();
  return listings.filter((listing) => {
    const groupId = listing.duplicate_group_id;
    if (!groupId || listing.duplicate_count <= 1) return true;
    if (listing.duplicate_role === "primary" && !seen.has(groupId)) {
      seen.add(groupId);
      return true;
    }
    if (seen.has(groupId)) return false;
    seen.add(groupId);
    return true;
  });
}

function applyPriceFilters(listings, scope) {
  const minId = scope === "search" ? "search-min-price" : "listing-min-price";
  const maxId = scope === "search" ? "search-max-price" : "listing-max-price";
  const locationId = scope === "search" ? "search-location" : "listing-location";
  const recentId = scope === "search" ? "search-recent-filter" : "listing-recent-filter";
  const min = getNumberValue(minId, 1);
  const max = getNumberValue(maxId, null);
  const location = document.getElementById(locationId).value.trim().toLowerCase();
  const maxAgeHours = getNumberValue(recentId, null);
  return listings.filter((listing) => {
    const price = Number(listing.current_price || 0);
    if (min !== null && price < min) return false;
    if (max !== null && price > max) return false;
    if (location && !String(listing.location || "").toLowerCase().includes(location)) return false;
    if (maxAgeHours !== null && getListingAgeHours(listing) > maxAgeHours) return false;
    return true;
  });
}

function getNumberValue(id, fallback) {
  const raw = document.getElementById(id).value;
  if (raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function formatMoney(value) {
  return `S$${Number(value || 0).toLocaleString()}`;
}

function sellerMarkup(listing) {
  const name = escapeHtml(listing.seller_name || "Carousell seller");
  return listing.seller_url ? `<a href="${escapeHtml(listing.seller_url)}" target="_blank" rel="noopener">${name}</a>` : name;
}

function displayLocation(listing) {
  const location = String(listing.location || "").trim();
  return escapeHtml(location && !/^carousell sg$/i.test(location) ? location : "Location not listed");
}

function listingImage(listing) {
  const urls = Array.isArray(listing.image_urls) ? listing.image_urls : [];
  return urls.find((url) => url && !/\/profiles?\//i.test(url)) || "";
}

function originalListingImage(listing) {
  const urls = Array.isArray(listing.original_image_urls) ? listing.original_image_urls : [];
  return urls.find((url) => url && !/\/profiles?\//i.test(url)) || "";
}

function marketBadge(insight = {}) {
  const rating = insight.rating || "unknown";
  if (rating === "unknown") return "";
  const tone = rating === "great" ? "good" : rating === "overpriced" || rating === "suspicious_low" ? "warn" : "info";
  return `<span class="badge market ${escapeHtml(tone)}">${escapeHtml(rating.replaceAll("_", " "))}</span>`;
}

function marketInsightText(insight = {}) {
  if (!insight || insight.rating === "unknown") return "Not enough local comps yet";
  const delta = insight.price_delta_percent === null || insight.price_delta_percent === undefined ? "" : ` / ${insight.price_delta_percent}% vs median`;
  return `${insight.rating.replaceAll("_", " ")} / median ${formatMoney(insight.median_price)} / ${insight.sample_size} comps${delta}`;
}

function scoreExplanation(listing) {
  const explanation = listing.score?.explanation;
  if (!explanation) return "";
  const components = explanation.components || {};
  return `
    <details class="score-explanation">
      <summary>Why this score?</summary>
      <p>${escapeHtml(explanation.summary || "")}</p>
      <div class="explanation-chips">
        <span>Seller ${Number(components.seller || 0)}</span>
        <span>Age ${Number(components.age || 0)}</span>
        <span>Detail ${Number(components.detail || 0)}</span>
        <span>Penalty ${Number(components.penalty || 0)}</span>
      </div>
    </details>
  `;
}

function sellerBadge(reputation = {}) {
  const total = Number(reputation.total || 0);
  const tone = total ? reputation.tone : "neutral";
  const label = total ? `${Math.round(Number(reputation.ratio || 0) * 100)}% good` : "new seller";
  return `<span class="seller-badge ${escapeHtml(tone)}">${escapeHtml(label)}</span>`;
}

function priceSparkline(history = []) {
  const points = Array.isArray(history) ? history.slice(-12) : [];
  if (points.length < 2) return `<svg class="sparkline empty" viewBox="0 0 92 28" aria-hidden="true"><path d="M4 22H88"/></svg>`;
  const prices = points.map((point) => Number(point.price || 0));
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const spread = Math.max(1, max - min);
  const coords = prices.map((price, index) => {
    const x = 4 + (index / Math.max(1, prices.length - 1)) * 84;
    const y = 24 - ((price - min) / spread) * 20;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const tone = prices[prices.length - 1] <= prices[0] ? "drop" : "rise";
  return `
    <svg class="sparkline ${tone}" viewBox="0 0 92 28" role="img" aria-label="Price history">
      <polyline points="${coords.join(" ")}"></polyline>
      <circle cx="${coords.at(-1).split(",")[0]}" cy="${coords.at(-1).split(",")[1]}" r="2.4"></circle>
    </svg>
  `;
}

function toggleAlerts(open) {
  const panel = document.getElementById("alerts-panel");
  const scrim = document.getElementById("alerts-scrim");
  document.getElementById("alerts-toggle").setAttribute("aria-expanded", String(open));
  panel.classList.toggle("open", open);
  panel.setAttribute("aria-hidden", String(!open));
  clearTimeout(toggleAlerts.scrimTimer);
  if (open) {
    scrim.hidden = false;
    requestAnimationFrame(() => scrim.classList.add("open"));
    return;
  }
  scrim.classList.remove("open");
  toggleAlerts.scrimTimer = setTimeout(() => {
    scrim.hidden = true;
  }, 190);
}

async function runAction(action, failurePrefix = "Action failed") {
  try {
    await action();
  } catch (error) {
    showToast(`${failurePrefix}: ${error.message}`, "error");
  }
}

async function runBusyAction(button, action, failurePrefix = "Action failed") {
  setButtonBusy(button);
  try {
    await action();
  } catch (error) {
    showToast(`${failurePrefix}: ${error.message}`, "error");
  } finally {
    resetButtonBusy(button);
  }
}

function sortListings(listings, mode) {
  return [...listings].sort((a, b) => {
    if (mode === "price_low") return Number(a.current_price || 0) - Number(b.current_price || 0);
    if (mode === "price_high") return Number(b.current_price || 0) - Number(a.current_price || 0);
    if (mode === "recent") return getListingAgeHours(a) - getListingAgeHours(b);
    return Number(b.score?.deal_score || 0) - Number(a.score?.deal_score || 0);
  });
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  const toggle = document.getElementById("theme-toggle");
  const light = state.theme === "light";
  toggle.textContent = light ? "Dark mode" : "Light mode";
  toggle.setAttribute("aria-pressed", String(light));
}

function applyDensity() {
  const compact = state.density === "compact";
  document.body.classList.toggle("compact-density", compact);
  const toggle = document.getElementById("density-toggle");
  toggle.textContent = compact ? "Comfortable" : "Compact";
  toggle.setAttribute("aria-pressed", String(compact));
}

function setButtonBusy(button) {
  if (!button) return;
  button.dataset.idleText = button.dataset.idleText || button.textContent;
  button.setAttribute("aria-busy", "true");
  button.disabled = true;
}

function resetButtonBusy(button) {
  if (!button) return;
  button.removeAttribute("aria-busy");
  button.disabled = false;
  if (button.dataset.idleText) {
    button.textContent = button.dataset.idleText;
  }
}

function showToast(message, type = "info", options = {}) {
  const root = document.getElementById("toast-root");
  if (!root) return;
  const toast = document.createElement("div");
  const safeType = ["success", "error", "info", "warn"].includes(type) ? type : "info";
  toast.className = `toast toast-${safeType}`;
  toast.dataset.state = "entering";
  toast.setAttribute("role", safeType === "error" ? "alert" : "status");
  toast.innerHTML = `
    <span class="toast-mark" aria-hidden="true"></span>
    <p>${escapeHtml(message)}</p>
    <button type="button" aria-label="Dismiss notification">x</button>
  `;
  root.prepend(toast);
  toast.querySelector("button").addEventListener("click", () => dismissToast(toast));
  requestAnimationFrame(() => {
    toast.dataset.state = "open";
  });
  toast.timer = setTimeout(() => dismissToast(toast), options.duration || (safeType === "error" ? 5200 : 3200));
}

function dismissToast(toast) {
  if (!toast || toast.dataset.state === "closing") return;
  clearTimeout(toast.timer);
  toast.dataset.state = "closing";
  setTimeout(() => toast.remove(), 190);
}

function formatAge(listing) {
  const hours = getListingAgeHours(listing);
  if (hours < 1) return `${Math.max(0, Math.round(hours * 60))} min`;
  if (hours < 24) return `${Math.round(hours)} hr`;
  return `${Math.round(hours / 24)} days`;
}

function getListingAgeHours(listing) {
  if (listing.listed_age_minutes !== null && listing.listed_age_minutes !== undefined) {
    return Number(listing.listed_age_minutes) / 60;
  }
  if (listing.listed_at) {
    return Math.max(0, (Date.now() - new Date(listing.listed_at).getTime()) / 3600000);
  }
  return Number(listing.days_listed || 0) * 24;
}

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString() : "Never";
}

async function checkedJson(response) {
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

function digestEndpointError(error) {
  return error.message === "Not found" ? "server needs a restart to load the new email digest routes" : error.message;
}

async function request(path, options = {}) {
  const timeoutMs = timeoutForPath(path);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, { ...options, signal: controller.signal });
    return await checkedJson(response);
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

applyTheme();
applyDensity();
load();
