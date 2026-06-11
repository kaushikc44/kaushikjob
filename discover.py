#!/usr/bin/env python3
"""
discover.py — find which ATS a company uses, at scale.

Give it a plain text file of company names (one per line) — e.g. exported from
your Notion job tracker — and it probes every ATS API with slug guesses,
then prints ready-to-paste YAML for companies.yaml.

Usage:
    python discover.py companies.txt >> companies.yaml
"""

import re
import sys
import time

import requests

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "Mozilla/5.0 (job-sniper discovery)"})
TIMEOUT = 12


def slug_guesses(name):
    base = re.sub(r"[^a-z0-9 ]", "", name.lower()).strip()
    no_space = base.replace(" ", "")
    hyphen = base.replace(" ", "-")
    guesses = [no_space, hyphen]
    # drop common suffixes: "Canva Pty Ltd" -> "canva"
    stripped = re.sub(r"\b(pty|ltd|inc|group|limited|technologies|technology|labs|co)\b", "", base).strip()
    if stripped and stripped != base:
        guesses += [stripped.replace(" ", ""), stripped.replace(" ", "-")]
    # first word only: "Atlassian Corporation" -> "atlassian"
    first = base.split(" ")[0]
    if first not in guesses:
        guesses.append(first)
    return list(dict.fromkeys(g for g in guesses if g))


def probe(ats, slug):
    try:
        if ats == "greenhouse":
            r = SESSION.get(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs", timeout=TIMEOUT)
            return r.status_code == 200 and "jobs" in r.json()
        if ats == "lever":
            r = SESSION.get(f"https://api.lever.co/v0/postings/{slug}?mode=json&limit=1", timeout=TIMEOUT)
            return r.status_code == 200 and isinstance(r.json(), list)
        if ats == "ashby":
            r = SESSION.get(f"https://api.ashbyhq.com/posting-api/job-board/{slug}", timeout=TIMEOUT)
            return r.status_code == 200 and "jobs" in r.json()
        if ats == "smartrecruiters":
            r = SESSION.get(f"https://api.smartrecruiters.com/v1/companies/{slug}/postings?limit=1", timeout=TIMEOUT)
            return r.status_code == 200 and "content" in r.json()
        if ats == "workable":
            r = SESSION.get(f"https://apply.workable.com/api/v1/widget/accounts/{slug}?details=false", timeout=TIMEOUT)
            return r.status_code == 200 and "jobs" in r.json()
    except Exception:
        return False
    return False


ATS_ORDER = ["greenhouse", "lever", "ashby", "smartrecruiters", "workable"]


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    names = [l.strip() for l in open(sys.argv[1]) if l.strip() and not l.startswith("#")]
    found, missed = 0, []

    for name in names:
        hit = None
        for slug in slug_guesses(name):
            for ats in ATS_ORDER:
                if probe(ats, slug):
                    hit = (ats, slug)
                    break
            if hit:
                break
            time.sleep(0.2)
        if hit:
            found += 1
            print(f"  - name: {name}\n    ats: {hit[0]}\n    slug: {hit[1]}\n")
            print(f"✓ {name} -> {hit[0]}/{hit[1]}", file=sys.stderr)
        else:
            missed.append(name)
            print(f"✗ {name} (likely Workday/SuccessFactors/PageUp — check careers page manually)", file=sys.stderr)

    print(f"\nFound {found}/{len(names)}. Missed: {', '.join(missed) or 'none'}", file=sys.stderr)


if __name__ == "__main__":
    main()
