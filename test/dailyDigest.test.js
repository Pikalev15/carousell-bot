import test from "node:test";
import assert from "node:assert/strict";
import { buildTopDealsBySearch, scoreListingForSearch } from "../src/services/dealScorer.js";
import { renderTopDealsDigest } from "../src/services/digestRenderer.js";
import { getDigestEmailConfig, maskDigestEmailConfig } from "../src/services/emailService.js";
import { nextRunDate, normalizeSendTime } from "../src/jobs/dailyDigest.js";

test("deal scorer selects recent matching listings and filters weak deals", () => {
  const now = new Date("2026-07-10T10:00:00+08:00");
  const searches = [{ id: 1, query: "RTX 3070", terms: ["rtx", "3070"], active: true, price_ceiling: 320 }];
  const listings = [
    {
      id: 1,
      title: "Nvidia RTX 3070 graphics card",
      description: "Working well",
      category: "graphics card",
      current_price: 280,
      scraped_at: "2026-07-10T08:30:00+08:00",
      carousell_id: "a"
    },
    {
      id: 2,
      title: "RTX 3070 wanted",
      description: "WTB only",
      category: "graphics card",
      current_price: 1,
      scraped_at: "2026-07-10T09:00:00+08:00",
      carousell_id: "b"
    },
    {
      id: 3,
      title: "Nvidia RTX 3070 graphics card duplicate",
      description: "Working well",
      category: "graphics card",
      current_price: 290,
      scraped_at: "2026-07-08T08:30:00+08:00",
      carousell_id: "c"
    },
    {
      id: 4,
      title: "RTX 3070 scraped today but listed last week",
      description: "Freshly scraped candidate",
      category: "graphics card",
      current_price: 260,
      listed_age_minutes: 7 * 24 * 60,
      scraped_at: "2026-07-10T09:30:00+08:00",
      carousell_id: "d"
    }
  ];

  const sections = buildTopDealsBySearch({ listings, searches, now, filters: [], config: {}, options: { minScore: 58 } });

  assert.equal(sections.length, 1);
  assert.equal(sections[0].deals.length, 2);
  assert.deepEqual(sections[0].deals.map((deal) => deal.listing.id).sort(), [1, 4]);
});

test("deal scorer applies bad keyword penalties", () => {
  const deal = scoreListingForSearch(
    {
      title: "RTX 3070 deposit only",
      description: "not selling the card yet",
      category: "graphics card",
      current_price: 280,
      scraped_at: "2026-07-10T08:30:00+08:00"
    },
    { query: "RTX 3070", terms: ["rtx", "3070"], price_ceiling: 320 },
    { now: new Date("2026-07-10T10:00:00+08:00"), filters: [{ type: "blacklist", phrase: "deposit" }] }
  );

  assert.ok(deal.components.bad_keyword_penalty > 0);
  assert.ok(deal.reasons.some((reason) => reason.includes("Penalty keyword")));
});

test("digest renderer escapes listing content", () => {
  const rendered = renderTopDealsDigest({
    generatedAt: new Date("2026-07-10T10:00:00+08:00"),
    sections: [
      {
        search: { query: "GPU" },
        deals: [
          {
            score: 80,
            components: { price: 90, keyword: 100, freshness: 88 },
            reasons: ["Matched keywords: gpu"],
            listing: {
              title: "<script>alert(1)</script>",
              current_price: 250,
              seller_name: "Seller",
              location: "Singapore",
              carousell_url: "https://www.carousell.sg/p/example"
            }
          }
        ]
      }
    ]
  });

  assert.match(rendered.subject, /Carousell Top Deals/);
  assert.doesNotMatch(rendered.html, /<script>alert/);
  assert.match(rendered.html, /&lt;script&gt;alert/);
});

test("daily digest send time parsing schedules next local run", () => {
  assert.equal(normalizeSendTime("8:05"), "08:05");
  assert.equal(normalizeSendTime("nope"), "08:00");
  assert.equal(nextRunDate(new Date("2026-07-10T07:00:00+08:00"), "08:00").toISOString(), new Date("2026-07-10T08:00:00+08:00").toISOString());
  assert.equal(nextRunDate(new Date("2026-07-10T09:00:00+08:00"), "08:00").toISOString(), new Date("2026-07-11T08:00:00+08:00").toISOString());
});

test("digest email config prefers saved UI settings and masks app password", () => {
  const config = getDigestEmailConfig(
    { GMAIL_USER: "env@example.com", GMAIL_APP_PASSWORD: "env-pass", DIGEST_EMAIL_TO: "env-to@example.com" },
    { gmailUser: "ui@example.com", gmailAppPassword: "abcd efgh ijkl mnop", emailTo: "me@example.com", sendTime: "9:05", enabled: true }
  );
  const masked = maskDigestEmailConfig({ gmailUser: "ui@example.com", gmailAppPassword: "abcd efgh ijkl mnop", emailTo: "me@example.com", sendTime: "9:05" }, {});

  assert.equal(config.user, "ui@example.com");
  assert.equal(config.to, "me@example.com");
  assert.equal(config.sendTime, "09:05");
  assert.equal(config.configured, true);
  assert.equal(masked.gmailAppPasswordConfigured, true);
  assert.equal(masked.gmailAppPasswordPreview, "abcd...mnop");
});
