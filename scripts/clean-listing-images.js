import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "..", "data");
const listingsPath = path.join(dataDir, "listings.json");

const BAD_IMAGE_PATTERN = /\b(?:profiles?|avatar|profile[-_]?(?:pic|photo|image)|user[-_]?icon|placeholder|sprite|favicon|logo|blank\.gif|1x1|spinner|badge|star-rating|verified-icon|seller|pfp)\b/i;
const PRODUCT_HINT_PATTERN = /\b(?:products?|listing|photos?|media)\b/i;

const raw = await readFile(listingsPath, "utf8").catch((error) => {
  if (error.code === "ENOENT") {
    console.log(`No listings file found at ${listingsPath}`);
    process.exit(0);
  }
  throw error;
});

const listings = JSON.parse(raw);
let removed = 0;
let changedListings = 0;

const cleaned = listings.map((listing) => {
  const before = Array.isArray(listing.image_urls) ? listing.image_urls : [];
  const after = cleanImageUrls(before);
  removed += Math.max(0, before.length - after.length);
  if (after.length !== before.length || after.some((url, index) => url !== before[index])) changedListings += 1;
  return {
    ...listing,
    image_urls: after,
    primary_image: after[0] || "",
    image_quality: after.length > 0 ? "product_or_unknown" : before.length > 0 ? "removed_profile_images" : "missing"
  };
});

await writeFile(listingsPath, `${JSON.stringify(cleaned, null, 2)}\n`);
console.log(`Cleaned listing images: ${changedListings} listings changed, ${removed} image URLs removed.`);

function cleanImageUrls(urls) {
  const normalized = [];
  for (const rawUrl of urls) {
    const url = String(rawUrl || "").trim();
    if (!url || normalized.includes(url)) continue;
    if (isBadImage(url)) continue;
    normalized.push(url);
  }
  return normalized
    .sort((a, b) => imageScore(b) - imageScore(a))
    .slice(0, 8);
}

function isBadImage(url) {
  const lower = String(url || "").toLowerCase();
  if (BAD_IMAGE_PATTERN.test(lower)) return true;
  if (/\/u\/|\/user\//i.test(lower)) return true;
  if (/googleusercontent\.com\/.*=s(?:32|40|48|64|80|96|128)(?:-|$)/i.test(lower)) return true;
  return false;
}

function imageScore(url) {
  const lower = String(url || "").toLowerCase();
  let score = 50;
  if (PRODUCT_HINT_PATTERN.test(lower)) score += 20;
  if (/media\.karousell|media\.carousell/.test(lower)) score += 10;
  if (/\.webp|\.jpg|\.jpeg|\.png/.test(lower)) score += 5;
  if (BAD_IMAGE_PATTERN.test(lower)) score -= 100;
  return score;
}
