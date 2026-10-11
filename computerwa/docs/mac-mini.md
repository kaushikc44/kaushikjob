# Mac mini: plug-and-run guide

Everything here is driven by `npm run mac:*` scripts (Node only; no Python, no extra dependencies). **Nothing is downloaded, exposed to the internet, installed as a service or deployed unless you run an explicit command for it.**

> **Verification status.** This tooling was built and tested in a Linux sandbox with a *mock* model server. It has **not** been run on the real Mac mini, with the real Gemma 4, with a real Tailscale/Cloudflare tunnel, on Vercel, or against public devnet. See [What was and was not verified](#what-was-and-was-not-verified). The launchd and `pmset` code paths are covered by unit tests with a fake `launchctl`; they have never touched a real macOS.

## First-run checklist (on the Mac mini)

1. `git clone -b computerwa-mvp https://github.com/kaushikc44/kaushikjob && cd kaushikjob/computerwa` (or `git pull` in an existing checkout).
2. **Model server** (you): install and start Ollama (or LM Studio / llama.cpp) *yourself*, keep it on `127.0.0.1`.
3. `node mac/bootstrap.mjs`. This runs `npm ci` if needed, then `mac:setup`. It detects the runtime, lists the real model ids, picks Gemma 4 only if there is exactly one match, writes `gateway/.env` (never overwriting yours), creates scoped keys, and runs a real smoke test through a throwaway gateway.
4. **If Gemma 4 isn't installed** (you, because the size is your call): find the exact tag in the Ollama library, then `ollama pull <tag>` and re-run `npm run mac:setup`. Or, once you have confirmed the tag and size, `npm run mac:setup -- --pull <tag>`.
5. `npm run mac:start`: starts the gateway in the background. Logs go to `~/Library/Logs/ComputeRWA/gateway.log`.
6. `npm run mac:verify`: sends **one** real inference request and checks usage, ledger, privacy, revenue and cost.
7. Dashboard check: in a second terminal `npm run build && npm start` (reads `.env.local` created by setup), then `npm run mac:verify` again. The dashboard step turns from NOT RUN to pass.
8. `npm run mac:doctor`: full diagnostic, with JSON saved under `gateway-data/reports/`.
9. Optional, explicit: `npm run mac:service -- install` (start at login), `npm run mac:remote -- private --apply` or `public --apply`, `npm run mac:vercel`.
10. Replace placeholder cost assumptions with measured ones (see [Cost assumptions](#cost-assumptions)).

## Commands

| Command | What it does | Changes anything? |
|---|---|---|
| `node mac/bootstrap.mjs [setup flags]` | `npm ci` if `node_modules` is missing, then `mac:setup` | project `node_modules` only |
| `npm run mac:setup` | Detect runtime/model → write config → create keys → smoke test | `gateway/.env` (created only if absent), `gateway-data/`, `.env.local` |
| `npm run mac:doctor [-- --json --skip-selftest]` | Read-only diagnostics + JSON report | report file only |
| `npm run mac:start` / `mac:stop` | Background gateway (pid file in `~/Library/Application Support/ComputeRWA`) | starts/stops that process |
| `npm run mac:logs [-- -n 100 --follow]` | Tail the gateway log (keys redacted) | no |
| `npm run mac:verify [-- --start --with-tests --offline-test --app-url URL]` | Real end-to-end check of the running gateway | adds 1 request to the ledger |
| `npm run mac:service -- install\|start\|stop\|status\|remove\|print` | launchd user agent | only when you run it |
| `npm run mac:remote -- status\|private\|public\|off\|verify <url>` | Tailscale access to the **gateway only**; dry-run unless `--apply` | only with `--apply` |
| `npm run mac:vercel [-- --target local --env-file F]` | Validate server-side env without printing values | no |

`mac:setup` flags: `--model <id>`, `--runtime ollama|lmstudio|llamacpp-or-mlx`, `--upstream-url URL`, `--public-model-id ID`, `--pull <tag>`, `--fill-missing`, `--new-dashboard-key`, `--dry-run`, `--skip-smoke`, `--yes` (non-interactive: never guesses between candidates).

Rules the tooling follows:

* **No guessing.** Several runtimes or several Gemma 4 models → it stops and asks (or needs `--runtime` / `--model`). A non-Gemma-4 model is only used if you pass it explicitly, and is then *not* labelled `gemma-4`. "Gemma 4" is recognised **by name only** (`gemma4`, `gemma-4`, …): an id cannot prove which weights are loaded.
* **No overwrites.** An existing `gateway/.env` is never modified unless you pass `--fill-missing`, and even then only empty values are filled. Existing keys are never revoked or replaced.
* **No secrets in output.** Created keys go to mode-600 files (`.env.local`, `gateway-data/local-secrets.json`), never to the terminal, logs, reports or this documentation. Reports and logs are passed through a redactor.

## Which steps need you, a login or physical access?

| Step | Why it cannot be automated | What you do |
|---|---|---|
| Install Ollama / LM Studio | System software | `brew install ollama` or the app |
| Download Gemma 4 | Size and tag are your decision | `ollama pull <tag>` or `mac:setup --pull <tag>` |
| Keep Mac awake / auto-login | System settings | See [Sleep and restarts](#sleep-restarts-and-network-loss) |
| Tailscale login | Interactive account auth | Open the app / `tailscale up` |
| Tailscale Funnel (public) | Must be allowed in your Tailscale admin console | Enable Funnel for the device |
| Cloudflare named tunnel (alternative) | Account login + DNS | `cloudflared tunnel login` and follow Cloudflare's docs |
| Vercel environment variables / deploy | Production settings are yours to approve | `vercel env add …`, deploy |
| Devnet wallet flow | Needs a wallet and devnet network | README → Repeatable demo scenario |
| Real power measurement | Needs a meter or `powermetrics` (sudo) | Update the `COST_*` values |

`mac:doctor`/`mac:verify` list each of these as **NOT RUN · needs …** until they have actually been exercised.

## Reading the reports

Every check carries where it ran:

| Label | Meaning |
|---|---|
| `LOCAL` | Ran on this machine against real files/services (including loopback requests to your gateway and model) |
| `REMOTE` | Ran over the network against the URL you passed (a loopback URL also counts as REMOTE but proves nothing about a tunnel) |
| `MOCK` | Ran against an in-process mock model server (gateway behaviour: auth, limits, timeouts, offline, privacy). Says nothing about the real model |
| `NOT RUN · needs X` | Could not run here (`physical-mac`, `tunnel-auth`, `vercel`, `devnet-wallet`, `model-runtime`, `gateway-running`, `app-running`, `app-build`) |

The JSON (`--json`, or the saved file) has the same fields: `status` (`pass|fail|warn|not_run`), `environment` (`mock|local-real|remote-real|not-run`), `requires`, `detail`, `fix`, and a `summary` that counts evidence by environment. Exit code is 1 only if some check **failed**.

## Environment variables

### Gateway (`gateway/.env`, loaded by the launcher, not by your shell)

| Variable | Default | Purpose |
|---|---|---|
| `GATEWAY_HOST` / `GATEWAY_PORT` | `127.0.0.1` / `8787` | Listen address. Keep loopback; expose via a tunnel. `mac:remote` refuses non-loopback. |
| `UPSTREAM_BASE_URL` | `http://127.0.0.1:11434/v1` | OpenAI-compatible model server (must be on this machine) |
| `UPSTREAM_MODEL` | **required** | Exact id from `/v1/models`, written by `mac:setup` |
| `PUBLIC_MODEL_ID` | model id (`gemma-4` for Gemma 4) | Name API clients and the dashboard see |
| `UPSTREAM_API_KEY` | none | Only if the runtime itself requires a key |
| `GATEWAY_KEYS_FILE` / `GATEWAY_LEDGER_FILE` | `gateway-data/keys.json` / `usage.jsonl` | Key hashes / metadata-only ledger (git-ignored) |
| `MAX_BODY_BYTES`, `MAX_MESSAGES`, `DEFAULT_MAX_TOKENS`, `MAX_OUTPUT_TOKENS` | 32768, 32, 256, 1024 | Request and output limits |
| `UPSTREAM_TIMEOUT_MS`, `READINESS_TIMEOUT_MS` | 60000, 3000 | Timeouts (raise the first for big models that load slowly) |
| `GLOBAL_CONCURRENCY`, `PER_KEY_CONCURRENCY`, `RATE_LIMIT_PER_MINUTE`, `IDEMPOTENCY_TTL_HOURS` | 2, 1, 20, 24 | Throttling and retry de-duplication |
| `COST_POWER_WATTS`, `COST_ELECTRICITY_USD_PER_KWH`, `COST_HARDWARE_USD`, `COST_HARDWARE_LIFETIME_HOURS`, `COST_NOTE` | 40, 0.22, 0, 26280, placeholder text | Cost **assumptions** |
| `COST_BASIS` | `placeholder` | `placeholder` or `measured`. Read by the Mac tooling only; `mac:doctor` warns while it is `placeholder` |

### App / dashboard (`.env.local` or Vercel, server-side)

| Variable | Purpose |
|---|---|
| `INFERENCE_GATEWAY_URL` | Gateway origin the **server** calls (HTTPS for Vercel) |
| `INFERENCE_GATEWAY_READ_KEY` | Key with **only** `usage:read`. Never `NEXT_PUBLIC_` |
| `NEXT_PUBLIC_SOLANA_RPC`, `NEXT_PUBLIC_SOLANA_CLUSTER` | Devnet RPC / `devnet`. Mainnet is refused by the app |
| `NEXT_PUBLIC_ENABLE_BURNER_WALLET` | `true` only for clearly-labelled demos |

### Tooling

| Variable | Purpose |
|---|---|
| `COMPUTERWA_HOME` | Relocates state + logs (used by tests); default `~/Library/{Application Support,Logs}/ComputeRWA` on macOS |
| `COMPUTERWA_APP_DIR` | Override the app directory (default: current directory) |

### Model runtime (do not change these to expose it)

`OLLAMA_HOST` should stay unset (loopback). `OLLAMA_KEEP_ALIVE` (e.g. `30m`) keeps the model loaded between requests so the first request after idle is not slow.

## Where things live

| What | Path | In git? |
|---|---|---|
| Gateway config | `computerwa/gateway/.env` (mode 600) | no |
| Key hashes, ledger | `computerwa/gateway-data/` | no |
| Smoke-test key | `computerwa/gateway-data/local-secrets.json` (600) | no |
| Dashboard read key | `computerwa/.env.local` (600) | no |
| Reports | `computerwa/gateway-data/reports/*.json` (secrets redacted) | no |
| Logs | `~/Library/Logs/ComputeRWA/gateway.log` | outside repo |
| pid file | `~/Library/Application Support/ComputeRWA/gateway.pid` | outside repo |
| launchd plist | `~/Library/LaunchAgents/com.computerwa.gateway.plist` (no secrets) | outside repo |

## Sleep, restarts and network loss

* **Install the service:** `npm run mac:service -- install` writes a *user* LaunchAgent (no root) and loads it. `RunAtLoad` starts the gateway at login; `KeepAlive` restarts it after a crash (not after a clean stop), with a 15 s throttle. `stop` unloads it for this session; it returns at next login. `remove` deletes the plist (config, keys and ledger are kept). Don't also use `mac:start` while the service runs.
* **LaunchAgents run only while that user is logged in**, not at boot. For an unattended Mac mini: enable automatic login (if your FileVault/security policy allows it), and in System Settings → Energy enable "Start up automatically after a power failure" and "Prevent automatic sleeping when the display is off". `mac:doctor` reads `pmset -g` and warns if the system sleep timer is not 0.
* **Sleep** stops the gateway and the tunnel; the dashboard shows **Offline** and nothing is estimated in its place. Wrapping with `caffeinate -is` is an alternative for manual runs.
* **Model server:** the gateway does not start Ollama. If Ollama isn't running, `/readyz` is 503 and chat returns 503 until it is. Set Ollama to launch at login.
* **Gateway restart:** the ledger and key hashes persist; rate-limit windows and in-flight requests do not (in-flight clients see a dropped connection). Idempotency-Key de-duplication of *completed* requests survives restarts because it reads the ledger.
* **Network loss:** inference on the Mac mini is unaffected (everything is local). Tailscale reconnects by itself; until then remote clients and the Vercel dashboard cannot reach the gateway and the dashboard shows Offline.

## Remote access (gateway only)

`mac:remote` only ever points the tunnel at the **gateway port**; it never forwards 11434/1234/8080. It refuses to run unless the config is valid, `GATEWAY_HOST` is loopback, at least one inference key exists and the gateway is running locally.

* **A. Private (development/admin):** `npm run mac:remote -- private` (dry run) then `… private --apply` runs `tailscale serve --bg <gateway port>`. Reachable only from your tailnet.
* **B. Public (hackathon demo):** `npm run mac:remote -- public --apply` runs `tailscale funnel --bg <gateway port>` after the same checks. Funnel must be allowed for the device in your Tailscale admin console. **Command syntax follows current Tailscale CLI docs but was not executed here; check `tailscale funnel --help` on your version.**
* **Undo:** `npm run mac:remote -- off --apply` (`tailscale serve reset`).
* **Before sharing the URL:** `npm run mac:remote -- verify https://<host> --burst` checks HTTPS, `/healthz`, 401 without/with a bad key, usage endpoint protected, the raw model ports (11434/1234/8080) *not* reachable on that host, oversize rejection (413) and the rate limit (429). `--burst` spends the smoke key's per-minute budget but never invokes the model. Any failure means **do not share the URL**.
* **Cloudflare Tunnel (alternative):** a *named* tunnel is authenticated (`cloudflared tunnel login`, create/route a tunnel to `http://127.0.0.1:<gateway port>`). `mac:remote status` only detects `cloudflared`; running it is on you. Always finish with `mac:remote -- verify`.

## Vercel

`npm run mac:vercel` validates the **server-side** variables without printing values: URL is an HTTPS origin (no path/credentials/localhost), the read key has only `usage:read` (checked against the local keys file), no gateway data in `NEXT_PUBLIC_*`, no mainnet RPC, and, if a public URL is set, that the gateway answers and accepts the key. It never contacts the Vercel API.

Add to Vercel (Production and Preview; values are prompted, never put them on the command line):

```bash
vercel env add INFERENCE_GATEWAY_URL production
vercel env add INFERENCE_GATEWAY_READ_KEY production --sensitive   # flag names vary by CLI version: check `vercel env add --help`
grep '^INFERENCE_GATEWAY_READ_KEY=' .env.local | cut -d= -f2- | pbcopy   # copy the key without displaying it
```

Redeploy afterwards (env changes apply to new deployments). Test the deployed dashboard: `curl -s https://<your-app>/api/inference?days=1 | head -c 300` should contain `"health":"online"`, and `/inference` should show live counts. `mac:doctor`/`mac:vercel` keep this check as **NOT RUN · needs vercel** until you've done it.

## Cost assumptions

The defaults (40 W while generating, US$0.22/kWh, hardware amortisation off) are **placeholders**. Measure the Mac mini's power under load (wall meter, or `sudo powermetrics --samplers cpu_power,gpu_power`), set `COST_POWER_WATTS`, `COST_ELECTRICITY_USD_PER_KWH` and optionally `COST_HARDWARE_USD`, write how you measured in `COST_NOTE`, and set `COST_BASIS=measured`. The dashboard always labels cost as an *estimate*; revenue stays $0 because no payments are recorded.

## Troubleshooting (by failing check)

| Check | Likely cause → fix |
|---|---|
| No model server found | Ollama not running → open the app / `ollama serve`, re-run setup |
| No Gemma 4 model found | Not installed → `ollama pull <tag>`; or the id lacks "gemma4"/"gemma-4" → `--model <id>` |
| Several servers/models | Pass `--runtime` / `--model` |
| `/readyz` 503 | Model not loaded/id mismatch → `ollama list`, check `UPSTREAM_MODEL`, `npm run mac:logs` |
| Model answers on LAN address | Runtime bound to `0.0.0.0` → unset `OLLAMA_HOST`, restart it |
| Smoke test timed out (504) | First load of a big model → retry; raise `UPSTREAM_TIMEOUT_MS` |
| Empty response | Wrong id/chat template → try another model id |
| Dashboard `Offline` | Gateway/tunnel down or Mac asleep → `mac:doctor`, `mac:remote status` |
| Dashboard `degraded` | Gateway up but model not ready, or read key rejected → `mac:verify` |
| Read key invalid | `.env.local` key not in `keys.json` → remove the line and re-run setup (nothing is revoked automatically) |

## What was and was not verified

| Area | Status |
|---|---|
| Setup/doctor/verify/remote/vercel/service logic | **Unit + integration tested** (79 new tests) with mock model servers and a fake `launchctl`/`tailscale` |
| Real background process (`mac:start`/`stop`) via the actual launcher | **Run for real** in the Linux sandbox against a mock model |
| Fresh-checkout bootstrap (`node mac/bootstrap.mjs`: `npm ci` → setup) | **Run for real** in the Linux sandbox |
| Real macOS: launchd, `pmset`, sleep behaviour | **Not run** |
| Real Ollama / real Gemma 4 model id and a real completion | **Not run** |
| Tailscale Serve/Funnel, Cloudflare Tunnel, public HTTPS | **Not run** |
| Vercel env + deployed dashboard | **Not run** |
| Public devnet transactions / Phantom | **Not run** |
