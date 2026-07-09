const DUPLICATE_COLLAPSE_HIDE_LIMIT = 3;
const HYDRATION_REFRESH_STEP = 3;
const originalCardRenderer = typeof globalThis.card === "function" ? globalThis.card.bind(globalThis) : null;

function collapseDuplicateGroups(listings) {
  const groups = new Map();
  for (const listing of listings || []) {
    const groupId = listing.duplicate_group_id;
    if (!groupId || Number(listing.duplicate_count || 1) <= 1) {
      groups.set(`single-${listing.id}`, [listing]);
      continue;
    }
    if (!groups.has(groupId)) groups.set(groupId, []);
    groups.get(groupId).push(listing);
  }

  const output = [];
  for (const [groupId, items] of groups.entries()) {
    if (items.length <= 1 || groupId.startsWith("single-")) {
      output.push(...items);
      continue;
    }

    const hiddenCount = items.length - 1;
    if (hiddenCount > DUPLICATE_COLLAPSE_HIDE_LIMIT) {
      console.warn(`Suspicious duplicate group ${groupId} has ${items.length} visible candidates; not collapsing it.`, items);
      output.push(...items.map((item) => ({ ...item, duplicate_count: 1, duplicate_role: "primary" })));
      continue;
    }

    const primary = items.find((item) => item.duplicate_role === "primary") || items[0];
    output.push({
      ...primary,
      duplicate_count: items.length,
      duplicate_role: "primary",
      collapsed_similar_count: hiddenCount,
      _similar_listings: items.filter((item) => Number(item.id) !== Number(primary.id))
    });
  }
  return output;
}

function renderCardWithSimilar(listing) {
  const base = renderBaseCard(listing);
  const similar = Array.isArray(listing._similar_listings) ? listing._similar_listings : [];
  if (!similar.length || !originalCardRenderer) return base;
  const similarMarkup = `
    <details class="similar-expander">
      <summary>+${similar.length} similar listing${similar.length === 1 ? "" : "s"}</summary>
      <div class="similar-listings">
        ${similar.map((item) => `
          <div class="similar-card-wrap">
            ${renderBaseCard({ ...item, duplicate_count: 1, duplicate_group_id: `single-${item.id}`, duplicate_role: "primary", _similar_listings: [] })}
            <button class="linklike" data-unlink-duplicate="${listing.id}" data-other-listing-id="${item.id}">not the same item?</button>
          </div>
        `).join("")}
      </div>
    </details>
  `;
  return base.replace(/<\/article>\s*$/, `${similarMarkup}</article>`);
}

function renderBaseCard(listing) {
  if (!originalCardRenderer) return "";
  const hydrated = hasHydratedImage(listing);
  const safeListing = hydrated ? listing : stripPreHydrationImages(listing);
  const html = originalCardRenderer(safeListing);
  return hydrated ? html : removeEmptyVisual(html);
}

function hasHydratedImage(listing) {
  return Boolean(listing?.details_scraped_at && Array.isArray(listing.image_urls) && listing.image_urls.some(Boolean));
}

function stripPreHydrationImages(listing) {
  return {
    ...listing,
    image_urls: [],
    original_image_urls: [],
    primary_image: "",
    thumbnail_url: ""
  };
}

function removeEmptyVisual(html) {
  return String(html || "").replace(/\s*<div class="listing-visual empty">[\s\S]*?<\/div>\s*/, "\n");
}

function renderListings() {
  const filter = document.getElementById("listing-filter").value;
  const raw = applyPriceFilters(state?.listings || [], "listing").filter((listing) => {
    if (filter === "clean") return !listing.classification.is_filtered;
    if (filter === "filtered") return listing.classification.is_filtered;
    return true;
  });
  const rendered = collapseDuplicateGroups(sortListings(raw, document.getElementById("listing-sort").value));
  document.getElementById("listing-list").innerHTML = rendered.length
    ? rendered.map(renderCardWithSimilar).join("")
    : `<p class="empty-state">No listings match the current filters.</p>`;
}

