#!/usr/bin/env python3
"""File-write validation against a disposable daemon; no model or child calls."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import sys
from threading import Barrier
import urllib.error
import urllib.parse
import urllib.request


def run(check):
    required = ("OMP_PULSE_TEST_BASE", "OMP_PULSE_TEST_TOKEN", "OMP_PULSE_TEST_TMP",
                "OMP_PULSE_TEST_SESSIONS", "OMP_PULSE_TEST_STATE_DIR", "OMP_PULSE_TEST_DAEMON_PID")
    if any(not os.environ.get(key) for key in required):
        raise SystemExit("run through e2e/with-test-daemon.sh")
    base = os.environ["OMP_PULSE_TEST_BASE"]
    parsed = urllib.parse.urlsplit(base)
    if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1"
            or not parsed.port or parsed.port == 7682 or parsed.path or parsed.query):
        raise SystemExit("isolated loopback daemon required")
    root = Path(os.environ["OMP_PULSE_TEST_TMP"]).resolve()
    sessions = Path(os.environ["OMP_PULSE_TEST_SESSIONS"]).resolve()
    state = Path(os.environ["OMP_PULSE_TEST_STATE_DIR"]).resolve()
    if root == Path("/") or not sessions.is_relative_to(root) or not state.is_relative_to(root):
        raise SystemExit("fixture directories must belong to the disposable harness")
    project = root / "file-write-validation"
    project.mkdir(exist_ok=False)
    session_dir = sessions / "file-write-validation"
    session_dir.mkdir(exist_ok=False)
    session = session_dir / "synthetic.jsonl"
    session.write_text(json.dumps({"type": "session", "version": 1, "id": "file-write-validation",
                                   "cwd": str(project)}) + "\n", encoding="utf-8")
    original = "original café 👋\n\tkeep these bytes\n".encode()
    target = project / "existing.txt"

    def post(path, fields):
        body = {"sessionPath": str(session), "path": path, **fields}
        request = urllib.request.Request(base + "/api/file", method="POST",
            headers={"Authorization": "Bearer " + os.environ["OMP_PULSE_TEST_TOKEN"],
                     "Content-Type": "application/json"}, data=json.dumps(body, ensure_ascii=False).encode())
        try:
            response = urllib.request.urlopen(request, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read())

    def read(path):
        query = urllib.parse.urlencode({"session": str(session), "path": path})
        request = urllib.request.Request(base + "/api/file?" + query,
            headers={"Authorization": "Bearer " + os.environ["OMP_PULSE_TEST_TOKEN"]})
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read())

    invalid = [("missing", {}), ("null", {"content": None}), ("number", {"content": 3}),
               ("boolean", {"content": False}), ("array", {"content": []}),
               ("object", {"content": {"text": "not a string"}})]
    for name, fields in invalid:
        target.write_bytes(original)
        status, body = post("existing.txt", {"expectedContent": original.decode(), **fields})
        check(f"file content {name}: HTTP 400 and error envelope",
              status == 400 and body.get("ok") is False and body.get("error") == "content must be a string",
              (status, body))
        check(f"file content {name}: existing bytes preserved", target.read_bytes() == original)
        relative = f"absent-{name}/nested/new.txt"
        status, body = post(relative, {"expectedContent": None, **fields})
        check(f"file content {name}: absent target refused", status == 400 and body.get("ok") is False,
              (status, body))
        check(f"file content {name}: no parent created", not (project / f"absent-{name}").exists())

    for name, content in [("empty", ""), ("text", "new text"), ("unicode", "  café 👋\n\t  "),
                          ("1MiB UTF-8 boundary", "é" * (512 * 1024))]:
        status, body = post("existing.txt", {"content": content,
                                           "expectedContent": target.read_text(encoding="utf-8")})
        check(f"valid file content {name}: saved exact bytes",
              status == 200 and body.get("ok") is True and target.read_bytes() == content.encode(),
              (status, body))
    for name, content in [("two full snapshots", "x" * (1024 * 1024)),
                          ("JSON-escaped snapshots", "\t" * (1024 * 1024))]:
        target.write_text(content, encoding="utf-8")
        replacement = "y" + content[1:]
        status, body = post("existing.txt", {"content": replacement, "expectedContent": content})
        check(f"conditional file payload {name}: saved exact bytes",
              status == 200 and body.get("ok") is True and target.read_bytes() == replacement.encode(),
              (status, body))
    target.write_bytes(original)
    status, body = post("existing.txt", {"content": "é" * (512 * 1024) + "x",
                                       "expectedContent": original.decode()})
    check("oversized file content: refused without mutation",
          status == 413 and body.get("ok") is False and target.read_bytes() == original, (status, body))
    status, body = post("created/nested/new.txt", {"content": "intentional new file\n", "expectedContent": None})
    check("valid new file: parent creation retained",
          status == 200 and body.get("ok") is True
          and (project / "created/nested/new.txt").read_bytes() == b"intentional new file\n", (status, body))

    target.write_bytes(original)
    for name, expected, status_expected in [
            ("missing", {}, 428), ("number", {"expectedContent": 3}, 400),
            ("boolean", {"expectedContent": False}, 400), ("array", {"expectedContent": []}, 400),
            ("object", {"expectedContent": {}}, 400)]:
        status, body = post("existing.txt", {"content": "phone edit", **expected})
        check(f"file precondition {name}: refused without mutation",
              status == status_expected and body.get("ok") is False and target.read_bytes() == original,
              (status, body))

    baseline = read("existing.txt")["content"]
    target.write_text("agent edit", encoding="utf-8")
    status, body = post("existing.txt", {"content": "phone edit", "expectedContent": baseline})
    check("agent write after GET: stale POST conflicts and preserves agent bytes",
          status == 409 and body.get("code") == "file_conflict"
          and target.read_bytes() == b"agent edit", (status, body))
    status, body = post("existing.txt", {"content": "create-only", "expectedContent": None})
    check("create-only never overwrites an existing file",
          status == 409 and target.read_bytes() == b"agent edit", (status, body))

    target.write_bytes(original)
    barrier = Barrier(3)
    def save_together(content):
        barrier.wait()
        return content, post("existing.txt", {"content": content, "expectedContent": original.decode()})
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(save_together, content) for content in ("first phone", "second phone")]
        barrier.wait()
        results = [future.result() for future in futures]
    successes = [content for content, (status, body) in results if status == 200 and body.get("ok") is True]
    conflicts = [content for content, (status, body) in results if status == 409 and body.get("code") == "file_conflict"]
    check("concurrent conditional saves: one success, one conflict, winning bytes intact",
          len(successes) == 1 and len(conflicts) == 1
          and target.read_bytes() == successes[0].encode(), results)


if __name__ == "__main__":
    results = []
    def check(name, condition, detail=""):
        results.append(bool(condition))
        print(("PASS " if condition else "FAIL ") + name + (f" {detail}" if detail else ""))
    run(check)
    print(f"{sum(results)} passed, {len(results) - sum(results)} failed")
    sys.exit(0 if all(results) else 1)
