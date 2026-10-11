import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyEnvEdits, blankKeys, parseEnv, writePrivateFile } from "./dotenv";
import { redact, redactDeep } from "./redact";
import { assertAppDir, resolvePaths } from "./paths";

describe("dotenv", () => {
  it("parses comments, quotes and export", () => {
    expect(parseEnv('# c\nA=1\nexport B="two words"\nC=\'x\'\nD=\nE=val # trailing\nbad line')).toEqual({ A: "1", B: "two words", C: "x", D: "", E: "val" });
  });

  it("never overwrites a non-empty value, fills empty ones, appends missing ones", () => {
    const src = "KEEP=mine\nEMPTY=\n# note\n";
    const { text, changes } = applyEnvEdits(src, { KEEP: "other", EMPTY: "filled", NEW: "added" });
    expect(parseEnv(text)).toEqual({ KEEP: "mine", EMPTY: "filled", NEW: "added" });
    expect(text).toContain("# note");
    expect(Object.fromEntries(changes.map((c) => [c.key, c.action]))).toEqual({ KEEP: "differs-not-changed", EMPTY: "filled-empty", NEW: "added" });
    expect(applyEnvEdits(src, { KEEP: "mine" }).changes[0].action).toBe("kept-existing");
  });

  it("refuses multi-line values and leaves untouched keys alone", () => {
    expect(() => applyEnvEdits("", { X: "a\nb" })).toThrow();
    const { text } = applyEnvEdits("OTHER=1\n", { NEW: "2" });
    expect(parseEnv(text)).toEqual({ OTHER: "1", NEW: "2" });
  });

  it("blankKeys empties only the named keys", () => {
    expect(parseEnv(blankKeys("A=1\nB=2\n", ["A"]))).toEqual({ A: "", B: "2" });
  });

  it("writes private files with mode 600", () => {
    const p = join(mkdtempSync(join(tmpdir(), "crwa-d-")), "sub", "f.env");
    writePrivateFile(p, "X=1\n");
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});

describe("redaction and paths", () => {
  const key = "crwa_0123abcd_" + "A".repeat(43);
  it("redacts gateway keys and extra secrets everywhere", () => {
    expect(redact(`Bearer ${key}`)).not.toContain(key);
    expect(redact("token hunter2hunter2", ["hunter2hunter2"])).toBe("token [redacted]");
    const o = redactDeep({ a: [{ b: `x ${key} y` }] });
    expect(JSON.stringify(o)).not.toContain("AAAA");
  });

  it("puts logs and state outside the repository", () => {
    const mac = resolvePaths({ appDir: "/repo/computerwa", home: "/Users/k", platform: "darwin", env: {} });
    expect(mac.gatewayLog).toBe("/Users/k/Library/Logs/ComputeRWA/gateway.log");
    expect(mac.launchAgentPlist).toBe("/Users/k/Library/LaunchAgents/com.computerwa.gateway.plist");
    expect(mac.gatewayLog.startsWith(mac.appDir)).toBe(false);
    expect(mac.localSecrets.startsWith("/repo/computerwa/gateway-data")).toBe(true); // git-ignored dir
  });

  it("asserts it runs from the computerwa directory", () => {
    expect(() => assertAppDir(mkdtempSync(join(tmpdir(), "crwa-x-")))).toThrow(/computerwa/);
  });
});
