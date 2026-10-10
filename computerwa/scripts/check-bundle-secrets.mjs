// Fails if gateway secrets or the gateway URL appear in any browser-delivered file.
// Run after `next build` with the same env the build used:
//   INFERENCE_GATEWAY_URL=... INFERENCE_GATEWAY_READ_KEY=... npm run check:bundle
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = [".next/static", ".next/server/app"].filter((d) => {
  try {
    return statSync(d).isDirectory();
  } catch {
    return false;
  }
});
if (!roots.length) {
  console.error("No .next build output found. Run `npm run build` first.");
  process.exit(1);
}

const needles = [
  process.env.INFERENCE_GATEWAY_READ_KEY,
  process.env.INFERENCE_GATEWAY_URL,
  process.env.INFERENCE_GATEWAY_URL && new URL(process.env.INFERENCE_GATEWAY_URL).host,
  ":11434",
].filter(Boolean);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

// Browser-delivered: everything in .next/static, plus prerendered HTML/RSC payloads.
const files = [];
for (const r of roots) for (const f of walk(r)) if (r === ".next/static" || /\.(html|rsc|body)$/.test(f)) files.push(f);

let leaks = 0;
for (const f of files) {
  const text = readFileSync(f, "utf8");
  for (const n of needles) {
    if (text.includes(n)) {
      console.error(`LEAK: "${n.length > 12 ? n.slice(0, 6) + "…" : n}" found in ${f}`);
      leaks++;
    }
  }
}
console.log(`Scanned ${files.length} browser-delivered files for ${needles.length} secret patterns.`);
if (leaks) process.exit(1);
console.log("OK: no gateway URL, read key or model-server port in browser bundles.");
