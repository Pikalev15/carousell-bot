import { readJson, writeJson } from "../src/store.js";
import { applyDefaultCategoryMedians } from "../src/marketGrouping.js";

const config = await readJson("config");
const next = applyDefaultCategoryMedians(config);
await writeJson("config", next);
console.log(`Category medians ready: ${Object.keys(next.categoryMedians || {}).length} categories.`);
