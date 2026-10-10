/** Gateway configuration, read from environment variables (see gateway/.env.example). */
import type { CostAssumptions } from "../src/lib/inference/types";

export interface GatewayConfig {
  host: string;
  port: number;
  upstreamBaseUrl: string;
  upstreamModel: string;
  upstreamApiKey: string | null;
  publicModelId: string;
  keysFile: string;
  ledgerFile: string;
  maxBodyBytes: number;
  maxMessages: number;
  defaultMaxTokens: number;
  maxOutputTokens: number;
  upstreamTimeoutMs: number;
  readinessTimeoutMs: number;
  globalConcurrency: number;
  perKeyConcurrency: number;
  rateLimitPerMinute: number;
  idempotencyTtlMs: number;
  cost: CostAssumptions;
}

type Env = Record<string, string | undefined>;

export class ConfigError extends Error {}

function int(env: Env, name: string, def: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

function num(env: Env, name: string, def: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new ConfigError(`${name} must be a non-negative number`);
  return n;
}

export function loadConfig(env: Env = process.env): GatewayConfig {
  const upstreamModel = env.UPSTREAM_MODEL?.trim();
  if (!upstreamModel) {
    throw new ConfigError("UPSTREAM_MODEL is required — set it to the exact model tag your runtime serves (e.g. from `ollama list`).");
  }
  const upstreamBaseUrl = (env.UPSTREAM_BASE_URL || "http://127.0.0.1:11434/v1").replace(/\/+$/, "");
  try {
    new URL(upstreamBaseUrl);
  } catch {
    throw new ConfigError("UPSTREAM_BASE_URL must be a valid URL");
  }
  const maxOutputTokens = int(env, "MAX_OUTPUT_TOKENS", 1024, 1, 32768);
  return {
    host: env.GATEWAY_HOST || "127.0.0.1",
    port: int(env, "GATEWAY_PORT", 8787, 0, 65535),
    upstreamBaseUrl,
    upstreamModel,
    upstreamApiKey: env.UPSTREAM_API_KEY || null,
    publicModelId: env.PUBLIC_MODEL_ID?.trim() || upstreamModel,
    keysFile: env.GATEWAY_KEYS_FILE || "gateway-data/keys.json",
    ledgerFile: env.GATEWAY_LEDGER_FILE || "gateway-data/usage.jsonl",
    maxBodyBytes: int(env, "MAX_BODY_BYTES", 32 * 1024, 256, 10 * 1024 * 1024),
    maxMessages: int(env, "MAX_MESSAGES", 32, 1, 1000),
    defaultMaxTokens: Math.min(int(env, "DEFAULT_MAX_TOKENS", 256, 1, 32768), maxOutputTokens),
    maxOutputTokens,
    upstreamTimeoutMs: int(env, "UPSTREAM_TIMEOUT_MS", 60_000, 100, 600_000),
    readinessTimeoutMs: int(env, "READINESS_TIMEOUT_MS", 3_000, 100, 60_000),
    globalConcurrency: int(env, "GLOBAL_CONCURRENCY", 2, 1, 64),
    perKeyConcurrency: int(env, "PER_KEY_CONCURRENCY", 1, 1, 64),
    rateLimitPerMinute: int(env, "RATE_LIMIT_PER_MINUTE", 20, 1, 100_000),
    idempotencyTtlMs: int(env, "IDEMPOTENCY_TTL_HOURS", 24, 1, 24 * 30) * 3_600_000,
    cost: {
      powerWatts: num(env, "COST_POWER_WATTS", 40),
      electricityUsdPerKwh: num(env, "COST_ELECTRICITY_USD_PER_KWH", 0.22),
      hardwareUsd: num(env, "COST_HARDWARE_USD", 0),
      hardwareLifetimeHours: Math.max(1, num(env, "COST_HARDWARE_LIFETIME_HOURS", 26_280)),
      note:
        env.COST_NOTE ||
        "Default assumptions, not measurements: 40 W while generating, US$0.22/kWh, hardware amortisation off. Override via COST_* env vars.",
    },
  };
}
