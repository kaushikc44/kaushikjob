import { ConfigError, loadConfig, type GatewayConfig } from "../../gateway/config";
import type { EnvMap } from "./dotenv";
import { isLoopbackUrl } from "./runtimes";

export const PLACEHOLDER_COST_NOTE =
  "PLACEHOLDER ESTIMATE, not measured: 40 W while generating, US$0.22/kWh, hardware amortisation off. Replace with measured power draw and your electricity tariff, then set COST_BASIS=measured.";

/** Values setup wants in gateway/.env. Existing non-empty values are never overwritten (see applyEnvEdits). */
export function desiredGatewayEnv(p: { upstreamBaseUrl: string; upstreamModel: string; publicModelId: string }): EnvMap {
  return {
    GATEWAY_HOST: "127.0.0.1",
    GATEWAY_PORT: "8787",
    UPSTREAM_BASE_URL: p.upstreamBaseUrl,
    UPSTREAM_MODEL: p.upstreamModel,
    PUBLIC_MODEL_ID: p.publicModelId,
    COST_BASIS: "placeholder",
    COST_NOTE: PLACEHOLDER_COST_NOTE,
  };
}

export interface GatewayEnvValidation {
  ok: boolean;
  config: GatewayConfig | null;
  errors: string[];
  warnings: string[];
}

export function validateGatewayEnv(env: EnvMap): GatewayEnvValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  let config: GatewayConfig | null = null;
  try {
    config = loadConfig(env);
  } catch (e) {
    errors.push(e instanceof ConfigError ? e.message : String(e));
  }
  if (config) {
    if (!isLoopbackUrl(`http://${config.host}`)) warnings.push(`GATEWAY_HOST=${config.host} is not loopback. Prefer 127.0.0.1 and expose the gateway with Tailscale/a tunnel.`);
    if (!isLoopbackUrl(config.upstreamBaseUrl)) warnings.push("UPSTREAM_BASE_URL is not on this machine. The model server should be bound to localhost next to the gateway.");
    if (config.publicModelId === config.upstreamModel && !/gemma/i.test(config.upstreamModel)) warnings.push("PUBLIC_MODEL_ID is not 'gemma-4' and the upstream model name does not mention gemma; dashboard labels will show this id.");
  }
  const basis = env.COST_BASIS ?? "placeholder";
  if (basis !== "placeholder" && basis !== "measured") errors.push("COST_BASIS must be 'placeholder' or 'measured'.");
  if (basis === "measured" && !(env.COST_NOTE ?? "").trim()) warnings.push("COST_BASIS=measured but COST_NOTE is empty; describe how power/tariff were measured.");
  return { ok: errors.length === 0, config, errors, warnings };
}
