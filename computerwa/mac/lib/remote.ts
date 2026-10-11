/**
 * Remote access to the GATEWAY only (never the model server).
 *   A. private: Tailscale Serve (tailnet devices only)
 *   B. public:  Tailscale Funnel (public HTTPS, Tailscale-authenticated node)
 * Every state-changing action is dry-run unless --apply is passed.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KeyStore } from "../../gateway/keys";
import type { Ctx } from "./ctx";
import { readEnvFile } from "./dotenv";
import { gatewayBaseUrl, isHealthy } from "./proc";
import { type Checks, Checks as ChecksImpl } from "./report";
import { validateGatewayEnv } from "./gwconfig";

const G = "Remote access";
const TS_APP_BIN = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export interface TailscaleState {
  installed: boolean;
  bin?: string;
  backend?: string; // Running | NeedsLogin | Stopped | …
  dnsName?: string;
}

export async function tailscaleState(ctx: Ctx): Promise<TailscaleState> {
  for (const bin of ["tailscale", TS_APP_BIN]) {
    const r = await ctx.exec(bin, ["status", "--json"], { timeoutMs: 10_000 });
    if (r.error === "not_found") continue;
    if (r.stdout.trim().startsWith("{")) {
      try {
        const j = JSON.parse(r.stdout) as { BackendState?: string; Self?: { DNSName?: string } };
        return { installed: true, bin, backend: j.BackendState, dnsName: j.Self?.DNSName?.replace(/\.$/, "") };
      } catch {
        /* fall through */
      }
    }
    const v = await ctx.exec(bin, ["version"], { timeoutMs: 5000 });
    if (v.code === 0) return { installed: true, bin, backend: "Unknown" };
  }
  return { installed: false };
}

export const TAILSCALE_INSTALL = [
  "Install Tailscale yourself (this tool does not install system software):",
  "  brew install --cask tailscale     (or the Mac App Store / https://tailscale.com/download)",
  "Then open the Tailscale app and log in, or run: tailscale up",
  "For the public mode, Funnel must also be allowed for this device in your Tailscale admin console (see Tailscale's Funnel documentation) — this cannot be done from here.",
];

function gatewayPort(ctx: Ctx): number {
  const u = new URL(gatewayBaseUrl(ctx.paths));
  return Number(u.port || 8787);
}

export interface RemoteOptions {
  apply?: boolean;
  url?: string;
  burst?: boolean;
}

export async function remoteStatus(ctx: Ctx, checks: Checks = new ChecksImpl()): Promise<Checks> {
  const ts = await tailscaleState(ctx);
  if (!ts.installed) checks.notRun("remote.tailscale", G, "Tailscale CLI", "tunnel-auth", "Not installed (or not on PATH).", TAILSCALE_INSTALL[1]);
  else if (ts.backend === "Running") checks.pass("remote.tailscale", G, `Tailscale running${ts.dnsName ? ` as ${ts.dnsName}` : ""}`, "local-real");
  else checks.notRun("remote.tailscale", G, `Tailscale installed but not logged in/running (${ts.backend})`, "tunnel-auth", "Authentication is interactive and must be done by you.", "Open the Tailscale app and log in, or run `tailscale up`.");
  const cf = await ctx.exec("cloudflared", ["--version"], { timeoutMs: 5000 });
  const cfCert = existsSync(join(homedir(), ".cloudflared", "cert.pem"));
  checks.add({ id: "remote.cloudflared", group: G, title: cf.code === 0 ? `cloudflared installed${cfCert ? " and logged in" : " (not logged in: run `cloudflared tunnel login`)"}` : "cloudflared not installed (optional alternative to Funnel)", status: "pass", environment: "local-real", detail: "Named Cloudflare tunnels are documented but not automated by this tool." });
  const healthy = await isHealthy(gatewayBaseUrl(ctx.paths), 1500, ctx.fetchImpl);
  if (healthy) checks.pass("remote.gateway", G, "Gateway is answering locally", "local-real");
  else checks.notRun("remote.gateway", G, "Gateway is not running locally", "gateway-running", "Nothing to expose yet.", "npm run mac:start");
  return checks;
}

export type RemoteMode = "private" | "public" | "off";

