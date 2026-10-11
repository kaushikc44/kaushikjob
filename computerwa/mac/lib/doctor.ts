/** `npm run mac:doctor`: read-only diagnostics + machine-readable report. */
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { KeyStore } from "../../gateway/keys";
import { assertNotMainnetEndpoint } from "../../src/lib/solana/config";
import type { UsageSummary } from "../../src/lib/inference/types";
import type { Ctx } from "./ctx";
import { readEnvFile } from "./dotenv";
import { effectiveGatewayEnv, envLocalValue } from "./envload";
import { validateGatewayEnv } from "./gwconfig";
import { readLocalSecrets } from "./keysetup";
import { gatewayBaseUrl, isHealthy } from "./proc";
import { buildReport, Checks, type Report } from "./report";
import { redactDeep, secretValuesFromEnv } from "./redact";
import { classifyModels, exposedOnLan, installGuidance, isLoopbackUrl, lanAddresses, probeRuntime } from "./runtimes";
import { runSelfTest } from "./selftest";
import { systemChecks } from "./system";

const LEDGER_TOP = new Set(["v", "requestId", "ts", "keyId", "model", "status", "outcome", "errorCode", "idempotencyKeyHash", "duplicateOf", "measured", "estimated"]);
const LEDGER_MEASURED = new Set(["latencyMs", "upstreamMs", "inputTokens", "outputTokens", "tokenSource", "finishReason"]);

/** The ledger must hold metadata only: reject any line with fields outside the schema. */
export function ledgerSchemaProblems(path: string): { lines: number; problems: string[] } {
  const problems: string[] = [];
  if (!existsSync(path)) return { lines: 0, problems };
  let lines = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    lines++;
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      const extra = Object.keys(e).filter((k) => !LEDGER_TOP.has(k));
      const m = (e.measured ?? {}) as Record<string, unknown>;
      const extraM = Object.keys(m).filter((k) => !LEDGER_MEASURED.has(k));
      if (extra.length || extraM.length) problems.push(`line ${lines}: unexpected fields ${[...extra, ...extraM.map((k) => `measured.${k}`)].join(", ")}`);
    } catch {
      /* torn final line is tolerated by the gateway */
    }
  }
  return { lines, problems: problems.slice(0, 5) };
}

export interface DoctorOptions {
  skipSelfTest?: boolean;
}

