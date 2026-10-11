import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KeyStore } from "../../gateway/keys";
import { vercelPreflight } from "./vercel";
import { makeAppDir, makeCtx } from "./testkit";
import type { Check } from "./report";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const st = (l: Check[], id: string) => l.find((c) => c.id === id)?.status;

function app(env: Record<string, string>, opts: { fetchImpl?: typeof fetch; scopes?: ("inference" | "usage:read")[] } = {}) {
  const a = makeAppDir();
  cleanups.push(a.cleanup);
  const ctx = makeCtx(a, { env, fetchImpl: opts.fetchImpl });
  mkdirSync(join(a.dir, "gateway-data"), { recursive: true });
  const { key } = new KeyStore(ctx.paths.keysFile).create("dash", opts.scopes ?? ["usage:read"]);
  return { ctx, key };
}
const okFetch = (async (url: string) => (String(url).includes("/healthz") ? new Response("{}") : new Response("{}", { status: 200 }))) as unknown as typeof fetch;
const URL_OK = "https://mini.tail1234.ts.net";

describe("mac:vercel preflight", () => {
  it("passes a correct setup, checks the live gateway, and never prints values", async () => {
    const a = app({}, { fetchImpl: okFetch });
    a.ctx.env = { INFERENCE_GATEWAY_URL: URL_OK, INFERENCE_GATEWAY_READ_KEY: a.key };
    const { checks, lines } = await vercelPreflight(a.ctx);
    expect(checks.list.filter((c) => c.status === "fail")).toEqual([]);
    expect(st(checks.list, "vc.read")).toBe("pass");
    expect(st(checks.list, "vc.deployed")).toBe("not_run"); // never claims the Vercel deployment works
    const out = JSON.stringify(checks.list) + lines.join("\n");
    expect(out).not.toContain(a.key);
    expect(out).not.toContain("tail1234");
    expect(lines.join("\n")).toContain("vercel env add INFERENCE_GATEWAY_URL production");
  });

  it("fails missing, malformed and unsafe values", async () => {
    expect(st((await vercelPreflight(app({}).ctx)).checks.list, "vc.url")).toBe("fail");
    expect(st((await vercelPreflight(app({}).ctx)).checks.list, "vc.key")).toBe("fail");
    const a = app({ INFERENCE_GATEWAY_URL: "http://mini.example.com/v1?x=1", INFERENCE_GATEWAY_READ_KEY: "not-a-key" });
    const l = (await vercelPreflight(a.ctx)).checks.list;
    expect(l.find((c) => c.id === "vc.url")?.title).toMatch(/path.*not HTTPS/);
    expect(st(l, "vc.key")).toBe("fail");
    expect(st((await vercelPreflight(app({ INFERENCE_GATEWAY_URL: "https://u:p@x.example.com" }).ctx)).checks.list, "vc.url")).toBe("fail");
  });

  it("localhost is fine for a local target but wrong for Vercel", async () => {
    const a = app({ INFERENCE_GATEWAY_URL: "http://127.0.0.1:8787" });
    a.ctx.env.INFERENCE_GATEWAY_READ_KEY = a.key;
    expect(st((await vercelPreflight(a.ctx)).checks.list, "vc.url")).toBe("fail");
    expect(st((await vercelPreflight(a.ctx, { target: "local" })).checks.list, "vc.url")).toBe("pass");
  });

  it("rejects a dashboard key that can also run inference", async () => {
    const a = app({}, { scopes: ["inference", "usage:read"] });
    a.ctx.env = { INFERENCE_GATEWAY_URL: URL_OK, INFERENCE_GATEWAY_READ_KEY: a.key };
    const l = (await vercelPreflight(a.ctx)).checks.list;
    expect(st(l, "vc.key")).toBe("fail");
    expect(l.find((c) => c.id === "vc.key")?.title).toMatch(/extra scopes/);
  });

  it("fails when gateway data is exposed through NEXT_PUBLIC_*", async () => {
    const a = app({}, { fetchImpl: okFetch });
    a.ctx.env = { INFERENCE_GATEWAY_URL: URL_OK, INFERENCE_GATEWAY_READ_KEY: a.key, NEXT_PUBLIC_INFERENCE_GATEWAY_URL: URL_OK, NEXT_PUBLIC_DEBUG: `k=${a.key}` };
    expect(st((await vercelPreflight(a.ctx)).checks.list, "vc.public")).toBe("fail");
  });

  it("fails mainnet RPC and localnet-on-Vercel; warns on the burner wallet", async () => {
    const m = app({ NEXT_PUBLIC_SOLANA_RPC: "https://api.mainnet-beta.solana.com" });
    expect(st((await vercelPreflight(m.ctx)).checks.list, "vc.solana")).toBe("fail");
    const l = app({ NEXT_PUBLIC_SOLANA_CLUSTER: "localnet", NEXT_PUBLIC_ENABLE_BURNER_WALLET: "true" });
    const res = (await vercelPreflight(l.ctx)).checks.list;
    expect(st(res, "vc.solana")).toBe("fail");
    expect(st(res, "vc.burner")).toBe("warn");
  });

  it("reports an unreachable or rejecting gateway", async () => {
    const a = app({}, { fetchImpl: (async (u: string) => (String(u).includes("healthz") ? new Response("{}") : new Response("{}", { status: 401 }))) as unknown as typeof fetch });
    a.ctx.env = { INFERENCE_GATEWAY_URL: URL_OK, INFERENCE_GATEWAY_READ_KEY: a.key };
    expect(st((await vercelPreflight(a.ctx)).checks.list, "vc.read")).toBe("fail");
    const b = app({}, { fetchImpl: (async () => { throw new Error("down"); }) as unknown as typeof fetch });
    b.ctx.env = { INFERENCE_GATEWAY_URL: URL_OK, INFERENCE_GATEWAY_READ_KEY: b.key };
    expect(st((await vercelPreflight(b.ctx)).checks.list, "vc.reach")).toBe("fail");
  });

  it("reads an --env-file (e.g. from `vercel env pull`) instead of .env.local", async () => {
    const a = app({});
    const f = join(a.ctx.paths.appDir, ".env.vercel");
    writeFileSync(f, `INFERENCE_GATEWAY_URL=${URL_OK}\nINFERENCE_GATEWAY_READ_KEY=${a.key}\n`);
    a.ctx.fetchImpl = okFetch;
    expect(st((await vercelPreflight(a.ctx, { envFile: f })).checks.list, "vc.read")).toBe("pass");
  });
});
