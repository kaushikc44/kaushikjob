"""Tools the Hermes agent can call during its tool-use loop.

Each tool is a plain function plus an Anthropic tool-schema entry. Keep this
list short and additive — new tools just need a schema in TOOLS and a branch
in run_tool().
"""

import os
import sys

import requests

import supabase_client

NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "")
TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")

TIMEOUT = 20

TOOLS = [
    {
        "name": "send_notification",
        "description": (
            "Push a notification to the user's phone right now (via ntfy/Telegram). "
            "Use this for anything the user should see immediately — a finding, a "
            "reminder firing, an answer they asked to be pinged about. Do not use it "
            "for your final reply text; that is shown automatically. Only use this "
            "when a real-time push adds value beyond the normal response."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Short notification title."},
                "message": {"type": "string", "description": "Notification body."},
                "priority": {
                    "type": "string",
                    "enum": ["low", "default", "high"],
                    "description": "Notification priority, default 'default'.",
                },
            },
            "required": ["title", "message"],
        },
    },
    {
        "name": "remember",
        "description": (
            "Persist a fact/preference/reminder under a short key so future runs "
            "(which start with no conversation history) can recall it. Overwrites "
            "any existing value for that key."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "key": {"type": "string", "description": "Short identifier, e.g. 'timezone' or 'standing_reminder_meds'."},
                "value": {"type": "string", "description": "The fact to remember, as plain text."},
            },
            "required": ["key", "value"],
        },
    },
    {
        "name": "recall",
        "description": "Look up previously remembered facts. Omit 'key' to list everything remembered so far.",
        "input_schema": {
            "type": "object",
            "properties": {
                "key": {"type": "string", "description": "Specific key to look up. Omit to list all."},
            },
        },
    },
]


def notify(title, message, priority="default"):
    sent = []

    if NTFY_TOPIC:
        try:
            requests.post(
                f"https://ntfy.sh/{NTFY_TOPIC}",
                data=message.encode("utf-8"),
                headers={
                    "Title": title,
                    "Priority": {"low": "low", "high": "high"}.get(priority, "default"),
                    "Tags": "robot",
                },
                timeout=TIMEOUT,
            )
            sent.append("ntfy")
        except Exception as e:
            print(f"  ntfy failed: {e}", file=sys.stderr)

    if TELEGRAM_TOKEN and TELEGRAM_CHAT_ID:
        try:
            requests.post(
                f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage",
                json={"chat_id": TELEGRAM_CHAT_ID, "text": f"🤖 {title}\n\n{message}"},
                timeout=TIMEOUT,
            )
            sent.append("telegram")
        except Exception as e:
            print(f"  telegram failed: {e}", file=sys.stderr)

    if not sent:
        return "no notification channel configured (set NTFY_TOPIC or TELEGRAM_TOKEN/TELEGRAM_CHAT_ID)"
    return f"sent via {', '.join(sent)}"


def _remember(key, value):
    if not supabase_client.configured():
        return "memory unavailable: Supabase not configured"
    supabase_client.upsert("hermes_memory", {"key": key, "value": value}, on_conflict="key")
    return f"remembered '{key}'"


def _recall(key=None):
    if not supabase_client.configured():
        return "memory unavailable: Supabase not configured"
    if key:
        rows = supabase_client.select("hermes_memory", {"key": f"eq.{key}", "select": "value"})
        return rows[0]["value"] if rows else f"nothing remembered for '{key}'"
    rows = supabase_client.select("hermes_memory", {"select": "key,value", "order": "key"})
    if not rows:
        return "nothing remembered yet"
    return "\n".join(f"{r['key']}: {r['value']}" for r in rows)


def run_tool(name, tool_input):
    """Execute a tool call and return a plain-text result for the model."""
    if name == "send_notification":
        return notify(
            tool_input.get("title", "Hermes agent"),
            tool_input.get("message", ""),
            tool_input.get("priority", "default"),
        )
    if name == "remember":
        return _remember(tool_input["key"], tool_input["value"])
    if name == "recall":
        return _recall(tool_input.get("key"))
    return f"unknown tool: {name}"
