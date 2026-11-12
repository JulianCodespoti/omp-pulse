#!/usr/bin/env python3
# Live-local alignment audit: every herdr pane vs the daemon listing.
#
# This is deliberately NOT an isolated-harness suite: both sides (herdr's
# agent list, the daemon's /api/sessions) exist only on the live machine.
# It is STRICTLY READ-ONLY (paged GETs, no prompts, no answers, no writes)
# and talks only to 127.0.0.1 — the same reads the phone performs.
#
# What "aligned" means per pane:
#   - pane reports a session file -> the listing contains it, owned, live;
#     herdr working/blocked reflected as streaming/waiting
#   - pane reports nothing (welcome screen) -> nothing expected
#   - pane reports a MISSING file (stale self-report, e.g. deleted tmp
#     sessions) -> informational only; the daemon must ignore it (it does:
#     fd overlay wins, ghost never resolves)
#
# Exit code = number of mismatches.
#
# Environment:
#   OMP_PULSE_BASE        daemon origin      (default http://127.0.0.1:7682)
#   OMP_PULSE_TOKEN_FILE  bearer token file  (default $XDG_STATE_HOME/omp-pulse/token,
#                                             i.e. ~/.local/state/omp-pulse/token)
import json
import os
import subprocess
import sys
from pathlib import Path
import urllib.request
import urllib.parse

_STATE_HOME = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local/state")
TOKEN_FILE = Path(os.environ.get("OMP_PULSE_TOKEN_FILE") or _STATE_HOME / "omp-pulse/token")
BASE = os.environ.get("OMP_PULSE_BASE", "http://127.0.0.1:7682").rstrip("/")

failures = []


def check(name, ok, detail=""):
    print(("ok    " if ok else "FAIL  ") + name + (f" — {detail}" if detail and not ok else ""))
    if not ok:
        failures.append(name)


def api(path):
    req = urllib.request.Request(BASE + path, headers={"Authorization": f"Bearer {open(TOKEN_FILE).read().strip()}"})
    return json.load(urllib.request.urlopen(req, timeout=15))


try:
    sessions = {}
    cursor = None
    while True:
        query = urllib.parse.urlencode({"limit": 50, **({"cursor": cursor} if cursor else {})})
        page = api("/api/sessions?" + query)
        sessions.update((s["path"], s) for s in page["sessions"])
        cursor = page.get("nextCursor")
        if not cursor:
            break
except Exception as e:
    print(f"FAIL  daemon listing unreachable: {e}")
    sys.exit(1)

try:
    agents = json.loads(
        subprocess.run(["herdr", "agent", "list"], capture_output=True, text=True, timeout=15).stdout
    )["result"]["agents"]
except Exception as e:
    print(f"FAIL  herdr agent list unreachable: {e}")
    sys.exit(1)

for a in agents:
    pane, st = a["pane_id"], a.get("agent_status")
    sess = (a.get("agent_session") or {}).get("value")
    title = (a.get("terminal_title_stripped") or "")[:40]
    tag = f"[{pane}] {st}"
    if not sess:
        print(f"ok    {tag} no session reported ({title}) — nothing expected")
        continue
    s = sessions.get(sess)
    if s is None:
        if Path(sess).is_file():
            check(f"{tag} {title}", False, f"session file exists but is absent from listing: {sess}")
        else:
            print(f"note  {tag} reports missing file ...{sess[-45:]} — no file to list")
        continue
    problems = []
    if st == "working" and s.get("status") != "streaming":
        problems.append(f"herdr=working but status={s.get('status')}")
    if st == "blocked" and s.get("status") != "waiting":
        problems.append(f"herdr=blocked but status={s.get('status')}")
    if not s.get("ownerPid"):
        problems.append("no owner (not live)")
    if not s.get("live"):
        problems.append("live=false")
    check(f"{tag} {title}", not problems, "; ".join(problems))

print("all aligned" if not failures else f"{len(failures)} mismatches")

# Reverse direction: sessions the daemon marks owned — is each owner
# herdr-managed (exact pane state) or heuristic-only (fd/cmdline, no pane)?
# Heuristic owners are legitimate (plain kitty/tmux TUIs) but worth seeing.
import os

herdr_panes = set()
try:
    for a in agents:
        herdr_panes.add(a["pane_id"])
except Exception:
    pass
heuristic = []
for path, s in sessions.items():
    pid = s.get("ownerPid")
    if not pid:
        continue
    try:
        env = open(f"/proc/{pid}/environ", "rb").read().split(b"\0")
    except OSError:
        print(f"ok    owner {pid} of ...{path[-40:]} exited mid-audit")
        continue
    pane = next((e.decode().split("=", 1)[1] for e in env if e.startswith(b"HERDR_PANE_ID=")), None)
    if pane is None:
        heuristic.append((pid, path))
    elif pane not in herdr_panes:
        failures.append(path)
        print(f"FAIL  owner {pid} claims pane {pane} herdr no longer lists (...{path[-40:]})")
if heuristic:
    print(f"note  {len(heuristic)} heuristic-only owner(s) (no pane — fd/cmdline proof stands):")
    for pid, path in heuristic[:5]:
        print(f"        pid={pid} ...{path[-50:]}")
sys.exit(1 if failures else 0)
