// Browser end-to-end demo run (Playwright). Requires the app built with the burner wallet + localnet:
//   NEXT_PUBLIC_SOLANA_RPC=http://127.0.0.1:8899 NEXT_PUBLIC_SOLANA_CLUSTER=localnet NEXT_PUBLIC_ENABLE_BURNER_WALLET=true npm run build && npx next start -p 3100
//   node scripts/e2e-ui.mjs ./screenshots   (set PLAYWRIGHT_PATH if playwright is installed globally)
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const BASE = process.env.BASE_URL || "http://localhost:3100";
const OUT = process.argv[2] || ".";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true });

await page.goto(BASE);
await page.getByText("Harbour Edge H100 Pool A").waitFor();
await shot("01-marketplace");

await page.getByText("Inspect pool →").first().click();
await page.getByText("Where the revenue went").waitFor();
await page.getByRole("button", { name: "Connect wallet" }).click();
await page.getByText("Burner Wallet").click();
await page.getByText("Fund wallet with devnet SOL").waitFor();
const t0 = Date.now();
const step = async (btn, done) => {
  await page.getByRole("button", { name: btn }).click();
  await page.getByText(done).first().waitFor({ timeout: 60000 });
  console.log("ok:", btn, `${Date.now() - t0}ms`);
};
await step("Airdrop 1 devnet SOL", "Airdrop confirmed");
await step("Register pool", "Pool registration confirmed");
await page.getByText("matches current off-chain record").waitFor({ timeout: 30000 });
await step("Create test token", "Test token mint confirmed");
await page.getByRole("button", { name: "+ 2 random demo addresses" }).click();
await step("Send test tokens", "Test token transfer confirmed");
await page.waitForFunction(() => document.body.innerText.includes("Your balance: 650,000"), null, { timeout: 30000 });
const facts = await page.locator("text=On-chain facts").locator("xpath=../..").innerText();
console.log("---- facts ----\n" + facts);
await shot("02-pool-detail");

await page.getByRole("link", { name: "Simulate a distribution with these holders →" }).click();
await page.getByText("Hypothetical allocation by holder").waitFor();
await page.getByText(/Balances read from mint/).waitFor({ timeout: 30000 });
const table = await page.locator("table").innerText();
console.log("---- allocation ----\n" + table);
await shot("03-simulator-chain");
await page.getByRole("button", { name: "Stress: −40% revenue" }).click();
await page.getByRole("button", { name: "Stress: −40% revenue" }).click();
await page.getByText(/Costs plus reserve exceed revenue/).waitFor();
await shot("04-simulator-shortfall");
await page.fill("#revenue", "-5");
await page.getByText("Revenue cannot be negative").waitFor();

await page.getByRole("link", { name: "On-chain records" }).click();
await page.getByText("On-chain records vs off-chain inputs").waitFor();
await page.getByText("matches", { exact: true }).first().waitFor({ timeout: 30000 });
await shot("05-transparency");

await page.goto(`${BASE}/pools/bne-b200-c`);
await page.getByText("Inspect the distributable-cash formula").waitFor();
await shot("06-b200");
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${BASE}/pools/syd-h100-a`);
await page.getByText("Where the revenue went").waitFor();
await shot("07-mobile");
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
console.log("mobile horizontal overflow px:", overflow);
await page.goto(`${BASE}/pools/does-not-exist`);
console.log("404 page:", (await page.locator("h1").innerText()));
console.log("console errors:", errors);
await browser.close();