export async function runDoctor(ctx: Ctx, opts: DoctorOptions = {}): Promise<Report> {
  const checks = new Checks();
  const { paths } = ctx;
  const f = ctx.fetchImpl ?? fetch;

  await systemChecks(checks, { info: ctx.info, exec: ctx.exec, appDir: paths.appDir });

  // ── configuration
  const G1 = "Configuration";
  const haveEnv = existsSync(paths.gatewayEnv);
  const env = effectiveGatewayEnv(ctx);
  if (!haveEnv) checks.fail("cfg.env", G1, "gateway/.env not found", "local-real", "The gateway has no configuration.", "npm run mac:setup");
  else checks.pass("cfg.env", G1, "gateway/.env present", "local-real");
  const v = haveEnv ? validateGatewayEnv(env) : null;
  if (v) {
    if (v.ok) checks.pass("cfg.valid", G1, "Gateway configuration valid (UPSTREAM_BASE_URL, UPSTREAM_MODEL, limits)", "local-real");
    else checks.fail("cfg.valid", G1, "Gateway configuration invalid", "local-real", v.errors.join("; "), "Fix gateway/.env or run `npm run mac:setup -- --fill-missing`.");
    for (const w of v.warnings) checks.warn("cfg.warn", G1, w, "local-real", "See gateway/.env.example for recommended values.");
    if ((env.COST_BASIS ?? "placeholder") === "placeholder") checks.warn("cfg.cost", G1, "Cost assumptions are placeholders (not measured)", "local-real", "The dashboard labels cost as an estimate.", "Measure power draw, then set COST_POWER_WATTS, COST_ELECTRICITY_USD_PER_KWH, COST_NOTE and COST_BASIS=measured.");
    else checks.pass("cfg.cost", G1, "Cost assumptions marked as measured", "local-real", env.COST_NOTE);
  }

  // ── model runtime
  const G2 = "Model runtime";
  const upstream = env.UPSTREAM_BASE_URL || "http://127.0.0.1:11434/v1";
  const probe = await probeRuntime({ id: "custom", label: "configured upstream", baseUrl: upstream }, { fetchImpl: ctx.fetchImpl, apiKey: env.UPSTREAM_API_KEY || null });
  if (!probe.reachable) {
    checks.notRun("rt.reach", G2, "Model server reachable", "model-runtime", `Nothing answers at ${upstream}.`, "Start your model server (Ollama: `ollama serve`, or open the app), then run `npm run mac:setup` (it prints install steps if needed).");
  } else {
    checks.pass("rt.reach", G2, `Model server answers at ${upstream}`, "local-real", `${probe.models.length} model(s) listed`);
    const model = env.UPSTREAM_MODEL;
    if (!model) checks.fail("rt.model", G2, "UPSTREAM_MODEL is not set", "local-real", `Available: ${probe.models.join(", ") || "(none)"}`, "npm run mac:setup");
    else if (probe.models.includes(model)) {
      checks.pass("rt.model", G2, `Configured model "${model}" is served`, "local-real");
      if (classifyModels([model]).gemma4.length) checks.pass("rt.gemma4", G2, "Model id identifies as Gemma 4 (by name)", "local-real", "Weights cannot be verified from an id.");
      else checks.warn("rt.gemma4", G2, "Model id does not look like Gemma 4", "local-real", `"${model}" — fine if intentional.`, "Run `npm run mac:setup -- --model <gemma-4 id>` if this is wrong.");
    } else checks.fail("rt.model", G2, `Configured model "${model}" is not served`, "local-real", `Available: ${probe.models.join(", ") || "(none)"}`, "Install/load it, or update UPSTREAM_MODEL.");
    if (isLoopbackUrl(upstream)) {
      const port = new URL(upstream).port;
      const exposed = await exposedOnLan(upstream, lanAddresses(networkInterfaces()), async (url) => {
        try {
          return (await f(url, { signal: AbortSignal.timeout(1500) })).ok;
        } catch {
          return false;
        }
      });
      if (exposed) checks.fail("rt.exposed", G2, `Model server answers on ${exposed}:${port} (not only localhost)`, "local-real", "Anyone on this network can use the raw model server.", "Bind it to 127.0.0.1 only (Ollama: remove OLLAMA_HOST=0.0.0.0; LM Studio: turn off \"Serve on Local Network\"), then restart it.");
      else checks.pass("rt.exposed", G2, "Model server is not reachable on this machine's LAN addresses", "local-real", `Probed ${lanAddresses(networkInterfaces()).length} interface address(es) on port ${port}.`);
    }
  }

  // ── keys
  const G3 = "API keys";
  if (!existsSync(paths.keysFile)) checks.fail("keys.file", G3, "No keys file", "local-real", "No API keys exist yet.", "npm run mac:setup");
  else {
    const store = new KeyStore(paths.keysFile);
    const active = store.list().filter((k) => !k.revokedAt);
    const inf = active.filter((k) => k.scopes.includes("inference")).length;
    const rd = active.filter((k) => k.scopes.includes("usage:read")).length;
    checks.add({ id: "keys.counts", group: G3, title: `${active.length} active key(s): ${inf} with inference, ${rd} with usage:read`, status: inf && rd ? "pass" : "fail", environment: "local-real", fix: inf && rd ? undefined : "npm run mac:setup" });
    const smoke = readLocalSecrets(paths.localSecrets).smokeKey;
    if (smoke && store.authenticate(smoke, "inference").ok) checks.pass("keys.smoke", G3, "Local smoke-test key valid", "local-real");
    else checks.warn("keys.smoke", G3, "No valid local smoke-test key", "local-real", "mac:verify needs one.", "npm run mac:setup");
    const rk = envLocalValue(ctx, "INFERENCE_GATEWAY_READ_KEY");
    if (rk && store.authenticate(rk, "usage:read").ok) checks.pass("keys.read", G3, "Dashboard read key (usage:read) valid", "local-real");
    else checks.warn("keys.read", G3, rk ? "Dashboard read key is not valid for this keys file" : "No dashboard read key in .env.local/environment", "local-real", "The local dashboard cannot read usage.", "npm run mac:setup");
  }

  // ── live gateway (read-only requests; no model call unless noted)
  const G4 = "Running gateway";
  const base = gatewayBaseUrl(paths, env);
  const up = await isHealthy(base, 1500, ctx.fetchImpl);
  if (!up) checks.notRun("gw.live", G4, "Gateway running", "gateway-running", `Nothing answers at ${base}/healthz.`, "npm run mac:start");
  else {
    checks.pass("gw.live", G4, `GET /healthz → 200 at ${base}`, "local-real");
    const ready = await f(`${base}/readyz`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (ready?.status === 200) checks.pass("gw.ready", G4, "GET /readyz → ready (model reachable)", "local-real");
    else checks.fail("gw.ready", G4, `GET /readyz → ${ready?.status ?? "no response"}`, "local-real", "The gateway cannot reach the configured model.", "Check the runtime (`ollama list`) and UPSTREAM_MODEL; see `npm run mac:logs`.");
    const noKey = await f(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null);
    if (noKey?.status === 401) checks.pass("gw.auth-none", G4, "Chat without a key → 401", "local-real");
    else checks.fail("gw.auth-none", G4, `Chat without a key → ${noKey?.status ?? "error"} (expected 401)`, "local-real", "Authentication is not enforced.", "Stop the gateway and investigate.");
    const bad = await f(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer crwa_deadbeef_" + "A".repeat(43) }, body: "{}" }).catch(() => null);
    if (bad?.status === 401) checks.pass("gw.auth-bad", G4, "Chat with an invalid key → 401", "local-real");
    else checks.fail("gw.auth-bad", G4, `Chat with an invalid key → ${bad?.status ?? "error"} (expected 401)`, "local-real", "Authentication is not enforced.", "Stop the gateway and investigate.");
    const smoke = readLocalSecrets(paths.localSecrets).smokeKey;
    if (smoke) {
      const scope = await f(`${base}/v1/usage/summary`, { headers: { authorization: `Bearer ${smoke}` } }).catch(() => null);
      if (scope?.status === 403) checks.pass("gw.scope", G4, "Inference-only key on usage endpoint → 403 (scopes enforced)", "local-real");
      else checks.fail("gw.scope", G4, `Inference-only key on usage endpoint → ${scope?.status ?? "error"} (expected 403)`, "local-real", "Scopes are not enforced.", "Stop the gateway and investigate.");
    } else checks.notRun("gw.scope", G4, "Insufficient-scope check", "gateway-running", "Needs the local smoke-test key.", "npm run mac:setup");
    const rk = envLocalValue(ctx, "INFERENCE_GATEWAY_READ_KEY");
    if (rk) {
      const s = await f(`${base}/v1/usage/summary?days=30`, { headers: { authorization: `Bearer ${rk}` } }).catch(() => null);
      if (s?.status === 200) {
        const sum = (await s.json()) as UsageSummary;
        if (sum.revenue.recordedPaymentsUsd === 0) checks.pass("gw.revenue0", G4, `Free inference: customer revenue $0 (${sum.requests.total} requests recorded)`, "local-real");
        else checks.fail("gw.revenue0", G4, "Gateway reports non-zero revenue", "local-real", `${sum.revenue.recordedPaymentsUsd}`, "The gateway must never record revenue; investigate.");
      } else checks.fail("gw.revenue0", G4, `Usage summary → ${s?.status ?? "error"}`, "local-real", "Dashboard read key rejected.", "npm run mac:setup");
    }
  }
  const led = ledgerSchemaProblems(paths.ledgerFile);
  if (!existsSync(paths.ledgerFile)) checks.notRun("gw.ledger", G4, "Usage ledger contains metadata only", "gateway-running", "No ledger yet (no requests recorded).", "npm run mac:verify");
  else if (led.problems.length) checks.fail("gw.ledger", G4, "Ledger has fields outside the metadata schema", "local-real", led.problems.join(" | "), "Investigate: prompts/responses must never be stored.");
  else checks.pass("gw.ledger", G4, `Ledger holds metadata only (${led.lines} entries match the schema)`, "local-real");

  // ── behaviour self-test (mock)
  if (opts.skipSelfTest) checks.notRun("gw.selftest", "Gateway behaviour (mock model server)", "Behaviour self-test", "gateway-running", "Skipped (--skip-selftest).", "Run `npm run mac:doctor` without --skip-selftest.");
  else await runSelfTest(checks);

  // ── app
  const G5 = "ComputeRWA app";
  const rpc = envLocalValue(ctx, "NEXT_PUBLIC_SOLANA_RPC") || "https://api.devnet.solana.com";
  const cluster = envLocalValue(ctx, "NEXT_PUBLIC_SOLANA_CLUSTER") || "devnet";
  try {
    assertNotMainnetEndpoint(rpc);
    if (cluster !== "devnet" && cluster !== "localnet") throw new Error(`cluster "${cluster}"`);
    checks.pass("app.devnet", G5, `Solana configured for ${cluster} (mainnet endpoints are rejected)`, "local-real");
  } catch (e) {
    checks.fail("app.devnet", G5, "Solana configuration is not devnet/localnet", "local-real", (e as Error).message, "Use https://api.devnet.solana.com and NEXT_PUBLIC_SOLANA_CLUSTER=devnet.");
  }
  try {
    assertNotMainnetEndpoint("https://api.mainnet-beta.solana.com");
    checks.fail("app.mainnet-guard", G5, "Mainnet guard did not reject a mainnet URL", "local-real", "assertNotMainnetEndpoint accepted it.", "Restore src/lib/solana/config.ts.");
  } catch {
    checks.pass("app.mainnet-guard", G5, "Mainnet guard rejects mainnet RPC URLs", "local-real");
  }
  if (!existsSync(resolve(paths.appDir, ".next", "static"))) checks.notRun("app.bundle", G5, "Secrets not exposed in browser bundles", "app-build", "No production build found.", "npm run build && npm run check:bundle");
  else {
    const gwUrl = envLocalValue(ctx, "INFERENCE_GATEWAY_URL");
    const key = envLocalValue(ctx, "INFERENCE_GATEWAY_READ_KEY");
    if (!gwUrl && !key) checks.warn("app.bundle", G5, "Bundle scan ran without gateway values to look for", "local-real", "Set INFERENCE_GATEWAY_URL/READ_KEY (as in the build) so the scan can detect them.", "Re-run with those env vars set.");
    else {
      const r = await ctx.exec("node", ["scripts/check-bundle-secrets.mjs"], { cwd: paths.appDir, timeoutMs: 60_000 });
      if (r.code === 0) checks.pass("app.bundle", G5, "No gateway URL, read key or model-server port in browser bundles", "local-real");
      else checks.fail("app.bundle", G5, "Secrets found in browser bundles (or scan failed)", "local-real", (r.stdout + r.stderr).split("\n").slice(-3).join(" | "), "Remove NEXT_PUBLIC_ usage of gateway values and rebuild.");
    }
  }

  // ── things this tool cannot verify by itself
  checks.notRun("ext.tunnel", "Not verifiable here", "Public HTTPS tunnel reachable and protected", "tunnel-auth", "Needs your Tailscale/Cloudflare login on the Mac mini.", "npm run mac:remote -- public --apply && npm run mac:remote -- verify <url> --burst");
  checks.notRun("ext.vercel", "Not verifiable here", "Deployed dashboard on Vercel reads live usage", "vercel", "This tool never deploys or edits Vercel settings.", "npm run mac:vercel");
  checks.notRun("ext.devnet", "Not verifiable here", "On-chain flow on public devnet with a real wallet", "devnet-wallet", "Needs a devnet wallet (Phantom) and network access to devnet.", "Run the checklist in README → Repeatable demo scenario.");
  if (ctx.info.platform !== "darwin") checks.notRun("ext.mac", "Not verifiable here", "Everything above against the physical Mac mini", "physical-mac", `This run was on ${ctx.info.platform}.`, "Run `npm run mac:doctor` on the Mac mini.");

  const secrets = secretValuesFromEnv({ ...readEnvFile(paths.envLocal), ...readEnvFile(paths.gatewayEnv), ...ctx.env });
  const smokeKey = readLocalSecrets(paths.localSecrets).smokeKey;
  const report = buildReport("mac:doctor", checks.list);
  return redactDeep(report, [...secrets, ...(smokeKey ? [smokeKey] : [])]);
}
