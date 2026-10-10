import "server-only";
import { getInferenceStatus } from "./gatewayClient";

/**
 * Server-side only. INFERENCE_GATEWAY_URL and INFERENCE_GATEWAY_READ_KEY are
 * deliberately not NEXT_PUBLIC_*, so they never reach the browser bundle.
 * The read key should have only the `usage:read` scope.
 */
export function loadInferenceStatus(days: number | "all") {
  return getInferenceStatus({
    baseUrl: process.env.INFERENCE_GATEWAY_URL,
    readKey: process.env.INFERENCE_GATEWAY_READ_KEY,
    days,
  });
}
