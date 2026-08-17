## Also in this repo: [Hermes Agent](hermes/README.md) 🪽
A general-purpose personal agent (Claude + tool use) that runs 24/7 via the
same GitHub Actions cron pattern as Job Sniper below, and takes instructions
from a mobile PWA you install on your phone. See [`hermes/README.md`](hermes/README.md).

---

# Job Sniper 🎯

Get pinged on your phone the **moment** a job goes live on a company's career site — before it hits LinkedIn, Seek, or Indeed.

How it works: most career sites run on a handful of ATS platforms (Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Workday), and all of them expose public JSON APIs. This polls them every ~10 minutes via GitHub Actions (free), diffs against state, and pushes alerts via ntfy.sh.

## Setup (10 minutes)

### 1. Phone alerts (ntfy — free, no account)
1. Install the **ntfy** app (iOS/Android)
2. Subscribe to a topic with a hard-to-guess name, e.g. `kaushik-jobs-x7q2p`
3. That topic name is your "channel" — anyone who knows it can see alerts, so make it random

### 2. GitHub repo
1. Create a **private** repo, push these files
2. Repo → Settings → Secrets and variables → Actions → New repository secret:
   - `NTFY_TOPIC` = your topic name
   - (optional) `TELEGRAM_TOKEN` + `TELEGRAM_CHAT_ID` for Telegram alerts too
3. Actions tab → enable workflows → run "Job Sniper" manually once
   - First run saves a baseline silently (no alert spam); every run after alerts only on **new** jobs

### 3. Tune `companies.yaml`
- Add target companies (slug-finding instructions are in the file's comments)
- Adjust `include` / `exclude` / `locations` keyword filters

### 4. Scan hundreds of companies automatically
Export your company list (e.g. from your Notion job tracker) to a text file, one name per line, then:
```bash
python discover.py companies.txt >> companies.yaml
```
It probes Greenhouse, Lever, Ashby, SmartRecruiters and Workable for each name and appends ready-made YAML entries. Companies it can't find are usually on Workday/SuccessFactors/PageUp — check their careers page URL manually.

### 5. Supabase storage
Every new matching job is inserted into the `sniped_jobs` table in your **job-referral-tracker** project the moment it's detected. Add these repo secrets:
- `SUPABASE_URL` = `https://dvmhijltswjhfoetepdo.supabase.co`
- `SUPABASE_SERVICE_KEY` = service_role key (Supabase dashboard → Project Settings → API keys)

### 6. Email alerts (optional)
Gmail → Google Account → Security → App Passwords → create one, then add secrets:
- `SMTP_USER` = your gmail address
- `SMTP_PASS` = the 16-char app password
- `EMAIL_TO` = where alerts go (defaults to SMTP_USER)

## Run locally
```bash
pip install requests pyyaml
NTFY_TOPIC=your-topic python watcher.py
```

## Notes & limits
- GitHub cron isn't exact — expect 10–20 min latency, which is still hours ahead of job boards. For true 5-min polling, run it on a cheap VPS or a free-tier fly.io machine with a loop.
- Workday is the fiddliest — the slug is `tenant/site/host` (see comments in companies.yaml).
- Some companies (e.g. big banks, government) use SuccessFactors or PageUp; those need custom scrapers — add a fetcher function to `watcher.py` following the same pattern.
- Be polite: this polls public endpoints at low volume. Don't crank the frequency to seconds.
