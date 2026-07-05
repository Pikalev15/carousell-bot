const state = {
  listings: [],
  deals: [],
  filters: [],
  sellers: [],
  labels: [],
  searches: [],
  stats: {},
  searchResults: [],
  lastQuery: ""
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
  }
};

document.querySelectorAll(".nav-button").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.view));
});

document.getElementById("refresh").addEventListener("click", load);
document.getElementById("listing-filter").addEventListener("change", renderListings);
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

document.getElementById("search-more").addEventListener("click", async () => {
  await runSearch("more");
});

async function load() {
  try {
    const [listings, deals, filters, sellers, stats, labels, searches] = await Promise.all([
      api.get("/api/listings"),
      api.get("/api/deals"),
      api.get("/api/filters/blacklist"),
      api.get("/api/sellers/blacklist"),
      api.get("/api/filters/stats"),
      api.get("/api/feedback/labels"),
      api.get("/api/search/history")
    ]);
    Object.assign(state, { listings, deals, filters, sellers, stats, labels, searches });
    if (state.lastQuery) {
      state.searchResults = state.listings.filter((listing) => matchesQuery(listing, state.lastQuery));
    }
    renderAll();
  } catch (error) {
    document.getElementById("search-summary").textContent = `Could not reach the local server: ${error.message}`;
  }
}

function renderAll() {
  renderStats();
  renderDeals();
  renderListings();
  renderSearch();
  renderFilters();
  renderSellers();
  bindActionButtons();
}

async function runSearch(mode) {
  const input = document.getElementById("search-input");
  const query = input.value.trim() || state.lastQuery;
  if (!query) return;
  document.getElementById("search-summary").textContent = mode === "more" ? "Searching Carousell for more results..." : "Searching Carousell...";
  try {
    const payload = await api.post("/api/search", { query, mode });
    state.lastQuery = query;
    state.searchResults = payload.results;
    state.searches = payload.history;
    await load();
    showView("search");
    document.getElementById("search-input").value = query;
    const source = payload.source === "carousell-web" ? "Carousell web" : payload.source;
    const added = payload.added ? ` Added ${payload.added} new listings.` : "";
    const warning = payload.warning ? ` ${payload.warning}` : "";
    document.getElementById("search-summary").textContent = `Found ${state.searchResults.length} results for "${query}" via ${source}.${added}${warning}`;
  } catch (error) {
    document.getElementById("search-summary").textContent = `Search failed: ${error.message}`;
  }
}

function showView(view) {
  document.querySelectorAll(".nav-button").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  document.querySelectorAll(".view").forEach((item) => item.classList.toggle("active", item.id === view));
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
  document.getElementById("deals").innerHTML = state.deals.length
    ? state.deals.map(card).join("")
    : `<p class="meta">No clean listings are above the deal threshold yet.</p>`;
}

function renderListings() {
  const filter = document.getElementById("listing-filter").value;
  const listings = state.listings.filter((listing) => {
    if (filter === "clean") return !listing.classification.is_filtered;
    if (filter === "filtered") return listing.classification.is_filtered;
    return true;
  });
  document.getElementById("listing-list").innerHTML = listings.map(card).join("");
}

