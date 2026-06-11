#!/usr/bin/env python3
"""
Job Sniper — real-time job watcher.
Polls public ATS APIs (Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Workday)
and pushes an alert the moment a new matching job appears.

State is kept in seen_jobs.json (committed back by GitHub Actions).
Alerts go to ntfy.sh (free push to your phone) and/or Telegram.
"""

import json
import os
import re
import sys
import time
from pathlib import Path

import requests
import yaml

ROOT = Path(__file__).parent
STATE_FILE = ROOT / "seen_jobs.json"
CONFIG_FILE = ROOT / "companies.yaml"

NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "")          # e.g. "kaushik-job-sniper-x7q2"
TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN", "")  # optional
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")

# Supabase: every new matching job is inserted into the `sniped_jobs` table
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")          # https://<ref>.supabase.co
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")  # service_role key (keep secret)

# Email via Gmail SMTP (optional): use a Google App Password, not your real password
SMTP_USER = os.environ.get("SMTP_USER", "")    # your gmail address
SMTP_PASS = os.environ.get("SMTP_PASS", "")    # 16-char app password
EMAIL_TO = os.environ.get("EMAIL_TO", SMTP_USER)

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "Mozilla/5.0 (job-sniper personal alert bot)"})
TIMEOUT = 20


# ---------------------------------------------------------------- ATS fetchers
# Each fetcher returns a list of dicts: {id, title, location, url}

