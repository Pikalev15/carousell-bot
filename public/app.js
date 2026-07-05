const state = {
  listings: [],
  deals: [],
  filters: [],
  sellers: [],
  stats: {}
};

const api = {
  async get(path) {
    const response = await fetch(path);
    return response.json();
  },
  async post(path, body) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return response.json();
  },
  async delete(path) {
    const response = await fetch(path, { method: "DELETE" });
    return response.json();
  }
};

document.querySelectorAll(".nav-button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav-button").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".view").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    document.getElementById(button.dataset.view).classList.add("active");
  });
});

document.getElementById("refresh").addEventListener("click", load);
document.getElementById("listing-filter").addEventListener("change", renderListings);
document.getElementById("filter-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await api.post("/api/filters/blacklist", Object.fromEntries(form.entries()));
  event.currentTarget.reset();
  await load();
});

async function load() {
  const [listings, deals, filters, sellers, stats] = await Promise.all([
    api.get("/api/listings"),
    api.get("/api/deals"),
    api.get("/api/filters/blacklist"),
    api.get("/api/sellers/blacklist"),
    api.get("/api/filters/stats")
  ]);
  Object.assign(state, { listings, deals, filters, sellers, stats });
  renderStats();
  renderDeals();
  renderListings();
  renderFilters();
  renderSellers();
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
  document.querySelectorAll("[data-block-seller]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api.post(`/api/sellers/blacklist/${encodeURIComponent(button.dataset.blockSeller)}`, {
        seller_name: button.dataset.sellerName,
        reason: "Blocked from listing card"
      });
      await load();
    });
  });
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
  document.querySelectorAll("[data-delete-filter]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api.delete(`/api/filters/blacklist/${button.dataset.deleteFilter}`);
      await load();
    });
  });
}

function renderSellers() {
  document.getElementById("sellers").innerHTML = state.sellers
    .map((seller) => `
      <div class="row">
        <strong>${escapeHtml(seller.seller_name || seller.seller_id)}</strong>
        <span class="badge bad">blocked</span>
        <span class="meta">${escapeHtml(seller.reason || "")}</span>
        <button data-delete-seller="${seller.seller_id}">Unblock</button>
      </div>
    `)
    .join("");
  document.querySelectorAll("[data-delete-seller]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api.delete(`/api/sellers/blacklist/${encodeURIComponent(button.dataset.deleteSeller)}`);
      await load();
    });
  });
}

function card(listing) {
  const classification = listing.classification;
  const badge = classification.is_filtered
    ? `<span class="badge bad">${classification.post_type}</span>`
    : `<span class="badge good">Score ${listing.score.deal_score}</span>`;
  const score = listing.score
    ? `<p class="meta">Est. negotiate: $${listing.score.estimated_negotiation_price} | vs median: ${listing.score.price_vs_median}% | trend: ${listing.score.trend_direction}</p>`
    : "";
  const reasons = classification.reasons.length
    ? `<ul class="reasons">${classification.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>`
    : `<p class="meta">Clean WTS listing.</p>`;

  return `
    <article class="card">
      <div class="card-header">
        <div>
          <p class="title">${escapeHtml(listing.title)}</p>
          <p class="meta">${escapeHtml(listing.seller_name)} | ${listing.seller_rating} stars | ${listing.days_listed} days</p>
        </div>
        ${badge}
      </div>
      <div class="price">$${listing.current_price}</div>
      ${score}
      ${reasons}
      <button data-block-seller="${listing.seller_id}" data-seller-name="${escapeHtml(listing.seller_name)}">Block seller</button>
    </article>
  `;
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