function renderSearch() {
  document.getElementById("search-results").innerHTML = state.searchResults.length
    ? state.searchResults.map(card).join("")
    : `<p class="meta">Run a web search to pull matching Carousell listings. Search more tries a larger pull and falls back to demo rows only if web search fails.</p>`;
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

function bindActionButtons() {
  document.querySelectorAll("[data-block-seller]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api.post(`/api/sellers/blacklist/${encodeURIComponent(button.dataset.blockSeller)}`, {
        seller_name: button.dataset.sellerName,
        reason: "Blocked from listing card"
      });
      await load();
    });
  });

  document.querySelectorAll("[data-delete-filter]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api.delete(`/api/filters/blacklist/${button.dataset.deleteFilter}`);
      await load();
    });
  });

  document.querySelectorAll("[data-delete-seller]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api.delete(`/api/sellers/blacklist/${encodeURIComponent(button.dataset.deleteSeller)}`);
      await load();
    });
  });

  document.querySelectorAll("[data-label]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api.post("/api/feedback/label", {
        listing_id: Number(button.dataset.listingId),
        rating: button.dataset.label,
        asked_price: Number(button.dataset.price)
      });
      await load();
    });
  });

  document.querySelectorAll("[data-msrp]").forEach((button) => {
    button.addEventListener("click", async () => {
      const result = await api.post("/api/msrp/lookup", {
        title: button.dataset.title,
        price: Number(button.dataset.price)
      });
      const target = document.querySelector(`[data-msrp-result="${button.dataset.msrp}"]`);
      target.textContent = `MSRP ${formatMoney(result.msrp)} | ${result.discount_percent}% off | ${result.source}`;
    });
  });

  document.querySelectorAll("[data-view-listing]").forEach((button) => {
    button.addEventListener("click", async () => {
      const listing = await api.get(`/api/listings/${button.dataset.viewListing}`);
      openDetails(listing);
    });
  });

  document.querySelectorAll("[data-open-url]").forEach((button) => {
    button.addEventListener("click", () => window.open(button.dataset.openUrl, "_blank", "noopener"));
  });

  document.querySelectorAll("[data-repeat-search]").forEach((button) => {
    button.addEventListener("click", async () => {
      document.getElementById("search-input").value = button.dataset.repeatSearch;
      await runSearch("web");
    });
  });
}

function card(listing) {
  const classification = listing.classification;
  const label = state.labels.find((item) => item.listing_id === listing.id);
  const badge = classification.is_filtered
    ? `<span class="badge bad">${classification.post_type}</span>`
    : `<span class="badge good">Score ${listing.score.deal_score}</span>`;
  const score = listing.score
    ? `<p class="meta">Est. negotiate: ${formatMoney(listing.score.estimated_negotiation_price)} | vs median: ${listing.score.price_vs_median}% | trend: ${listing.score.trend_direction}</p>`
    : "";
  const reasons = classification.reasons.length
    ? `<ul class="reasons">${classification.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>`
    : `<p class="meta">Clean WTS listing.</p>`;
  const labelBadge = label ? `<span class="badge info">${label.user_rating}</span>` : "";

  return `
    <article class="card">
      <div class="card-header">
        <div>
          <p class="title">${escapeHtml(listing.title)}</p>
          <p class="meta">${escapeHtml(listing.seller_name)} | ${listing.seller_rating} stars | ${listing.days_listed} days | ${escapeHtml(listing.location)}</p>
        </div>
        <div class="badge-stack">${badge}${labelBadge}</div>
      </div>
      <div class="price">${formatMoney(listing.current_price)}</div>
      ${score}
      ${reasons}
      <p class="meta" data-msrp-result="${listing.id}"></p>
      <div class="actions">
        <button data-view-listing="${listing.id}">View</button>
        <button data-open-url="${escapeHtml(listing.carousell_url)}">Open</button>
        <button data-label="good" data-listing-id="${listing.id}" data-price="${listing.current_price}">Good</button>
        <button data-label="skip" data-listing-id="${listing.id}" data-price="${listing.current_price}">Skip</button>
        <button data-label="bought" data-listing-id="${listing.id}" data-price="${listing.current_price}">Bought</button>
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
      <p><strong>Seller</strong><span>${escapeHtml(listing.seller_name)} (${listing.seller_rating} stars)</span></p>
      <p><strong>Condition</strong><span>${escapeHtml(listing.condition)}</span></p>
      <p><strong>Classification</strong><span>${escapeHtml(listing.classification.post_type)}</span></p>
      <p><strong>Description</strong><span>${escapeHtml(listing.description || "")}</span></p>
    </div>
  `;
  document.getElementById("details-modal").showModal();
}

function matchesQuery(listing, query) {
  const text = `${listing.title} ${listing.description} ${listing.category}`.toLowerCase();
  return text.includes(query.toLowerCase());
}

function formatMoney(value) {
  return `$${Number(value || 0).toLocaleString()}`;
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

load();
