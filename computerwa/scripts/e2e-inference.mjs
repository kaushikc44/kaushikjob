// Browser E2E for the live inference dashboard (Playwright).
// Needs: a model server (real or scripts/mock-openai-server.mjs), the gateway, and the app started with
// INFERENCE_GATEWAY_URL / INFERENCE_GATEWAY_READ_KEY. Pass an inference-scoped key to generate traffic:
//   GATEWAY_URL=http://127.0.0.1:8787 CLIENT_KEY=crwa_... node scripts/e2e-inference.mjs ./screenshots
// With STOP_GATEWAY_CMD set, it also stops the gateway and checks the offline state.
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const BASE = process.env.BASE_URL || "http://localhost:3100";
const GW = process.env.GATEWAY_URL;
const OUT = process.argv[2] || ".";
const assert = (c, m) => {
  if (!c) throw new Error("ASSERT: " + m);
  console.log("ok:", m);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const browserRequests = [];
const errors = [];
page.on("request", (r) => browserRequests.push(r.url()));
page.on("pageerror", (e) => errors.push(String(e)));
const text = () => page.locator("body").innerText();
const tileValue = async (label) => (await page.locator(".label", { hasText: label }).locator("xpath=../..").innerText()).split("\n");

await page.goto(`${BASE}/inference`);
await page.getByText("API Online · model ready").waitFor({ timeout: 20000 });
const before = Number((await tileValue("Requests"))[2].replace(/,/g, ""));
assert(before > 0, `dashboard shows ${before} recorded requests`);
assert((await text()).includes("$0.00"), "customer revenue shown as $0.00");
await page.screenshot({ path: `${OUT}/inference-online.png`, fullPage: true });

// Real request through the gateway, then confirm the dashboard reflects it.
const r = await fetch(`${GW}/v1/chat/completions`, {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.CLIENT_KEY}`, "content-type": "application/json" },
  body: JSON.stringify({ messages: [{ role: "user", content: "e2e ping" }], max_tokens: 16 }),
});
assert(r.status === 200, `gateway completion HTTP ${r.status} (request ${r.headers.get("x-request-id")})`);
await page.getByRole("button", { name: "Refresh" }).click();
await page.waitForFunction(
  (b) => {
    const el = [...document.querySelectorAll(".label")].find((e) => e.textContent === "Requests");
    return el && Number(el.parentElement.parentElement.innerText.split("\n")[2].replace(/,/g, "")) === b + 1;
  },
  before,
  { timeout: 10000 },
);
console.log("ok: request count incremented to", before + 1);

// Simulator: live actual → revenue 0, nothing distributable.
await page.getByRole("link", { name: /Use this usage in the distribution simulator/ }).click();
await page.getByTestId("scenario-label").filter({ hasText: "Live usage · actual" }).waitFor({ timeout: 15000 });
assert((await page.inputValue("#revenue")) === "0", "simulator revenue = 0 for live actual usage");
const dist = await page.locator(".label", { hasText: "Holder pool" }).locator("xpath=..").innerText();
assert(dist.includes("$0.00"), "holder pool $0.00 with free API usage");
await page.screenshot({ path: `${OUT}/simulator-live-actual.png`, fullPage: true });

await page.getByRole("button", { name: "Load HYPOTHETICAL scenario" }).click();
await page.getByTestId("scenario-label").filter({ hasText: "HYPOTHETICAL paid-inference scenario" }).waitFor();
console.log("ok: hypothetical scenario labelled, revenue input =", await page.inputValue("#revenue"));
await page.fill("#opex", "1");
await page.getByTestId("scenario-label").filter({ hasText: "manually edited" }).waitFor();
console.log("ok: manual edit flagged on scenario label");

const leaked = browserRequests.filter((u) => GW && u.startsWith(GW));
assert(leaked.length === 0, "browser never contacted the gateway directly");
const html = await page.content();
assert(!html.includes(process.env.CLIENT_KEY) && !(GW && html.includes(GW)), "no key or gateway URL in page HTML");

if (process.env.STOP_GATEWAY_CMD) {
  execSync(process.env.STOP_GATEWAY_CMD);
  await page.goto(`${BASE}/inference`);
  await page.getByText("API Offline").waitFor({ timeout: 20000 });
  assert((await text()).includes("Gateway unreachable"), "offline state explains that no data is shown or estimated");
  await page.screenshot({ path: `${OUT}/inference-offline.png`, fullPage: true });
  await page.goto(`${BASE}/simulator?source=live`);
  await page.getByText(/Live usage unavailable \(gateway offline\)/).waitFor({ timeout: 15000 });
  console.log("ok: simulator shows live usage unavailable while offline; seeded flow still works");
}
assert(errors.length === 0, `no page errors (${errors.join("; ")})`);
await browser.close();
