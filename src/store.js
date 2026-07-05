import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const paths = {
  listings: path.join(root, "data", "listings.json"),
  filters: path.join(root, "data", "filters.json"),
  sellers: path.join(root, "data", "seller-blacklist.json"),
  config: path.join(root, "data", "config.json"),
  labels: path.join(root, "data", "labels.json"),
  searches: path.join(root, "data", "search-history.json")
};

export async function readJson(name) {
  return JSON.parse(await readFile(paths[name], "utf8"));
}

export async function writeJson(name, value) {
  await writeFile(paths[name], `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function getState() {
  const [listings, filters, sellers, config] = await Promise.all([
    readJson("listings"),
    readJson("filters"),
    readJson("sellers"),
    readJson("config")
  ]);
  return { listings, filters, sellers, config };
}
