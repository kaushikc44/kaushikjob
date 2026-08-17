#!/usr/bin/env python3
"""
Hermes — a general-purpose personal agent that runs 24/7 in GitHub Actions
and takes instructions from your phone.

How it works:
  1. You open the mobile PWA (hermes/webapp/) and type an instruction.
  2. The PWA POSTs it to a Supabase edge function, which inserts a row into
     the `hermes_tasks` table.
  3. This script runs on a cron schedule (.github/workflows/hermes.yml),
     picks up pending tasks, runs Claude with tool use (notifications,
     persistent memory) to work each one, and writes the result back.
  4. You get a push notification with the outcome; the PWA log view shows
     the full history.

There is no long-running process and no server to keep alive — the schedule
*is* the 24/7-ness, the same pattern this repo already uses for job-sniper.
"""

import os
import sys
from datetime import datetime, timezone

import requests

import supabase_client
import tools

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
MODEL = os.environ.get("HERMES_MODEL", "claude-sonnet-5")
MAX_TASKS_PER_RUN = int(os.environ.get("HERMES_MAX_TASKS_PER_RUN", "5"))
MAX_TOOL_ITERATIONS = 6

API_URL = "https://api.anthropic.com/v1/messages"
TIMEOUT = 60

SYSTEM_PROMPT = """You are Hermes, the user's personal agent. You run unattended on a \
schedule (not in a live chat), so there is no back-and-forth: read the task, do what you \
can with the tools available, and give one clear, complete final answer.

Guidelines:
- Be concise. Your final text reply is what the user sees as the task result.
- Use `send_notification` only for things that deserve an immediate phone push in \
addition to your reply (e.g. the user explicitly asked to be pinged, or you found \
something time-sensitive). Don't use it just to repeat your final answer.
- Use `remember` for durable facts/preferences the user states (name, timezone, standing \
reminders) so future runs — which start with zero memory of past conversations — can use \
`recall` to look them up.
- You currently do not have live access to email, calendar, or the web. If a task needs \
one of those, say so plainly and suggest the user extend hermes/tools.py rather than \
guessing or making something up.
"""


def call_claude(messages):
    r = requests.post(
        API_URL,
        headers={
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": MODEL,
            "max_tokens": 1024,
            "system": SYSTEM_PROMPT,
            "tools": tools.TOOLS,
            "messages": messages,
        },
        timeout=TIMEOUT,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"Anthropic API error {r.status_code}: {r.text[:500]}")
    return r.json()


def run_task(content):
    """Runs the tool-use loop for one task, returns the final text reply."""
    messages = [{"role": "user", "content": content}]

    for _ in range(MAX_TOOL_ITERATIONS):
        response = call_claude(messages)
        messages.append({"role": "assistant", "content": response["content"]})

        if response.get("stop_reason") != "tool_use":
            return "".join(b["text"] for b in response["content"] if b["type"] == "text").strip()

        tool_results = []
        for block in response["content"]:
            if block["type"] != "tool_use":
                continue
            print(f"  tool: {block['name']}({block['input']})")
            try:
                result = tools.run_tool(block["name"], block["input"])
            except Exception as e:
                result = f"tool error: {e}"
            tool_results.append(
                {"type": "tool_result", "tool_use_id": block["id"], "content": str(result)}
            )
        messages.append({"role": "user", "content": tool_results})

    return "(stopped after max tool iterations without a final answer)"


def main():
    if not ANTHROPIC_API_KEY:
        print("ANTHROPIC_API_KEY not set — nothing to do.", file=sys.stderr)
        sys.exit(1)
    if not supabase_client.configured():
        print("SUPABASE_URL/SUPABASE_SERVICE_KEY not set — nowhere to read tasks from.", file=sys.stderr)
        sys.exit(1)

    pending = supabase_client.select(
        "hermes_tasks",
        {"status": "eq.pending", "order": "created_at.asc", "limit": str(MAX_TASKS_PER_RUN)},
    )

    if not pending:
        print("No pending tasks.")
        return

    for task in pending:
        task_id, content = task["id"], task["content"]
        now = datetime.now(timezone.utc).isoformat()
        print(f"\n=== task {task_id}: {content[:120]}")
        try:
            reply = run_task(content)
            supabase_client.update(
                "hermes_tasks",
                {"id": f"eq.{task_id}"},
                {"status": "done", "result": reply, "processed_at": now},
            )
            supabase_client.insert(
                "hermes_log",
                {"kind": "task", "summary": content[:200], "detail": reply},
                prefer="return=minimal",
            )
            tools.notify("Hermes", reply[:400] if reply else "(done, no reply text)")
            print(f"done: {reply[:200]}")
        except Exception as e:
            print(f"FAILED task {task_id}: {e}", file=sys.stderr)
            supabase_client.update(
                "hermes_tasks",
                {"id": f"eq.{task_id}"},
                {"status": "error", "result": str(e), "processed_at": now},
            )
            supabase_client.insert(
                "hermes_log",
                {"kind": "error", "summary": content[:200], "detail": str(e)},
                prefer="return=minimal",
            )


if __name__ == "__main__":
    main()
