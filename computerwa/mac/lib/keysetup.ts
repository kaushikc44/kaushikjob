/**
 * Provisions the scoped keys the Mac setup needs. Additive only: it never
 * revokes or replaces an existing key. Secrets are written to mode-600 files
 * and never printed.
 *
 *  - smoke-test key  (inference)  → gateway-data/local-secrets.json  (used by verify/remote checks)
 *  - dashboard key   (usage:read) → .env.local as INFERENCE_GATEWAY_READ_KEY (local dashboard; copy to Vercel yourself)
 */
import { existsSync, readFileSync } from "node:fs";
import { KeyStore } from "../../gateway/keys";
import { applyEnvEdits, readEnvFile, writePrivateFile } from "./dotenv";

export interface LocalSecrets {
  smokeKey?: string;
}

export function readLocalSecrets(path: string): LocalSecrets {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LocalSecrets;
  } catch {
    return {};
  }
}

export interface KeySetupResult {
  smoke: "reused" | "created" | "dry-run-would-create";
  dashboard: "reused" | "created" | "dry-run-would-create" | "existing-key-secret-unavailable" | "env-local-key-invalid";
  notes: string[];
}

export function ensureKeys(p: { keysFile: string; secretsFile: string; envLocalFile: string; gatewayUrl: string; dryRun: boolean; newDashboardKey?: boolean }): KeySetupResult {
  const store = new KeyStore(p.keysFile);
  const notes: string[] = [];
  const result: KeySetupResult = { smoke: "reused", dashboard: "reused", notes };

  // smoke-test key
  const secrets = readLocalSecrets(p.secretsFile);
  if (secrets.smokeKey && store.authenticate(secrets.smokeKey, "inference").ok) {
    result.smoke = "reused";
  } else if (p.dryRun) {
    result.smoke = "dry-run-would-create";
  } else {
    const { key, stored } = store.create(`mac-smoke-test-${new Date().toISOString().slice(0, 10)}`, ["inference"], 60);
    writePrivateFile(p.secretsFile, JSON.stringify({ ...secrets, smokeKey: key }, null, 2) + "\n");
    result.smoke = "created";
    notes.push(`Created inference key ${stored.id} for local verification (saved to ${p.secretsFile}, mode 600).`);
  }

  // dashboard key
  const envLocal = readEnvFile(p.envLocalFile);
  const presented = envLocal.INFERENCE_GATEWAY_READ_KEY;
  if (presented) {
    if (store.authenticate(presented, "usage:read").ok) result.dashboard = "reused";
    else {
      result.dashboard = "env-local-key-invalid";
      notes.push("INFERENCE_GATEWAY_READ_KEY in .env.local is not a valid usage:read key for this keys file. It was NOT changed or revoked.");
    }
  } else {
    const existing = store.list().find((k) => !k.revokedAt && k.scopes.length === 1 && k.scopes[0] === "usage:read");
    if (existing && !p.newDashboardKey) {
      result.dashboard = "existing-key-secret-unavailable";
      notes.push(`A usage:read key already exists (id ${existing.id}, "${existing.name}"). Its secret cannot be recovered, so no new one was made. If you need one in .env.local: npm run mac:setup -- --new-dashboard-key`);
    } else if (p.dryRun) {
      result.dashboard = "dry-run-would-create";
    } else {
      const { key, stored } = store.create("dashboard", ["usage:read"]);
      const current = existsSync(p.envLocalFile) ? readFileSync(p.envLocalFile, "utf8") : "";
      const edited = applyEnvEdits(current, { INFERENCE_GATEWAY_URL: p.gatewayUrl, INFERENCE_GATEWAY_READ_KEY: key });
      writePrivateFile(p.envLocalFile, edited.text);
      result.dashboard = "created";
      notes.push(`Created usage:read key ${stored.id} and saved it to .env.local (mode 600) as INFERENCE_GATEWAY_READ_KEY.`);
    }
  }
  return result;
}

/** Scopes of the key whose secret is `presented`, read from the local keys file (no network). */
export function scopesOfKey(keysFile: string, presented: string): string[] | null {
  const m = /^crwa_([0-9a-f]{8})_/.exec(presented);
  if (!m) return null;
  const k = new KeyStore(keysFile).list().find((x) => x.id === m[1]);
  return k && !k.revokedAt ? [...k.scopes] : null;
}
