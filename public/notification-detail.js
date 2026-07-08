(() => {
  const modal = document.getElementById("notification-modal");
  const title = document.getElementById("notification-title");
  const body = document.getElementById("notification-body");
  const close = document.getElementById("notification-close");
  const list = document.getElementById("alerts-list");

  if (!modal || !title || !body || !close || !list) return;

  close.addEventListener("click", () => modal.close());
  modal.addEventListener("click", (event) => {
    if (event.target === modal) modal.close();
  });

  list.addEventListener("click", async (event) => {
    const item = event.target.closest(".alert-item");
    if (!item || !list.contains(item)) return;
    const index = [...list.querySelectorAll(".alert-item")].indexOf(item);
    const alert = getAlerts()[index];
    if (!alert) return;
    await openNotificationDetail(alert);
  });

  list.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const item = event.target.closest(".alert-item");
    if (!item || !list.contains(item)) return;
    event.preventDefault();
    const index = [...list.querySelectorAll(".alert-item")].indexOf(item);
    const alert = getAlerts()[index];
    if (!alert) return;
    await openNotificationDetail(alert);
  });

  const observer = new MutationObserver(enhanceAlertItems);
  observer.observe(list, { childList: true, subtree: false });
  enhanceAlertItems();

  async function openNotificationDetail(alert) {
    const type = cleanType(alert.type || "deal");
    title.textContent = alert.title || "Alert";
    body.innerHTML = loadingTemplate(alert, type);
    modal.showModal();

    let listing = null;
    if (alert.listing_id) {
      listing = await fetchListing(alert.listing_id).catch((error) => ({ error: error.message }));
    }

    body.innerHTML = detailTemplate(alert, type, listing);
    wireNotificationActions(alert, listing);
  }

  function wireNotificationActions(alert, listing) {
    body.querySelector("[data-notification-open-listing]")?.addEventListener("click", () => {
      if (listing && !listing.error && typeof openDetails === "function") {
        modal.close();
        openDetails(listing);
      }
    });

    body.querySelector("[data-notification-open-url]")?.addEventListener("click", () => {
      const url = listing?.carousell_url || alert.listing_url;
      if (url) window.open(url, "_blank", "noopener");
    });
  }

  async function fetchListing(id) {
    const response = await fetch(`/api/listings/${encodeURIComponent(id)}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Listing fetch failed (${response.status})`);
    return payload;
  }

  function loadingTemplate(alert, type) {
    return `
      <section class="notification-hero ${toneForType(alert.type)}">
        <div>
          <span class="badge ${badgeForType(alert.type)}">${escapeHtml(type)}</span>
          <h4>${escapeHtml(alert.title || "Alert")}</h4>
          <p>${escapeHtml(alert.message || "No message captured.")}</p>
        </div>
      </section>
      <div class="notification-loading">Loading full notification context...</div>
    `;
  }

  function detailTemplate(alert, type, listing) {
    const hasListing = listing && !listing.error;
    const failedListing = listing?.error;
    const score = hasListing ? listing.score : null;
    const classification = hasListing ? listing.classification : null;
    const market = hasListing ? listing.market_insight : null;
    const actions = [
      hasListing ? `<button type="button" class="primary-action" data-notification-open-listing>Open listing details</button>` : "",
      hasListing || alert.listing_url ? `<button type="button" data-notification-open-url>Open on Carousell</button>` : ""
    ].filter(Boolean).join("");

    return `
      <section class="notification-hero ${toneForType(alert.type)}">
        <div>
          <span class="badge ${badgeForType(alert.type)}">${escapeHtml(type)}</span>
          <h4>${escapeHtml(alert.title || "Alert")}</h4>
          <p>${escapeHtml(alert.message || "No message captured.")}</p>
        </div>
        <div class="notification-time-block">
          <span class="meta">Created</span>
          <strong>${formatDate(alert.created_at)}</strong>
        </div>
      </section>

      <section class="notification-section notification-grid">
        ${fact("Status", alert.read_at ? "Read" : "Unread")}
        ${fact("Sent to Telegram", alert.sent_at ? formatDate(alert.sent_at) : alert.error ? "Failed" : "Not sent / local only")}
        ${fact("Listing ID", alert.listing_id || "None")}
        ${fact("Watch ID", alert.watch_id || "Manual / none")}
        ${fact("Alert ID", alert.id || "None")}
        ${fact("Error", alert.error || "None")}
      </section>

      ${failedListing ? `
        <section class="notification-section notification-warning">
          <strong>Listing lookup failed</strong>
          <p>${escapeHtml(failedListing)}</p>
        </section>
      ` : ""}

      ${hasListing ? listingTemplate(listing, score, classification, market) : ""}

      ${actions ? `<section class="notification-actions">${actions}</section>` : ""}

      <details class="notification-raw">
        <summary>Raw alert payload</summary>
        <pre>${escapeHtml(JSON.stringify(alert, null, 2))}</pre>
      </details>
    `;
  }

  function listingTemplate(listing, score, classification, market) {
    const image = firstImage(listing);
    const reasons = [
      ...(classification?.reasons || []),
      ...(score?.explanation?.reasons || []),
      ...(listing.training?.reasons || [])
    ].filter(Boolean).slice(0, 8);
    const priceHistory = Array.isArray(listing.price_history) ? listing.price_history.slice(-6) : [];

    return `
      <section class="notification-listing-card">
        ${image ? `<img src="${escapeHtml(image)}" alt="" loading="lazy">` : `<div class="notification-image-empty">${escapeHtml((listing.title || "?").slice(0, 1).toUpperCase())}</div>`}
        <div>
          <p class="eyebrow">Linked listing</p>
          <h4>${escapeHtml(listing.title || "Untitled listing")}</h4>
          <p class="notification-price">${formatMoney(listing.current_price)}</p>
          <p class="meta">${escapeHtml(listing.seller_name || "Unknown seller")} · ${escapeHtml(displayLocation(listing))} · ${escapeHtml(formatAge(listing))}</p>
        </div>
      </section>

      <section class="notification-section notification-grid">
        ${fact("Deal score", score?.deal_score ?? "No score")}
        ${fact("Price score", score?.price_score ?? "No score")}
        ${fact("Preference", score?.training_preference ?? score?.preference_score ?? "No data")}
        ${fact("Classification", classification?.post_type || "Unknown")}
        ${fact("Market", marketText(market))}
        ${fact("Condition", listing.condition || "Unknown")}
        ${fact("Location", displayLocation(listing))}
        ${fact("Scraped", formatDate(listing.scraped_at))}
      </section>

      ${score?.explanation ? `
        <section class="notification-section">
          <h4>Why it triggered</h4>
          <p class="meta">${escapeHtml(score.explanation.summary || "No score summary captured.")}</p>
          ${score.explanation.estimated_negotiation_price ? `<p class="meta">Estimated negotiation target: <strong>${formatMoney(score.explanation.estimated_negotiation_price)}</strong></p>` : ""}
        </section>
      ` : ""}

      ${reasons.length ? `
        <section class="notification-section">
          <h4>Reasons</h4>
          <div class="notification-chip-list">${[...new Set(reasons)].map((reason) => `<span>${escapeHtml(reason)}</span>`).join("")}</div>
        </section>
      ` : ""}

      ${priceHistory.length ? `
        <section class="notification-section">
          <h4>Recent price history</h4>
          <div class="notification-history">${priceHistory.map((entry) => `<span>${formatMoney(entry.price)} <small>${formatDate(entry.recorded_at)}</small></span>`).join("")}</div>
        </section>
      ` : ""}

      <section class="notification-section">
        <h4>Description</h4>
        <p class="notification-description">${escapeHtml(listing.description || "No description captured yet.")}</p>
      </section>
    `;
  }

  function enhanceAlertItems() {
    list.querySelectorAll(".alert-item").forEach((item, index) => {
      item.tabIndex = 0;
      item.setAttribute("role", "button");
      item.setAttribute("aria-label", `Open notification ${index + 1}`);
      item.classList.add("clickable-alert");
    });
  }

  function getAlerts() {
    try {
      return Array.isArray(state?.alerts?.alerts) ? state.alerts.alerts : [];
    } catch {
      return [];
    }
  }

  function fact(label, value) {
    return `<div class="notification-fact"><span class="meta">${escapeHtml(label)}</span><strong>${escapeHtml(String(value ?? "—"))}</strong></div>`;
  }

  function cleanType(value) {
    return String(value || "alert").replaceAll("_", " ");
  }

  function badgeForType(value) {
    const type = String(value || "");
    if (/error|failed|spam|bad/i.test(type)) return "bad";
    if (/price|drop|warn/i.test(type)) return "warn";
    if (/deal|good|match/i.test(type)) return "good";
    return "info";
  }

  function toneForType(value) {
    const type = String(value || "");
    if (/error|failed|spam|bad/i.test(type)) return "bad";
    if (/price|drop|warn/i.test(type)) return "warn";
    if (/deal|good|match/i.test(type)) return "good";
    return "info";
  }

  function firstImage(listing) {
    const urls = listing?.image_urls || listing?.original_image_urls || [];
    return Array.isArray(urls) ? urls.find(Boolean) : "";
  }

  function marketText(market) {
    if (!market || market.rating === "unknown") return "Unknown";
    const delta = Number.isFinite(Number(market.price_delta_percent)) ? `${market.price_delta_percent}%` : "no delta";
    return `${String(market.rating).replaceAll("_", " ")} · ${delta} vs ${market.sample_size || 0} comps`;
  }

  function displayLocation(listing) {
    return listing?.location || "Unknown location";
  }

  function formatAge(listing) {
    const minutes = Number(listing?.listed_age_minutes);
    if (Number.isFinite(minutes)) {
      if (minutes < 60) return `${Math.max(0, Math.round(minutes))}m ago`;
      if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
      return `${Math.round(minutes / 1440)}d ago`;
    }
    if (listing?.listed_at) return formatDate(listing.listed_at);
    return "Unknown age";
  }

  function formatMoney(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number) || number <= 0) return "S$—";
    return `S$${number.toLocaleString("en-SG")}`;
  }

  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }
})();

