/** Minimal .env handling that never overwrites a value the user set. */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type EnvMap = Record<string, string>;

export function parseEnv(text: string): EnvMap {
  const out: EnvMap = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

export function readEnvFile(path: string): EnvMap {
  return existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
}

export interface EnvChange {
  key: string;
  action: "added" | "filled-empty" | "kept-existing" | "differs-not-changed";
}

/**
 * Applies edits to .env text. Existing non-empty values are never changed
 * (`differs-not-changed` records that the wanted value differs). Empty values
 * (e.g. `UPSTREAM_MODEL=` copied from the example) are filled in.
 */
export function applyEnvEdits(text: string, edits: EnvMap): { text: string; changes: EnvChange[] } {
  const existing = parseEnv(text);
  const lines = text === "" ? [] : text.split(/\r?\n/);
  const changes: EnvChange[] = [];
  for (const [key, value] of Object.entries(edits)) {
    if (/[\r\n]/.test(value)) throw new Error(`Refusing to write multi-line value for ${key}`);
    const has = Object.prototype.hasOwnProperty.call(existing, key);
    if (has && existing[key] !== "") {
      changes.push({ key, action: existing[key] === value ? "kept-existing" : "differs-not-changed" });
      continue;
    }
    if (has) {
      const idx = lines.findIndex((l) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(l));
      lines[idx] = `${key}=${value}`;
      changes.push({ key, action: "filled-empty" });
    } else {
      if (lines.length && lines[lines.length - 1] !== "") lines.push("");
      lines.push(`${key}=${value}`);
      changes.push({ key, action: "added" });
    }
  }
  let out = lines.join("\n");
  if (!out.endsWith("\n")) out += "\n";
  return { text: out, changes };
}

/** Blanks the values of `keys` (keeps the lines/comments). Used on the shipped example so template defaults are not mistaken for user choices. */
export function blankKeys(text: string, keys: string[]): string {
  return text
    .split(/\r?\n/)
    .map((l) => (keys.some((k) => new RegExp(`^\\s*(?:export\\s+)?${k}\\s*=`).test(l)) ? l.replace(/=.*/, "=") : l))
    .join("\n");
}

/** Writes with mode 600 via temp file + rename. */
export function writePrivateFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}
