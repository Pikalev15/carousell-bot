const DUPLICATE_COLLAPSE_HIDE_LIMIT = 3;

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
      collapsed_similar_count: hiddenCount
    });
  }
  return output;
}

function renderListings() {
  const filter = document.getElementById("listing-filter").value;
  const raw = applyPriceFilters(state.listings, "listing").filter((listing) => {
    if (filter === "clean") return !listing.classification.is_filtered;
    if (filter === "filtered") return listing.classification.is_filtered;
    return true;
  });
  const rendered = collapseDuplicateGroups(sortListings(raw, document.getElementById("listing-sort").value));
  document.getElementById("listing-list").innerHTML = rendered.length
    ? rendered.map(card).join("")
    : `<p class="empty-state">No listings match the current filters.</p>`;
}

function renderSearch() {
  const raw = sortListings(applyPriceFilters(state.searchResults, "search"), document.getElementById("search-sort").value);
  const rendered = collapseDuplicateGroups(raw);
  document.getElementById("search-results").innerHTML = rendered.length
    ? rendered.map(card).join("")
    : `<p class="empty-state">No visible listings in this price range. Try raising the max, lowering the min, or searching a more specific phrase.</p>`;
  if (state.lastQuery) {
    document.getElementById("search-summary").textContent = searchSummaryText(raw.length, rendered.length, state.lastQuery);
  }
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
    const raw = sortListings(applyPriceFilters(state.searchResults, "search"), document.getElementById("search-sort").value);
    const rendered = collapseDuplicateGroups(raw);
    if (job.status === "running" || job.status === "queued") {
      document.getElementById("search-summary").textContent = `${searchSummaryText(raw.length, rendered.length, query)}. Enriching details ${done}/${total}...`;
      setTimeout(() => pollSearchJob(id, query), 1800);
      return;
    }
    if (job.status === "complete") {
      await load();
      state.searchResults = applyPriceFilters(state.listings.filter((listing) => matchesQuery(listing, query)), "search");
      renderSearch();
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

function searchSummaryText(rawCount, renderedCount, query) {
  const hidden = Math.max(0, Number(rawCount || 0) - Number(renderedCount || 0));
  if (hidden > 0) return `Found ${renderedCount} shown results for "${query}" (${rawCount} total, ${hidden} grouped as similar)`;
  return `Found ${renderedCount} visible results for "${query}"`;
}

globalThis.collapseDuplicateGroups = collapseDuplicateGroups;
globalThis.renderListings = renderListings;
globalThis.renderSearch = renderSearch;
globalThis.runSearch = runSearch;
globalThis.pollSearchJob = pollSearchJob;
