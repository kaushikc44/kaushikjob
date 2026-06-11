#!/usr/bin/env python3
"""
discover.py (v3) — find which ATS a company uses, at scale. Now parallel.

v3: checks ~24 companies concurrently (~10-15x faster than v2).
Results print as they complete; YAML output is sorted by input order at the end.

Usage:
    python discover.py companies.txt >> companies.yaml
"""

import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

TIMEOUT = 6
WORKERS = 24
HEADERS = {"User-Agent": "Mozilla/5.0 (job-sniper discovery)"}


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
    """Returns number of live postings (0 = not found)."""
    try:
        if ats == "greenhouse":
            r = requests.get(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs",
                             headers=HEADERS, timeout=TIMEOUT)
            return len(r.json().get("jobs", [])) if r.status_code == 200 else 0

        if ats == "lever":
            r = requests.get(f"https://api.lever.co/v0/postings/{slug}?mode=json",
                             headers=HEADERS, timeout=TIMEOUT)
            if r.status_code != 200:
                return 0
            data = r.json()
            return len(data) if isinstance(data, list) else 0

        if ats == "ashby":
            r = requests.get(f"https://api.ashbyhq.com/posting-api/job-board/{slug}",
                             headers=HEADERS, timeout=TIMEOUT)
            return len(r.json().get("jobs", [])) if r.status_code == 200 else 0

        if ats == "smartrecruiters":
            # NB: returns 200 + empty for ANY name — posting count is the only real signal
            r = requests.get(f"https://api.smartrecruiters.com/v1/companies/{slug}/postings?limit=1",
                             headers=HEADERS, timeout=TIMEOUT)
            return int(r.json().get("totalFound", 0)) if r.status_code == 200 else 0

        if ats == "workable":
            r = requests.get(f"https://apply.workable.com/api/v1/widget/accounts/{slug}?details=false",
                             headers=HEADERS, timeout=TIMEOUT)
            return len(r.json().get("jobs", [])) if r.status_code == 200 else 0
    except Exception:
        return 0
    return 0


ATS_ORDER = ["greenhouse", "lever", "ashby", "smartrecruiters", "workable"]


def discover_one(name):
    """Returns (name, ats, slug, count) or (name, None, None, 0)."""
    for slug in slug_guesses(name):
        for ats in ATS_ORDER:
            count = probe(ats, slug)
            if count > 0:
                return (name, ats, slug, count)
    return (name, None, None, 0)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    names = [l.strip() for l in open(sys.argv[1]) if l.strip() and not l.startswith("#")]
    order = {n: i for i, n in enumerate(names)}
    hits, missed, done = [], [], 0

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(discover_one, n): n for n in names}
        for fut in as_completed(futures):
            name, ats, slug, count = fut.result()
            done += 1
            if ats:
                hits.append((name, ats, slug))
                print(f"[{done}/{len(names)}] OK {name} -> {ats}/{slug} ({count} live postings)", file=sys.stderr)
            else:
                missed.append(name)
                print(f"[{done}/{len(names)}] MISS {name}", file=sys.stderr)

    # YAML to stdout, in original input order
    for name, ats, slug in sorted(hits, key=lambda h: order[h[0]]):
        print(f"  - name: {name}\n    ats: {ats}\n    slug: {slug}\n")

    print(f"\nFound {len(hits)}/{len(names)}.", file=sys.stderr)
    print(f"Missed ({len(missed)}): {', '.join(sorted(missed)) or 'none'}", file=sys.stderr)
    print("Misses are usually Workday/SuccessFactors/PageUp companies or boards with zero open roles right now.", file=sys.stderr)


if __name__ == "__main__":
    main()
