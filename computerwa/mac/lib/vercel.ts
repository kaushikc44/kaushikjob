/**
 * Preflight for the server-side environment the dashboard needs on Vercel.
 * Reads values but never prints them, and never contacts the Vercel API or
 * changes any environment variable.
 */
import { existsSync } from "node:fs";
import type { Ctx } from "./ctx";
import { readEnvFile, type EnvMap } from "./dotenv";
import { scopesOfKey } from "./keysetup";
import { Checks } from "./report";
import { isLoopbackUrl } from "./runtimes";

const G = "Vercel preflight";
const KEY_RE = /^crwa_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/;

export const VERCEL_VARS = [
  { name: "INFERENCE_GATEWAY_URL", scope: "Production + Preview (server only)", purpose: "HTTPS URL of the gateway (Tailscale Funnel / tunnel hostname). Origin only, no path, no credentials." },
  { name: "INFERENCE_GATEWAY_READ_KEY", scope: "Production + Preview (server only, mark Sensitive)", purpose: "Gateway key with ONLY the usage:read scope; used by /api/inference." },
  { name: "NEXT_PUBLIC_SOLANA_RPC", scope: "All (public)", purpose: "Devnet RPC URL (default https://api.devnet.solana.com). Must not be mainnet." },
  { name: "NEXT_PUBLIC_SOLANA_CLUSTER", scope: "All (public)", purpose: "`devnet`." },
];

export interface VercelOptions {
  target?: "vercel" | "local";
  envFile?: string;
}

