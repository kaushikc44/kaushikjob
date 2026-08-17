"""Minimal Supabase REST client — just enough to read/write the hermes_* tables.

Uses the service_role key, which bypasses row-level security, so this is only
ever meant to run server-side (GitHub Actions), never shipped to the phone.
"""

import os

import requests

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

TIMEOUT = 20


def _headers(extra=None):
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }
    if extra:
        headers.update(extra)
    return headers


def configured():
    return bool(SUPABASE_URL and SUPABASE_KEY)


def select(table, params=None):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=_headers(),
        params=params or {},
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    return r.json()


def insert(table, row, prefer="return=representation"):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=_headers({"Prefer": prefer}),
        json=row,
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    return r.json() if r.text else None


def update(table, params, values):
    """params: query-string filters, e.g. {"id": "eq.5"}"""
    r = requests.patch(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=_headers({"Prefer": "return=minimal"}),
        params=params,
        json=values,
        timeout=TIMEOUT,
    )
    r.raise_for_status()


def upsert(table, row, on_conflict):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=_headers({"Prefer": "resolution=merge-duplicates"}),
        params={"on_conflict": on_conflict},
        json=row,
        timeout=TIMEOUT,
    )
    r.raise_for_status()
