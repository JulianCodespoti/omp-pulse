#!/usr/bin/env python3
"""Provider-free HTTP smoke for project boundaries, branches and draft recovery."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import urllib.error
import urllib.parse
import urllib.request
import uuid

required = ("BASE", "TOKEN", "SESSIONS", "STATE_DIR", "TMP")
if any(not os.environ.get("OMP_PULSE_TEST_" + name) for name in required):
    raise SystemExit("run through e2e/with-test-daemon.sh")
base = os.environ["OMP_PULSE_TEST_BASE"]
if not base.startswith("http://127.0.0.1:"):
    raise SystemExit("an isolated loopback daemon is required")
token = os.environ["OMP_PULSE_TEST_TOKEN"]
root = Path(os.environ["OMP_PULSE_TEST_SESSIONS"]) / "issue-regressions"
work = Path(os.environ["OMP_PULSE_TEST_TMP"]) / "issue-projects"
root.mkdir()
work.mkdir()


def request(route, query=None, body=None):
    url = base + route + ("?" + urllib.parse.urlencode(query) if query else "")
    req = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + token, "Content-Type": "application/json",
    }, data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


def api(route, query=None, body=None):
    status, result = request(route, query, body)
    assert status == 200 and result.get("ok", True), (status, result.get("error"))
    return result


def session(name, cwd):
    sid = str(uuid.uuid4())
    path = root / ("2026-10-31T00-00-00-000Z_" + sid + ".jsonl")
    entries = [
        {"type": "session", "version": 1, "id": sid, "cwd": str(cwd),
         "timestamp": "2026-10-31T00:00:00.000Z"},
        {"type": "message", "id": "user", "parentId": None,
         "message": {"role": "user", "content": [{"type": "text", "text": "issue-scope-probe"}]}},
    ]
    for reply, outcome in (("first", "stop"), ("second", "stop"), ("failed", "error")):
        entries.append({"type": "message", "id": reply, "parentId": "user",
                        "message": {"role": "assistant", "stopReason": outcome,
                                    "content": [{"type": "text", "text": name + " " + reply}]}})
    path.write_text("".join(json.dumps(entry) + "\n" for entry in entries))
    return str(path)


alpha = work / "alpha"
beta = work / "beta"
alpha.mkdir()
beta.mkdir()
first = session("alpha", alpha)
second = session("beta", beta)
missing = session("missing", work / "removed-project")
for cwd, expected in ((alpha, first), (beta, second)):
    result = api("/api/search", {"q": "issue-scope-probe", "project": str(cwd)})
    assert [hit["path"] for hit in result["hits"]] == [expected]
    assert result["scannedFiles"] == 1 and result["truncated"] is False
result = api("/api/search", {"q": "issue-scope-probe", "project": str(work / "unrelated")})
assert result["hits"] == [] and result["scannedFiles"] == 0
print("PASS transcript search is project-scoped before scan limits")

for route, query in (
    ("/api/files", {"session": missing}),
    ("/api/files", {"session": missing, "search": "probe"}),
    ("/api/file", {"session": missing, "path": "probe.txt"}),
):
    _, result = request(route, query)
    assert result["ok"] is False and result["code"] == "project_folder_unavailable"
for path in (first, missing):
    status, result = request("/api/raw", {"session": path, "path": "missing.txt"})
    assert status == 404 and result["ok"] is False
print("PASS unavailable projects never expose a fallback; missing downloads return 404")

rows = api("/api/tree", {"session": first})["rows"]
turn = next(row for row in rows if row["id"] == "user")
assert [reply["id"] for reply in turn["resumeTargets"]] == ["first", "second"]
print("PASS completed sibling replies retain distinct continuation targets")


def git(*args, check=True):
    # A throwaway repo must not depend on the operator's global signing setup
    # (commit.gpgsign with an agent that is not running exits 128).
    return subprocess.run(["git", "-c", "commit.gpgsign=false", "-C", str(alpha), *args], check=check,
                          capture_output=True, text=True)


git("init", "-q", "--initial-branch=main")
git("config", "user.email", "fixture@example.invalid")
git("config", "user.name", "Issue fixture")
conflict = alpha / "conflict.txt"
conflict.write_text("base\n")
git("add", "conflict.txt")
git("commit", "-qm", "base")
git("checkout", "-qb", "side")
conflict.write_text("side\n")
git("commit", "-qam", "side")
git("checkout", "-q", "main")
conflict.write_text("main\n")
git("commit", "-qam", "main")
assert git("merge", "side", check=False).returncode == 1
conflict.write_text("main\n")
changes = api("/api/changes", {"session": first})
assert next(item for item in changes["files"] if item["path"] == "conflict.txt")["status"] == "conflicted"
git("add", "conflict.txt")
changes = api("/api/changes", {"session": first})
assert all(item["status"] != "conflicted" for item in changes["files"])
# Descriptor-relative cleanup also works with read-only Git objects under proot.
shutil.rmtree(alpha / ".git")
print("PASS unresolved index conflicts survive marker removal and end after staging")

# Seed a real on-disk recovery record, as after a lost HTTP response. Writer
# cancellation/persistence is covered separately by the native capture tests.
recovery_id = "1" * 32
journal = Path(os.environ["OMP_PULSE_TEST_STATE_DIR"]) / "queue-recovery" / hashlib.sha256(first.encode()).hexdigest()
journal.mkdir(parents=True)
record_path = journal / (recovery_id + ".json")
data = {"recoveryId": recovery_id, "removed": True, "text": "Retained [Image 1]",
        "images": [{"mimeType": "image/png", "data": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4l8AAAAASUVORK5CYII="}]}
record_path.write_text(json.dumps({"id": recovery_id, "kind": "message", "sessionPath": first, "data": data}))
children_before = api("/api/status")["children"]
command = {"sessionPath": first, "command": "get_queue_recovery", "params": {}}
for _ in range(2):
    recovery = api("/api/rpc", body=command)["data"]
    assert recovery["recoveries"][0]["data"] == data
wrong_owner = {"sessionPath": second, "command": "acknowledge_queue_recovery", "params": {"recoveryId": recovery_id}}
api("/api/rpc", body=wrong_owner)
assert record_path.is_file()
api("/api/rpc", body={**wrong_owner, "sessionPath": first})
assert not record_path.exists()
assert api("/api/rpc", body=command)["data"]["recoveries"] == []
assert api("/api/status")["children"] == children_before
print("PASS withdrawal replay retains text/photos until same-session acknowledgement, without spawning a child")
