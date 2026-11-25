#!/usr/bin/env python3
"""Build a Spawn Gate v1 launch from a Work Board task."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys


ROLE_RULES = {
    "impl": "Implement the approved plan. Hand over one commit on fresh origin/main without a version bump.",
    "review": "Review the exact range below and report actionable findings. Leave the implementation unchanged.",
    "check": "Run the checks or captures in the approved plan. Record the result and supporting evidence on the card.",
    "plan-review": "Wait for the Work Board review assignment, then review the submitted plan version and record your decision on the card.",
}
TASK_KEY = re.compile(r"[A-Z][A-Z0-9]{0,9}-[0-9]{1,12}")
SCOPE = re.compile(r"Scope: plugins/([a-z0-9][a-z0-9_-]*)/?")
REVIEW_RANGE = re.compile(r"Review range: ([0-9a-f]{40})\.\.([0-9a-f]{40})")


class Refusal(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class Arguments(argparse.ArgumentParser):
    def error(self, _message):
        raise Refusal("invalid_arguments", "Pass --card <key> and --role <role>, once each.")


def bb(*args):
    try:
        result = subprocess.run(
            [os.environ.get("BB_CLI", "bb"), *args, "--json"],
            capture_output=True, text=True, timeout=15,
        )
        data = json.loads(result.stdout)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        raise Refusal("board_unavailable", "Check that the BB server and Work Board are reachable.") from None
    if data.get("error", {}).get("code") == "task_not_found":
        raise Refusal("card_not_found", "Use the key of an existing Work Board task.")
    if result.returncode or data.get("ok") is False:
        raise Refusal("board_unavailable", "Check that the BB server and Work Board are reachable.")
    return data


def read_config(project_id):
    default = Path.home() / ".bb" / "spawn-gate" / "work-board" / f"{project_id}.json"
    path = Path(os.environ.get("BB_SPAWN_GATE_WORK_BOARD_CONFIG", default))
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError:
        raise Refusal("config_missing", "Install a readable server-local Work Board builder config.") from None
    except ValueError:
        raise Refusal("invalid_config", "Repair the server-local Work Board builder JSON.") from None
    if not isinstance(data, dict) or not re.fullmatch(r"thr_[a-z0-9]+", str(data.get("managerThreadId"))) or not all(
        isinstance(data.get(field), dict) for field in ("owners", "roles")
    ):
        raise Refusal("invalid_config", "Configure managerThreadId, owners and roles in the server-local file.")
    if data.get("environment", "managed-worktree") not in ("managed-worktree", "reuse-parent"):
        raise Refusal("invalid_config", "Set environment to managed-worktree or reuse-parent.")
    return data


def plugin_scope(description, config, parent):
    lines = [line.rstrip() for line in description.splitlines() if line.startswith("Scope:")]
    owner_scopes = [plugin for plugin, thread in config["owners"].items() if thread == parent]
    if not lines and len(owner_scopes) == 1:
        lines = [f"Scope: plugins/{owner_scopes[0]}/"]
    match = SCOPE.fullmatch(lines[0]) if len(lines) == 1 else None
    if not match:
        raise Refusal("invalid_scope", "Add one card line such as Scope: plugins/example/.")
    plugin = match[1]
    owner = config["owners"].get(plugin)
    if not isinstance(owner, str) or not re.fullmatch(r"thr_[a-z0-9]+", owner):
        raise Refusal("scope_not_allowed", "Register the card's plugin and its owner in the local config.")
    if parent not in (owner, config["managerThreadId"]):
        raise Refusal("scope_not_allowed", "Have the plugin owner or manager launch this card.")
    return f"plugins/{plugin}/", owner


def role_route(config, role, excluded):
    candidates = config["roles"].get(role)
    if not isinstance(candidates, list) or not 1 <= len(candidates) <= 16 or any(
        not isinstance(item, dict) or set(item) - {"providerId", "model", "reasoningLevel"}
        or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,99}", str(item.get("providerId")))
        or not all(isinstance(value, str) and 1 <= len(value) <= 1000 for value in item.values())
        or "model" not in item
        for item in candidates
    ) or len({item["providerId"] for item in candidates}) != len(candidates):
        raise Refusal("invalid_config", "Set distinct provider IDs and models for each role in the local config.")
    eligible = [item for item in candidates if item["providerId"] != excluded]
    if not eligible:
        raise Refusal("no_eligible_provider", "Configure an eligible reviewer provider distinct from the author's.")
    return eligible[0], {"eligible": [{"providerId": item["providerId"], "model": item["model"]} for item in eligible]}


def quote(text):
    return "\n".join(f"> {line}" for line in text.splitlines())


def assemble(card, config, request, role):
    task, plan = card["task"], card.get("plan")
    parent = request["parentThreadId"]
    if card["project"]["linkedBbProjectId"] != request["projectId"]:
        raise Refusal("wrong_project", "Use a task linked to the launch project's BB project.")
    if task.get("archivedAt") or task["status"] in {"done", "canceled"}:
        raise Refusal("card_closed", "Use an open Work Board task.")
    if task["type"] != "task":
        raise Refusal("unsupported_card_type", "Use the key of a Work Board task within the epic.")
    if any(item["status"] != "done" for item in card["dependencies"]["blockedBy"]):
        raise Refusal("open_dependency", "Wait until all blocking Work Board tasks are Done.")
    if role == "plan-review" and (not plan or not plan.get("body")):
        raise Refusal("missing_plan", "Save the plan before launching its reviewer.")
    if role != "plan-review" and (not plan or plan["state"] != "approved"):
        raise Refusal("no_approved_plan", "Get the current plan version approved before launching this role.")
    scope, owner = plugin_scope(task.get("description") or "", config, parent)
    excluded, review = None, ""
    if role == "review":
        for comment in reversed(card["comments"]):
            match = REVIEW_RANGE.fullmatch(comment["body"].strip())
            provider = (comment.get("provider") or {}).get("id")
            if match and comment.get("kind") == "agent" and comment.get("threadId") and provider:
                excluded = provider
                review = f"Review base `{match[1]}` and head `{match[2]}`.\n"
                break
        if not review:
            raise Refusal("missing_review_range", "Have the implementation agent post: Review range: <full BASE SHA>..<full HEAD SHA>.")
    reuse_parent = config.get("environment") == "reuse-parent"
    parent_thread = bb("thread", "show", parent)["thread"] if reuse_parent or role == "plan-review" else {}
    if role == "plan-review":
        excluded = parent_thread["providerId"]
    if reuse_parent and not parent_thread.get("environmentId"):
        raise Refusal("missing_parent_environment", "Launch from a parent thread with an attached BB environment.")
    execution, policy = role_route(config, role, excluded)
    key, title = task["key"], " ".join(task["title"].split())
    brief = (
        f"{key} · {role} · {title}\n\n"
        f"{ROLE_RULES[role]}\n"
        f"Keep work within `{scope}`. Report to @thread:{parent}. Plugin owner: @thread:{owner}.\n"
        f"{review}\n## Card ({task['status']})\n{quote(task.get('description') or '')}\n\n"
        f"## Plan v{plan['version']} ({plan['state']})\n{quote(plan['body'])}\n"
    )
    spawn = {
        **execution, "parentThreadId": parent, "title": f"{key} {role}: {title}"[:120],
        "parentNotifications": "stuck",
    }
    if reuse_parent:
        spawn["environment"] = {"type": "reuse", "environmentId": parent_thread["environmentId"]}
    elif role in {"impl", "review"}:
        spawn["environment"] = {"type": "host", "workspace": {"type": "managed-worktree", "baseBranch": {"kind": "default"}}}
    return {"version": 1, "brief": brief, "spawn": spawn, "providerPolicy": policy}


def main():
    parser = Arguments(allow_abbrev=False, add_help=False)
    parser.add_argument("--card", required=True, action="append")
    parser.add_argument("--role", required=True, action="append")
    args = parser.parse_args()
    if len(args.card) != 1 or len(args.role) != 1 or not TASK_KEY.fullmatch(args.card[0]):
        parser.error(None)
    role = args.role[0]
    if role not in ROLE_RULES:
        raise Refusal("unknown_role", "Choose impl, review, check or plan-review.")
    try:
        request = json.load(sys.stdin)
    except ValueError:
        request = None
    if not isinstance(request, dict) or type(request.get("version")) is not int or request["version"] != 1 or not all(
        re.fullmatch(pattern, str(request.get(key)))
        for key, pattern in (("projectId", r"proj_[a-z0-9]+"), ("parentThreadId", r"thr_[a-z0-9]+"))
    ):
        raise Refusal("invalid_request", "Run through Spawn Gate with a project and parent thread.")
    config = read_config(request["projectId"])
    print(json.dumps(assemble(bb("work-board", "show", args.card[0], "--with-plan"), config, request, role)))


if __name__ == "__main__":
    try:
        main()
    except (TypeError, ValueError, AttributeError, KeyError, IndexError):
        print('{"reasonCode":"builder_error"}', file=sys.stderr)
        print("The Work Board payload could not be read. Inspect the card and the local builder config.", file=sys.stderr)
        sys.exit(1)
    except Refusal as error:
        print(json.dumps({"reasonCode": error.code}), file=sys.stderr)
        print(error, file=sys.stderr)
        sys.exit(1)
