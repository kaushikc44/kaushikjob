/**
 * ComputeRWA inference gateway: an authenticated, rate-limited,
 * OpenAI-compatible front door to a local model server. Prompts and
 * completions are passed through and never stored.
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { LedgerEntry, Outcome, ReadinessResponse } from "../src/lib/inference/types";
import type { GatewayConfig } from "./config";
import { assumptionsId, estimateCost } from "./cost";
import { extractKey, KeyStore, type Scope, type StoredKey } from "./keys";
import { Ledger, summarize } from "./ledger";
import { ConcurrencyLimiter, RateLimiter } from "./limits";
import { chatCompletion, checkReady, UpstreamError } from "./upstream";

type ErrorType = "invalid_request_error" | "authentication_error" | "permission_error" | "rate_limit_error" | "api_error" | "not_found_error";

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly type: ErrorType,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const ROLES = new Set(["system", "user", "assistant"]);
const PASSTHROUGH = ["temperature", "top_p", "stop", "seed", "presence_penalty", "frequency_penalty"] as const;

export interface Gateway {
  server: Server;
  ledger: Ledger;
  keys: KeyStore;
  startedAt: string;
}

export function createGateway(config: GatewayConfig, log: (line: Record<string, unknown>) => void = defaultLog): Gateway {
  const keys = new KeyStore(config.keysFile);
  const ledger = new Ledger(config.ledgerFile);
  const rate = new RateLimiter();
  const conc = new ConcurrencyLimiter(config.globalConcurrency, config.perKeyConcurrency);
  const inFlightIdem = new Set<string>();
  const startedAt = new Date().toISOString();
  const costId = assumptionsId(config.cost);
  let unauthenticated = 0;

  function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    });
    res.end(json);
  }

  function sendError(res: ServerResponse, requestId: string, e: HttpError) {
    send(res, e.status, { error: { message: e.message, type: e.type, code: e.code, request_id: requestId, ...e.extra } }, e.headers);
  }

  function auth(req: IncomingMessage, scope: Scope): StoredKey {
    const r = keys.authenticate(extractKey(req.headers), scope);
    if (r.ok) return r.key;
    if (r.reason === "forbidden") throw new HttpError(403, "permission_error", "insufficient_scope", `This API key lacks the "${scope}" scope`);
    unauthenticated++;
    const msg = r.reason === "missing" ? "Missing API key. Send `Authorization: Bearer <key>`." : r.reason === "revoked" ? "API key has been revoked" : "Invalid API key";
    throw new HttpError(401, "authentication_error", r.reason === "missing" ? "missing_api_key" : "invalid_api_key", msg, {}, { "www-authenticate": "Bearer" });
  }

  async function readBody(req: IncomingMessage): Promise<unknown> {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > config.maxBodyBytes) throw new HttpError(413, "invalid_request_error", "request_too_large", `Request body exceeds ${config.maxBodyBytes} bytes`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > config.maxBodyBytes) throw new HttpError(413, "invalid_request_error", "request_too_large", `Request body exceeds ${config.maxBodyBytes} bytes`);
      chunks.push(chunk as Buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new HttpError(400, "invalid_request_error", "invalid_json", "Request body must be valid JSON");
    }
  }

  /** Validates an OpenAI-style chat request and builds the upstream payload from an allow-list of fields. */
  function buildPayload(body: unknown): Record<string, unknown> {
    const bad = (code: string, msg: string) => new HttpError(400, "invalid_request_error", code, msg);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("invalid_body", "Body must be a JSON object");
    const b = body as Record<string, unknown>;
    if (b.model !== undefined && b.model !== config.publicModelId) {
      throw new HttpError(404, "invalid_request_error", "model_not_found", `Model "${String(b.model)}" is not served here. Use "${config.publicModelId}".`);
    }
    if (b.stream === true) throw bad("stream_not_supported", "Streaming is not supported by this gateway; omit `stream` or set it to false");
    if (b.n !== undefined && b.n !== 1) throw bad("n_not_supported", "Only n=1 is supported");
    if (b.tools !== undefined || b.functions !== undefined) throw bad("tools_not_supported", "Tool calling is not supported by this gateway");
    const messages = b.messages;
    if (!Array.isArray(messages) || messages.length === 0) throw bad("invalid_messages", "`messages` must be a non-empty array");
    if (messages.length > config.maxMessages) throw bad("too_many_messages", `At most ${config.maxMessages} messages per request`);
    const clean = messages.map((m, i) => {
      if (!m || typeof m !== "object") throw bad("invalid_messages", `messages[${i}] must be an object`);
      const { role, content } = m as Record<string, unknown>;
      if (typeof role !== "string" || !ROLES.has(role)) throw bad("invalid_messages", `messages[${i}].role must be system, user or assistant`);
      if (typeof content === "string") return { role, content };
      if (Array.isArray(content) && content.every((p) => p && typeof p === "object" && (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string")) {
        return { role, content: (content as { text: string }[]).map((p) => p.text).join("\n") };
      }
      throw bad("invalid_messages", `messages[${i}].content must be a string or text parts (images are not supported)`);
    });
    const requested = b.max_completion_tokens ?? b.max_tokens;
    if (requested !== undefined && (!Number.isInteger(requested) || (requested as number) < 1)) throw bad("invalid_max_tokens", "max_tokens must be a positive integer");
    const maxTokens = Math.min((requested as number | undefined) ?? config.defaultMaxTokens, config.maxOutputTokens);
    const payload: Record<string, unknown> = { model: config.upstreamModel, messages: clean, max_tokens: maxTokens, stream: false };
    for (const k of PASSTHROUGH) if (b[k] !== undefined) payload[k] = b[k];
    return payload;
  }

  function record(e: Omit<LedgerEntry, "v" | "ts" | "model" | "estimated"> & { upstreamMsForCost: number | null }) {
    const { upstreamMsForCost, ...rest } = e;
    const est = estimateCost(upstreamMsForCost, config.cost);
    const entry: LedgerEntry = {
      v: 1,
      ts: new Date().toISOString(),
      model: config.publicModelId,
      ...rest,
      estimated: { costUsd: est.costUsd, energyKwh: est.energyKwh, assumptionsId: costId },
    };
    try {
      ledger.append(entry);
    } catch (err) {
      log({ level: "error", msg: "ledger_write_failed", requestId: entry.requestId, error: (err as Error).message });
    }
    return entry;
  }

  async function handleChat(req: IncomingMessage, res: ServerResponse, requestId: string, t0: number) {
    const key = auth(req, "inference");
    const idemRaw = req.headers["idempotency-key"];
    const idemHash =
      typeof idemRaw === "string" && idemRaw.trim()
        ? idemRaw.length > 128
          ? (() => {
              throw new HttpError(400, "invalid_request_error", "invalid_idempotency_key", "Idempotency-Key must be at most 128 characters");
            })()
          : createHash("sha256").update(idemRaw.trim()).digest("hex")
        : undefined;
    const base = { requestId, keyId: key.id, idempotencyKeyHash: idemHash };
    const fail = (outcome: Outcome, err: HttpError, upstreamMs: number | null = null) => {
      record({
        ...base,
        status: err.status,
        outcome,
        errorCode: err.code,
        measured: { latencyMs: Date.now() - t0, upstreamMs, inputTokens: null, outputTokens: null, tokenSource: "unavailable" },
        upstreamMsForCost: upstreamMs,
      });
      return err;
    };

    // Retry de-duplication: a completed success with the same Idempotency-Key is not re-run.
    const idemSlot = idemHash ? `${key.id}:${idemHash}` : null;
    if (idemSlot && idemHash) {
      if (inFlightIdem.has(idemSlot)) {
        throw fail("duplicate", new HttpError(409, "invalid_request_error", "request_in_progress", "A request with this Idempotency-Key is still in progress"));
      }
      const prev = ledger.findByIdempotency(key.id, idemHash, Date.now() - config.idempotencyTtlMs);
      if (prev && prev.outcome === "success") {
        const err = new HttpError(409, "invalid_request_error", "duplicate_request", "This Idempotency-Key already completed successfully; the response is not stored, so it cannot be replayed", {
          original_request_id: prev.requestId,
        });
        record({ ...base, duplicateOf: prev.requestId, status: 409, outcome: "duplicate", errorCode: err.code, measured: { latencyMs: Date.now() - t0, upstreamMs: null, inputTokens: null, outputTokens: null, tokenSource: "unavailable" }, upstreamMsForCost: null });
        throw err;
      }
    }

    const retryAfter = rate.take(key.id, key.rateLimitPerMinute ?? config.rateLimitPerMinute);
    if (retryAfter) {
      throw fail("rate_limited", new HttpError(429, "rate_limit_error", "rate_limit_exceeded", "Rate limit exceeded for this API key", {}, { "retry-after": String(retryAfter) }));
    }

    let payload: Record<string, unknown>;
    try {
      payload = buildPayload(await readBody(req));
    } catch (e) {
      if (e instanceof HttpError) throw fail("client_error", e);
      throw e;
    }

    const slot = conc.acquire(key.id);
    if (!slot.ok) {
      const msg = slot.scope === "key" ? "Too many concurrent requests for this API key" : "The model server is busy; try again shortly";
      throw fail("rate_limited", new HttpError(429, "rate_limit_error", slot.scope === "key" ? "concurrency_limit_key" : "server_busy", msg, {}, { "retry-after": "2" }));
    }
    if (idemSlot) inFlightIdem.add(idemSlot);
    const clientGone = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) clientGone.abort();
    });
    const u0 = Date.now();
    try {
      const result = await chatCompletion(config.upstreamBaseUrl, config.upstreamApiKey, payload, config.upstreamTimeoutMs, clientGone.signal);
      const upstreamMs = Date.now() - u0;
      const tokenSource = result.inputTokens !== null && result.outputTokens !== null ? "runtime_usage_field" : "unavailable";
      record({
        ...base,
        status: 200,
        outcome: "success",
        measured: { latencyMs: Date.now() - t0, upstreamMs, inputTokens: result.inputTokens, outputTokens: result.outputTokens, tokenSource, finishReason: result.finishReason },
        upstreamMsForCost: upstreamMs,
      });
      send(res, 200, { ...result.body, model: config.publicModelId }, { "x-request-id": requestId });
    } catch (e) {
      const upstreamMs = Date.now() - u0;
      if (!(e instanceof UpstreamError)) throw e;
      if (e.kind === "timeout") throw fail("upstream_timeout", new HttpError(504, "api_error", "upstream_timeout", `Model server did not respond within ${config.upstreamTimeoutMs} ms`), upstreamMs);
      if (e.kind === "unavailable") throw fail("upstream_unavailable", new HttpError(503, "api_error", "model_unavailable", "The model server is offline or unreachable. Try again later.", {}, { "retry-after": "30" }), null);
      throw fail("upstream_error", new HttpError(502, "api_error", "upstream_error", e.message), upstreamMs);
    } finally {
      slot.release();
      if (idemSlot) inFlightIdem.delete(idemSlot);
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const requestId = `req_${randomUUID().replace(/-/g, "")}`;
    res.setHeader("x-request-id", requestId);
    const t0 = Date.now();
    const url = new URL(req.url ?? "/", "http://gateway");
    const route = `${req.method} ${url.pathname}`;
    try {
      switch (route) {
        case "GET /healthz":
          return send(res, 200, { status: "ok", startedAt });
        case "GET /readyz": {
          const r = await checkReady(config.upstreamBaseUrl, config.upstreamApiKey, config.upstreamModel, config.readinessTimeoutMs);
          const body: ReadinessResponse = { status: r.ok ? "ready" : "not_ready", model: config.publicModelId, checkedAt: new Date().toISOString(), ...(r.reason ? { reason: r.reason } : {}) };
          return send(res, r.ok ? 200 : 503, body);
        }
        case "GET /v1/models":
          auth(req, "inference");
          return send(res, 200, { object: "list", data: [{ id: config.publicModelId, object: "model", owned_by: "computerwa-gateway" }] });
        case "POST /v1/chat/completions":
          return await handleChat(req, res, requestId, t0);
        case "GET /v1/usage/summary": {
          auth(req, "usage:read");
          const days = url.searchParams.get("days");
          let from: Date | null = null;
          if (days && days !== "all") {
            const n = Number(days);
            if (!Number.isInteger(n) || n < 1 || n > 3650) throw new HttpError(400, "invalid_request_error", "invalid_range", "days must be an integer 1–3650 or 'all'");
            from = new Date(Date.now() - n * 86_400_000);
          }
          return send(
            res,
            200,
            summarize(ledger.all(), {
              from,
              to: new Date(),
              model: config.publicModelId,
              assumptions: config.cost,
              assumptionsId: costId,
              gatewayStartedAt: startedAt,
              unauthenticatedRejected: unauthenticated,
            }),
          );
        }
        default:
          throw new HttpError(404, "not_found_error", "not_found", `No route for ${route}`);
      }
    } catch (e) {
      const err = e instanceof HttpError ? e : new HttpError(500, "api_error", "internal_error", "Internal gateway error");
      if (!(e instanceof HttpError)) log({ level: "error", msg: "unhandled", requestId, error: (e as Error).message });
      if (!res.headersSent) sendError(res, requestId, err);
    } finally {
      // Metadata only — never prompt or completion text.
      log({ level: "info", requestId, method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - t0 });
    }
  }

  const server = createServer((req, res) => void handle(req, res));
  server.requestTimeout = config.upstreamTimeoutMs + 15_000;
  server.headersTimeout = 15_000;
  return { server, ledger, keys, startedAt };
}

function defaultLog(line: Record<string, unknown>) {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...line }) + "\n");
}
