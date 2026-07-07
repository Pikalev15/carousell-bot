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
  theme: localStorage.getItem("theme") || "dark",
  density: localStorage.getItem("density") || "comfortable"
};

const api = {
  async get(path) {
    const response = await fetch(path);
    return checkedJson(response);
  },
  async post(path, body) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return checkedJson(response);
  },
  async delete(path) {
    const response = await fetch(path, { method: "DELETE" });
    return checkedJson(response);
  },
  async patch(path, body) {
    const response = await fetch(path, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return checkedJson(response);
  }
};

document.querySelectorAll(".nav-button").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.view));
});

document.getElementById("refresh").addEventListener("click", async (event) => {
  setButtonBusy(event.currentTarget, "Refreshing");
  await load();
  event.currentTarget.removeAttribute("aria-busy");
  event.currentTarget.textContent = "Refresh";
  showToast("Dashboard updated");
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
  const query = document.getElementById("dashboard-query").value.trim();
  if (!query) return;
  document.getElementById("search-input").value = query;
  showView("search");
  await runSearch("web");
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
  const form = new FormData(event.currentTarget);
  await api.post("/api/filters/blacklist", Object.fromEntries(form.entries()));
  event.currentTarget.reset();
  await load();
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
  state.trainingModel = await api.post("/api/training/retrain", {});
  await load();
});
document.getElementById("alerts-toggle").addEventListener("click", () => toggleAlerts(true));
document.getElementById("alerts-close").addEventListener("click", () => toggleAlerts(false));
document.getElementById("alerts-mark-read").addEventListener("click", async () => {
  await api.post("/api/alerts/mark-read", {});
  await load();
  toggleAlerts(false);
});
document.getElementById("watchlist-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await api.post("/api/watchlist", {
    query: form.get("query"),
    price_ceiling: form.get("price_ceiling"),
    category: form.get("category"),
    active: true
  });
  event.currentTarget.reset();
  await load();
  showToast("Watched search added");
});
document.getElementById("telegram-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await api.post("/api/config/telegram", {
    botToken: form.get("botToken"),
    chatId: form.get("chatId"),
    enabled: form.get("enabled") === "true"
  });
  event.currentTarget.reset();
  await load();
  showToast("Telegram settings saved");
});
document.getElementById("telegram-test").addEventListener("click", async (event) => {
  setButtonBusy(event.currentTarget, "Sending");
  const result = await api.post("/api/telegram/test", {});
  event.currentTarget.removeAttribute("aria-busy");
  event.currentTarget.textContent = "Send test message";
  showToast(result.ok ? "Telegram test sent" : result.reason || "Telegram not configured");
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;

  if (button.dataset.blockSeller) {
    await api.post(`/api/sellers/blacklist/${encodeURIComponent(button.dataset.blockSeller)}`, {
      seller_name: button.dataset.sellerName,
      reason: "Blocked from listing card"
    });
    await load();
  }

  if (button.dataset.deleteFilter) {
    await api.delete(`/api/filters/blacklist/${button.dataset.deleteFilter}`);
    await load();
  }

  if (button.dataset.deleteSeller) {
    await api.delete(`/api/sellers/blacklist/${encodeURIComponent(button.dataset.deleteSeller)}`);
    await load();
  }

  if (button.dataset.label) {
    setButtonBusy(button, "Saving");
    await api.post("/api/feedback/label", {
      listing_id: Number(button.dataset.listingId),
      rating: button.dataset.label,
      asked_price: Number(button.dataset.price)
    });
    await load();
    showToast(`Marked as ${button.dataset.label.replace("_", " ")}`);
  }

  if (button.dataset.msrp) {
    setButtonBusy(button, "Checking");
    const result = await api.post("/api/msrp/lookup", {
      title: button.dataset.title,
      price: Number(button.dataset.price)
    });
    document.querySelectorAll(`[data-msrp-result="${button.dataset.msrp}"]`).forEach((target) => {
      const evidence = result.evidence ? ` | ${result.evidence.slice(0, 120)}` : "";
      target.textContent = `MSRP ${formatMoney(result.msrp)} (${result.currency || "SGD"}) | ${result.discount_percent}% off | ${result.source}${evidence}`;
    });
    button.removeAttribute("aria-busy");
    button.textContent = "MSRP";
  }

  if (button.dataset.viewListing) {
    const listing = await api.get(`/api/listings/${button.dataset.viewListing}`);
    openDetails(listing);
  }

  if (button.dataset.refreshDetails) {
    setButtonBusy(button, "Refreshing");
    const listing = await api.post(`/api/listings/${button.dataset.refreshDetails}/refresh-details`, {});
    await load();
    openDetails(listing);
    showToast("Listing details refreshed");
  }

  if (button.dataset.openUrl) {
    window.open(button.dataset.openUrl, "_blank", "noopener");
  }

  if (button.dataset.repeatSearch) {
    document.getElementById("search-input").value = button.dataset.repeatSearch;
    await runSearch("web");
  }

  if (button.dataset.toggleWatch) {
    await api.patch(`/api/watchlist/${button.dataset.toggleWatch}`, { active: button.dataset.active !== "true" });
    await load();
  }

  if (button.dataset.deleteWatch) {
    await api.delete(`/api/watchlist/${button.dataset.deleteWatch}`);
    await load();
  }

  if (button.dataset.runWatch) {
    const watch = state.watchlist.find((item) => String(item.id) === String(button.dataset.runWatch));
    if (watch) {
      document.getElementById("search-input").value = watch.query;
      showView("search");
      await runSearch("web");
    }
  }

  if (button.dataset.schedulerToggle) {
    const enabled = button.dataset.schedulerToggle !== "true";
    await api.post("/api/scheduler", { enabled, intervalMinutes: state.scheduler.intervalMinutes || 30, jitterSeconds: state.scheduler.jitterSeconds || 45 });
    await load();
  }

  if (button.dataset.schedulerRun) {
    setButtonBusy(button, "Running");
    await api.post("/api/scheduler/run", {});
    button.removeAttribute("aria-busy");
    button.textContent = "Run now";
    await load();
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
    const source = payload.source === "carousell-web" ? "Carousell web" : payload.source;
    const added = payload.added ? ` Added ${payload.added} new listings.` : "";
    const updated = payload.updated ? ` Updated ${payload.updated} existing listings with full details.` : "";
    const warning = payload.warning ? ` ${payload.warning}` : "";
    document.getElementById("search-summary").textContent = `Found ${state.searchResults.length} visible results for "${query}" via ${source}.${added}${updated}${warning}`;
    showToast(payload.added || payload.updated ? `Added ${payload.added || 0}, updated ${payload.updated || 0}` : "Search complete");
  } catch (error) {
    document.getElementById("search-summary").textContent = `Search failed: ${error.message}`;
  } finally {
    submit.removeAttribute("aria-busy");
    submit.textContent = mode === "more" ? "Search more" : "Search web";
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
  document.getElementById("listing-list").innerHTML = sortListings(listings, document.getElementById("listing-sort").value).map(card).join("");
}

function renderSearch() {
  const results = sortListings(applyPriceFilters(state.searchResults, "search"), document.getElementById("search-sort").value);
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
  document.getElementById("telegram-status").innerHTML = `
    <div><span class="meta">Status</span><strong>${telegram.enabled ? "Enabled" : "Paused"}</strong></div>
    <div><span class="meta">Token</span><strong>${telegram.botTokenConfigured ? "Saved" : "Missing"}</strong></div>
    <div><span class="meta">Chat</span><strong>${escapeHtml(telegram.chatId || "Missing")}</strong></div>
    <div><span class="meta">Preview</span><strong>${escapeHtml(telegram.botTokenPreview || "-")}</strong></div>
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
  const visual = visualUrl
    ? `<div class="listing-visual"><img src="${escapeHtml(visualUrl)}" alt="" loading="lazy"></div>`
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
        <div class="badge-stack">${badge}${labelBadge}</div>
      </div>
      <div class="price-row">
        <div class="price">${formatMoney(listing.current_price)}</div>
        ${sparkline}
      </div>
      ${score}
      ${priceNote}
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
  document.getElementById("details-title").textContent = listing.title;
  document.getElementById("details-body").innerHTML = `
    <div class="detail-grid">
      <p><strong>Price</strong><span>${formatMoney(listing.current_price)}</span></p>
      <p><strong>Seller</strong><span>${sellerMarkup(listing)} (${listing.seller_rating} stars)</span></p>
      <p><strong>Location</strong><span>${displayLocation(listing)}</span></p>
      <p><strong>Condition</strong><span>${escapeHtml(listing.condition)}</span></p>
      <p><strong>Classification</strong><span>${escapeHtml(listing.classification.post_type)}</span></p>
      <p class="description-row"><strong>Description</strong><span>${escapeHtml(listing.description || "No description captured yet. Search this listing again to refresh details.")}</span></p>
    </div>
  `;
  document.getElementById("details-modal").showModal();
}

function matchesQuery(listing, query) {
  const text = `${listing.title} ${listing.description} ${listing.category}`.toLowerCase();
  return text.includes(query.toLowerCase());
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
  document.getElementById("alerts-toggle").setAttribute("aria-expanded", String(open));
  panel.classList.toggle("open", open);
  panel.setAttribute("aria-hidden", String(!open));
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

function setButtonBusy(button, text) {
  if (!button) return;
  button.dataset.idleText = button.dataset.idleText || button.textContent;
  button.setAttribute("aria-busy", "true");
  button.textContent = text;
}

let toastTimer;
function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2200);
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
