(() => {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installScraperIdeasLab);
  } else {
    installScraperIdeasLab();
  }

  function installScraperIdeasLab() {
    const searchForm = document.getElementById("search-form");
    if (!searchForm) return;

    document.getElementById("scraper-ideas-lab")?.remove();
    injectStyles();

    const panel = document.createElement("section");
    panel.id = "scraper-ideas-lab";
    panel.className = "scraper-lab scraper-lab-v2";
    panel.innerHTML = `
      <div class="scraper-lab-header">
        <div>
          <p class="eyebrow">Feature branch lab</p>
          <h3>Advanced / Category Search</h3>
          <p class="section-caption">Paste Carousell search, category, or listing URLs. Category URLs are converted into clean category search terms and the generated Carousell URL keeps condition, price, location, distance, and sort filters.</p>
        </div>
        <span class="badge info">PR test</span>
      </div>

      <div class="scraper-lab-grid wide">
        <label>Start URLs / category URLs
          <textarea id="scraper-lab-url" rows="3" placeholder="Paste one or more Carousell URLs, one per line"></textarea>
        </label>
        <label>Parsed mode
          <select id="scraper-lab-mode">
            <option value="auto">Auto detect</option>
            <option value="query">Query search</option>
            <option value="category_url">Category URL</option>
            <option value="listing_url">Listing URL</option>
            <option value="mixed">Mixed URLs</option>
          </select>
        </label>
      </div>

      <div class="scraper-lab-grid">
        <label>Condition
          <select id="scraper-lab-condition">
            <option value="">Any</option>
            <option value="NEW">New</option>
            <option value="USED">Used</option>
          </select>
        </label>
        <label>Distance
          <input id="scraper-lab-range" type="number" min="1" step="1" placeholder="km">
        </label>
        <label>Sort
          <select id="scraper-lab-sort">
            <option value="time_created,descending">Newest first</option>
            <option value="price,ascending">Price low to high</option>
            <option value="price,descending">Price high to low</option>
          </select>
        </label>
        <label>Max items hint
          <input id="scraper-lab-max-items" type="number" min="1" max="500" step="1" value="80">
        </label>
      </div>

      <div class="scraper-lab-actions">
        <button type="button" id="scraper-lab-import" class="primary-action">Run advanced search</button>
        <button type="button" id="scraper-lab-fill">Fill normal search</button>
        <button type="button" id="scraper-lab-copy-url">Copy generated URL</button>
        <button type="button" id="scraper-lab-open-url">Open generated URL</button>
        <button type="button" id="scraper-lab-export-listings">Export listings CSV</button>
        <button type="button" id="scraper-lab-export-deals">Export deals CSV</button>
        <button type="button" id="scraper-lab-export-alerts">Export alerts JSON</button>
        <button type="button" id="scraper-lab-export-history">Export price history CSV</button>
      </div>

      <div id="scraper-lab-preview" class="scraper-lab-preview"></div>
      <p id="scraper-lab-status" class="meta">Paste a category URL like /categories/mobile-phones-gadgets-215/mobile-phones-5707 and it will search “mobile phones”, not “mobile phones 5707”.</p>
    `;
    searchForm.before(panel);

    $("scraper-lab-url")?.addEventListener("input", renderPreview);
    $("scraper-lab-fill")?.addEventListener("click", fillNormalSearch);
    $("scraper-lab-import")?.addEventListener("click", runAdvancedSearch);
    $("scraper-lab-copy-url")?.addEventListener("click", copyGeneratedUrl);
    $("scraper-lab-open-url")?.addEventListener("click", () => window.open(buildCarousellUrl(), "_blank", "noopener"));
    $("scraper-lab-export-listings")?.addEventListener("click", () => exportListings("/api/listings?include_filtered=true", "carousell-listings.csv"));
    $("scraper-lab-export-deals")?.addEventListener("click", () => exportListings("/api/deals", "carousell-deals.csv"));
    $("scraper-lab-export-alerts")?.addEventListener("click", exportAlertsJson);
    $("scraper-lab-export-history")?.addEventListener("click", exportPriceHistoryCsv);

    renderPreview();
  }

  function renderPreview() {
    const parsed = parseStartUrls();
    const preview = $("scraper-lab-preview");
    if (!preview) return;
    if (!parsed.items.length) {
      preview.innerHTML = `<span class="meta">No start URL parsed yet.</span>`;
      return;
    }
    $("scraper-lab-mode").value = parsed.mode;
    preview.innerHTML = parsed.items.map((item) => `
      <div class="scraper-lab-url-card">
        <strong>${escapeHtml(item.kind)}</strong>
        <span>${escapeHtml(item.query || "No query detected")}</span>
        <small>${escapeHtml(item.url)}</small>
      </div>
    `).join("");
    fillFromParsed(parsed.primary);
    setStatus(`Parsed ${parsed.items.length} URL${parsed.items.length === 1 ? "" : "s"}. Mode: ${parsed.mode}.`);
  }

  function fillNormalSearch() {
    const parsed = parseStartUrls();
    fillFromParsed(parsed.primary);
    if (!parsed.primary?.query) {
      setStatus("No query/category text found. Type a query manually in the normal search box.", true);
      return;
    }
    setStatus(`Filled normal search with: ${parsed.primary.query}`);
  }

  async function runAdvancedSearch() {
    const parsed = parseStartUrls();
    const query = parsed.primary?.query || $("search-input")?.value?.trim();
    if (!query) {
      setStatus("Need a query or a parseable Carousell category/search/listing URL.", true);
      return;
    }

    fillFromParsed(parsed.primary);
    setStatus(`Running ${parsed.mode} search for ${query}...`);

    const payload = {
      query,
      mode: "web",
      startUrls: parsed.items.map((item) => ({ url: item.url, kind: item.kind, query: item.query })),
      search_options: {
        condition: $("scraper-lab-condition")?.value || "",
        range: $("scraper-lab-range")?.value || "",
        sort_by: $("scraper-lab-sort")?.value || "",
        generated_url: buildCarousellUrl(),
        max_items: Number($("scraper-lab-max-items")?.value || 80)
      },
      min_price: $("search-min-price")?.value || "",
      max_price: $("search-max-price")?.value || "",
      location: $("search-location")?.value || ""
    };

    try {
      const response = await fetch("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Search failed (${response.status})`);
      setStatus(`Search done. Added ${result.added || 0}, updated ${result.updated || 0}. Source: ${result.source_url || result.source || "local"}`);
      document.getElementById("refresh")?.click();
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  function fillFromParsed(parsed) {
    if (!parsed) return;
    if (parsed.query) setValue("search-input", parsed.query);
    if (parsed.min_price) setValue("search-min-price", parsed.min_price);
    if (parsed.max_price) setValue("search-max-price", parsed.max_price);
    if (parsed.location) setValue("search-location", parsed.location);
    if (parsed.condition) setValue("scraper-lab-condition", parsed.condition);
    if (parsed.range) setValue("scraper-lab-range", parsed.range);
    if (parsed.sort) setValue("scraper-lab-sort", parsed.sort);
  }

  function parseStartUrls() {
    const rawUrls = String($("scraper-lab-url")?.value || "")
      .split(/\n+/)
      .map((item) => item.trim())
      .filter(Boolean);
    const items = rawUrls.map(parseCarousellUrl).filter(Boolean);
    const primary = items[0] || null;
    const kinds = new Set(items.map((item) => item.kind));
    const mode = items.length === 0 ? "query" : kinds.size > 1 ? "mixed" : primary.kind;
    return { items, primary, mode };
  }

  function buildCarousellUrl() {
    const parsed = parseStartUrls();
    const query = $("search-input")?.value?.trim() || parsed.primary?.query || "search";
    const params = new URLSearchParams();
    params.set("addRecent", "true");
    params.set("canChangeKeyword", "true");
    params.set("includeSuggestions", "true");
    setParam(params, "condition_v2", $("scraper-lab-condition")?.value);
    setParam(params, "price_start", $("search-min-price")?.value);
    setParam(params, "price_end", $("search-max-price")?.value);
    setParam(params, "location_name", $("search-location")?.value?.trim());
    setParam(params, "range", $("scraper-lab-range")?.value);
    setParam(params, "sort_by", $("scraper-lab-sort")?.value);
    return `https://www.carousell.sg/search/${encodeURIComponent(query)}?${params.toString()}`;
  }

  async function copyGeneratedUrl() {
    const url = buildCarousellUrl();
    await navigator.clipboard?.writeText(url).catch(() => {});
    setStatus(`Generated URL copied: ${url}`);
  }

  function parseCarousellUrl(raw) {
    try {
      const url = new URL(raw);
      const host = url.hostname.replace(/^www\./, "").toLowerCase();
      if (!/^carousell\.(sg|com|ph|my|tw|hk|co\.id)$/.test(host)) return null;
      const segments = url.pathname.split("/").filter(Boolean);
      const searchIndex = segments.indexOf("search");
      const categoryIndex = segments.indexOf("categories");
      const listingIndex = segments.indexOf("p");
      let kind = "start_url";
      let query = "";

      if (searchIndex >= 0 && segments[searchIndex + 1]) {
        kind = "query";
        query = cleanSlug(segments[searchIndex + 1], { keepModelNumbers: true });
      } else if (categoryIndex >= 0) {
        kind = "category_url";
        query = bestCategoryQuery(segments.slice(categoryIndex + 1));
      } else if (listingIndex >= 0 || /\/p\//.test(url.pathname)) {
        kind = "listing_url";
        query = cleanSlug(segments[listingIndex + 1] || segments.at(-1), { keepModelNumbers: true });
      } else if (segments.length) {
        kind = "category_url";
        query = bestCategoryQuery(segments);
      }

      return {
        url: url.toString(),
        kind,
        query,
        min_price: url.searchParams.get("price_start") || "",
        max_price: url.searchParams.get("price_end") || "",
        location: url.searchParams.get("location_name") || "",
        range: url.searchParams.get("range") || "",
        condition: url.searchParams.get("condition_v2") || "",
        sort: url.searchParams.get("sort_by") || ""
      };
    } catch {
      return null;
    }
  }

  function bestCategoryQuery(segments) {
    const cleaned = segments
      .map((segment) => cleanSlug(segment, { keepModelNumbers: false }))
      .filter(Boolean)
      .filter((segment) => !/^(categories|search|popular|all)$/.test(segment));
    return cleaned.at(-1) || cleaned.at(0) || "";
  }

  function cleanSlug(value, options = {}) {
    let text = decodeURIComponent(String(value || ""));
    text = text.replace(/[?#].*$/, "");
    text = text.replace(/-PV?\d+.*$/i, "");
    text = text.replace(/-P\d+.*$/i, "");
    text = text.replace(/-r$/i, "");
    if (!options.keepModelNumbers) text = text.replace(/-\d{2,}$/g, "");
    text = text.replace(/-\d{5,}.*$/g, "");
    return text.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  }

  async function exportListings(endpoint, filename) {
    setStatus(`Preparing ${filename}...`);
    const rows = await fetchJson(endpoint);
    const items = Array.isArray(rows) ? rows : [];
    const columns = [
      "id", "title", "current_price", "seller_name", "seller_rating", "location", "condition", "category",
      "carousell_url", "classification", "deal_score", "price_score", "market_rating", "primary_image",
      "categories", "is_certified", "is_free_shipping", "variations", "data_completeness"
    ];
    const csvRows = items.map((item) => ({
      id: item.id,
      title: item.title,
      current_price: item.current_price,
      seller_name: item.seller_name,
      seller_rating: item.seller_rating,
      location: item.location,
      condition: item.condition,
      category: item.category,
      carousell_url: item.carousell_url,
      classification: item.classification?.post_type || "",
      deal_score: item.score?.deal_score ?? "",
      price_score: item.score?.price_score ?? "",
      market_rating: item.market_insight?.rating || "",
      primary_image: firstArrayItem(item.original_image_urls) || firstArrayItem(item.image_urls),
      categories: stringifyMaybe(item.categories),
      is_certified: Boolean(item.is_certified || item.isCertified),
      is_free_shipping: Boolean(item.is_free_shipping || item.isFreeShipping),
      variations: stringifyMaybe(item.variations),
      data_completeness: completenessScore(item)
    }));
    download(csv(columns, csvRows), filename, "text/csv");
    setStatus(`Exported ${items.length} rows to ${filename}.`);
  }

  async function exportAlertsJson() {
    setStatus("Preparing alerts JSON...");
    const data = await fetchJson("/api/alerts");
    download(JSON.stringify(data, null, 2), "carousell-alerts.json", "application/json");
    setStatus(`Exported ${data.alerts?.length || 0} alerts.`);
  }

  async function exportPriceHistoryCsv() {
    setStatus("Preparing price history CSV...");
    const listings = await fetchJson("/api/listings?include_filtered=true");
    const rows = [];
    for (const listing of listings.slice(0, 250)) {
      const history = await fetchJson(`/api/listings/${listing.id}/price-history`).catch(() => []);
      for (const entry of history || []) {
        rows.push({ listing_id: listing.id, title: listing.title, price: entry.price, recorded_at: entry.recorded_at, carousell_url: listing.carousell_url });
      }
    }
    download(csv(["listing_id", "title", "price", "recorded_at", "carousell_url"], rows), "carousell-price-history.csv", "text/csv");
    setStatus(`Exported ${rows.length} price history rows.`);
  }

  async function fetchJson(url) {
    const response = await fetch(url);
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error || `Request failed: ${response.status}`);
    return payload;
  }

  function csv(columns, rows) {
    return [columns.join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\n");
  }

  function csvCell(value) {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }

  function download(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function completenessScore(item) {
    const checks = [item.title, Number(item.current_price || 0) > 0, item.description, item.seller_name, item.location, firstArrayItem(item.original_image_urls) || firstArrayItem(item.image_urls), item.condition, item.carousell_url];
    return `${checks.filter(Boolean).length}/${checks.length}`;
  }

  function setParam(params, key, value) {
    if (value !== undefined && value !== null && String(value).trim() !== "") params.set(key, String(value).trim());
  }

  function stringifyMaybe(value) {
    if (!value) return "";
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  function firstArrayItem(value) {
    return Array.isArray(value) ? value.find(Boolean) || "" : "";
  }

  function setValue(id, value) {
    const element = $(id);
    if (element && value !== undefined && value !== null && value !== "") element.value = value;
  }

  function setStatus(message, isError = false) {
    const status = $("scraper-lab-status");
    if (!status) return;
    status.textContent = message;
    status.dataset.error = isError ? "true" : "false";
  }

  function escapeHtml(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  }

  function $(id) {
    return document.getElementById(id);
  }

  function injectStyles() {
    if (document.getElementById("scraper-lab-v2-styles")) return;
    const style = document.createElement("style");
    style.id = "scraper-lab-v2-styles";
    style.textContent = `
      .scraper-lab { display: grid; gap: 14px; margin: 0 0 18px; border: 1px solid color-mix(in srgb, var(--blue) 35%, var(--line)); border-radius: 16px; padding: 16px; background: linear-gradient(135deg, var(--blue-soft), transparent 45%), var(--surface); box-shadow: var(--shadow-soft); }
      .scraper-lab-header { display: flex; align-items: start; justify-content: space-between; gap: 14px; }
      .scraper-lab-header h3 { margin: 3px 0 7px; color: var(--ink); }
      .scraper-lab-grid { display: grid; grid-template-columns: repeat(4, minmax(130px, 1fr)); gap: 10px; }
      .scraper-lab-grid.wide { grid-template-columns: minmax(260px, 1fr) 180px; }
      .scraper-lab label { display: grid; gap: 6px; color: var(--muted); font-size: 11px; font-weight: 850; text-transform: uppercase; }
      .scraper-lab textarea { width: 100%; resize: vertical; }
      .scraper-lab-actions { display: flex; flex-wrap: wrap; gap: 8px; }
      .scraper-lab-preview { display: grid; gap: 8px; }
      .scraper-lab-url-card { border: 1px solid var(--line); border-radius: 12px; padding: 10px; background: var(--control-subtle); }
      .scraper-lab-url-card strong { display: block; color: var(--ink); text-transform: capitalize; }
      .scraper-lab-url-card span, .scraper-lab-url-card small { display: block; overflow-wrap: anywhere; color: var(--muted); }
      #scraper-lab-status[data-error="true"] { color: #ff9d90; }
      @media (max-width: 900px) { .scraper-lab-grid, .scraper-lab-grid.wide { grid-template-columns: 1fr; } }
    `;
    document.head.append(style);
  }
})();
