import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KeyStore } from "../../gateway/keys";
import { readEnvFile } from "./dotenv";
import { ensureKeys, readLocalSecrets, scopesOfKey } from "./keysetup";
import { makeAppDir } from "./testkit";

const apps: ReturnType<typeof makeAppDir>[] = [];
afterEach(() => apps.splice(0).forEach((a) => a.cleanup()));
function setup() {
  const app = makeAppDir();
  apps.push(app);
  const p = { keysFile: join(app.dir, "gateway-data", "keys.json"), secretsFile: join(app.dir, "gateway-data", "local-secrets.json"), envLocalFile: join(app.dir, ".env.local"), gatewayUrl: "http://127.0.0.1:8787", dryRun: false };
  return { app, p };
}

describe("ensureKeys", () => {
  it("creates scoped keys, stores secrets privately and only hashes in keys.json", () => {
    const { p } = setup();
    const r = ensureKeys(p);
    expect(r).toMatchObject({ smoke: "created", dashboard: "created" });
    const smoke = readLocalSecrets(p.secretsFile).smokeKey!;
    const read = readEnvFile(p.envLocalFile).INFERENCE_GATEWAY_READ_KEY;
    expect(readEnvFile(p.envLocalFile).INFERENCE_GATEWAY_URL).toBe("http://127.0.0.1:8787");
    expect(statSync(p.secretsFile).mode & 0o777).toBe(0o600);
    expect(statSync(p.envLocalFile).mode & 0o777).toBe(0o600);
    const store = new KeyStore(p.keysFile);
    expect(store.authenticate(smoke, "inference").ok).toBe(true);
    expect(store.authenticate(smoke, "usage:read").ok).toBe(false);
    expect(store.authenticate(read, "usage:read").ok).toBe(true);
    expect(store.authenticate(read, "inference").ok).toBe(false);
    const keysJson = readFileSync(p.keysFile, "utf8");
    expect(keysJson).not.toContain(smoke);
    expect(keysJson).not.toContain(read);
    expect(r.notes.join(" ")).not.toContain(smoke);
    expect(r.notes.join(" ")).not.toContain(read);
    expect(scopesOfKey(p.keysFile, read)).toEqual(["usage:read"]);
  });

  it("is idempotent: reuses valid keys and creates nothing new", () => {
    const { p } = setup();
    ensureKeys(p);
    const before = readFileSync(p.keysFile, "utf8");
    const again = ensureKeys(p);
    expect(again).toMatchObject({ smoke: "reused", dashboard: "reused" });
    expect(readFileSync(p.keysFile, "utf8")).toBe(before);
  });

  it("never overwrites or revokes: an invalid key in .env.local is reported, not replaced", () => {
    const { p } = setup();
    ensureKeys(p);
    const bogus = "crwa_deadbeef_" + "B".repeat(43);
    const env = readFileSync(p.envLocalFile, "utf8").replace(/INFERENCE_GATEWAY_READ_KEY=.*/, `INFERENCE_GATEWAY_READ_KEY=${bogus}`);
    writeFileSync(p.envLocalFile, env);
    const r = ensureKeys(p);
    expect(r.dashboard).toBe("env-local-key-invalid");
    expect(readEnvFile(p.envLocalFile).INFERENCE_GATEWAY_READ_KEY).toBe(bogus);
    expect(new KeyStore(p.keysFile).list().every((k) => !k.revokedAt)).toBe(true);
  });

  it("does not duplicate an existing usage:read key whose secret is unrecoverable", () => {
    const { p } = setup();
    new KeyStore(p.keysFile).create("dashboard", ["usage:read"]);
    const r = ensureKeys(p);
    expect(r.dashboard).toBe("existing-key-secret-unavailable");
    expect(existsSync(p.envLocalFile)).toBe(false);
    expect(new KeyStore(p.keysFile).list().filter((k) => k.scopes.includes("usage:read"))).toHaveLength(1);
    expect(ensureKeys({ ...p, newDashboardKey: true }).dashboard).toBe("created");
  });

  it("preserves unrelated .env.local content", () => {
    const { p } = setup();
    writeFileSync(p.envLocalFile, "NEXT_PUBLIC_SOLANA_CLUSTER=devnet\n");
    ensureKeys(p);
    expect(readEnvFile(p.envLocalFile).NEXT_PUBLIC_SOLANA_CLUSTER).toBe("devnet");
  });

  it("dry run writes nothing", () => {
    const { p } = setup();
    const r = ensureKeys({ ...p, dryRun: true });
    expect(r).toMatchObject({ smoke: "dry-run-would-create", dashboard: "dry-run-would-create" });
    expect(existsSync(p.keysFile) || existsSync(p.secretsFile) || existsSync(p.envLocalFile)).toBe(false);
  });
});
