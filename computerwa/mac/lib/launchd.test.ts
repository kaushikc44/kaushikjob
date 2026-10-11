import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { buildPlist, runService } from "./launchd";
import { resolvePaths } from "./paths";
import { fakeExec, makeAppDir } from "./testkit";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const apps: ReturnType<typeof makeAppDir>[] = [];
afterEach(() => apps.splice(0).forEach((a) => a.cleanup()));
function mk() {
  const app = makeAppDir();
  apps.push(app);
  const paths = resolvePaths({ appDir: app.dir, home: app.home, platform: "darwin", env: { COMPUTERWA_HOME: app.home } });
  return { app, paths };
}

describe("launchd plist", () => {
  it("is a user agent that restarts on crash, logs outside the repo and contains no secrets", () => {
    const { paths } = mk();
    process.env.INFERENCE_GATEWAY_READ_KEY = "crwa_0123abcd_" + "S".repeat(43);
    const plist = buildPlist({ paths, nodeBin: "/opt/homebrew/bin/node" });
    delete process.env.INFERENCE_GATEWAY_READ_KEY;
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
    expect(plist).toContain("<key>ThrottleInterval</key><integer>15</integer>");
    expect(plist).toContain(paths.gatewayLog);
    expect(plist.includes(paths.appDir + "/gateway-data")).toBe(false);
    expect(plist).not.toContain("S".repeat(43));
    expect(plist).not.toMatch(/UPSTREAM|READ_KEY|crwa_/);
    expect(plist).not.toContain("LaunchDaemons");
    expect(plist).not.toContain("UserName"); // no root/daemon user switching
  });
  it("escapes XML special characters in paths", () => {
    const { paths } = mk();
    expect(buildPlist({ paths: { ...paths, appDir: "/Users/a&b/<x>" }, nodeBin: "/n" })).toContain("/Users/a&amp;b/&lt;x&gt;");
  });
});

describe("mac:service", () => {
  const base = { uid: 501, nodeBin: "/usr/local/bin/node" };

  it("print never writes anything", async () => {
    const { paths } = mk();
    const exec = fakeExec();
    const r = await runService("print", { paths, exec, platform: "linux", ...base });
    expect(r.ok).toBe(true);
    expect(existsSync(paths.launchAgentPlist)).toBe(false);
    expect(exec.calls).toHaveLength(0);
  });

  it("refuses everything else off macOS and as root, changing nothing", async () => {
    const { app, paths } = mk();
    writeFileSync(join(app.dir, "gateway", ".env"), "UPSTREAM_MODEL=x\n");
    const exec = fakeExec();
    const linux = await runService("install", { paths, exec, platform: "linux", ...base });
    expect(linux.ok).toBe(false);
    const root = await runService("install", { paths, exec, platform: "darwin", uid: 0, nodeBin: "/n" });
    expect(root.ok).toBe(false);
    expect(root.message).toMatch(/root/);
    expect(existsSync(paths.launchAgentPlist)).toBe(false);
    expect(exec.calls).toHaveLength(0);
  });

  it("install requires gateway/.env, then writes the plist and bootstraps in the user's gui domain", async () => {
    const { app, paths } = mk();
    const exec = fakeExec((cmd) => (cmd === "launchctl" ? { code: 0, stdout: "", stderr: "" } : undefined));
    expect((await runService("install", { paths, exec, platform: "darwin", ...base })).ok).toBe(false);
    expect(exec.calls).toHaveLength(0);
    writeFileSync(join(app.dir, "gateway", ".env"), "UPSTREAM_MODEL=x\n");
    const r = await runService("install", { paths, exec, platform: "darwin", ...base });
    expect(r.ok).toBe(true);
    expect(readFileSync(paths.launchAgentPlist, "utf8")).toContain("com.computerwa.gateway");
    expect(exec.calls.map((c) => c.args.join(" "))).toEqual(["bootout gui/501/com.computerwa.gateway", `bootstrap gui/501 ${paths.launchAgentPlist}`]);
  });

  it("stop / status / remove use launchctl and remove only deletes the plist", async () => {
    const { app, paths } = mk();
    writeFileSync(join(app.dir, "gateway", ".env"), "UPSTREAM_MODEL=x\n");
    const exec = fakeExec((cmd, args) => (cmd === "launchctl" ? { code: 0, stdout: args[0] === "print" ? "state = running\n pid = 4242\n" : "", stderr: "" } : undefined));
    await runService("install", { paths, exec, platform: "darwin", ...base });
    const st = await runService("status", { paths, exec, platform: "darwin", ...base });
    expect(st.message).toContain("plist installed: yes · loaded: yes · state: running · pid 4242");
    expect((await runService("stop", { paths, exec, platform: "darwin", ...base })).ok).toBe(true);
    expect(existsSync(paths.launchAgentPlist)).toBe(true);
    await runService("remove", { paths, exec, platform: "darwin", ...base });
    expect(existsSync(paths.launchAgentPlist)).toBe(false);
    expect(existsSync(join(app.dir, "gateway", ".env"))).toBe(true); // config untouched
  });

  it("reports launchctl failures instead of claiming success", async () => {
    const { app, paths } = mk();
    writeFileSync(join(app.dir, "gateway", ".env"), "UPSTREAM_MODEL=x\n");
    const exec = fakeExec((cmd, args) => (cmd === "launchctl" && args[0] === "bootstrap" ? { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" } : { code: 0, stdout: "", stderr: "" }));
    const r = await runService("install", { paths, exec, platform: "darwin", ...base });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("Input/output error");
  });
});
