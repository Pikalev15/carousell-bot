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
