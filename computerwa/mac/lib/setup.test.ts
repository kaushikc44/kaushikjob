import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseEnv } from "./dotenv";
import { runSetup } from "./setup";
import { buildReport } from "./report";
import { redactDeep } from "./redact";
import { fakeExec, makeAppDir, makeCtx, startMockModel, type MockModel } from "./testkit";

const apps: ReturnType<typeof makeAppDir>[] = [];
const mocks: MockModel[] = [];
afterEach(() => {
  apps.splice(0).forEach((a) => a.cleanup());
  mocks.splice(0).forEach((m) => m.close());
});
async function env(models: string[], usage = true) {
  const app = makeAppDir();
  apps.push(app);
  const m = await startMockModel({ models, usage });
  mocks.push(m);
  return { app, m };
}
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const byId = (r: Awaited<ReturnType<typeof runSetup>>, id: string) => r.checks.list.find((c) => c.id === id);

describe("mac:setup", () => {
  it("refuses to guess when no model server is reachable and writes nothing", async () => {
    const app = makeAppDir();
    apps.push(app);
    const ctx = makeCtx(app);
    const r = await runSetup(ctx, { upstreamUrl: "http://127.0.0.1:9/v1" });
    expect(r.ok).toBe(false);
    expect(byId(r, "setup.runtime")?.status).toBe("fail");
    expect(r.next.join("\n")).toMatch(/will not install system software/);
    expect(existsSync(ctx.paths.gatewayEnv) || existsSync(ctx.paths.keysFile)).toBe(false);
  });

  it("with no Gemma 4 installed it fails with install guidance, downloads nothing and writes nothing", async () => {
    const { app, m } = await env(["llama3.1:8b", "gemma3:4b"]);
    const exec = fakeExec((cmd) => (cmd === "ollama" ? { code: 0, stdout: "ollama 0.1\n", stderr: "" } : undefined));
    const ctx = makeCtx(app, { exec });
    const r = await runSetup(ctx, { upstreamUrl: m.url });
    expect(r.ok).toBe(false);
    expect(byId(r, "setup.model")?.detail).toMatch(/other Gemma versions: gemma3:4b/);
    expect(r.next.join("\n")).toContain("ollama pull <tag>");
    expect(exec.calls.some((c) => c.args.includes("pull"))).toBe(false);
    expect(existsSync(ctx.paths.gatewayEnv)).toBe(false);
  });

  it("configures a detected Gemma 4 model, creates keys, runs a real smoke test and leaks no secrets", async () => {
    const { app, m } = await env(["llama3.1:8b", "gemma4:12b"]);
    const ctx = makeCtx(app);
    const r = await runSetup(ctx, { upstreamUrl: m.url });
    expect(r.ok).toBe(true);
    expect(r.selected).toMatchObject({ model: "gemma4:12b", publicModelId: "gemma-4", baseUrl: m.url });
    const env1 = parseEnv(readFileSync(ctx.paths.gatewayEnv, "utf8"));
    expect(env1).toMatchObject({ UPSTREAM_MODEL: "gemma4:12b", PUBLIC_MODEL_ID: "gemma-4", UPSTREAM_BASE_URL: m.url, GATEWAY_HOST: "127.0.0.1", COST_BASIS: "placeholder" });
    expect(env1.COST_NOTE).toMatch(/PLACEHOLDER/);
    expect(statSync(ctx.paths.gatewayEnv).mode & 0o777).toBe(0o600);
    expect(byId(r, "setup.smoke")?.status).toBe("pass");
    expect(m.chatCalls).toBe(1);
    expect(byId(r, "setup.cost")?.status).toBe("warn"); // placeholders flagged
    // keys exist, secrets are private, nothing secret in the report
    expect(existsSync(ctx.paths.keysFile)).toBe(true);
    const smokeKey = JSON.parse(readFileSync(ctx.paths.localSecrets, "utf8")).smokeKey as string;
    const readKey = parseEnv(readFileSync(ctx.paths.envLocal, "utf8")).INFERENCE_GATEWAY_READ_KEY;
    const report = JSON.stringify(redactDeep(buildReport("mac:setup", r.checks.list)));
    expect(report).not.toContain(smokeKey);
    expect(report).not.toContain(readKey);
    expect(ctx.lines.join("\n")).not.toContain(readKey);
    // the throwaway smoke gateway must not pollute the production ledger
    expect(existsSync(ctx.paths.ledgerFile)).toBe(false);
  });

  it("is idempotent: a second run changes no file", async () => {
    const { app, m } = await env(["gemma4:12b"]);
    const ctx = makeCtx(app);
    await runSetup(ctx, { upstreamUrl: m.url });
    const files = [ctx.paths.gatewayEnv, ctx.paths.keysFile, ctx.paths.localSecrets, ctx.paths.envLocal];
    const before = files.map(sha);
    const r2 = await runSetup(ctx, {});
    expect(r2.ok).toBe(true);
    expect(files.map(sha)).toEqual(before);
  });

  it("does not label a non-Gemma-4 model as gemma-4", async () => {
    const { app, m } = await env(["mistral:7b"]);
    const ctx = makeCtx(app);
    const r = await runSetup(ctx, { upstreamUrl: m.url, model: "mistral:7b" });
    expect(r.ok).toBe(true);
    expect(byId(r, "setup.gemma4")?.status).toBe("warn");
    expect(parseEnv(readFileSync(ctx.paths.gatewayEnv, "utf8")).PUBLIC_MODEL_ID).toBe("mistral:7b");
  });

  it("rejects an explicit --model the server does not list", async () => {
    const { app, m } = await env(["gemma4:12b"]);
    const r = await runSetup(makeCtx(app), { upstreamUrl: m.url, model: "gemma4:99b" });
    expect(byId(r, "setup.model")).toMatchObject({ status: "fail" });
    expect(byId(r, "setup.model")?.detail).toContain("gemma4:12b");
  });

  it("never overwrites an existing gateway/.env; --fill-missing fills only empty values", async () => {
    const { app, m } = await env(["gemma4:12b"]);
    const ctx = makeCtx(app);
    const mine = `GATEWAY_PORT=9999\nUPSTREAM_BASE_URL=${m.url}\nUPSTREAM_MODEL=\nPUBLIC_MODEL_ID=my-label\nRATE_LIMIT_PER_MINUTE=5\n`;
    require("node:fs").mkdirSync(join(app.dir, "gateway"), { recursive: true });
    writeFileSync(ctx.paths.gatewayEnv, mine);
    const r1 = await runSetup(ctx, { skipSmoke: true });
    expect(readFileSync(ctx.paths.gatewayEnv, "utf8")).toBe(mine); // untouched without approval
    expect(byId(r1, "setup.env-write")?.status).toBe("warn");
    const r2 = await runSetup(ctx, { fillMissing: true, skipSmoke: true });
    const after = parseEnv(readFileSync(ctx.paths.gatewayEnv, "utf8"));
    expect(after).toMatchObject({ GATEWAY_PORT: "9999", PUBLIC_MODEL_ID: "my-label", RATE_LIMIT_PER_MINUTE: "5", UPSTREAM_MODEL: "gemma4:12b" });
    expect(byId(r2, "setup.env-write")?.status).toBe("pass");
  });

  it("refuses to choose between several Gemma 4 models unless told", async () => {
    const { app, m } = await env(["gemma4:4b", "gemma4:12b"]);
    const noPrompt = await runSetup(makeCtx(app), { upstreamUrl: m.url });
    expect(noPrompt.ok).toBe(false);
    expect(byId(noPrompt, "setup.model")?.title).toMatch(/refusing to guess/);
    const picked = await runSetup(makeCtx(app, { prompt: { choose: async (_q, o) => o[1] } }), { upstreamUrl: m.url, skipSmoke: true });
    expect(picked.selected?.model).toBe("gemma4:12b");
    // --yes means non-interactive: even with a prompter it must not guess
    const yes = await runSetup(makeCtx(makeAppDirTracked(), { prompt: { choose: async (_q, o) => o[0] } }), { upstreamUrl: m.url, yes: true });
    expect(yes.ok).toBe(false);
  });

  it("--pull is the only way a download happens, validates the tag, and verifies afterwards", async () => {
    const { app, m } = await env(["gemma4:12b"]);
    const pulls = () => exec.calls.filter((c) => c.args[0] === "pull");
    const exec = fakeExec((cmd, args) => (cmd === "ollama" ? { code: 0, stdout: "ollama 0.1\n", stderr: "" } : undefined));
    await runSetup(makeCtx(app, { exec }), { upstreamUrl: m.url, skipSmoke: true });
    expect(pulls()).toHaveLength(0);
    const bad = await runSetup(makeCtx(app, { exec }), { upstreamUrl: m.url, pull: "x; rm -rf /" });
    expect(bad.ok).toBe(false);
    expect(pulls()).toHaveLength(0);
    const ok = makeCtx(app, { exec });
    await runSetup(ok, { upstreamUrl: m.url, pull: "gemma4:12b", skipSmoke: true });
    expect(pulls().map((c) => c.args)).toEqual([["pull", "gemma4:12b"]]);
    expect(ok.lines.join("\n")).toMatch(/size .*NOT checked/);
    const noCli = await runSetup(makeCtx(app, { exec: fakeExec() }), { upstreamUrl: m.url, pull: "gemma4:12b" });
    expect(byId(noCli, "setup.pull")).toMatchObject({ status: "fail" });
  });

  it("dry run writes nothing at all", async () => {
    const { app, m } = await env(["gemma4:12b"]);
    const ctx = makeCtx(app);
    const r = await runSetup(ctx, { upstreamUrl: m.url, dryRun: true, skipSmoke: true });
    expect(r.ok).toBe(true);
    expect([ctx.paths.gatewayEnv, ctx.paths.keysFile, ctx.paths.envLocal, ctx.paths.localSecrets].some(existsSync)).toBe(false);
  });

  it("reports a failing smoke test with an actionable fix (model returns nothing)", async () => {
    const app = makeAppDir();
    apps.push(app);
    const m = await startMockModel({ models: ["gemma4:12b"], content: "   " });
    mocks.push(m);
    const r = await runSetup(makeCtx(app), { upstreamUrl: m.url });
    expect(byId(r, "setup.smoke")).toMatchObject({ status: "fail" });
    expect(byId(r, "setup.smoke")?.fix).toBeTruthy();
    expect(r.ok).toBe(false);
  });
});

function makeAppDirTracked() {
  const a = makeAppDir();
  apps.push(a);
  return a;
}
