(() => {
  const previousCard = typeof globalThis.card === "function" ? globalThis.card.bind(globalThis) : null;
  const previousOpenDetails = typeof globalThis.openDetails === "function" ? globalThis.openDetails.bind(globalThis) : null;

  if (previousCard) {
    globalThis.card = (listing) => replaceStarsWithLikes(previousCard(listingWithLikeDisplay(listing)), listing);
  }

  if (previousOpenDetails) {
    globalThis.openDetails = async (listing) => {
      const output = await previousOpenDetails(listingWithLikeDisplay(listing));
      const details = document.getElementById("details-body");
      if (details) details.innerHTML = replaceStarsWithLikes(details.innerHTML, listing);
      return output;
    };
  }

  function listingWithLikeDisplay(listing = {}) {
    return {
      ...listing,
      seller_rating: likeCountOrZero(listing)
    };
  }

  function replaceStarsWithLikes(html, listing = {}) {
    const label = escapeHtml(likeLabel(listing));
    return String(html || "")
      .replace(/<span>\s*[^<]*?\s*stars\s*<\/span>/gi, `<span>${label}</span>`)
      .replace(/\(\s*[^)]*?\s*stars\s*\)/gi, `(${label})`);
  }

  function likeLabel(listing = {}) {
    if (!hasLikeData(listing)) return "likes pending";
    const count = likeCountOrZero(listing);
    return `${formatCompactCount(count)} ${count === 1 ? "like" : "likes"}`;
  }

  function hasLikeData(listing = {}) {
    return ["like_count", "likes_count", "favorite_count", "favourite_count"].some((key) => listing[key] !== undefined && listing[key] !== null);
  }

  function likeCountOrZero(listing = {}) {
    const value = listing.like_count ?? listing.likes_count ?? listing.favorite_count ?? listing.favourite_count ?? 0;
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function formatCompactCount(value) {
    const number = Number(value || 0);
    if (number >= 1_000_000) return `${trimDecimal(number / 1_000_000)}M`;
    if (number >= 1_000) return `${trimDecimal(number / 1_000)}k`;
    return String(number);
  }

  function trimDecimal(value) {
    return Number(value.toFixed(1)).toString();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }
})();
