import { readEnvFile, type EnvMap } from "./dotenv";
import type { Ctx } from "./ctx";

/** gateway/.env values, with explicitly exported shell variables taking precedence (same rule as the launcher). */
export function effectiveGatewayEnv(ctx: Ctx): EnvMap {
  const file = readEnvFile(ctx.paths.gatewayEnv);
  const out: EnvMap = { ...file };
  for (const k of Object.keys(file)) {
    const v = ctx.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export function envLocalValue(ctx: Ctx, name: string): string | undefined {
  return ctx.env[name] ?? readEnvFile(ctx.paths.envLocal)[name];
}