def fetch_greenhouse(slug):
    r = SESSION.get(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs", timeout=TIMEOUT)
    r.raise_for_status()
    return [
        {
            "id": f"gh-{slug}-{j['id']}",
            "title": j.get("title", ""),
            "location": (j.get("location") or {}).get("name", ""),
            "url": j.get("absolute_url", ""),
        }
        for j in r.json().get("jobs", [])
    ]


def fetch_lever(slug):
    r = SESSION.get(f"https://api.lever.co/v0/postings/{slug}?mode=json", timeout=TIMEOUT)
    r.raise_for_status()
    return [
        {
            "id": f"lv-{slug}-{j['id']}",
            "title": j.get("text", ""),
            "location": (j.get("categories") or {}).get("location", ""),
            "url": j.get("hostedUrl", ""),
        }
        for j in r.json()
    ]


def fetch_ashby(slug):
    r = SESSION.get(
        f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true",
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    return [
        {
            "id": f"ab-{slug}-{j['id']}",
            "title": j.get("title", ""),
            "location": j.get("location", ""),
            "url": j.get("jobUrl", ""),
        }
        for j in r.json().get("jobs", [])
    ]


def fetch_smartrecruiters(slug):
    jobs, offset = [], 0
    while True:
        r = SESSION.get(
            f"https://api.smartrecruiters.com/v1/companies/{slug}/postings",
            params={"limit": 100, "offset": offset},
            timeout=TIMEOUT,
        )
        r.raise_for_status()
        data = r.json()
        for j in data.get("content", []):
            loc = j.get("location") or {}
            jobs.append(
                {
                    "id": f"sr-{slug}-{j['id']}",
                    "title": j.get("name", ""),
                    "location": ", ".join(filter(None, [loc.get("city"), loc.get("country")])),
                    "url": f"https://jobs.smartrecruiters.com/{slug}/{j['id']}",
                }
            )
        offset += 100
        if offset >= data.get("totalFound", 0):
            break
    return jobs


def fetch_workable(slug):
    r = SESSION.get(
        f"https://apply.workable.com/api/v1/widget/accounts/{slug}?details=false",
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    return [
        {
            "id": f"wk-{slug}-{j.get('shortcode', j.get('id'))}",
            "title": j.get("title", ""),
            "location": ", ".join(filter(None, [j.get("city"), j.get("country")])),
            "url": j.get("url", f"https://apply.workable.com/{slug}/"),
        }
        for j in r.json().get("jobs", [])
    ]


def fetch_workday(slug):
    """slug format: 'tenant/site/host' e.g. 'atlassian/External/atlassian.wd1.myworkdayjobs.com'"""
    tenant, site, host = slug.split("/", 2)
    url = f"https://{host}/wday/cxs/{tenant}/{site}/jobs"
    jobs, offset = [], 0
    while True:
        r = SESSION.post(
            url,
            json={"appliedFacets": {}, "limit": 20, "offset": offset, "searchText": ""},
            timeout=TIMEOUT,
        )
        r.raise_for_status()
        data = r.json()
        postings = data.get("jobPostings", [])
        if not postings:
            break
        for j in postings:
            ext = j.get("externalPath", "")
            jobs.append(
                {
                    "id": f"wd-{tenant}-{j.get('bulletFields', [ext])[0] if j.get('bulletFields') else ext}",
                    "title": j.get("title", ""),
                    "location": j.get("locationsText", ""),
                    "url": f"https://{host}/{site}{ext}",
                }
            )
        offset += 20
        if offset >= data.get("total", 0):
            break
        time.sleep(0.3)
    return jobs


FETCHERS = {
    "greenhouse": fetch_greenhouse,
    "lever": fetch_lever,
    "ashby": fetch_ashby,
    "smartrecruiters": fetch_smartrecruiters,
    "workable": fetch_workable,
    "workday": fetch_workday,
}


# ---------------------------------------------------------------- filtering

def matches(job, include, exclude, locations):
    text = f"{job['title']} {job['location']}".lower()
    if include and not any(k.lower() in text for k in include):
        return False
    if exclude and any(k.lower() in text for k in exclude):
        return False
    if locations and not any(l.lower() in job["location"].lower() for l in locations):
        return False
    return True


# ---------------------------------------------------------------- alerts & storage

def save_to_supabase(company, job):
    """Insert the job into Supabase the moment it's detected. Idempotent via job_id PK."""
    if not (SUPABASE_URL and SUPABASE_KEY):
        return
    try:
        r = SESSION.post(
            f"{SUPABASE_URL}/rest/v1/sniped_jobs",
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "resolution=ignore-duplicates",
            },
            json={
                "job_id": job["id"],
                "company": company,
                "title": job["title"],
                "location": job["location"],
                "url": job["url"],
            },
            timeout=TIMEOUT,
        )
        if r.status_code >= 400:
            print(f"  supabase insert failed ({r.status_code}): {r.text[:200]}", file=sys.stderr)
    except Exception as e:
        print(f"  supabase failed: {e}", file=sys.stderr)


def send_email(company, job):
    if not (SMTP_USER and SMTP_PASS):
        return
    import smtplib
    from email.mime.text import MIMEText

    try:
        msg = MIMEText(f"{job['title']}\n{company} — {job['location']}\n\nApply now:\n{job['url']}")
        msg["Subject"] = f"🚨 New job: {job['title']} @ {company}"
        msg["From"] = SMTP_USER
        msg["To"] = EMAIL_TO
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=TIMEOUT) as s:
            s.login(SMTP_USER, SMTP_PASS)
            s.send_message(msg)
    except Exception as e:
        print(f"  email failed: {e}", file=sys.stderr)


def alert(company, job):
    msg = f"{job['title']}\n{company} — {job['location']}\n{job['url']}"
    print(f"NEW: {msg}\n")

    save_to_supabase(company, job)
    send_email(company, job)

    if NTFY_TOPIC:
        try:
            SESSION.post(
                f"https://ntfy.sh/{NTFY_TOPIC}",
                data=msg.encode("utf-8"),
                headers={
                    "Title": f"New job at {company}",
                    "Priority": "high",
                    "Tags": "rotating_light,briefcase",
                    "Click": job["url"],
                },
                timeout=TIMEOUT,
            )
        except Exception as e:
            print(f"  ntfy failed: {e}", file=sys.stderr)

    if TELEGRAM_TOKEN and TELEGRAM_CHAT_ID:
        try:
            SESSION.post(
                f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage",
                json={"chat_id": TELEGRAM_CHAT_ID, "text": f"🚨 New job at {company}\n\n{msg}"},
                timeout=TIMEOUT,
            )
        except Exception as e:
            print(f"  telegram failed: {e}", file=sys.stderr)


# ---------------------------------------------------------------- main

def main():
    config = yaml.safe_load(CONFIG_FILE.read_text())
    defaults = config.get("filters", {})

    seen = set()
    first_run = not STATE_FILE.exists()
    if not first_run:
        seen = set(json.loads(STATE_FILE.read_text()))

    new_count, all_ids = 0, set()

    for company in config.get("companies", []):
        name, ats, slug = company["name"], company["ats"], company["slug"]
        fetcher = FETCHERS.get(ats)
        if not fetcher:
            print(f"Unknown ATS '{ats}' for {name}", file=sys.stderr)
            continue
        try:
            jobs = fetcher(slug)
        except Exception as e:
            print(f"FAILED {name} ({ats}): {e}", file=sys.stderr)
            continue

        include = company.get("include", defaults.get("include", []))
        exclude = company.get("exclude", defaults.get("exclude", []))
        locations = company.get("locations", defaults.get("locations", []))

        for job in jobs:
            all_ids.add(job["id"])
            if job["id"] in seen:
                continue
            if not matches(job, include, exclude, locations):
                continue
            if not first_run:  # don't spam hundreds of alerts on first run
                alert(name, job)
                new_count += 1

        print(f"{name}: {len(jobs)} live postings")

    # keep state bounded: only ids still live + previously seen (prune dead after 30 runs is overkill; union is fine)
    STATE_FILE.write_text(json.dumps(sorted(seen | all_ids), indent=0))
    print(f"\nDone. {new_count} new matching jobs alerted." + (" (first run — baseline saved, no alerts)" if first_run else ""))


if __name__ == "__main__":
    main()
