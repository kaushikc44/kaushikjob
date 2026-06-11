#!/usr/bin/env python3
"""
discover.py (v2) — find which ATS a company uses, at scale.

Fixes vs v1:
- SmartRecruiters returns 200 + empty results for ANY name (even fake ones),
  which caused mass false positives. All probes now require >= 1 live posting.
- Output shows the live posting count per hit so you can sanity-check.

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
    stripped = re.sub(r"\b(pty|ltd|inc|group|limited|technologies|technology|labs|co|australia)\b", "", base).strip()
    if stripped and stripped != base:
        guesses += [stripped.replace(" ", ""), stripped.replace(" ", "-")]
    first = base.split(" ")[0]
    if first and first not in guesses:
        guesses.append(first)
    return list(dict.fromkeys(g for g in guesses if g))


def probe(ats, slug):
    """Returns the number of live postings (0 = not found / no signal)."""
    try:
        if ats == "greenhouse":
            r = SESSION.get(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs", timeout=TIMEOUT)
            if r.status_code != 200:
                return 0
            return len(r.json().get("jobs", []))

        if ats == "lever":
            r = SESSION.get(f"https://api.lever.co/v0/postings/{slug}?mode=json", timeout=TIMEOUT)
            if r.status_code != 200:
                return 0
            data = r.json()
            return len(data) if isinstance(data, list) else 0

        if ats == "ashby":
            r = SESSION.get(f"https://api.ashbyhq.com/posting-api/job-board/{slug}", timeout=TIMEOUT)
            if r.status_code != 200:
                return 0
            return len(r.json().get("jobs", []))

        if ats == "smartrecruiters":
            # NB: this API returns 200 + empty for ANY name — count is the only real signal
            r = SESSION.get(
                f"https://api.smartrecruiters.com/v1/companies/{slug}/postings?limit=1",
                timeout=TIMEOUT,
            )
            if r.status_code != 200:
                return 0
            return int(r.json().get("totalFound", 0))

        if ats == "workable":
            r = SESSION.get(
                f"https://apply.workable.com/api/v1/widget/accounts/{slug}?details=false",
                timeout=TIMEOUT,
            )
            if r.status_code != 200:
                return 0
            return len(r.json().get("jobs", []))
    except Exception:
        return 0
    return 0


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
                count = probe(ats, slug)
                if count > 0:
                    hit = (ats, slug, count)
                    break
            if hit:
                break
            time.sleep(0.2)
        if hit:
            found += 1
            print(f"  - name: {name}\n    ats: {hit[0]}\n    slug: {hit[1]}\n")
            print(f"OK {name} -> {hit[0]}/{hit[1]} ({hit[2]} live postings)", file=sys.stderr)
        else:
            missed.append(name)
            print(f"MISS {name} (no live board found — likely Workday/SuccessFactors/PageUp or zero open roles)", file=sys.stderr)

    print(f"\nFound {found}/{len(names)}. Missed {len(missed)}: {', '.join(missed) or 'none'}", file=sys.stderr)


if __name__ == "__main__":
    main()
