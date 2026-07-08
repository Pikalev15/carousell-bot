import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const serverPlusSource = await readFile(new URL("../src/server-plus.js", import.meta.url), "utf8");

test("default npm runtime uses plus server", () => {
  assert.equal(packageJson.scripts.start, "node src/server-plus.js");
  assert.equal(packageJson.scripts.dev, "node src/server-plus.js");
  assert.equal(packageJson.scripts["start:core"], "node src/server.js");
  assert.equal(packageJson.scripts["start:plus"], "node src/server-plus.js");
});

test("plus server entrypoint has valid syntax", () => {
  const result = spawnSync(process.execPath, ["--check", "src/server-plus.js"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("plus runtime replays JSON request bodies as buffers", () => {
  assert.match(serverPlusSource, /Readable\.from\(\[Buffer\.from\(JSON\.stringify\(body \|\| \{\}\)\)\]\)/);
  assert.match(serverPlusSource, /chunks\.push\(typeof chunk === "string" \? Buffer\.from\(chunk\) : chunk\)/);
});