export async function remoteApply(ctx: Ctx, mode: RemoteMode, opts: RemoteOptions): Promise<{ checks: Checks; ok: boolean; lines: string[] }> {
  const checks = new ChecksImpl();
  const lines: string[] = [];
  const ts = await tailscaleState(ctx);
  const port = gatewayPort(ctx);
  const cmd =
    mode === "private" ? ["serve", "--bg", String(port)] : mode === "public" ? ["funnel", "--bg", String(port)] : ["serve", "reset"];
  const human = `tailscale ${cmd.join(" ")}`;

  if (!ts.installed) {
    checks.notRun("remote.tailscale", G, "Tailscale CLI", "tunnel-auth", "Not installed.", TAILSCALE_INSTALL[1]);
    lines.push(...TAILSCALE_INSTALL);
    return { checks, ok: false, lines };
  }
  if (ts.backend !== "Running") {
    checks.notRun("remote.tailscale", G, `Tailscale not logged in (${ts.backend})`, "tunnel-auth", "Login is interactive.", "Open the Tailscale app and log in, or run `tailscale up`.");
    lines.push("Log in to Tailscale first (`tailscale up`), then re-run.");
    return { checks, ok: false, lines };
  }

  if (mode !== "off") {
    // Preconditions: only the gateway is exposed, and it is protected.
    const env = readEnvFile(ctx.paths.gatewayEnv);
    const v = validateGatewayEnv(env);
    if (!v.ok || !v.config) {
      checks.fail("remote.config", G, "Gateway configuration is invalid", "local-real", v.errors.join("; "), "Run `npm run mac:setup`.");
      return { checks, ok: false, lines };
    }
    if (v.config.host !== "127.0.0.1" && v.config.host !== "localhost") {
      checks.fail("remote.host", G, `GATEWAY_HOST=${v.config.host} (must be 127.0.0.1 so only the tunnel can reach it)`, "local-real", "A non-loopback bind would also expose the gateway on your LAN.", "Set GATEWAY_HOST=127.0.0.1 in gateway/.env and restart.");
      return { checks, ok: false, lines };
    }
    const activeInference = new KeyStore(ctx.paths.keysFile).list().filter((k) => !k.revokedAt && k.scopes.includes("inference"));
    if (!activeInference.length) {
      checks.fail("remote.keys", G, "No active inference API key exists", "local-real", "Exposing the gateway without any key is pointless and risky.", "npm run mac:setup");
      return { checks, ok: false, lines };
    }
    checks.pass("remote.config", G, "Config valid, gateway bound to loopback, an inference key exists", "local-real");
    if (!(await isHealthy(gatewayBaseUrl(ctx.paths), 1500, ctx.fetchImpl))) {
      checks.notRun("remote.gateway", G, "Gateway is not running locally", "gateway-running", "Start it before exposing it.", "npm run mac:start");
      return { checks, ok: false, lines };
    }
  }

  lines.push(
    mode === "public"
      ? "PUBLIC: this makes ONLY the gateway reachable from the internet over HTTPS. Requests still need an API key; rate/size/concurrency limits apply. The model server stays on localhost."
      : mode === "private"
        ? "PRIVATE: this makes only the gateway reachable by devices on your tailnet over HTTPS. Not public."
        : "OFF: this clears the Tailscale serve/funnel configuration for this device.",
    `Command: ${human}`,
  );
  if (!opts.apply) {
    lines.push("Dry run — nothing was changed. Add --apply to run the command above.");
    return { checks, ok: true, lines };
  }
  const r = await ctx.exec(ts.bin!, cmd, { timeoutMs: 60_000 });
  if (r.code !== 0) {
    checks.fail("remote.apply", G, `${human} failed`, "local-real", (r.stderr || r.stdout).trim().split("\n").slice(-4).join(" | "), mode === "public" ? "Funnel must be enabled for this device in the Tailscale admin console (ACL `funnel` attribute) and HTTPS certificates enabled." : "Check `tailscale status` and that HTTPS is enabled for your tailnet.");
    return { checks, ok: false, lines };
  }
  checks.pass("remote.apply", G, `Ran: ${human}`, "local-real");
  if (mode !== "off") {
    const url = ts.dnsName ? `https://${ts.dnsName}` : null;
    lines.push(url ? `Gateway URL: ${url}` : "Run `tailscale serve status` to see the URL.");
    if (url) lines.push(`Verify before sharing: npm run mac:remote -- verify ${url}${mode === "public" ? " --burst" : ""}   (DNS/certificate can take a few minutes the first time)`);
  }
  return { checks, ok: true, lines };
}

