import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.resolve(__dirname, "..", "data", "image-cache");
const MAX_BYTES = 8 * 1024 * 1024;

export function proxiedImageUrl(url) {
  return isCacheableImageUrl(url) ? `/api/images?url=${encodeURIComponent(url)}` : url || "";
}

export function isCacheableImageUrl(rawUrl) {
  const text = String(rawUrl || "").trim();
  if (!text) return false;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return false;
  const lower = parsed.href.toLowerCase();
  if (/\/profiles?\//i.test(lower)) return false;
  if (/avatar|profile|logo|user-profile|seller-photo/i.test(lower)) return false;
  return /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(lower) || /carousell|carousel|cloudfront|imgix|images?/i.test(lower);
}

export async function getCachedImage(rawUrl, settings = {}) {
  if (!isCacheableImageUrl(rawUrl)) throw new Error("Unsupported image URL");
  if (settings.enabled === false) return fetchImage(rawUrl);

  await mkdir(cacheDir, { recursive: true });
  await cleanupImageCache(settings).catch(() => {});
  const key = createHash("sha256").update(String(rawUrl)).digest("hex");
  const dataPath = path.join(cacheDir, `${key}.bin`);
  const metaPath = path.join(cacheDir, `${key}.json`);
  const maxAgeMs = Math.max(1, Number(settings.maxAgeDays || 14)) * 24 * 60 * 60 * 1000;

  try {
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    const age = Date.now() - new Date(meta.cached_at || 0).getTime();
    if (age < maxAgeMs) {
      return {
        body: await readFile(dataPath),
        contentType: meta.content_type || "image/jpeg",
        source: "cache"
      };
    }
  } catch {
    // Cache miss, stale metadata, or partial file. Fetch below.
  }

  const fetched = await fetchImage(rawUrl);
  await writeFile(dataPath, fetched.body);
  await writeFile(metaPath, JSON.stringify({ url: rawUrl, content_type: fetched.contentType, cached_at: new Date().toISOString() }, null, 2));
  return { ...fetched, source: "network" };
}

async function fetchImage(rawUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(rawUrl, { signal: controller.signal, headers: { "user-agent": "CarousellBot/0.1" } });
    if (!response.ok) throw new Error(`Image fetch failed (${response.status})`);
    const contentType = response.headers.get("content-type") || "image/jpeg";
    if (!contentType.startsWith("image/")) throw new Error("URL did not return an image");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_BYTES) throw new Error("Image is too large to cache");
    return { body: buffer, contentType, source: "network" };
  } finally {
    clearTimeout(timeout);
  }
}

async function cleanupImageCache(settings = {}) {
  const maxFiles = Math.max(50, Number(settings.maxFiles || 500));
  const maxAgeMs = Math.max(1, Number(settings.maxAgeDays || 14)) * 24 * 60 * 60 * 1000;
  const files = (await readdir(cacheDir)).filter((file) => file.endsWith(".bin"));
  const entries = [];
  for (const file of files) {
    const fullPath = path.join(cacheDir, file);
    const info = await stat(fullPath).catch(() => null);
    if (!info) continue;
    entries.push({ file, fullPath, mtimeMs: info.mtimeMs });
  }

  const stale = entries.filter((entry) => Date.now() - entry.mtimeMs > maxAgeMs);
  const overflow = entries.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(maxFiles);
  const targets = new Set([...stale, ...overflow].map((entry) => entry.file));
  for (const file of targets) {
    const base = path.join(cacheDir, file.replace(/\.bin$/, ""));
    await unlink(`${base}.bin`).catch(() => {});
    await unlink(`${base}.json`).catch(() => {});
  }
}
