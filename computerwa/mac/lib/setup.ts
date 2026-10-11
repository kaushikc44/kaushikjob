/**
 * `npm run mac:setup`: detect the runtime and the real model id, write config
 * without overwriting anything, provision scoped keys, and run a real smoke
 * test through a throwaway gateway (temp keys + ledger, so the production
 * ledger is not polluted). Nothing is downloaded unless --pull <tag> is given.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../../gateway/config";
import { createGateway } from "../../gateway/server";
import type { Ctx } from "./ctx";
import { applyEnvEdits, blankKeys, parseEnv, writePrivateFile } from "./dotenv";
import { desiredGatewayEnv, validateGatewayEnv } from "./gwconfig";
import { ensureKeys } from "./keysetup";
import { Checks } from "./report";
import { classifyModels, installGuidance, probeAll, RUNTIME_CANDIDATES, type RuntimeCandidate, type RuntimeProbe } from "./runtimes";
import { readExampleEnv, systemChecks } from "./system";
import { gatewayBaseUrl } from "./proc";

export interface SetupOptions {
  yes?: boolean;
  dryRun?: boolean;
  fillMissing?: boolean;
  newDashboardKey?: boolean;
  runtime?: string;
  model?: string;
  upstreamUrl?: string;
  publicModelId?: string;
  pull?: string;
  skipSmoke?: boolean;
}

export interface SetupResult {
  checks: Checks;
  ok: boolean;
  next: string[];
  selected?: { runtime: string; baseUrl: string; model: string; publicModelId: string };
}

const G = "Setup";
const PULL_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export async function runSetup(ctx: Ctx, opts: SetupOptions = {}): Promise<SetupResult> {
  const checks = new Checks();
  const next: string[] = [];
  const { paths, out } = ctx;
  const done = (selected?: SetupResult["selected"]): SetupResult => ({ checks, ok: !checks.list.some((c) => c.status === "fail"), next, selected });

  await systemChecks(checks, { info: ctx.info, exec: ctx.exec, appDir: paths.appDir });
  if (checks.list.some((c) => c.id === "sys.node" && c.status === "fail")) return done();
  if (!existsSync(join(paths.appDir, "gateway", ".env.example"))) {
    checks.fail("setup.example", G, "gateway/.env.example is missing", "local-real", "The repository checkout looks incomplete.", "Run `git status` / re-clone the computerwa-mvp branch.");
    return done();
  }

  // ── existing config (never overwritten)
  const existingText = existsSync(paths.gatewayEnv) ? readFileSync(paths.gatewayEnv, "utf8") : null;
  const existing = existingText ? parseEnv(existingText) : {};
  if (existingText) checks.pass("setup.env-exists", G, "gateway/.env already exists — existing values will be kept", "local-real");

  // ── optional explicit model pull
  let probes: RuntimeProbe[] = [];
  const customUrl = opts.upstreamUrl ?? (existing.UPSTREAM_BASE_URL || undefined);
  const candidates: RuntimeCandidate[] = customUrl && !RUNTIME_CANDIDATES.some((c) => c.baseUrl === customUrl.replace(/\/+$/, ""))
    ? [{ id: "custom", label: "Custom OpenAI-compatible server", baseUrl: customUrl.replace(/\/+$/, "") }]
    : customUrl
      ? RUNTIME_CANDIDATES.filter((c) => c.baseUrl === customUrl.replace(/\/+$/, ""))
      : RUNTIME_CANDIDATES;
  const probeOpts = { fetchImpl: ctx.fetchImpl, apiKey: ctx.env.UPSTREAM_API_KEY || existing.UPSTREAM_API_KEY || null };
  probes = await probeAll(candidates, probeOpts);

  const ollama = RUNTIME_CANDIDATES[0];
  const haveOllamaCli = (await ctx.exec("ollama", ["--version"], { timeoutMs: 8000 })).code === 0;
  if (opts.pull) {
    if (!PULL_TAG_RE.test(opts.pull)) {
      checks.fail("setup.pull", G, "Invalid model tag for --pull", "local-real", `"${opts.pull}" is not a valid Ollama tag.`, "Use the exact tag from the Ollama library, e.g. --pull <name>:<size>.");
      return done();
    }
    if (!haveOllamaCli) {
      checks.fail("setup.pull", G, "`ollama` CLI not found, so --pull cannot run", "local-real", "This tool will not install system software.", "Install Ollama yourself (`brew install ollama` or https://ollama.com/download), start it, then retry.");
      return done();
    }
    out(`⚠  Downloading "${opts.pull}" with \`ollama pull\`. The download size depends on the tag and was NOT checked by this tool. Press Ctrl-C to abort.`);
    const r = await ctx.exec("ollama", ["pull", opts.pull], { inherit: true, timeoutMs: 6 * 3600_000 });
    if (r.code !== 0) {
      checks.fail("setup.pull", G, `ollama pull ${opts.pull} failed`, "local-real", `exit code ${r.code}${r.error ? ` (${r.error})` : ""}`, "Check the tag spelling, disk space and that the Ollama server is running (`ollama serve`).");
      return done();
    }
    checks.pass("setup.pull", G, `Pulled ${opts.pull}`, "local-real");
    probes = await probeAll(candidates, probeOpts);
  }

  const reachable = probes.filter((p) => p.reachable);
  if (!reachable.length) {
    checks.fail("setup.runtime", G, "No model server found", "local-real", `Tried ${probes.map((p) => p.candidate.baseUrl).join(", ")}`, installGuidance("none", haveOllamaCli)[0]);
    next.push(...installGuidance("none", haveOllamaCli));
    return done();
  }

  // ── choose runtime (never guess between several)
  let probe: RuntimeProbe | undefined;
  if (opts.runtime) {
    probe = reachable.find((p) => p.candidate.id === opts.runtime);
    if (!probe) {
      checks.fail("setup.runtime", G, `Runtime "${opts.runtime}" is not reachable`, "local-real", `Reachable: ${reachable.map((p) => p.candidate.id).join(", ")}`, "Start that runtime or pass a different --runtime.");
      return done();
    }
  } else if (reachable.length === 1) probe = reachable[0];
  else {
    const withGemma = reachable.filter((p) => classifyModels(p.models).gemma4.length);
    if (withGemma.length === 1) probe = withGemma[0];
    else {
      const pick = ctx.prompt && !opts.yes ? await ctx.prompt.choose("Several model servers are running. Which should the gateway use?", reachable.map((p) => `${p.candidate.id} (${p.candidate.baseUrl}, ${p.models.length} models)`)) : null;
      probe = pick ? reachable.find((p) => pick.startsWith(p.candidate.id)) : undefined;
      if (!probe) {
        checks.fail("setup.runtime", G, "Several model servers are running; refusing to guess", "local-real", reachable.map((p) => `${p.candidate.id}: ${p.candidate.baseUrl}`).join(" · "), `Re-run with --runtime ${reachable.map((p) => p.candidate.id).join("|")}`);
        return done();
      }
    }
  }
  checks.pass("setup.runtime", G, `Model server: ${probe.candidate.label} at ${probe.candidate.baseUrl}`, "local-real", `${probe.models.length} model(s) listed by /v1/models`);

  // ── choose model (never guess; never silently pick a non-Gemma-4 model)
  const cls = classifyModels(probe.models);
  let model: string | undefined = opts.model ?? (existing.UPSTREAM_MODEL || undefined);
  if (model) {
    if (!probe.models.includes(model)) {
      checks.fail("setup.model", G, `Model "${model}" is not served by ${probe.candidate.id}`, "local-real", `Available: ${probe.models.join(", ") || "(none)"}`, "Pass an id from that list with --model, or install the model first.");
      return done();
    }
  } else if (cls.gemma4.length === 1) model = cls.gemma4[0];
  else if (cls.gemma4.length > 1) {
    const pick = ctx.prompt && !opts.yes ? await ctx.prompt.choose("Several Gemma 4 models are installed. Which one?", cls.gemma4) : null;
    if (!pick) {
      checks.fail("setup.model", G, "Several Gemma 4 models are installed; refusing to guess", "local-real", cls.gemma4.join(", "), `Re-run with --model <one of: ${cls.gemma4.join(" | ")}>`);
      return done();
    }
    model = pick;
  } else {
    const g = installGuidance(probe.candidate.id === "ollama" ? "ollama" : probe.candidate.id, haveOllamaCli);
    checks.fail("setup.model", G, "No Gemma 4 model found on the model server", "local-real", `Installed: ${probe.models.join(", ") || "(none)"}${cls.otherGemma.length ? ` · other Gemma versions: ${cls.otherGemma.join(", ")}` : ""}`, "Install Gemma 4 (steps listed under Next below), then re-run `npm run mac:setup`.");
    next.push(...g);
    return done();
  }
  const looksGemma4 = classifyModels([model]).gemma4.length === 1;
  if (looksGemma4) checks.pass("setup.gemma4", G, `Gemma 4 model selected: ${model}`, "local-real", "Identified by name only; weights cannot be verified from an id.");
  else checks.warn("setup.gemma4", G, `Selected model "${model}" does not look like Gemma 4 by name`, "local-real", "It was chosen explicitly (or from your existing gateway/.env). Dashboard labels will show the id below.", "If this is a mistake, pass --model <gemma-4 id>.");
  const publicModelId = opts.publicModelId ?? existing.PUBLIC_MODEL_ID ?? (looksGemma4 ? "gemma-4" : model);

  // ── gateway/.env (never overwrite existing values)
  const wanted = desiredGatewayEnv({ upstreamBaseUrl: probe.candidate.baseUrl, upstreamModel: model, publicModelId });
  // A fresh file starts from the example with managed values blanked (they are template defaults, not user choices).
  const base = existingText ?? blankKeys(readExampleEnv(paths.appDir), Object.keys(wanted));
  const edited = applyEnvEdits(base, wanted);
  const wouldChange = edited.changes.filter((c) => c.action === "added" || c.action === "filled-empty").map((c) => c.key);
  const differing = edited.changes.filter((c) => c.action === "differs-not-changed").map((c) => c.key);
  if (differing.length) checks.warn("setup.env-differs", G, `gateway/.env keeps your existing values for: ${differing.join(", ")}`, "local-real", "They differ from what setup detected; they were NOT changed.", "Edit gateway/.env yourself if you want the detected values.");
  let effective = parseEnv(edited.text);
  if (!existingText) {
    if (opts.dryRun) checks.pass("setup.env-write", G, "Would create gateway/.env (dry run)", "local-real");
    else {
      writePrivateFile(paths.gatewayEnv, edited.text);
      checks.pass("setup.env-write", G, "Created gateway/.env (mode 600) from .env.example", "local-real", `Set: ${Object.keys(wanted).join(", ")}`);
    }
  } else if (wouldChange.length) {
    if (opts.fillMissing && !opts.dryRun) {
      writePrivateFile(paths.gatewayEnv, edited.text);
      checks.pass("setup.env-write", G, `Filled missing values in gateway/.env: ${wouldChange.join(", ")}`, "local-real", "Existing non-empty values were not modified.");
    } else {
      effective = parseEnv(existingText);
      checks.warn("setup.env-write", G, `gateway/.env is missing values: ${wouldChange.join(", ")}`, "local-real", "Not modified (your file is never overwritten without approval).", "Re-run `npm run mac:setup -- --fill-missing` to add only the missing values.");
    }
  } else checks.pass("setup.env-write", G, "gateway/.env already complete", "local-real");

  // ── validate
  const v = validateGatewayEnv(effective);
  if (v.ok) checks.pass("setup.env-valid", G, "Gateway configuration is valid", "local-real");
  else checks.fail("setup.env-valid", G, "Gateway configuration is invalid", "local-real", v.errors.join("; "), "Fix gateway/.env, or re-run with --fill-missing.");
  for (const w of v.warnings) checks.warn("setup.env-warn", G, w, "local-real", "See gateway/.env.example for recommended values.");
  const costBasis = effective.COST_BASIS ?? "placeholder";
  if (costBasis === "placeholder") checks.warn("setup.cost", G, "Cost assumptions are PLACEHOLDERS, not measurements", "local-real", "The dashboard shows cost as an estimate. Defaults: 40 W, US$0.22/kWh.", "Measure power (wall meter or `sudo powermetrics --samplers cpu_power,gpu_power`), set COST_POWER_WATTS / COST_ELECTRICITY_USD_PER_KWH / COST_NOTE and COST_BASIS=measured.");
  else checks.pass("setup.cost", G, "Cost assumptions marked as measured", "local-real", effective.COST_NOTE);
  if (!v.ok || !v.config) return done();

  // ── keys (additive; never revoked)
  const keyRes = ensureKeys({ keysFile: paths.keysFile, secretsFile: paths.localSecrets, envLocalFile: paths.envLocal, gatewayUrl: gatewayBaseUrl(paths, effective), dryRun: !!opts.dryRun, newDashboardKey: opts.newDashboardKey });
  const keyBad = keyRes.dashboard === "env-local-key-invalid";
  const keyDetail = `smoke-test key: ${keyRes.smoke} · dashboard key: ${keyRes.dashboard}`;
  if (keyBad) checks.fail("setup.keys", G, "Existing dashboard key in .env.local is not valid", "local-real", keyDetail + " · " + keyRes.notes.join(" "), "Remove the INFERENCE_GATEWAY_READ_KEY line from .env.local and re-run setup, or restore the matching keys.json.");
  else checks.pass("setup.keys", G, "Scoped API keys in place", "local-real", keyDetail);
  for (const n of keyRes.notes) if (!keyBad) out(`   note: ${n}`);

  // ── real smoke test through a throwaway gateway
  if (opts.skipSmoke) checks.notRun("setup.smoke", G, "Inference smoke test (skipped by --skip-smoke)", "model-runtime", "Not run.", "Run `npm run mac:verify` later.");
  else await smokeTest(ctx, checks, v.config, probe.candidate.baseUrl);

  const failed = checks.list.some((c) => c.status === "fail");
  if (!failed) {
    next.push(
      "npm run mac:start         # start the gateway in the background (logs outside the repo)",
      "npm run mac:verify        # real end-to-end check of the running gateway",
      "npm run mac:service -- install   # optional: auto-start at login (launchd, no root)",
      "npm run mac:remote        # private (Tailscale) / public (Funnel) access — dry-run by default",
      "npm run mac:vercel        # preflight for Vercel environment variables",
    );
  }
  return done({ runtime: probe.candidate.id, baseUrl: probe.candidate.baseUrl, model, publicModelId });
}

async function smokeTest(ctx: Ctx, checks: Checks, cfg: ReturnType<typeof loadConfig>, upstreamBaseUrl: string) {
  const dir = mkdtempSync(join(tmpdir(), "crwa-setup-smoke-"));
  const config = loadConfig({
    UPSTREAM_BASE_URL: upstreamBaseUrl,
    UPSTREAM_MODEL: cfg.upstreamModel,
    UPSTREAM_API_KEY: cfg.upstreamApiKey ?? undefined,
    PUBLIC_MODEL_ID: cfg.publicModelId,
    UPSTREAM_TIMEOUT_MS: String(Math.max(cfg.upstreamTimeoutMs, 120_000)), // first request may load the model
    GATEWAY_KEYS_FILE: join(dir, "keys.json"),
    GATEWAY_LEDGER_FILE: join(dir, "usage.jsonl"),
  });
  const gw = createGateway(config, () => {});
  try {
    await new Promise<void>((r) => gw.server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(gw.server.address() as AddressInfo).port}`;
    const key = gw.keys.create("setup-smoke", ["inference"]).key;
    const f = ctx.fetchImpl ?? fetch;
    const ready = await (await f(`${base}/readyz`)).json().catch(() => null) as { status?: string; reason?: string } | null;
    if (ready?.status !== "ready") {
      checks.fail("setup.smoke", G, "Gateway ↔ model server readiness failed", "local-real", ready?.reason ?? "unknown", "Make sure the model is loaded (`ollama run <model>` once) and the id matches /v1/models.");
      return;
    }
    const t0 = Date.now();
    const res = await f(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ messages: [{ role: "user", content: "Reply with one short word." }], max_tokens: 64 }),
    });
    const ms = Date.now() - t0;
    const body = (await res.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[]; usage?: { completion_tokens?: number }; error?: { code?: string; message?: string } } | null;
    if (res.status !== 200) {
      checks.fail("setup.smoke", G, `Smoke test failed (HTTP ${res.status})`, "local-real", body?.error ? `${body.error.code}: ${body.error.message}` : "no error body", res.status === 503 ? "The model server is unreachable or the model is not loaded." : res.status === 504 ? "The model took too long (first load can be slow). Retry." : "See `npm run mac:logs`.");
      return;
    }
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      checks.fail("setup.smoke", G, "Model returned an empty response", "local-real", `HTTP 200 but no text after ${ms} ms.`, "Try a different model id or increase max_tokens; check the runtime's chat template.");
      return;
    }
    const tokens = body?.usage?.completion_tokens;
    checks.pass("setup.smoke", G, `Real inference works: ${ms} ms, ${content.trim().length} characters returned`, "local-real", tokens === undefined ? "Runtime did not report token counts (they will show as unavailable, never estimated)." : `Runtime reported ${tokens} output tokens.`);
  } catch (e) {
    checks.fail("setup.smoke", G, "Smoke test errored", "local-real", (e as Error).message, "See `npm run mac:logs`.");
  } finally {
    gw.server.closeAllConnections();
    gw.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

