/** Dispatcher for the mac:* npm scripts. Usage: tsx mac/cli.ts <command> [flags] */
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { runDoctor } from "./lib/doctor";
import type { Ctx, Prompter } from "./lib/ctx";
import { realExec } from "./lib/exec";
import { runService, type ServiceAction } from "./lib/launchd";
import { assertAppDir, resolvePaths } from "./lib/paths";
import { followFile, gatewayBaseUrl, startGateway, stopGateway, tailFile } from "./lib/proc";
import { buildReport, formatReport, type Report } from "./lib/report";
import { redactDeep } from "./lib/redact";
import { remoteApply, remoteStatus, type RemoteMode, verifyRemote } from "./lib/remote";
import { runSetup } from "./lib/setup";
import { systemInfo } from "./lib/system";
import { runVerify } from "./lib/verify";
import { vercelPreflight } from "./lib/vercel";
import { readLocalSecrets } from "./lib/keysetup";
import { writePrivateFile } from "./lib/dotenv";

const VALUE_FLAGS = new Set(["runtime", "model", "upstream-url", "public-model-id", "pull", "app-url", "target", "env-file", "n"]);

export function parseArgs(argv: string[]): { cmd: string; pos: string[]; flags: Record<string, string | true> } {
  const [cmd = "", ...rest] = argv;
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--") || a === "-n") {
      const name = a.replace(/^-{1,2}/, "");
      if (VALUE_FLAGS.has(name)) {
        const v = rest[i + 1];
        if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value`);
        flags[name] = v;
        i++;
      } else flags[name] = true;
    } else pos.push(a);
  }
  return { cmd, pos, flags };
}

function makePrompter(): Prompter | undefined {
  if (!process.stdin.isTTY) return undefined;
  return {
    async choose(question, options) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        console.log(question);
        options.forEach((o, i) => console.log(`  ${i + 1}) ${o}`));
        const a = (await rl.question("Number (or Enter to cancel): ")).trim();
        const n = Number(a);
        return Number.isInteger(n) && n >= 1 && n <= options.length ? options[n - 1] : null;
      } finally {
        rl.close();
      }
    },
  };
}

function emit(ctx: Ctx, report: Report, flags: Record<string, string | true>, saveAs: string) {
  const file = join(ctx.paths.reportsDir, `${saveAs}-${report.generatedAt.replace(/[:.]/g, "-")}.json`);
  mkdirSync(ctx.paths.reportsDir, { recursive: true });
  writePrivateFile(file, JSON.stringify(report, null, 2) + "\n");
  if (flags.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(formatReport(report));
    console.log(`\nJSON report: ${file}`);
  }
}

export async function main(argv: string[]): Promise<number> {
  const { cmd, pos, flags } = parseArgs(argv);
  const paths = resolvePaths();
  const ctx: Ctx = { paths, exec: realExec, info: systemInfo(), env: process.env, out: (l) => console.log(l), prompt: makePrompter() };
  if (!["", "help"].includes(cmd)) assertAppDir(paths.appDir);
  const failed = (r: Report) => r.summary.fail > 0;

  switch (cmd) {
    case "doctor": {
      const r = await runDoctor(ctx, { skipSelfTest: !!flags["skip-selftest"] });
      emit(ctx, r, flags, "doctor");
      return failed(r) ? 1 : 0;
    }
    case "setup": {
      if (!flags.json) console.log("ComputeRWA Mac setup. Nothing is downloaded, exposed or deployed unless you pass an explicit flag.\n");
      const res = await runSetup(ctx, {
        yes: !!flags.yes,
        dryRun: !!flags["dry-run"],
        fillMissing: !!flags["fill-missing"],
        newDashboardKey: !!flags["new-dashboard-key"],
        runtime: flags.runtime as string | undefined,
        model: flags.model as string | undefined,
        upstreamUrl: flags["upstream-url"] as string | undefined,
        publicModelId: flags["public-model-id"] as string | undefined,
        pull: flags.pull as string | undefined,
        skipSmoke: !!flags["skip-smoke"],
      });
      const r = redactDeep(buildReport("mac:setup", res.checks.list));
      emit(ctx, r, flags, "setup");
      if (!flags.json && res.next.length) console.log("\nNext:\n" + res.next.map((n) => `  ${n}`).join("\n"));
      return res.ok ? 0 : 1;
    }
    case "start": {
      const r = await startGateway(paths);
      console.log(r.message);
      if (r.logTail) console.log(r.logTail);
      return r.ok ? 0 : 1;
    }
    case "stop": {
      const r = await stopGateway(paths);
      console.log(r.message);
      return r.ok ? 0 : 1;
    }
    case "logs": {
      const n = Number(flags.n ?? 50);
      console.log(`# ${paths.gatewayLog} (secrets redacted)`);
      console.log(tailFile(paths.gatewayLog, Number.isInteger(n) && n > 0 ? n : 50));
      if (flags.follow || flags.f) {
        followFile(paths.gatewayLog, (s) => process.stdout.write(s));
        await new Promise(() => {});
      }
      return 0;
    }
    case "verify": {
      const r = await runVerify(ctx, { appUrl: flags["app-url"] as string | undefined, start: !!flags.start, withTests: !!flags["with-tests"], offlineTest: !!flags["offline-test"] });
      emit(ctx, r, flags, "verify");
      return failed(r) ? 1 : 0;
    }
    case "service": {
      const action = (pos[0] ?? "status") as ServiceAction;
      if (!["install", "start", "stop", "status", "remove", "print"].includes(action)) {
        console.log("usage: mac:service -- install | start | stop | status | remove | print");
        return 1;
      }
      const r = await runService(action, { paths, exec: realExec, platform: process.platform, uid: process.getuid?.() ?? -1, nodeBin: process.execPath });
      console.log(r.message);
      if (r.detail) console.log(r.detail);
      if (action === "status" || action === "install") console.log(`Logs: ${paths.gatewayLog}   (npm run mac:logs)`);
      return r.ok ? 0 : 1;
    }
    case "remote": {
      const sub = pos[0] ?? "status";
      if (sub === "status") {
        const r = buildReport("mac:remote status", (await remoteStatus(ctx)).list);
        emit(ctx, r, flags, "remote");
        console.log("\nModes:  npm run mac:remote -- private   (tailnet only)   |   public   (internet, via Funnel)   |   off      [add --apply to execute]");
        return failed(r) ? 1 : 0;
      }
      if (sub === "verify") {
        const url = pos[1] ?? (flags.url as string | undefined);
        if (!url) {
          console.log("usage: mac:remote -- verify <https-gateway-url> [--burst]");
          return 1;
        }
        const checks = await verifyRemote(ctx, url, { smokeKey: readLocalSecrets(paths.localSecrets).smokeKey ?? null, burst: !!flags.burst });
        const r = redactDeep(buildReport("mac:remote verify", checks.list));
        emit(ctx, r, flags, "remote-verify");
        console.log(failed(r) ? "\nNOT safe to share this URL until the failures above are fixed." : "\nNo failures. (Warnings/NOT RUN items above were not verified.)");
        return failed(r) ? 1 : 0;
      }
      if (sub === "private" || sub === "public" || sub === "off") {
        const res = await remoteApply(ctx, sub as RemoteMode, { apply: !!flags.apply });
        for (const l of res.lines) console.log(l);
        console.log(formatReport(buildReport(`mac:remote ${sub}`, res.checks.list)));
        return res.ok ? 0 : 1;
      }
      console.log("usage: mac:remote -- [status | private | public | off | verify <url>] [--apply] [--burst]");
      return 1;
    }
    case "vercel": {
      const res = await vercelPreflight(ctx, { target: flags.target === "local" ? "local" : "vercel", envFile: flags["env-file"] as string | undefined });
      const r = redactDeep(buildReport("mac:vercel", res.checks.list));
      emit(ctx, r, flags, "vercel");
      if (!flags.json) console.log(res.lines.join("\n"));
      return failed(r) ? 1 : 0;
    }
    default:
      console.log(`ComputeRWA Mac tooling\n  npm run mac:setup     detect runtime/model, write config, create keys, smoke-test\n  npm run mac:doctor    diagnostics (+ --json)\n  npm run mac:start | mac:stop | mac:logs\n  npm run mac:verify    real end-to-end check of the running gateway\n  npm run mac:service -- install|start|stop|status|remove|print\n  npm run mac:remote -- status|private|public|off|verify <url>\n  npm run mac:vercel    server-side env preflight for Vercel\nSee docs/mac-mini.md`);
      return cmd === "" || cmd === "help" ? 0 : 1;
  }
}

if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`Error: ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
