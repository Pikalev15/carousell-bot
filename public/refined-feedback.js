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
const feedbackObserver = new MutationObserver(injectRefinedFeedbackControls);
feedbackObserver.observe(document.body, { childList: true, subtree: true });
document.addEventListener("DOMContentLoaded", injectRefinedFeedbackControls);
injectRefinedFeedbackControls();

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
        relevance_flags: ISSUE_FEEDBACK.has(rating) ? rating : ""
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

function showRefinedFeedbackToast(message, type = "info") {
  const root = document.getElementById("toast-root");
  if (!root) return;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  root.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}