export async function vercelPreflight(ctx: Ctx, opts: VercelOptions = {}): Promise<{ checks: Checks; lines: string[] }> {
  const checks = new Checks();
  const target = opts.target ?? "vercel";
  const fileEnv: EnvMap = readEnvFile(opts.envFile ?? ctx.paths.envLocal);
  const env = (k: string) => ctx.env[k] ?? fileEnv[k];
  const src = opts.envFile ? `env file ${opts.envFile}` : ".env.local + process environment";
  const f = ctx.fetchImpl ?? fetch;

  const urlRaw = env("INFERENCE_GATEWAY_URL");
  let url: URL | null = null;
  if (!urlRaw) checks.fail("vc.url", G, "INFERENCE_GATEWAY_URL is not set", "local-real", `Checked ${src}.`, "Set it to the gateway's HTTPS URL (see the commands below).");
  else {
    try {
      url = new URL(urlRaw);
    } catch {
      checks.fail("vc.url", G, "INFERENCE_GATEWAY_URL is not a valid URL", "local-real", "(value not shown)", "Use e.g. https://<mac>.<tailnet>.ts.net");
    }
  }
  if (url) {
    const problems: string[] = [];
    const loop = isLoopbackUrl(url.href);
    if (url.username || url.password) problems.push("contains credentials");
    if (url.pathname !== "/" || url.search || url.hash) problems.push("has a path/query (use the origin only)");
    if (url.protocol !== "https:" && !(loop && target === "local")) problems.push("is not HTTPS");
    if (loop && target === "vercel") problems.push("points at localhost, which on Vercel is Vercel's own server, not your Mac");
    if (problems.length) checks.fail("vc.url", G, `INFERENCE_GATEWAY_URL ${problems.join("; ")}`, "local-real", "(value not shown)", "Set the public/tailnet HTTPS origin of the gateway.");
    else checks.pass("vc.url", G, `INFERENCE_GATEWAY_URL set (${url.protocol.replace(":", "")}, host hidden)`, "local-real");
  }

  const key = env("INFERENCE_GATEWAY_READ_KEY");
  if (!key) checks.fail("vc.key", G, "INFERENCE_GATEWAY_READ_KEY is not set", "local-real", `Checked ${src}.`, "Create one: `npm run mac:setup` (writes it to .env.local), then copy it to Vercel without printing it.");
  else if (!KEY_RE.test(key)) checks.fail("vc.key", G, "INFERENCE_GATEWAY_READ_KEY does not look like a gateway key", "local-real", "(value not shown)", "Keys look like crwa_<8 hex>_<43 chars>.");
  else {
    const scopes = existsSync(ctx.paths.keysFile) ? scopesOfKey(ctx.paths.keysFile, key) : null;
    if (scopes === null) checks.warn("vc.key", G, "Read key format OK; its scopes could not be checked against a local keys file", "local-real", "keys.json has no active key with that id (the key may belong to another gateway).", "Run this on the Mac mini, or check the live test below.");
    else if (scopes.length === 1 && scopes[0] === "usage:read") checks.pass("vc.key", G, "INFERENCE_GATEWAY_READ_KEY set and limited to usage:read", "local-real");
    else checks.fail("vc.key", G, `Dashboard key has extra scopes (${scopes.join(", ")})`, "local-real", "A dashboard secret must not be able to run inference.", "Create a usage:read-only key: `npm run gateway:keys -- create dashboard --scopes usage:read`.");
  }

  // Secrets must never be NEXT_PUBLIC_*
  const all: Record<string, string | undefined> = { ...fileEnv, ...ctx.env };
  const leakyNames = Object.keys(all).filter((n) => n.startsWith("NEXT_PUBLIC_") && /GATEWAY|INFERENCE|READ_KEY|SECRET|PRIVATE/i.test(n));
  const leakyValues = Object.entries(all).filter(([n, v]) => n.startsWith("NEXT_PUBLIC_") && v && ((key && v.includes(key)) || (url && v.includes(url.host))));
  if (leakyNames.length || leakyValues.length) checks.fail("vc.public", G, `Gateway/secret data is in public (NEXT_PUBLIC_*) variables: ${[...leakyNames, ...leakyValues.map(([n]) => n)].join(", ")}`, "local-real", "NEXT_PUBLIC_ values are embedded in browser bundles.", "Remove them; use only INFERENCE_GATEWAY_URL / INFERENCE_GATEWAY_READ_KEY.");
  else checks.pass("vc.public", G, "No gateway URL or key in NEXT_PUBLIC_* variables", "local-real");

  const rpc = env("NEXT_PUBLIC_SOLANA_RPC");
  const cluster = env("NEXT_PUBLIC_SOLANA_CLUSTER") ?? "devnet";
  if (rpc && /mainnet/i.test(rpc)) checks.fail("vc.solana", G, "NEXT_PUBLIC_SOLANA_RPC looks like mainnet", "local-real", "(value not shown) The app refuses mainnet at runtime.", "Use a devnet RPC.");
  else if (target === "vercel" && cluster === "localnet") checks.fail("vc.solana", G, "NEXT_PUBLIC_SOLANA_CLUSTER=localnet on a Vercel target", "local-real", "localnet only exists on your own machine.", "Set NEXT_PUBLIC_SOLANA_CLUSTER=devnet (or unset it).");
  else checks.pass("vc.solana", G, `Solana configured for ${cluster}${rpc ? " with a custom RPC" : " (default devnet RPC)"}`, "local-real", "Mainnet is rejected by the app regardless.");
  if (env("NEXT_PUBLIC_ENABLE_BURNER_WALLET") === "true") {
    if (target === "vercel") checks.warn("vc.burner", G, "NEXT_PUBLIC_ENABLE_BURNER_WALLET=true", "local-real", "Fine for a clearly-labelled demo; it adds an in-memory throwaway wallet to the public site.", "Unset it for a public deployment unless intended.");
  }

  // Live reachability of the configured gateway (read-only requests)
  if (url && key && KEY_RE.test(key) && !isLoopbackUrl(url.href)) {
    try {
      const h = await f(`${url.origin}/healthz`, { signal: AbortSignal.timeout(8000) });
      if (h.ok) checks.pass("vc.reach", G, "Gateway reachable from this machine", "remote-real");
      else checks.fail("vc.reach", G, `Gateway /healthz → ${h.status}`, "remote-real", "Wrong URL, or something else is answering.", "Check the tunnel with `npm run mac:remote`.");
      const s = await f(`${url.origin}/v1/usage/summary?days=1`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
      if (s.ok) checks.pass("vc.read", G, "Read key accepted by the gateway (usage summary → 200)", "remote-real");
      else checks.fail("vc.read", G, `Usage summary with this key → ${s.status}`, "remote-real", s.status === 401 || s.status === 403 ? "Key rejected or lacks usage:read." : "Gateway error.", "Create/copy a valid usage:read key.");
    } catch {
      checks.fail("vc.reach", G, "Gateway not reachable from this machine", "remote-real", "Timed out or TLS error.", "Start the tunnel: `npm run mac:remote -- public --apply`, then retry.");
    }
  } else if (url && isLoopbackUrl(url.href)) {
    checks.notRun("vc.reach", G, "Reachability of the public gateway URL", "tunnel-auth", "URL is loopback; a tunnel is needed for Vercel.", "npm run mac:remote -- public --apply");
  }

  checks.notRun("vc.deployed", G, "Deployed dashboard connectivity (/api/inference on Vercel)", "vercel", "This tool never deploys or edits Vercel settings.", "After you deploy: curl -s https://<your-app>/api/inference?days=1 | head -c 300   (expect \"health\":\"online\")");

  const lines = [
    "",
    "Variables for Vercel → Project → Settings → Environment Variables (Production and Preview):",
    ...VERCEL_VARS.map((v) => `  • ${v.name}  [${v.scope}]\n      ${v.purpose}`),
    "",
    "Set them (values are prompted, never put on the command line):",
    "  vercel env add INFERENCE_GATEWAY_URL production",
    "  vercel env add INFERENCE_GATEWAY_READ_KEY production --sensitive   # flag names vary by CLI version: check `vercel env add --help`",
    "  (repeat for `preview`, then redeploy; env changes apply to new deployments only)",
    "Copy the read key without displaying it (macOS):",
    "  grep '^INFERENCE_GATEWAY_READ_KEY=' .env.local | cut -d= -f2- | pbcopy",
  ];
  return { checks, lines };
}