function renderSearch() {
  const raw = sortListings(applyPriceFilters(state?.searchResults || [], "search"), document.getElementById("search-sort").value);
  const rendered = collapseDuplicateGroups(raw);
  document.getElementById("search-results").innerHTML = rendered.length
    ? rendered.map(renderCardWithSimilar).join("")
    : `<p class="empty-state">No visible listings in this price range. Try raising the max, lowering the min, or searching a more specific phrase.</p>`;
  if (state?.lastQuery) {
    document.getElementById("search-summary").textContent = searchSummaryText(raw.length, rendered.length, state.lastQuery);
  }
  document.getElementById("search-history").innerHTML = state?.searches?.length
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

async function openDetails(listing) {
  const [history, reputation] = await Promise.all([
    api.get(`/api/listings/${listing.id}/price-history`).catch(() => listing.price_history || []),
    listing.seller_id ? api.get(`/api/sellers/${encodeURIComponent(listing.seller_id)}/reputation`).catch(() => null) : null
  ]);
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
      <p><strong>Classification</strong><span>${escapeHtml(listing.classification?.post_type || "")}</span></p>
      <p><strong>Market</strong><span>${marketInsightText(listing.market_insight)}</span></p>
      <p><strong>Seller history</strong><span>${reputation ? `${reputation.total_listings} listings, ${Math.round(Number(reputation.relist_ratio || 0) * 100)}% relist-linked` : "Not enough seller history"}</span></p>
      <p><strong>Why this score?</strong><span>${escapeHtml(listing.score?.explanation?.summary || "No score explanation available.")}</span></p>
      <p class="description-row"><strong>Description</strong><span>${escapeHtml(listing.description || "No description captured yet. Search this listing again to refresh details.")}</span></p>
    </div>
    <section class="price-history-panel">
      <h3>Price history</h3>
      ${priceHistoryChart(history)}
    </section>
    ${variants.length ? `
      <div class="variant-list">
        <h3>${variants.length} similar listing${variants.length === 1 ? "" : "s"}</h3>
        ${variants.map((variant) => `
          <div class="row compact">
            <strong>${escapeHtml(variant.title)}</strong>
            <span class="meta">${formatMoney(variant.current_price)} / ${displayLocation(variant)}</span>
            <button data-open-url="${escapeHtml(variant.carousell_url)}">Open</button>
            <button data-unlink-duplicate="${listing.id}" data-other-listing-id="${variant.id}">not the same item?</button>
          </div>
        `).join("")}
      </div>
    ` : ""}
  `;
  document.getElementById("details-modal").showModal();
}

async function runSearch(mode) {
  const input = document.getElementById("search-input");
  const query = input.value.trim() || state.lastQuery;
  if (!query) return;
  const submit = mode === "more" ? document.getElementById("search-more") : document.querySelector("#search-form button[type='submit']");
  setButtonBusy(submit, mode === "more" ? "Searching more" : "Searching");
  state._hydrationRefreshStep = 0;
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
    const raw = sortListings(applyPriceFilters(state.searchResults, "search"), document.getElementById("search-sort").value);
    const rendered = collapseDuplicateGroups(raw);
    const source = payload.source === "carousell-web" ? "Carousell web" : payload.source;
    const added = payload.added ? ` Added ${payload.added} new listings.` : "";
    const updated = payload.updated ? ` Updated ${payload.updated} existing listings.` : "";
    const warning = payload.warning ? ` ${payload.warning}` : "";
    document.getElementById("search-summary").textContent = `${searchSummaryText(raw.length, rendered.length, query)} via ${source}.${added}${updated}${warning}`;
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
    const refreshStep = Math.floor(done / HYDRATION_REFRESH_STEP);
    if (refreshStep > Number(state._hydrationRefreshStep || 0)) {
      state._hydrationRefreshStep = refreshStep;
      await refreshHydratedSearchResults(query);
    }
    const raw = sortListings(applyPriceFilters(state.searchResults, "search"), document.getElementById("search-sort").value);
    const rendered = collapseDuplicateGroups(raw);
    if (job.status === "running" || job.status === "queued") {
      document.getElementById("search-summary").textContent = `${searchSummaryText(raw.length, rendered.length, query)}. Enriching details ${done}/${total}...`;
      setTimeout(() => pollSearchJob(id, query), 1200);
      return;
    }
    if (job.status === "complete") {
      await refreshHydratedSearchResults(query);
      const nextRaw = sortListings(applyPriceFilters(state.searchResults, "search"), document.getElementById("search-sort").value);
      const nextRendered = collapseDuplicateGroups(nextRaw);
      document.getElementById("search-summary").textContent = `${searchSummaryText(nextRaw.length, nextRendered.length, query)}. Details enriched ${done}/${total}.`;
      showToast("Listing details enriched");
      return;
    }
    document.getElementById("search-summary").textContent = `${searchSummaryText(raw.length, rendered.length, query)}. Detail enrichment failed: ${job.error || "unknown error"}`;
  } catch (error) {
    showToast(`Hydration status failed: ${error.message}`, "error");
  }
}

async function refreshHydratedSearchResults(query) {
  await load();
  state.searchResults = applyPriceFilters((state?.listings || []).filter((listing) => matchesQuery(listing, query)), "search");
  renderSearch();
}

function priceHistoryChart(history = []) {
  const points = Array.isArray(history) ? history : [];
  if (points.length < 2) return `<p class="empty-state compact-empty">Not enough price history yet.</p>`;
  const prices = points.map((point) => Number(point.price || 0));
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const spread = Math.max(1, max - min);
  const width = 320;
  const height = 120;
  const coords = points.map((point, index) => {
    const x = 24 + (index / Math.max(1, points.length - 1)) * (width - 44);
    const y = height - 24 - ((Number(point.price || 0) - min) / spread) * (height - 44);
    return { x, y, point };
  });
  return `
    <svg class="price-history-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Merged price history">
      <line x1="24" y1="10" x2="24" y2="96"></line>
      <line x1="24" y1="96" x2="300" y2="96"></line>
      <polyline points="${coords.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}"></polyline>
      ${coords.map(({ x, y, point }, index) => point.relist_transition ? `<line class="relist-marker" x1="${x.toFixed(1)}" y1="10" x2="${x.toFixed(1)}" y2="100"></line>` : `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${index === coords.length - 1 ? 3 : 2}"></circle>`).join("")}
      <text x="28" y="16">${formatMoney(max)}</text>
      <text x="28" y="112">${formatMoney(min)}</text>
    </svg>
    <p class="meta">${points.length} points${new Set(points.map((point) => Number(point.listing_id))).size > 1 ? " across relisted items" : ""}</p>
  `;
}

function injectImportExportControls() {
  if (document.getElementById("config-export-import")) return;
  const settings = document.getElementById("settings");
  if (!settings) return;
  const panel = document.createElement("section");
  panel.id = "config-export-import";
  panel.className = "training-panel";
  panel.innerHTML = `
    <div><h3>Config backup</h3><p class="meta">Export/import watchlists, presets, and non-secret filters.</p></div>
    <button type="button" data-export-config="true">Export config</button>
    <button type="button" data-import-config="true">Import config</button>
    <input id="config-import-file" type="file" accept="application/json" hidden>
  `;
  settings.appendChild(panel);
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.unlinkDuplicate) {
    await api.post(`/api/listings/${button.dataset.unlinkDuplicate}/unlink-duplicate`, { other_listing_id: Number(button.dataset.otherListingId) });
    await load();
    showToast("Duplicate link split");
  }
  if (button.dataset.exportConfig) {
    const bundle = await api.get("/api/export");
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `carousell-bot-config-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }
  if (button.dataset.importConfig) {
    document.getElementById("config-import-file")?.click();
  }
});

document.addEventListener("change", async (event) => {
  if (event.target?.id !== "config-import-file") return;
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    await api.post("/api/import", JSON.parse(text));
    await load();
    showToast("Config imported");
  } catch (error) {
    showToast(`Import failed: ${error.message}`, "error");
  }
});

document.addEventListener("DOMContentLoaded", injectImportExportControls);
injectImportExportControls();

function searchSummaryText(rawCount, renderedCount, query) {
  const hidden = Math.max(0, Number(rawCount || 0) - Number(renderedCount || 0));
  if (hidden > 0) return `Found ${renderedCount} shown results for "${query}" (${rawCount} total, ${hidden} grouped as similar)`;
  return `Found ${renderedCount} visible results for "${query}"`;
}

globalThis.collapseDuplicateGroups = collapseDuplicateGroups;
globalThis.card = renderCardWithSimilar;
globalThis.openDetails = openDetails;
globalThis.renderListings = renderListings;
globalThis.renderSearch = renderSearch;
globalThis.runSearch = runSearch;
globalThis.pollSearchJob = pollSearchJob;