(() => {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installScraperIdeasLab);
  } else {
    installScraperIdeasLab();
  }

  function installScraperIdeasLab() {
    if (document.getElementById("scraper-ideas-lab")) return;
    const searchView = document.getElementById("search");
    const searchForm = document.getElementById("search-form");
    if (!searchView || !searchForm) return;

    injectScraperLabStyles();

    const panel = document.createElement("section");
    panel.id = "scraper-ideas-lab";
    panel.className = "scraper-lab";
    panel.innerHTML = `
      <div class="scraper-lab-header">
        <div>
          <p class="eyebrow">Feature branch lab</p>
          <h3>Scraper Ideas Lab</h3>
          <p class="section-caption">Borrowed from the reference repos: pasted start URLs, URL-level filters, and one-click exports. This branch uses the existing search API, so it is safe to test before backend parser changes.</p>
        </div>
        <span class="badge info">feature/scraper-ideas</span>
      </div>
      <div class="scraper-lab-grid">
        <label>Start URL / Carousell URL
          <input id="scraper-lab-url" placeholder="Paste a Carousell search/category/listing URL">
        </label>
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
      </div>
      <div class="scraper-lab-actions">
        <button type="button" id="scraper-lab-import" class="primary-action">Run parsed URL</button>
        <button type="button" id="scraper-lab-copy-url">Copy generated URL</button>
        <button type="button" id="scraper-lab-export-listings">Export listings CSV</button>
        <button type="button" id="scraper-lab-export-deals">Export deals CSV</button>
        <button type="button" id="scraper-lab-export-alerts">Export alerts JSON</button>
        <button type="button" id="scraper-lab-export-history">Export price history CSV</button>
      </div>
      <p id="scraper-lab-status" class="meta">Tip: paste an existing Carousell URL and this will extract query/filter values into your current search UI.</p>
    `;
    searchForm.before(panel);

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

  function injectScraperLabStyles() {
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
        background:
          linear-gradient(135deg, var(--blue-soft), transparent 45%),
          var(--surface);
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
