# Hermes Agent 🪽

A general-purpose personal agent that runs **24/7 in the cloud** and takes
instructions **from your phone**. It's the same "no server to babysit"
pattern as the Job Sniper in the repo root — a cron job, not a daemon — just
pointed at a real LLM instead of a job-board diff.

```
 phone (PWA)  --POST /task-->  Supabase edge fn  --insert-->  hermes_tasks
                                                                    |
                                                     GitHub Actions cron
                                                     (every 15 min, forever)
                                                                    |
                                                        agent.py + Claude
                                                       (tool use: notify,
                                                        remember/recall)
                                                                    |
                                              hermes_log + push notification
                                                                    |
 phone (PWA)  <--GET /log-----  Supabase edge fn  <---------------/
```

Nothing here needs a machine you keep on. The 24/7-ness comes entirely from
GitHub Actions' scheduler and Supabase's always-on Postgres + edge runtime.

## What's already deployed

- **Supabase tables** `hermes_tasks`, `hermes_log`, `hermes_memory` in the
  `job-referral-tracker` project, RLS-enabled (service-role only — the PWA
  never talks to Postgres directly).
- **Edge function** `hermes-api` on that same project, exposing:
  - `POST /task` `{ "content": "..." }` → queues an instruction
  - `GET /log?limit=30` → recent activity for the PWA feed
  - `GET /tasks` → recent tasks + their status
  Auth is a shared-secret header (`x-hermes-secret`), not a Supabase login —
  there's no user account system here, just you and your phone.

## Setup (your part)

### 1. Set the edge function's secret
The edge function refuses all requests until this is set:
```bash
supabase secrets set HERMES_SHARED_SECRET=some-long-random-string --project-ref dvmhijltswjhfoetepdo
```
(Or via Supabase Dashboard → Edge Functions → hermes-api → Secrets.) Pick
something you wouldn't mind typing on your phone once — it's stored in
`localStorage` after that.

### 2. GitHub repo secrets
Settings → Secrets and variables → Actions:
| Secret | Value |
|---|---|
| `ANTHROPIC_API_KEY` | from [console.anthropic.com](https://console.anthropic.com) |
| `SUPABASE_URL` | `https://dvmhijltswjhfoetepdo.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Supabase → Project Settings → API → `service_role` key |
| `NTFY_TOPIC` | reuse the same ntfy topic as Job Sniper, or a new one |
| `TELEGRAM_TOKEN` / `TELEGRAM_CHAT_ID` | optional, same as Job Sniper |

Then Actions tab → enable workflows → run **"Hermes Agent"** once manually
to confirm it doesn't error (it'll just print "No pending tasks." — that's
success).

### 3. Turn on GitHub Pages (hosts the phone app)
Settings → Pages → Source: **GitHub Actions**. Merge this branch to `main`
and the **"Deploy Hermes PWA"** workflow publishes `hermes/webapp/` there
automatically on every change to it.

### 4. Install the app on your phone
Open the Pages URL (Settings → Pages shows it, looks like
`https://<you>.github.io/<repo>/`) in Safari/Chrome → Share → **Add to Home
Screen**. First launch asks for:
- **Agent API URL**: `https://dvmhijltswjhfoetepdo.supabase.co/functions/v1/hermes-api`
- **Shared secret**: whatever you set in step 1

That's it — type an instruction, it runs on the next 15-minute cycle, and
you get a push notification with the result.

## Current capabilities

The agent ships with three tools (`hermes/tools.py`):
- `send_notification` — push to ntfy/Telegram
- `remember` / `recall` — a small persistent key-value memory in
  `hermes_memory`, since every run starts with zero conversation history

It does **not** yet have live email/calendar/web access — that needs real
OAuth setup per service, which is a deliberate next step rather than
something to fake. To add a tool: write the function, add its schema to
`TOOLS` in `hermes/tools.py`, and branch on its name in `run_tool()`.
`agent.py` already does the tool-use loop generically, so new tools need no
changes there.

## Run/test locally
```bash
pip install requests
ANTHROPIC_API_KEY=... SUPABASE_URL=... SUPABASE_SERVICE_KEY=... NTFY_TOPIC=... \
  python hermes/agent.py
```

## Cost & tuning
- Polling cadence: edit the cron in `.github/workflows/hermes.yml` (15 min
  default; GitHub's scheduler has ~a few minutes of slop like Job Sniper's).
- Model: set repo secret/env `HERMES_MODEL` to override the default
  (`claude-sonnet-5`).
- Each run only calls the API for *pending* tasks — an idle agent costs
  nothing beyond a free GitHub Actions minute every 15 minutes.