/** Verifies a reachable gateway URL is safe to hand out. Network checks are tagged remote-real. */
export async function verifyRemote(ctx: Ctx, rawUrl: string, opts: { smokeKey?: string | null; burst?: boolean } = {}): Promise<Checks> {
  const checks = new ChecksImpl();
  const f = ctx.fetchImpl ?? fetch;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    checks.fail("rv.url", G, "Not a valid URL", "remote-real", "Pass the full gateway URL, e.g. https://<mac>.<tailnet>.ts.net", "npm run mac:remote -- verify https://…");
    return checks;
  }
  const origin = u.origin;
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol === "https:") checks.pass("rv.https", G, "URL uses HTTPS", "remote-real");
  else if (loopback) checks.warn("rv.https", G, "Plain HTTP on loopback (fine for local tests, not for sharing)", "remote-real", "Remote clients need HTTPS.");
  else checks.fail("rv.https", G, "Remote URL is not HTTPS", "remote-real", "API keys would travel in clear text.", "Expose the gateway through a TLS tunnel (Tailscale Serve/Funnel or Cloudflare Tunnel).");

  const get = async (path: string, init: RequestInit = {}) => {
    try {
      return await f(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(8000), redirect: "manual" });
    } catch (e) {
      return e as Error;
    }
  };
  const health = await get("/healthz");
  if (health instanceof Error) {
    checks.fail("rv.reach", G, "Gateway not reachable at that URL", "remote-real", health.name === "TimeoutError" ? "Timed out." : "Connection or TLS error.", "Check the tunnel (`tailscale serve status`), DNS, and that `npm run mac:start` is running.");
    return checks;
  }
  if (health.status === 200) checks.pass("rv.health", G, u.protocol === "https:" ? "GET /healthz → 200 (TLS certificate accepted)" : "GET /healthz → 200 (plain HTTP, no TLS involved)", "remote-real");
  else checks.fail("rv.health", G, `GET /healthz → ${health.status}`, "remote-real", "Something other than the gateway may be answering.", "Check what the tunnel points at.");

  const ready = await get("/readyz");
  if (!(ready instanceof Error)) {
    if (ready.status === 200) checks.pass("rv.ready", G, "GET /readyz → ready (model reachable)", "remote-real");
    else checks.warn("rv.ready", G, `GET /readyz → ${ready.status}`, "remote-real", "Model server not ready.", "`npm run mac:doctor`");
  }

  const status = async (path: string, init: RequestInit) => {
    const r = await get(path, init);
    return r instanceof Error ? -1 : r.status;
  };
  const post = (key: string | null, body: string) => ({ method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body });
  const noKey = await status("/v1/chat/completions", post(null, "{}"));
  if (noKey === 401) checks.pass("rv.auth-none", G, "Chat without a key → 401", "remote-real");
  else checks.fail("rv.auth-none", G, `Chat without a key → ${noKey} (expected 401)`, "remote-real", "The endpoint is not protected.", "Do not share this URL until fixed.");
  const badKey = await status("/v1/chat/completions", post("crwa_deadbeef_" + "A".repeat(43), "{}"));
  if (badKey === 401) checks.pass("rv.auth-bad", G, "Chat with an invalid key → 401", "remote-real");
  else checks.fail("rv.auth-bad", G, `Chat with an invalid key → ${badKey} (expected 401)`, "remote-real", "Authentication is not enforced.", "Do not share this URL until fixed.");
  const usageNoKey = await status("/v1/usage/summary", { method: "GET" });
  if (usageNoKey === 401) checks.pass("rv.usage-private", G, "Usage summary without a key → 401", "remote-real");
  else checks.fail("rv.usage-private", G, `Usage summary without a key → ${usageNoKey} (expected 401)`, "remote-real", "Usage data is exposed.", "Do not share this URL until fixed.");

  // The raw model-server port must not be reachable on the same host.
  if (!loopback) {
    const raw = await Promise.all([11434, 1234, 8080].map(async (port) => {
      try {
        const r = await f(`http://${u.hostname}:${port}/v1/models`, { signal: AbortSignal.timeout(3000) });
        return r.ok ? port : null;
      } catch {
        return null;
      }
    }));
    const open = raw.filter((p): p is number => p !== null);
    if (open.length) checks.fail("rv.raw-port", G, `Model server port(s) ${open.join(", ")} answer on the same host`, "remote-real", "The raw model server is exposed.", "Bind the model server to 127.0.0.1 (Ollama: unset OLLAMA_HOST=0.0.0.0) and stop any port forwarding.");
    else checks.pass("rv.raw-port", G, "Raw model-server ports 11434/1234/8080 are not reachable on that host", "remote-real", "Only these three common ports were probed.");
  }

  if (!opts.smokeKey) {
    checks.notRun("rv.limits", G, "Request-size and rate-limit checks", "gateway-running", "Need an inference key (the local smoke-test key from `mac:setup`).", "Run this on the Mac mini after `npm run mac:setup`.");
    return checks;
  }
  const big = await status("/v1/chat/completions", post(opts.smokeKey, JSON.stringify({ messages: [{ role: "user", content: "x".repeat(300_000) }] })));
  if (big === 413) checks.pass("rv.size", G, "Oversized request → 413", "remote-real");
  else checks.warn("rv.size", G, `300 KB request → ${big} (expected 413)`, "remote-real", "MAX_BODY_BYTES may be set above 300 KB, or a proxy intervened.", "Check MAX_BODY_BYTES in gateway/.env.");
  if (!opts.burst) checks.notRun("rv.rate", G, "Rate-limit burst test", "gateway-running", "Skipped (it consumes the smoke key's per-minute budget).", "Add --burst to run it.");
  else {
    let limited = 0;
    for (let i = 1; i <= 70 && !limited; i++) {
      if ((await status("/v1/chat/completions", post(opts.smokeKey, "{}"))) === 429) limited = i;
    }
    if (limited) checks.pass("rv.rate", G, `Rate limit enforced: 429 on burst request #${limited}`, "remote-real", "Probe requests used an empty body, so the model was not invoked.");
    else checks.warn("rv.rate", G, "No 429 within 70 requests", "remote-real", "The per-key limit may exceed 70/min.", "Lower RATE_LIMIT_PER_MINUTE if the demo is public.");
  }
  return checks;
}
