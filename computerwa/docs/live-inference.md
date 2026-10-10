# Live inference: Mac mini + Gemma 4 gateway

```
 other device ──HTTPS──▶ tunnel (Tailscale / Cloudflare) ──▶ gateway :8787 ──▶ model server 127.0.0.1:11434
 (curl / SDK)                                                (keys, limits,      (Ollama / LM Studio /
                                                              ledger)             llama.cpp; never exposed)
 ComputeRWA server route /api/inference ──usage:read key──▶ gateway  (browser never sees URL or key)
```

The gateway works with any runtime that serves OpenAI-style `POST /v1/chat/completions` and `GET /v1/models`. **This was tested against a mock server only**, because the Mac mini wasn't reachable from the build environment. Run the "verify" steps below on the Mac mini before the demo.

## 1. Mac mini setup

Requirements: Node.js 20 or newer (`node -v`) and your Gemma 4 runtime.

1. **Model server: keep it on localhost.**
   * Ollama binds `127.0.0.1:11434` by default. Do **not** set `OLLAMA_HOST=0.0.0.0`.
   * LM Studio: leave "Serve on Local Network" off.
   * llama.cpp: don't pass `--host 0.0.0.0`.
   * Check: `lsof -nP -iTCP -sTCP:LISTEN | grep -E '11434|1234|8080'` should show `127.0.0.1`, not `*`.
2. **Find the exact model tag**: run `ollama list` or `curl -s http://127.0.0.1:11434/v1/models`. Use that string for `UPSTREAM_MODEL`.
3. **Install the gateway:**
   ```bash
   git clone -b computerwa-mvp https://github.com/kaushikc44/kaushikjob && cd kaushikjob/computerwa
   npm ci
   cp gateway/.env.example gateway/.env      # gateway/.env is git-ignored
   # edit gateway/.env: UPSTREAM_MODEL=<tag>, PUBLIC_MODEL_ID=gemma-4, adjust UPSTREAM_BASE_URL for non-Ollama runtimes
   ```
4. **Create keys** (each is printed once; only its SHA-256 is stored, in `gateway-data/keys.json` with mode 600):
   ```bash
   npm run gateway:keys -- create friend-laptop --scopes inference --rpm 20
   npm run gateway:keys -- create dashboard --scopes usage:read
   npm run gateway:keys -- list        # revoke with: npm run gateway:keys -- revoke <id>
   ```
5. **Run it:**
   ```bash
   set -a; source gateway/.env; set +a
   caffeinate -is npm run gateway       # keeps the Mac awake while it runs
   ```
   Also turn off automatic sleep in System Settings → Energy. To survive reboots, wrap the command in a launchd agent or `pm2`.
6. **Verify locally:**
   ```bash
   curl -s localhost:8787/healthz          # {"status":"ok",…}
   curl -s localhost:8787/readyz           # {"status":"ready",…}  (503 + reason if the model isn't loaded)
   curl -s localhost:8787/v1/chat/completions -H "Authorization: Bearer <inference key>" \
     -H 'content-type: application/json' -d '{"messages":[{"role":"user","content":"Say hi"}],"max_tokens":32}'
   curl -s "localhost:8787/v1/usage/summary?days=1" -H "Authorization: Bearer <dashboard key>"
   ```
   Check that `tokens.requestsWithUsage` goes up. If your runtime doesn't return a `usage` object, token counts will show as unavailable. That is expected and never estimated.
7. **Expose only the gateway** (the gateway has no TLS of its own, so use a tunnel rather than plain-HTTP port forwarding):
   * Private, your devices only: `tailscale serve --bg 8787` → `https://<mac>.<tailnet>.ts.net`
   * Public, needed if the dashboard runs on Vercel: `tailscale funnel --bg 8787`, or `cloudflared tunnel --url http://127.0.0.1:8787`

## 2. Dashboard configuration

On the server running ComputeRWA (Vercel project settings or `.env.local`), set:

```
INFERENCE_GATEWAY_URL=https://<your-gateway-host>
INFERENCE_GATEWAY_READ_KEY=crwa_…        # the usage:read key, never NEXT_PUBLIC_
```

Then run `npm run build && npm run check:bundle` to confirm neither value is in browser-delivered files. If the dashboard runs on the Mac mini itself, `INFERENCE_GATEWAY_URL=http://127.0.0.1:8787` works and needs no tunnel.

## 3. Calling it from another device

