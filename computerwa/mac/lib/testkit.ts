/** Shared helpers for the mac tooling tests (not collected as a test file). */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "./ctx";
import type { Exec, ExecResult } from "./exec";
import { resolvePaths } from "./paths";

const REAL_APP = process.cwd(); // vitest runs from computerwa/

export function makeAppDir() {
  const dir = mkdtempSync(join(tmpdir(), "crwa-mac-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "computerwa" }));
  mkdirSync(join(dir, "gateway"), { recursive: true });
  copyFileSync(join(REAL_APP, "gateway", ".env.example"), join(dir, "gateway", ".env.example"));
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(dir, "node_modules", ".bin", "tsx"), "");
  mkdirSync(join(dir, "node_modules", "next"), { recursive: true });
  return { dir, home: join(dir, "home"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface MockModel {
  url: string; // .../v1
  port: number;
  chatCalls: number;
  lastBody: string;
  close: () => void;
}

export async function startMockModel(opts: { models?: string[]; usage?: boolean; content?: string } = {}): Promise<MockModel> {
  const models = opts.models ?? ["gemma4:test"];
  const state = { chatCalls: 0, lastBody: "" };
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/models") return res.end(JSON.stringify({ object: "list", data: models.map((id) => ({ id, object: "model" })) }));
      if (req.url === "/v1/chat/completions") {
        state.chatCalls++;
        state.lastBody = raw;
        return res.end(
          JSON.stringify({
            id: "c1",
            object: "chat.completion",
            model: models[0],
            choices: [{ index: 0, message: { role: "assistant", content: opts.content ?? "pong" }, finish_reason: "stop" }],
            ...(opts.usage === false ? {} : { usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } }),
          }),
        );
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    get chatCalls() {
      return state.chatCalls;
    },
    get lastBody() {
      return state.lastBody;
    },
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  } as MockModel;
}

export async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

export type ExecHandler = (cmd: string, args: string[]) => Partial<ExecResult> | undefined;

/** Records every call; unknown commands behave like "not installed". */
export function fakeExec(handler: ExecHandler = () => undefined): Exec & { calls: { cmd: string; args: string[] }[] } {
  const calls: { cmd: string; args: string[] }[] = [];
  const fn = (async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const handled = handler(cmd, args);
    if (handled) return { code: 0, stdout: "", stderr: "", ...handled } as ExecResult;
    if (cmd === "npm") return { code: 0, stdout: "10.9.0\n", stderr: "" };
    return { code: null, stdout: "", stderr: "", error: "not_found" } as ExecResult;
  }) as Exec & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

export function makeCtx(app: { dir: string; home: string }, over: Partial<Ctx> & { platform?: NodeJS.Platform } = {}): Ctx & { lines: string[] } {
  const lines: string[] = [];
  const platform = over.platform ?? "linux";
  const paths = resolvePaths({ appDir: app.dir, home: app.home, platform, env: { COMPUTERWA_HOME: app.home } });
  return {
    paths,
    exec: over.exec ?? fakeExec(),
    info: over.info ?? { platform, arch: "arm64", nodeVersion: "v22.0.0" },
    env: over.env ?? {},
    fetchImpl: over.fetchImpl,
    out: (l) => lines.push(l),
    prompt: over.prompt,
    lines,
  };
}

/** A configured app dir (real setup flow) with a real in-process gateway on the configured port. */
export async function configuredApp(opts: { startGateway?: boolean; modelContent?: string; usage?: boolean } = {}) {
  const { runSetup } = await import("./setup");
  const { createGateway } = await import("../../gateway/server");
  const { loadConfig } = await import("../../gateway/config");
  const app = makeAppDir();
  const m = await startMockModel({ models: ["gemma4:test"], content: opts.modelContent, usage: opts.usage });
  const port = await freePort();
  const ctx = makeCtx(app, { env: {} });
  mkdirSync(join(app.dir, "gateway"), { recursive: true });
  writeFileSync(ctx.paths.gatewayEnv, `GATEWAY_PORT=${port}\n`);
  const res = await runSetup(ctx, { upstreamUrl: m.url, fillMissing: true, skipSmoke: true });
  if (!res.ok) throw new Error("setup failed in testkit");
  const closers: (() => void)[] = [m.close];
  if (opts.startGateway !== false) {
    const gw = createGateway(
      loadConfig({ UPSTREAM_BASE_URL: m.url, UPSTREAM_MODEL: "gemma4:test", PUBLIC_MODEL_ID: "gemma-4", GATEWAY_KEYS_FILE: ctx.paths.keysFile, GATEWAY_LEDGER_FILE: ctx.paths.ledgerFile }),
      () => {},
    );
    await new Promise<void>((r) => gw.server.listen(port, "127.0.0.1", r));
    closers.push(() => {
      gw.server.closeAllConnections();
      gw.server.close();
    });
  }
  return { app, ctx, m, port, close: () => { closers.forEach((c) => c()); app.cleanup(); } };
}
