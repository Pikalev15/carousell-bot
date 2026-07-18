const REFINED_FEEDBACK_OPTIONS = [
  ["great_deal", "Great deal"],
  ["good_deal", "Good deal"],
  ["fair_deal", "Fair deal"],
  ["bad_deal", "Bad deal"],
  ["overpriced", "Overpriced"],
  ["duplicate_listing", "Duplicate"],
  ["bundle_mixed", "Bundle/mixed"],
  ["accessory_only", "Accessory only"],
  ["wrong_category", "Wrong category"],
  ["irrelevant", "Irrelevant"],
  ["wtb_service", "WTB/service"]
];

const ISSUE_FEEDBACK = new Set(["duplicate_listing", "bundle_mixed", "accessory_only", "wrong_category", "irrelevant", "wtb_service"]);
const PLACEHOLDER_PRICES = new Set([0, 1, 8, 88, 888, 8888, 9999, 12345]);
const feedbackObserver = new MutationObserver(() => {
  injectRefinedFeedbackControls();
  guardPlaceholderPriceDisplay();
});
feedbackObserver.observe(document.body, { childList: true, subtree: true });
document.addEventListener("DOMContentLoaded", () => {
  injectRefinedFeedbackControls();
  guardPlaceholderPriceDisplay();
});
injectRefinedFeedbackControls();
guardPlaceholderPriceDisplay();

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-refined-label]");
  if (!button) return;
  event.preventDefault();
  const card = button.closest(".card");
  const listingId = Number(button.dataset.listingId || card?.querySelector("button[data-listing-id]")?.dataset.listingId || 0);
  if (!listingId) return;
  const price = Number(card?.querySelector("button[data-listing-id]")?.dataset.price || 0);
  const rating = button.dataset.refinedLabel;
  button.disabled = true;
  button.dataset.idleText = button.dataset.idleText || button.textContent;
  button.textContent = "Saving...";
  try {
    const response = await fetch("/api/feedback/label", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        listing_id: listingId,
        rating,
        asked_price: price,
        relevance_flags: ISSUE_FEEDBACK.has(rating) ? rating : "",
        search_query: typeof state !== "undefined" ? state.lastQuery : "",
        search_intent: typeof state !== "undefined" ? state.searchIntent : "any"
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Feedback failed");
    showRefinedFeedbackToast(`Trained: ${button.textContent.replace("Saving...", button.dataset.idleText)}`);
    document.getElementById("refresh")?.click();
  } catch (error) {
    showRefinedFeedbackToast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = button.dataset.idleText;
  }
});

function injectRefinedFeedbackControls() {
  document.querySelectorAll(".card").forEach((card) => {
    if (card.querySelector(".refined-feedback")) return;
    const baseButton = card.querySelector("button[data-listing-id]");
    const actions = card.querySelector(".actions");
    if (!baseButton || !actions) return;
    const listingId = baseButton.dataset.listingId;
    const details = document.createElement("details");
    details.className = "refined-feedback";
    details.innerHTML = `
      <summary>Train model better</summary>
      <div class="refined-feedback-grid">
        ${REFINED_FEEDBACK_OPTIONS.map(([value, label]) => `<button type="button" data-refined-label="${value}" data-listing-id="${listingId}">${label}</button>`).join("")}
      </div>
    `;
    actions.insertAdjacentElement("afterend", details);
  });
}

function guardPlaceholderPriceDisplay() {
  const listings = allKnownListings();
  if (!listings.length) return;
  document.querySelectorAll(".card").forEach((card) => {
    if (card.dataset.priceGuarded === "true") return;
    const listingId = Number(card.querySelector("button[data-listing-id]")?.dataset.listingId || 0);
    const listing = listings.find((item) => Number(item.id) === listingId);
    if (!listing) return;
    const priceElement = card.querySelector(".price");
    if (!priceElement) return;
    const price = Number(listing.current_price || 0);
    const placeholder = PLACEHOLDER_PRICES.has(price);
    if (placeholder) {
      priceElement.textContent = "Check desc.";
      priceElement.classList.add("placeholder-price");
      addPriceGuardNote(card, "Card price looks like a placeholder. Refresh/hydrate details and read the description before judging this deal.", "placeholder");
    }
    card.dataset.priceGuarded = "true";
  });
}

function addPriceGuardNote(card, text, kind) {
  if (card.querySelector(`.price-guard-note[data-kind="${kind}"]`)) return;
  const note = document.createElement("p");
  note.className = "price-guard-note price-note";
  note.dataset.kind = kind;
  note.textContent = text;
  const priceRow = card.querySelector(".price-row");
  priceRow?.insertAdjacentElement("afterend", note);
}

function allKnownListings() {
  try {
    const base = Array.isArray(state?.listings) ? state.listings : [];
    const search = Array.isArray(state?.searchResults) ? state.searchResults : [];
    const deals = Array.isArray(state?.deals) ? state.deals : [];
    return [...base, ...search, ...deals];
  } catch {
    return [];
  }
}

function showRefinedFeedbackToast(message, type = "info") {
  if (typeof globalThis.showToast === "function") {
    globalThis.showToast(message, type, { dedupeKey: `feedback:${type}:${message}` });
    return;
  }
  const root = document.getElementById("toast-root");
  if (!root) return;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  root.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}
