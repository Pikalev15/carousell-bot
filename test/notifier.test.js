import test from "node:test";
import assert from "node:assert/strict";
import { alertInlineKeyboard, formatAlertMessage, parseTelegramCallbackData, parseTelegramCommand, TELEGRAM_COMMANDS } from "../src/notifier.js";
import { isCacheableImageUrl, proxiedImageUrl } from "../src/imageCache.js";

test("parses telegram slash commands", () => {
  assert.deepEqual(parseTelegramCommand("/search gpu"), { command: "/search", args: "gpu" });
  assert.deepEqual(parseTelegramCommand("/watch@my_bot Computers & Tech"), { command: "/watch", args: "Computers & Tech" });
  assert.deepEqual(parseTelegramCommand("hello"), { command: "", args: "" });
});

test("exposes botfather-style command menu definitions", () => {
  assert.deepEqual(
    TELEGRAM_COMMANDS.map((item) => item.command),
    ["search", "watch", "unwatch", "status", "deals", "settings", "help"]
  );
  assert.equal(TELEGRAM_COMMANDS.every((item) => item.description.length > 0 && !item.command.startsWith("/")), true);
});

test("formats rich telegram alert messages", () => {
  const message = formatAlertMessage({
    type: "new_deal",
    title: "RTX 4070 Super",
    price: 520,
    score: 86,
    score_breakdown: "price 92/100, preference 80/100",
    location: "Jurong East",
    condition: "Like new",
    seller_name: "pcseller",
    reason: "New deal from Computers & Tech",
    listing_url: "https://www.carousell.sg/p/test-123"
  });

  assert.match(message, /RTX 4070 Super/);
  assert.match(message, /S\$520/);
  assert.match(message, /Score 86/);
  assert.match(message, /Jurong East/);
  assert.match(message, /https:\/\/www\.carousell\.sg\/p\/test-123/);
});

test("formats scrape-health telegram alerts with visible body context", () => {
  const message = formatAlertMessage({
    type: "scrape_health",
    title: "Scrape health: SSD",
    watch_id: 3,
    message: "⚠️ Scrape health warning\n\nWatch: SSD\nResults: 2\nPrevious healthy result count: 48"
  });

  assert.match(message, /Scrape health: SSD/);
  assert.match(message, /Watch: SSD/);
  assert.match(message, /Previous healthy result count: 48/);
  assert.equal(alertInlineKeyboard({ type: "scrape_health", watch_id: 3 }), null);
});

test("builds inline action keyboard and parses callback data", () => {
  const keyboard = alertInlineKeyboard({
    listing_id: 42,
    listing_url: "https://www.carousell.sg/p/test-42"
  });
  assert.equal(keyboard.inline_keyboard[0][0].text, "Open");
  assert.equal(keyboard.inline_keyboard[1][0].callback_data, "cb:good:42");
  assert.deepEqual(parseTelegramCallbackData("cb:bad_deal:42"), { action: "bad_deal", listingId: 42 });
  assert.deepEqual(parseTelegramCallbackData("tgset:dnd"), { kind: "settings", action: "dnd", settingAction: "dnd", listingId: 0 });
  assert.deepEqual(parseTelegramCallbackData("bad"), { action: "", listingId: 0 });
});

test("filters image cache proxy URLs to listing photos", () => {
  assert.equal(isCacheableImageUrl("https://media.karousell.com/media/photos/products/test.jpg"), true);
  assert.equal(isCacheableImageUrl("https://media.karousell.com/media/photos/profiles/user.jpg"), false);
  assert.equal(isCacheableImageUrl("javascript:alert(1)"), false);
  assert.equal(proxiedImageUrl("https://media.karousell.com/media/photos/products/test.jpg").startsWith("/api/images?url="), true);
});
