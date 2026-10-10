/** Calls an OpenAI-compatible model server (Ollama, LM Studio, llama.cpp server, mlx_lm.server…). */

export class UpstreamError extends Error {
  constructor(
    readonly kind: "unavailable" | "timeout" | "bad_response" | "error_status",
    message: string,
    readonly upstreamStatus?: number,
  ) {
    super(message);
  }
}

export interface ChatResult {
  body: Record<string, unknown>;
  inputTokens: number | null;
  outputTokens: number | null;
  finishReason: string | null;
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** Reads token counts only if the runtime reported both as non-negative integers. */
export function readUsage(body: Record<string, unknown>): { inputTokens: number | null; outputTokens: number | null } {
  const u = body.usage as Record<string, unknown> | undefined;
  if (u && isCount(u.prompt_tokens) && isCount(u.completion_tokens)) {
    return { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens };
  }
  return { inputTokens: null, outputTokens: null };
}

function classify(e: unknown, timedOut: boolean): UpstreamError {
  if (e instanceof UpstreamError) return e;
  if (timedOut) return new UpstreamError("timeout", "Model server did not respond in time");
  return new UpstreamError("unavailable", "Model server is unreachable");
}

export async function chatCompletion(
  baseUrl: string,
  apiKey: string | null,
  payload: Record<string, unknown>,
  timeoutMs: number,
  clientSignal?: AbortSignal,
): Promise<ChatResult> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const onClientAbort = () => ctrl.abort();
  clientSignal?.addEventListener("abort", onClientAbort);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new UpstreamError("error_status", `Model server returned HTTP ${res.status}`, res.status);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text);
    } catch {
      throw new UpstreamError("bad_response", "Model server returned invalid JSON");
    }
    if (!body || typeof body !== "object" || !Array.isArray(body.choices)) {
      throw new UpstreamError("bad_response", "Model server response has no choices");
    }
    const first = (body.choices as Record<string, unknown>[])[0];
    return { body, ...readUsage(body), finishReason: typeof first?.finish_reason === "string" ? first.finish_reason : null };
  } catch (e) {
    throw classify(e, timedOut);
  } finally {
    clearTimeout(timer);
    clientSignal?.removeEventListener("abort", onClientAbort);
  }
}

export async function checkReady(baseUrl: string, apiKey: string | null, model: string, timeoutMs: number): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, reason: `model server returned HTTP ${res.status}` };
    const body = (await res.json()) as { data?: { id?: string }[] };
    const ids = (body.data ?? []).map((m) => m.id);
    if (ids.length && !ids.includes(model)) return { ok: false, reason: "configured model is not loaded/available on the model server" };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).name === "TimeoutError" ? "model server readiness check timed out" : "model server unreachable" };
  }
}
