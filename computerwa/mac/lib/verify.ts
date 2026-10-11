/**
 * `npm run mac:verify`: real, local, end-to-end check of the RUNNING gateway
 * and the real model. Sends ONE genuine inference request. No public access needed.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Ledger, summarize } from "../../gateway/ledger";
import { assumptionsId } from "../../gateway/cost";
import { computeDistribution } from "../../src/lib/finance";
import { liveActualInputs } from "../../src/lib/inference/accounting";
import { getInferenceStatus } from "../../src/lib/inference/gatewayClient";
import type { UsageSummary } from "../../src/lib/inference/types";
import type { Ctx } from "./ctx";
import { effectiveGatewayEnv, envLocalValue } from "./envload";
import { ledgerSchemaProblems } from "./doctor";
import { validateGatewayEnv } from "./gwconfig";
import { readLocalSecrets } from "./keysetup";
import { gatewayBaseUrl, isAlive, isHealthy, readPid, startGateway, stopGateway } from "./proc";
import { buildReport, Checks, type Report } from "./report";
import { redactDeep, secretValuesFromEnv } from "./redact";

export interface VerifyOptions {
  appUrl?: string;
  start?: boolean;
  withTests?: boolean;
  offlineTest?: boolean;
}

const G = "Real inference verification";

export async function runVerify(ctx: Ctx, opts: VerifyOptions = {}): Promise<Report> {
  const checks = new Checks();
  const { paths } = ctx;
  const f = ctx.fetchImpl ?? fetch;
  const env = effectiveGatewayEnv(ctx);
  const v = existsSync(paths.gatewayEnv) ? validateGatewayEnv(env) : null;
  const finish = () => {
    const secrets = secretValuesFromEnv({ ...ctx.env, INFERENCE_GATEWAY_READ_KEY: envLocalValue(ctx, "INFERENCE_GATEWAY_READ_KEY") });
    const smoke = readLocalSecrets(paths.localSecrets).smokeKey;
    return redactDeep(buildReport("mac:verify", checks.list), [...secrets, ...(smoke ? [smoke] : [])]);
  };

  if (!v || !v.ok || !v.config) {
    checks.fail("v.config", G, "Gateway configuration missing or invalid", "local-real", v ? v.errors.join("; ") : "gateway/.env not found", "npm run mac:setup");
    return finish();
  }
  const cfg = v.config;
  const smokeKey = readLocalSecrets(paths.localSecrets).smokeKey;
  const readKey = envLocalValue(ctx, "INFERENCE_GATEWAY_READ_KEY");
  if (!smokeKey || !readKey) {
    checks.fail("v.keys", G, "Local smoke-test key or dashboard read key missing", "local-real", `smoke-test key: ${smokeKey ? "ok" : "missing"} · dashboard read key: ${readKey ? "ok" : "missing"}`, "npm run mac:setup");
    return finish();
  }

  const base = gatewayBaseUrl(paths, env);
  let healthy = await isHealthy(base, 1500, ctx.fetchImpl);
  if (!healthy && opts.start) {
    const r = await startGateway(paths);
    ctx.out(`   ${r.message}`);
    healthy = r.ok;
  }
  if (!healthy) {
    checks.fail("v.gateway", G, `Gateway not running at ${base}`, "local-real", "Cannot test a gateway that is down.", "npm run mac:start   (or add --start)");
    return finish();
  }
  checks.pass("v.gateway", G, "Gateway is running", "local-real");

  const ready = await f(`${base}/readyz`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (ready?.status !== 200) {
    checks.fail("v.ready", G, `Model not ready (/readyz → ${ready?.status ?? "no response"})`, "local-real", "The gateway cannot reach the model.", "Check `ollama list` / the runtime, UPSTREAM_MODEL, then `npm run mac:logs`.");
    return finish();
  }
  checks.pass("v.ready", G, "Model server reachable and model available", "local-real");

  const getSummary = async (): Promise<UsageSummary | null> => {
    const r = await f(`${base}/v1/usage/summary?days=1`, { headers: { authorization: `Bearer ${readKey}` }, signal: AbortSignal.timeout(8000) }).catch(() => null);
    return r?.status === 200 ? ((await r.json()) as UsageSummary) : null;
  };
  const before = await getSummary();
  if (!before) {
    checks.fail("v.summary", G, "Could not read the usage summary with the dashboard key", "local-real", "Key rejected or gateway error.", "npm run mac:setup");
    return finish();
  }

  // ── one real inference request, with a unique nonce to prove prompts are not stored
  const nonce = `nonce-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const t0 = Date.now();
  let requestId: string | null = null;
  let status = 0;
  let content = "";
  let model = "";
  try {
    const res = await f(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${smokeKey}` },
      body: JSON.stringify({ messages: [{ role: "user", content: `Reply with exactly one short word. (ref ${nonce})` }], max_tokens: 64 }),
      signal: AbortSignal.timeout(Math.max(cfg.upstreamTimeoutMs, 120_000) + 5_000),
    });
    status = res.status;
    requestId = res.headers.get("x-request-id");
    const body = (await res.json()) as { model?: string; choices?: { message?: { content?: unknown } }[]; error?: { code?: string; message?: string } };
    model = body.model ?? "";
    content = typeof body.choices?.[0]?.message?.content === "string" ? (body.choices[0].message!.content as string) : "";
    if (status !== 200) checks.fail("v.infer", G, `Inference request failed (HTTP ${status})`, "local-real", body.error ? `${body.error.code}: ${body.error.message}` : "no error body", status === 429 ? "Smoke key hit a rate/concurrency limit; wait a minute and retry." : "See `npm run mac:logs`.");
  } catch (e) {
    checks.fail("v.infer", G, "Inference request errored", "local-real", (e as Error).message, "See `npm run mac:logs`.");
  }
  const ms = Date.now() - t0;
  if (status === 200) {
    if (!content.trim()) checks.fail("v.infer", G, "Model returned an empty response", "local-real", `HTTP 200 after ${ms} ms but no text.`, "Try a different model id; check the chat template.");
    else if (!requestId?.startsWith("req_")) checks.fail("v.infer", G, "Response lacks an x-request-id", "local-real", "Gateway contract broken.", "Investigate gateway/server.ts.");
    else if (model !== cfg.publicModelId) checks.fail("v.infer", G, "Response model id differs from PUBLIC_MODEL_ID", "local-real", `Expected ${cfg.publicModelId}, got ${model}.`, "Investigate.");
    else checks.pass("v.infer", G, `Real inference: HTTP 200 in ${ms} ms, ${content.trim().length} characters from "${model}"`, "local-real", "Response text is not stored or printed.");
  }

  // ── usage recorded correctly
  const after = await getSummary();
  if (status === 200 && after) {
    const dTotal = after.requests.total - before.requests.total;
    const dOk = after.requests.success - before.requests.success;
    if (dTotal === 1 && dOk === 1) checks.pass("v.usage", G, "Usage summary advanced by exactly one successful request", "local-real");
    else checks.fail("v.usage", G, `Usage changed by total ${dTotal}, success ${dOk} (expected 1 and 1)`, "local-real", "Something else used the API concurrently, or the ledger is not recording.", "Re-run when idle; check `npm run mac:logs`.");
    const dWith = after.tokens.requestsWithUsage - before.tokens.requestsWithUsage;
    if (dWith === 1) checks.pass("v.tokens", G, `Runtime reported token counts (+${after.tokens.outputTokens - before.tokens.outputTokens} output tokens)`, "local-real");
    else checks.warn("v.tokens", G, "Runtime did not report token counts for this request", "local-real", "They show as unavailable on the dashboard and are never estimated.", "Check that your runtime returns a `usage` object on /v1/chat/completions.");
    const lat = after.latencyMs.count > before.latencyMs.count;
    checks.add({ id: "v.latency", group: G, title: lat ? "Latency measured and recorded" : "Latency not recorded", status: lat ? "pass" : "fail", environment: "local-real", fix: lat ? undefined : "Investigate the ledger." });
  }

  // ── ledger privacy + independent recomputation
  const ledgerPath = resolve(paths.appDir, cfg.ledgerFile);
  if (status === 200 && existsSync(ledgerPath)) {
    const raw = readFileSync(ledgerPath, "utf8");
    const logRaw = existsSync(paths.gatewayLog) ? readFileSync(paths.gatewayLog, "utf8") : "";
    if (raw.includes(nonce) || logRaw.includes(nonce)) checks.fail("v.privacy", G, "Prompt text found in the ledger or gateway log", "local-real", "The unique prompt marker was stored.", "Stop the gateway and investigate; prompts must never be stored.");
    else checks.pass("v.privacy", G, "Prompt marker absent from the ledger and the gateway log", "local-real", existsSync(paths.gatewayLog) ? undefined : "No gateway log file found (started another way); only the ledger was scanned.");
    const last = new Ledger(ledgerPath).all().at(-1);
    if (last?.requestId === requestId && last.outcome === "success" && last.measured.latencyMs > 0) checks.pass("v.ledger", G, "Newest ledger entry matches the response's request ID", "local-real", `status ${last.status}, ${last.measured.tokenSource}`);
    else checks.fail("v.ledger", G, "Newest ledger entry does not match this request", "local-real", `expected ${requestId}`, "Another process may share the ledger; re-run when idle.");
    const sch = ledgerSchemaProblems(ledgerPath);
    if (sch.problems.length) checks.fail("v.schema", G, "Ledger has non-metadata fields", "local-real", sch.problems.join(" | "), "Investigate.");
    else checks.pass("v.schema", G, "Every ledger entry matches the metadata-only schema", "local-real");
    if (after) {
      const recomputed = summarize(new Ledger(ledgerPath).all(), { from: after.range.from ? new Date(after.range.from) : null, to: new Date(after.range.to), model: cfg.publicModelId, assumptions: cfg.cost, assumptionsId: assumptionsId(cfg.cost), gatewayStartedAt: after.source.gatewayStartedAt, unauthenticatedRejected: 0 });
      const same = recomputed.requests.total === after.requests.total && Math.abs(recomputed.estimated.operatingCostUsd - after.estimated.operatingCostUsd) < 1e-9;
      if (same) checks.pass("v.recompute", G, "API totals match an independent recomputation from the ledger file", "local-real", `${after.requests.total} requests, estimated cost $${after.estimated.operatingCostUsd.toFixed(6)} (estimate)`);
      else checks.fail("v.recompute", G, "API totals differ from the ledger file", "local-real", `API ${after.requests.total} vs ledger ${recomputed.requests.total}`, "Another request may have landed mid-check; re-run when idle.");
    }
  }

  // ── zero revenue + distribution consistency (free inference)
  if (after) {
    const i = liveActualInputs(after);
    const d = computeDistribution({ revenue: i.revenue, operatingExpenses: i.operatingExpenses, reserve: i.reserve, holderSharePct: 70 });
    if (after.revenue.recordedPaymentsUsd === 0 && i.revenue === 0 && d.holderPoolCents === 0 && d.distributableCashCents === 0 && d.shortfallCents === Math.round(i.operatingExpenses * 100)) {
      checks.pass("v.revenue", G, "Free inference: revenue $0 → distributable cash $0, shortfall equals estimated cost", "local-real", "Cost is an estimate; revenue is recorded payments only (none).");
    } else checks.fail("v.revenue", G, "Revenue/distribution accounting inconsistent", "local-real", JSON.stringify({ rev: after.revenue.recordedPaymentsUsd, pool: d.holderPoolCents }), "Investigate src/lib/inference/accounting.ts.");
  }

  // ── dashboard through its server-side route
  const appUrl = (opts.appUrl ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
  const dash = await f(`${appUrl}/api/inference?days=1`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!dash) checks.notRun("v.dashboard", G, "Dashboard reads usage through /api/inference", "app-running", `No app answering at ${appUrl}.`, "In another terminal: npm run build && npm start   (with .env.local present), then re-run `npm run mac:verify`.");
  else {
    const text = await dash.text();
    let json: { health?: string; summary?: UsageSummary | null } | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    const leaks = [readKey, new URL(base).host].filter((s) => text.includes(s));
    if (!json || dash.status !== 200) checks.fail("v.dashboard", G, `GET /api/inference → ${dash.status}`, "local-real", "Not valid JSON/200.", "Check the app log.");
    else if (leaks.length) checks.fail("v.dashboard", G, "Dashboard API response contains the gateway address or key", "local-real", "Secrets must stay server-side.", "Investigate src/app/api/inference/route.ts.");
    else if (json.health !== "online") checks.fail("v.dashboard", G, `Dashboard reports health "${json.health}"`, "local-real", "The app server cannot reach the gateway with its configured URL/key.", "Check INFERENCE_GATEWAY_URL / INFERENCE_GATEWAY_READ_KEY in the app's environment (restart the app after editing .env.local).");
    else if (after && json.summary && json.summary.requests.total !== after.requests.total) checks.warn("v.dashboard", G, "Dashboard totals differ from the gateway's", "local-real", `${json.summary.requests.total} vs ${after.requests.total}`, "Re-run when idle.");
    else checks.pass("v.dashboard", G, "Dashboard read live usage via its server-side route (no gateway URL or key in the response)", "local-real");
  }

  // ── honest offline state (only if this tool started the gateway)
  if (opts.offlineTest) {
    const pid = readPid(paths.pidFile);
    if (!pid || !isAlive(pid)) checks.notRun("v.offline", G, "Honest offline state with the real gateway stopped", "gateway-running", "The gateway was not started by `mac:start` (e.g. it runs under launchd), so this tool will not stop it.", "Stop it yourself (`npm run mac:service -- stop`), open /inference, expect \"API Offline\", then start it again.");
    else {
      await stopGateway(paths);
      const st = await getInferenceStatus({ baseUrl: base, readKey, days: 1, timeoutMs: 1500, fetchImpl: ctx.fetchImpl });
      if (st.health === "offline" && st.summary === null) checks.pass("v.offline", G, "With the gateway stopped the dashboard client reports offline and invents no data", "local-real");
      else checks.fail("v.offline", G, `Dashboard client reported "${st.health}" with the gateway stopped`, "local-real", "Honest offline state broken.", "Investigate src/lib/inference/gatewayClient.ts.");
      const r = await startGateway(paths);
      ctx.out(`   ${r.message}`);
      if (!r.ok) checks.fail("v.restart", G, "Gateway did not restart after the offline test", "local-real", r.message, "npm run mac:start");
    }
  }

  // ── existing test-suite + Solana devnet integration unchanged
  if (opts.withTests) {
    for (const [id, title, args] of [["v.tests", "Existing test suite (npm test)", ["test"]], ["v.typecheck", "Type check", ["run", "typecheck"]]] as const) {
      const r = await ctx.exec("npm", [...args], { cwd: paths.appDir, timeoutMs: 600_000 });
      if (r.code === 0) checks.pass(id, G, title, "local-real", (r.stdout.match(/Tests\s+(\d+ passed[^\n]*)/) ?? [])[1]);
      else checks.fail(id, G, `${title} failed`, "local-real", (r.stdout + r.stderr).split("\n").slice(-6).join(" | "), "Fix the failing tests before the demo.");
    }
  } else checks.notRun("v.tests", G, "Existing test suite", "app-build", "Not requested.", "npm run mac:verify -- --with-tests");
  const git = await ctx.exec("git", ["status", "--porcelain", "--", "src/lib/solana", "src/lib/finance.ts"], { cwd: paths.appDir, timeoutMs: 10_000 });
  if (git.code === 0) {
    if (git.stdout.trim() === "") checks.pass("v.solana-unchanged", G, "Solana/financial source files have no local modifications", "local-real", "Compared with the git checkout (this does not run the on-chain flow).");
    else checks.warn("v.solana-unchanged", G, "Solana/financial source files are modified locally", "local-real", git.stdout.trim().split("\n").join(", "), "Review with `git diff src/lib/solana`.");
  }
  checks.notRun("v.devnet", G, "On-chain flow on public devnet (wallet, mint, registration)", "devnet-wallet", "Needs a devnet wallet and network access; never run automatically.", "Follow README → Repeatable demo scenario, or `SOLANA_RPC=https://api.devnet.solana.com npm run e2e:chain` (uses a throwaway keypair + faucet airdrop).");
  return finish();
}
