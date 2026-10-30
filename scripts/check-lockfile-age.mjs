// Lists every locked package version published after a cutoff (default 2026-09-30T00:00:00Z).
// Usage: node scripts/check-lockfile-age.mjs [ISO-cutoff]
import { readFileSync } from "node:fs";

const cutoff = Date.parse(process.argv[2] ?? "2026-09-30T00:00:00Z");
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const entries = Object.entries(lock.packages)
  .filter(([path, meta]) => path.startsWith("node_modules/") && meta.version)
  .map(([path, meta]) => ({ name: path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length), version: meta.version }));
const unique = [...new Map(entries.map((e) => [`${e.name}@${e.version}`, e])).values()];

async function publishedAt({ name, version }) {
  const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}`);
  if (!res.ok) throw new Error(`${name}: registry HTTP ${res.status}`);
  const doc = await res.json();
  const when = doc.time?.[version];
  if (!when) throw new Error(`${name}@${version}: no publish time in registry`);
  return { ...{ name, version }, when };
}

const results = [];
const queue = [...unique];
await Promise.all(
  Array.from({ length: 8 }, async () => {
    while (queue.length) results.push(await publishedAt(queue.pop()));
  }),
);
const tooNew = results.filter((r) => Date.parse(r.when) > cutoff);
console.log(`checked ${results.length} locked packages against cutoff ${new Date(cutoff).toISOString()}`);
console.log(`published after cutoff: ${tooNew.length}`);
for (const r of tooNew) console.log(`  ${r.name}@${r.version} ${r.when}`);
process.exit(tooNew.length === 0 ? 0 : 1);
