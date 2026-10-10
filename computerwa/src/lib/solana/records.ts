/**
 * On-chain record formats. Records are written with the SPL Memo program, so
 * no custom program deployment is required. Each memo is compact JSON tagged
 * with app "ComputeRWA" so records can be rediscovered from an address's
 * transaction history (getSignaturesForAddress returns memo text).
 */
import type { AssetPool } from "../types";

export const APP_TAG = "ComputeRWA";
export const RECORD_VERSION = 1;
export const NO_RIGHTS_NOTICE = "TEST TOKEN ON DEVNET. No ownership, redemption, revenue or payment rights.";
const MAX_MEMO_BYTES = 560;

export interface PoolRegistrationRecord {
  app: typeof APP_TAG;
  v: number;
  t: "pool-registration";
  pool: string;
  gpu: string;
  units: number;
  /** sha256 (hex) of the off-chain accounting record at registration time. */
  dataHash: string;
  demo: true;
}

export interface MintRecord {
  app: typeof APP_TAG;
  v: number;
  t: "demo-token-mint";
  pool: string;
  mint: string;
  supply: string;
  notice: string;
}

export interface DistributionRecord {
  app: typeof APP_TAG;
  v: number;
  t: "demo-token-transfer";
  pool: string;
  mint: string;
  recipients: number;
  notice: string;
}

export type ComputeRwaRecord = PoolRegistrationRecord | MintRecord | DistributionRecord;

/** Deterministic JSON of the fields of a pool that form its off-chain accounting record. */
export function canonicalPoolRecord(pool: AssetPool): string {
  const { id, name, operator, location, gpuModel, units, acquisitionCost, acquisitionDate, serials, months, ledger } = pool;
  return JSON.stringify({ id, name, operator, location, gpuModel, units, acquisitionCost, acquisitionDate, serials, months, ledger });
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function poolDataHash(pool: AssetPool): Promise<string> {
  return sha256Hex(canonicalPoolRecord(pool));
}

export function encodeRecord(record: ComputeRwaRecord): string {
  const text = JSON.stringify(record);
  if (new TextEncoder().encode(text).length > MAX_MEMO_BYTES) {
    throw new Error("Record too large for a memo");
  }
  return text;
}

/**
 * Parse memo text as returned by RPC. getSignaturesForAddress formats memos as
 * "[len] text" and joins multiple memos with "; ". Unknown/foreign memos are ignored.
 */
export function parseMemoField(memo: string | null | undefined): ComputeRwaRecord[] {
  if (!memo) return [];
  const out: ComputeRwaRecord[] = [];
  const re = /\[\d+\]\s(\{.*?\})(?=;\s\[\d+\]|$)/g;
  const candidates: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(memo))) candidates.push(m[1]);
  if (!candidates.length) candidates.push(memo.trim());
  for (const c of candidates) {
    const rec = tryParseRecord(c);
    if (rec) out.push(rec);
  }
  return out;
}

export function tryParseRecord(text: string): ComputeRwaRecord | null {
  try {
    const obj = JSON.parse(text);
    if (obj && obj.app === APP_TAG && typeof obj.t === "string" && typeof obj.pool === "string") {
      return obj as ComputeRwaRecord;
    }
  } catch {
    // not JSON — not ours
  }
  return null;
}
