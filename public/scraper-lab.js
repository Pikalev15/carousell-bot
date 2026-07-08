(() => {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initScraperLab);
  } else {
    initScraperLab();
  }

  function initScraperLab() {
    const panel = document.getElementById("scraper-ideas-lab");
    if (!panel || panel.dataset.bound === "true") return;
    panel.dataset.bound = "true";
    injectStyles();

    $("scraper-lab-url")?.addEventListener("input", fillFromPastedUrl);
    $("scraper-lab-import")?.addEventListener("click", runParsedUrl);
    $("scraper-lab-copy-url")?.addEventListener("click", copyGeneratedUrl);
    $("scraper-lab-export-listings")?.addEventListener("click", () => exportListings("/api/listings?include_filtered=true", "carousell-listings.csv"));
    $("scraper-lab-export-deals")?.addEventListener("click", () => exportListings("/api/deals", "carousell-deals.csv"));
    $("scraper-lab-export-alerts")?.addEventListener("click", exportAlertsJson);
    $("scraper-lab-export-history")?.addEventListener("click", exportPriceHistoryCsv);
  }

  function fillFromPastedUrl() {
    const parsed = parseCarousellUrl($("scraper-lab-url")?.value || "");
    if (!parsed) return;
    if (parsed.query) setValue("search-input", parsed.query);
    if (parsed.min_price) setValue("search-min-price", parsed.min_price);
    if (parsed.max_price) setValue("search-max-price", parsed.max_price);
    if (parsed.location) setValue("search-location", parsed.location);
    if (parsed.condition) setValue("scraper-lab-condition", parsed.condition);
    if (parsed.range) setValue("scraper-lab-range", parsed.range);
    if (parsed.sort) setValue("scraper-lab-sort", parsed.sort);
    setStatus(`Parsed URL: ${parsed.kind}. Query: ${parsed.query || "none"}`);
  }

  function runParsedUrl() {
    fillFromPastedUrl();
    const query = $("search-input")?.value?.trim();
    if (!query) {
      setStatus("Could not find a query in that URL. Put a query in the normal search box first.", true);
      return;
    }
    setStatus(`Running search for ${query} with imported filters...`);
    document.getElementById("search-form")?.requestSubmit();
  }

  async function copyGeneratedUrl() {
    const url = buildCarousellUrl();
    await navigator.clipboard?.writeText(url).catch(() => {});
    setStatus(`Generated URL copied: ${url}`);
  }

  function buildCarousellUrl() {
    const query = $("search-input")?.value?.trim() || parseCarousellUrl($("scraper-lab-url")?.value || "")?.query || "search";
    const params = new URLSearchParams();
    params.set("addRecent", "true");
    params.set("canChangeKeyword", "true");
    params.set("includeSuggestions", "true");
    const condition = $("scraper-lab-condition")?.value;
    const min = $("search-min-price")?.value;
    const max = $("search-max-price")?.value;
    const location = $("search-location")?.value?.trim();
    const range = $("scraper-lab-range")?.value;
    const sort = $("scraper-lab-sort")?.value;
    if (condition) params.set("condition_v2", condition);
    if (min) params.set("price_start", min);
    if (max) params.set("price_end", max);
    if (location) params.set("location_name", location);
    if (range) params.set("range", range);
    if (sort) params.set("sort_by", sort);
    return `https://www.carousell.sg/search/${encodeURIComponent(query)}?${params.toString()}`;
  }

  function parseCarousellUrl(raw) {
    if (!raw.trim()) return null;
    try {
      const url = new URL(raw.trim());
      if (!/carousell\.(sg|com|ph|my|tw|hk|co\.id)$/i.test(url.hostname.replace(/^www\./, ""))) return null;
      const segments = url.pathname.split("/").filter(Boolean);
      const params = url.searchParams;
      let query = "";
      let kind = "start URL";
      const searchIndex = segments.indexOf("search");
      if (searchIndex >= 0 && segments[searchIndex + 1]) {
        query = decodeURIComponent(segments[searchIndex + 1].replaceAll("+", " "));
        kind = "search URL";
      } else if (segments.includes("p") && segments.length > 0) {
        query = titleFromSlug(segments[segments.indexOf("p") + 1] || segments.at(-1));
        kind = "listing URL";
      } else if (segments.length > 0) {
        query = titleFromSlug(segments.at(-1));
        kind = "category URL";
      }
      return {
        kind,
        query,
        min_price: params.get("price_start") || "",
        max_price: params.get("price_end") || "",
        location: params.get("location_name") || "",
        range: params.get("range") || "",
        condition: params.get("condition_v2") || "",
        sort: params.get("sort_by") || ""
      };
    } catch {
      return null;
    }
  }

  function titleFromSlug(slug = "") {
    return decodeURIComponent(slug)
      .replace(/-?\d{5,}.*/g, "")
      .replace(/-P\d+.*/i, "")
      .replace(/-r$/i, "")
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
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
        rows.push({
          listing_id: listing.id,
          title: listing.title,
          price: entry.price,
          recorded_at: entry.recorded_at,
          carousell_url: listing.carousell_url
        });
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
    const header = columns.join(",");
    const body = rows.map((row) => columns.map((column) => csvCell(row[column])).join(","));
    return [header, ...body].join("\n");
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
    const checks = [
      item.title,
      Number(item.current_price || 0) > 0,
      item.description,
      item.seller_name,
      item.location,
      firstArrayItem(item.original_image_urls) || firstArrayItem(item.image_urls),
      item.condition,
      item.carousell_url
    ];
    return `${checks.filter(Boolean).length}/${checks.length}`;
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

  function $(id) {
    return document.getElementById(id);
  }

  function injectStyles() {
    if (document.getElementById("scraper-lab-styles")) return;
    const style = document.createElement("style");
    style.id = "scraper-lab-styles";
    style.textContent = `
      .scraper-lab {
        display: grid;
        gap: 14px;
        margin: 0 0 18px;
        border: 1px solid color-mix(in srgb, var(--blue) 35%, var(--line));
        border-radius: 16px;
        padding: 16px;
        background: linear-gradient(135deg, var(--blue-soft), transparent 45%), var(--surface);
        box-shadow: var(--shadow-soft);
      }
      .scraper-lab-header {
        display: flex;
        align-items: start;
        justify-content: space-between;
        gap: 14px;
      }
      .scraper-lab-header h3 { margin: 3px 0 7px; color: var(--ink); }
      .scraper-lab-grid {
        display: grid;
        grid-template-columns: minmax(260px, 1.8fr) repeat(3, minmax(120px, 0.7fr));
        gap: 10px;
      }
      .scraper-lab label {
        display: grid;
        gap: 6px;
        color: var(--muted);
        font-size: 11px;
        font-weight: 850;
        text-transform: uppercase;
      }
      .scraper-lab-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      #scraper-lab-status[data-error="true"] { color: #ff9d90; }
      @media (max-width: 900px) { .scraper-lab-grid { grid-template-columns: 1fr; } }
    `;
    document.head.append(style);
  }
})();