```bash
export COMPUTERWA_API_KEY=crwa_…        # an inference-scoped key
curl https://<your-gateway-host>/v1/chat/completions \
  -H "Authorization: Bearer $COMPUTERWA_API_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"model":"gemma-4","messages":[{"role":"user","content":"Explain GPU utilisation in one sentence."}],"max_tokens":128}'
```

Python (OpenAI SDK):

```python
from openai import OpenAI
client = OpenAI(base_url="https://<your-gateway-host>/v1", api_key="crwa_…")
r = client.chat.completions.create(model="gemma-4", messages=[{"role": "user", "content": "Hello"}], max_tokens=64)
print(r.choices[0].message.content)
```

Every response carries an `x-request-id` header. Errors look like `{"error":{"message","type","code","request_id"}}`.

| Status | `code` | Meaning |
|---|---|---|
| 401 | `missing_api_key` / `invalid_api_key` | No key, unknown key or revoked key |
| 403 | `insufficient_scope` | e.g. a `usage:read` key used for chat |
| 400 | `invalid_json`, `invalid_messages`, `stream_not_supported`, `tools_not_supported`… | Request validation failed |
| 404 | `model_not_found` | `model` is not the configured public model id |
| 409 | `duplicate_request` / `request_in_progress` | Idempotency-Key already succeeded (includes `original_request_id`) or is still running |
| 413 | `request_too_large` | Body over `MAX_BODY_BYTES` |
| 429 | `rate_limit_exceeded`, `concurrency_limit_key`, `server_busy` | Includes `Retry-After` |
| 502 | `upstream_error` | Model server returned an error or invalid JSON |
| 503 | `model_unavailable` | Mac mini model server offline (`Retry-After: 30`) |
| 504 | `upstream_timeout` | No response within `UPSTREAM_TIMEOUT_MS` |

## 4. What is recorded

One JSON line per authenticated chat request in `gateway-data/usage.jsonl`. **Prompts and completions are never stored or logged.**

```json
{"v":1,"requestId":"req_…","ts":"…","keyId":"e17267f0","model":"gemma-4","status":200,"outcome":"success",
 "idempotencyKeyHash":"sha256 of the header",
 "measured":{"latencyMs":218,"upstreamMs":217,"inputTokens":5,"outputTokens":8,"tokenSource":"runtime_usage_field","finishReason":"stop"},
 "estimated":{"costUsd":5.3e-7,"energyKwh":2.4e-6,"assumptionsId":"cost-v1-…"}}
```

* **Measured:** latency at the gateway (end to end, and time spent on the model server), HTTP status and outcome. Tokens only when the runtime returns both `prompt_tokens` and `completion_tokens` as integers; otherwise `null` with `tokenSource: "unavailable"`.
* **Estimated:** `busy time × (COST_POWER_WATTS × COST_ELECTRICITY_USD_PER_KWH + COST_HARDWARE_USD / COST_HARDWARE_LIFETIME_HOURS)`. Idle power is not allocated. The defaults (40 W, US$0.22/kWh, hardware amortisation off) are placeholders; measure your machine with `sudo powermetrics --samplers cpu_power,gpu_power` or a wall meter.
* **Revenue:** none. The API is free, so recorded customer payments are $0, and the simulator's "actual" mode uses $0 revenue. The hypothetical paid scenario prices only runtime-reported tokens at prices you enter, and it is labelled HYPOTHETICAL wherever it appears.
* **Retries:** with an `Idempotency-Key`, a retry of a request that already succeeded gets 409 and is not re-run or double counted. A retry after a failure runs normally.
* **Unauthenticated requests** are not written to the ledger; there is only an in-memory counter, which resets on restart.

## 5. Limitations

* **Not yet tested:** the real Mac mini, Gemma 4, the tunnel and a Vercel deployment. All tests used a mock OpenAI-compatible server.
* No streaming, tool calling or images. `n` must be 1.
* Single process. Rate-limit windows, concurrency counters and in-flight idempotency are in memory and reset on restart. Requests over the concurrency limit are rejected (429), not queued.
* The ledger is a JSONL file that is also held in memory. That's fine for demo volumes (roughly 300 bytes per request); for production, use SQLite or Postgres plus log rotation.
* Responses are not cached, so a duplicate Idempotency-Key cannot replay the original body.
* Token counts are whatever the runtime reports. Some runtimes report a cached prompt differently.
* When the Mac mini or tunnel is offline, the dashboard shows "Offline" with no data. Nothing is cached or estimated in its place.
* The gateway has no TLS of its own; rely on the tunnel for HTTPS. Don't expose port 8787 over plain HTTP outside your machine.
