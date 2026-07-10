export function renderTopDealsDigest({ sections = [], generatedAt = new Date() } = {}) {
  const totalDeals = sections.reduce((total, section) => total + section.deals.length, 0);
  const subject = `Carousell Top Deals: ${totalDeals} ${totalDeals === 1 ? "deal" : "deals"}`;
  const html = `
    <!doctype html>
    <html>
      <body style="margin:0;background:#f5f7fb;color:#172033;font-family:Arial,sans-serif;">
        <main style="max-width:760px;margin:0 auto;padding:28px 18px;">
          <header style="margin-bottom:20px;">
            <p style="margin:0 0 6px;color:#687186;font-size:13px;">Generated ${escapeHtml(formatDate(generatedAt))}</p>
            <h1 style="margin:0;font-size:26px;line-height:1.2;">Carousell Top Deals</h1>
            <p style="margin:8px 0 0;color:#465066;">${totalDeals} qualifying ${totalDeals === 1 ? "listing" : "listings"} from enabled saved searches.</p>
          </header>
          ${sections.map(renderSection).join("")}
        </main>
      </body>
    </html>
  `;
  return {
    subject,
    html,
    text: renderTextDigest({ sections, generatedAt })
  };
}

function renderSection(section) {
  return `
    <section style="margin:0 0 22px;">
      <h2 style="font-size:18px;margin:0 0 10px;">${escapeHtml(section.search.query || "Saved search")}</h2>
      ${section.deals.map(renderDeal).join("")}
    </section>
  `;
}

function renderDeal(deal) {
  const listing = deal.listing;
  const url = listing.carousell_url || listing.url || "";
  const reasons = deal.reasons.slice(0, 4).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("");
  return `
    <article style="background:#fff;border:1px solid #dfe5ef;border-radius:8px;margin:0 0 12px;padding:16px;">
      <div style="display:flex;gap:12px;align-items:flex-start;justify-content:space-between;">
        <div>
          <h3 style="font-size:16px;line-height:1.35;margin:0 0 5px;">${linkOrText(url, listing.title || "Untitled listing")}</h3>
          <p style="margin:0;color:#465066;">${escapeHtml(listing.seller_name || "Unknown seller")} · ${escapeHtml(listing.location || "Location not listed")}</p>
        </div>
        <strong style="white-space:nowrap;font-size:18px;">${formatMoney(listing.current_price)}</strong>
      </div>
      <p style="margin:10px 0 0;color:#172033;">Score <strong>${deal.score}</strong> · Price ${deal.components.price} · Match ${deal.components.keyword} · Freshness ${deal.components.freshness}</p>
      ${reasons ? `<ul style="margin:10px 0 0;padding-left:20px;color:#465066;">${reasons}</ul>` : ""}
    </article>
  `;
}

function renderTextDigest({ sections = [], generatedAt = new Date() } = {}) {
  const lines = [`Carousell Top Deals`, `Generated ${formatDate(generatedAt)}`, ""];
  for (const section of sections) {
    lines.push(section.search.query || "Saved search");
    for (const deal of section.deals) {
      const listing = deal.listing;
      lines.push(`- ${listing.title} | ${formatMoney(listing.current_price)} | score ${deal.score}`);
      if (listing.carousell_url) lines.push(`  ${listing.carousell_url}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

function linkOrText(url, text) {
  if (!url) return escapeHtml(text);
  return `<a href="${escapeHtml(url)}" style="color:#1b62d1;text-decoration:none;">${escapeHtml(text)}</a>`;
}

function formatMoney(value) {
  const number = Number(value || 0);
  return number > 0 ? `S$${number.toLocaleString("en-SG")}` : "S$--";
}

function formatDate(value) {
  return new Date(value).toLocaleString("en-SG", { dateStyle: "medium", timeStyle: "short" });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
