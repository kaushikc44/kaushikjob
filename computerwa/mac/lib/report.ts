/**
 * Check/report model. Every check says WHERE it ran, so a pass on a mock or
 * in a sandbox is never mistaken for a pass on the real Mac mini.
 *
 *  environment:
 *    "mock"        ran against an in-process mock model server
 *    "local-real"  ran on this machine against real local files/services
 *    "remote-real" ran over the network against a real remote URL (tunnel / deployed app)
 *    "not-run"     could not run here; `requires` says what is needed
 */
export type Status = "pass" | "fail" | "warn" | "not_run";
export type Environment = "mock" | "local-real" | "remote-real" | "not-run";
export type Requires = "physical-mac" | "model-runtime" | "gateway-running" | "tunnel-auth" | "vercel" | "devnet-wallet" | "app-running" | "app-build";

export interface Check {
  id: string;
  group: string;
  title: string;
  status: Status;
  environment: Environment;
  requires?: Requires;
  detail?: string;
  /** Exact next action when the check did not pass. */
  fix?: string;
}

export interface Report {
  tool: "computerwa-mac";
  command: string;
  generatedAt: string;
  platform: { os: string; arch: string; node: string };
  summary: { pass: number; fail: number; warn: number; notRun: number; ranMock: number; ranLocalReal: number; ranRemoteReal: number };
  checks: Check[];
}

export class Checks {
  readonly list: Check[] = [];
  add(c: Check): Check {
    this.list.push(c);
    return c;
  }
  pass(id: string, group: string, title: string, environment: Environment, detail?: string) {
    return this.add({ id, group, title, status: "pass", environment, detail });
  }
  fail(id: string, group: string, title: string, environment: Environment, detail: string, fix?: string) {
    return this.add({ id, group, title, status: "fail", environment, detail, fix });
  }
  warn(id: string, group: string, title: string, environment: Environment, detail: string, fix?: string) {
    return this.add({ id, group, title, status: "warn", environment, detail, fix });
  }
  notRun(id: string, group: string, title: string, requires: Requires, detail: string, fix?: string) {
    return this.add({ id, group, title, status: "not_run", environment: "not-run", requires, detail, fix });
  }
}

export function buildReport(command: string, checks: Check[], now = new Date()): Report {
  const count = (s: Status) => checks.filter((c) => c.status === s).length;
  return {
    tool: "computerwa-mac",
    command,
    generatedAt: now.toISOString(),
    platform: { os: process.platform, arch: process.arch, node: process.version },
    summary: {
      pass: count("pass"),
      fail: count("fail"),
      warn: count("warn"),
      notRun: count("not_run"),
      ranMock: checks.filter((c) => c.environment === "mock" && c.status !== "not_run").length,
      ranLocalReal: checks.filter((c) => c.environment === "local-real" && c.status !== "not_run").length,
      ranRemoteReal: checks.filter((c) => c.environment === "remote-real" && c.status !== "not_run").length,
    },
    checks,
  };
}

const ICON: Record<Status, string> = { pass: "✔", fail: "✘", warn: "▲", not_run: "○" };
const ENV_LABEL: Record<Environment, string> = { mock: "MOCK", "local-real": "LOCAL", "remote-real": "REMOTE", "not-run": "NOT RUN" };

export function formatReport(r: Report): string {
  const lines: string[] = [];
  let group = "";
  for (const c of r.checks) {
    if (c.group !== group) {
      group = c.group;
      lines.push("", `── ${group}`);
    }
    const where = c.status === "not_run" ? `NOT RUN · needs ${c.requires}` : ENV_LABEL[c.environment];
    lines.push(`  ${ICON[c.status]} ${c.title}  [${where}]`);
    if (c.detail) lines.push(`      ${c.detail}`);
    if (c.fix && c.status !== "pass") lines.push(`      → ${c.fix}`);
  }
  const s = r.summary;
  lines.push(
    "",
    `Result: ${s.pass} passed · ${s.fail} failed · ${s.warn} warnings · ${s.notRun} not run`,
    `Evidence: ${s.ranLocalReal} checks ran against this machine's real services/files, ${s.ranRemoteReal} over the network against a real URL, ${s.ranMock} against a mock model server (mock results say nothing about the real model).`,
  );
  if (s.notRun) lines.push("Checks marked NOT RUN have not been verified: they need the physical Mac mini, a tunnel login, Vercel or a devnet wallet.");
  return lines.join("\n");
}
