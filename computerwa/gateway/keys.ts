/**
 * API keys. Only a SHA-256 hash of each key is stored. Keys are 256-bit
 * random secrets, so a fast hash is appropriate (no password stretching
 * needed). Format: crwa_<8-hex id>_<43-char base64url secret>.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Scope = "inference" | "usage:read";
export const SCOPES: Scope[] = ["inference", "usage:read"];

export interface StoredKey {
  id: string;
  name: string;
  hash: string; // "sha256:<hex>"
  scopes: Scope[];
  createdAt: string;
  revokedAt?: string;
  rateLimitPerMinute?: number;
}

export interface KeyFile {
  version: 1;
  keys: StoredKey[];
}

const KEY_RE = /^crwa_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;

export function hashKey(key: string): string {
  return "sha256:" + createHash("sha256").update(key, "utf8").digest("hex");
}

export function generateKey(): { id: string; key: string } {
  const id = randomBytes(4).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  return { id, key: `crwa_${id}_${secret}` };
}

/** Extracts the bearer token from an Authorization header (or x-api-key). */
export function extractKey(headers: Record<string, string | string[] | undefined>): string | null {
  const auth = headers["authorization"];
  if (typeof auth === "string") {
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    if (m) return m[1];
  }
  const x = headers["x-api-key"];
  if (typeof x === "string" && x.trim()) return x.trim();
  return null;
}

export type AuthResult = { ok: true; key: StoredKey } | { ok: false; reason: "missing" | "invalid" | "revoked" | "forbidden" };

export class KeyStore {
  private file: KeyFile = { version: 1, keys: [] };
  private mtimeMs = -1;

  constructor(private readonly path: string) {}

  /** Re-reads the key file if it changed, so keys created by the CLI apply without a restart. */
  private refresh() {
    if (!existsSync(this.path)) {
      this.file = { version: 1, keys: [] };
      this.mtimeMs = -1;
      return;
    }
    const m = statSync(this.path).mtimeMs;
    if (m === this.mtimeMs) return;
    const parsed = JSON.parse(readFileSync(this.path, "utf8")) as KeyFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.keys)) throw new Error(`Invalid key file ${this.path}`);
    this.file = parsed;
    this.mtimeMs = m;
  }

  list(): StoredKey[] {
    this.refresh();
    return this.file.keys.map((k) => ({ ...k }));
  }

  authenticate(presented: string | null, scope: Scope): AuthResult {
    if (!presented) return { ok: false, reason: "missing" };
    const m = KEY_RE.exec(presented);
    if (!m) return { ok: false, reason: "invalid" };
    this.refresh();
    const stored = this.file.keys.find((k) => k.id === m[1]);
    const expected = Buffer.from((stored?.hash ?? hashKey("dummy-for-constant-time")).padEnd(71, "0"));
    const actual = Buffer.from(hashKey(presented));
    const match = expected.length === actual.length && timingSafeEqual(expected, actual);
    if (!stored || !match) return { ok: false, reason: "invalid" };
    if (stored.revokedAt) return { ok: false, reason: "revoked" };
    if (!stored.scopes.includes(scope)) return { ok: false, reason: "forbidden" };
    return { ok: true, key: stored };
  }

  create(name: string, scopes: Scope[], rateLimitPerMinute?: number): { key: string; stored: StoredKey } {
    this.refresh();
    if (!name.trim()) throw new Error("Key name is required");
    if (!scopes.length || scopes.some((s) => !SCOPES.includes(s))) throw new Error(`Scopes must be from: ${SCOPES.join(", ")}`);
    let gen = generateKey();
    while (this.file.keys.some((k) => k.id === gen.id)) gen = generateKey();
    const stored: StoredKey = { id: gen.id, name: name.trim(), hash: hashKey(gen.key), scopes, createdAt: new Date().toISOString() };
    if (rateLimitPerMinute) stored.rateLimitPerMinute = rateLimitPerMinute;
    this.file.keys.push(stored);
    this.save();
    return { key: gen.key, stored };
  }

  revoke(id: string): boolean {
    this.refresh();
    const k = this.file.keys.find((x) => x.id === id);
    if (!k || k.revokedAt) return false;
    k.revokedAt = new Date().toISOString();
    this.save();
    return true;
  }

  private save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.file, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
    this.mtimeMs = -1;
  }
}
