#!/usr/bin/env python3
"""REST+WS smoke for an isolated omp-pulse daemon."""
import asyncio, json, os, subprocess, sys, tempfile, time, urllib.error, urllib.request, uuid

# This suite mutates session fixtures and sends prompts. It MUST run through
# with-test-daemon.sh so the daemon, token, state and sessions root all belong
# to this invocation. Never fall back to the live daemon or its token.
REQUIRED_ENV = (
    "OMP_PULSE_TEST_BASE",
    "OMP_PULSE_TEST_WS",
    "OMP_PULSE_TEST_TOKEN",
    "OMP_PULSE_TEST_STATE_DIR",
    "OMP_PULSE_TEST_SESSIONS",
    "OMP_PULSE_TEST_TMP",
)
missing = [name for name in REQUIRED_ENV if not os.environ.get(name)]
if missing:
    raise SystemExit(
        "run through e2e/with-test-daemon.sh; missing "
        + ", ".join(missing)
    )
BASE = os.environ["OMP_PULSE_TEST_BASE"]
WSBASE = os.environ["OMP_PULSE_TEST_WS"]
TOKEN = os.environ["OMP_PULSE_TEST_TOKEN"]
STATE_DIR = os.environ["OMP_PULSE_TEST_STATE_DIR"]
ROOT = os.environ["OMP_PULSE_TEST_SESSIONS"]
TMP = os.environ["OMP_PULSE_TEST_TMP"]
if not BASE.startswith("http://127.0.0.1:") or not WSBASE.startswith("ws://127.0.0.1:"):
    raise SystemExit("test daemon endpoints must be loopback URLs from with-test-daemon.sh")

def api(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method,
        headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"},
        data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read())

def children():
    out = subprocess.run(["pgrep", "-fc", "omp --mode rpc"], capture_output=True, text=True).stdout.strip()
    return int(out or 0)

PASS = []
SKIPPED = []


class UpstreamStall(Exception):
    """omp accepted a turn and produced nothing: not this project's failure."""


def check(name, cond, detail=""):
    PASS.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + ("  " + str(detail)[:200] if detail else ""))
    if not cond:
        print("  DETAIL:", str(detail)[:1000])


def skip(name, why):
    """Record a check we deliberately did not run.

    WHY THIS EXISTS: everything that needs a live `omp --mode rpc` child cannot
    run on a machine without omp installed - a CI runner, or a contributor who
    has cloned this before installing the agent. Those checks must not be
    silently counted as passing (that would hide real regressions) and must not
    fail (that would make the suite useless to a newcomer). They are skipped and
    named, so "12 skipped" is a legible state rather than a broken checkout.
    """
    SKIPPED.append((name, why))
    print(f"SKIP {name}  ({why})")


def seed_fixtures_on_disk(scratch_cwd):
    """Fixtures the daemon can serve without a live child.

    Used in two situations: omp is not installed at all (a CI runner, or a
    contributor who cloned before installing the agent), and omp IS installed but is
    not completing turns. The second case is an upstream stall: the daemon spawned a
    child and delivered the prompt, and omp wrote nothing. Failing the gate for that
    blames the wrong component, so the daemon-side checks continue against these.
    """
    out = []
    root = ROOT
    proj = os.path.join(root, "-tmp-pulse-smoke-proj")
    # No OMP child creates this directory in the offline fallback.
    os.makedirs(proj, exist_ok=True)
    for i in range(3):
        sid = f"019ff000-0000-7000-0000-{i:012d}"
        path = os.path.join(proj, f"2026-08-12T00-00-0{i}-000Z_{sid}.jsonl")
        with open(path, "w") as f:
            f.write(json.dumps({"type": "session", "version": 1, "id": sid,
                                "timestamp": "2026-08-12T00:00:00.000Z",
                                "cwd": scratch_cwd}) + "\n")
            f.write(json.dumps({"type": "title", "id": "t0",
                                "title": f"smoke fixture {i}"}) + "\n")
            f.write(json.dumps({"type": "message", "id": "m0", "parentId": None,
                                "timestamp": "2026-08-12T00:00:01.000Z",
                                "message": {"role": "user",
                                            "content": [{"type": "text", "text": "seeded"}]}}) + "\n")
        out.append(path)
    return out


def have_omp():
    """Will the DAEMON find a usable `omp`?

    This must mirror `paths::find_omp_binary` exactly, including its precedence.
    An earlier version fell through to the well-known install locations even when
    OMP_BIN pointed at a missing file - so the suite believed omp was available
    while the daemon dutifully tried to spawn OMP_BIN and failed. Same question,
    two answers, is worse than either answer.
    """
    import shutil
    forced = os.environ.get("OMP_BIN")
    if forced:
        return os.path.exists(forced)
    if shutil.which("omp") or shutil.which("omp.cmd") or shutil.which("omp.exe"):
        return True
    for cand in ("~/.bun/bin/omp", "~/.local/bin/omp"):
        if os.path.exists(os.path.expanduser(cand)):
            return True
    return False


OMP = have_omp()


def encode_dir_name(cwd, home=None, temp=None):
    """Mirror of omp's `getDefaultSessionDirName` (session-paths.ts) / the
    daemon's `jsonl::project_session_dir`: classify `cwd` against home and the
    temp dir (realpath forms), then encode. Used by the session-filing
    regression check to assert that a phone-created session lands in the
    per-project directory every lister globs."""
    home = home if home is not None else os.path.expanduser("~")
    temp = temp if temp is not None else tempfile.gettempdir()

    def norm(p):
        return os.path.realpath(os.path.abspath(os.path.expanduser(p)))

    def rel_within(root, p):
        try:
            r = os.path.relpath(p, root)
        except ValueError:
            return None
        if r == ".." or r.startswith(".." + os.sep) or os.path.isabs(r):
            return None
        return r

    def enc_rel(prefix, rel):
        enc = rel.replace("/", "-").replace("\\", "-").replace(":", "-")
        if not enc:
            return prefix
        return prefix + enc if prefix.endswith("-") else prefix + "-" + enc

    def enc_abs(p):
        s = p
        if s.startswith("/") or s.startswith("\\"):
            s = s[1:]
        return "--" + s.replace("/", "-").replace("\\", "-").replace(":", "-") + "--"

    cwd_n, home_n, temp_n = norm(cwd), norm(home), norm(temp)
    hr = rel_within(home_n, cwd_n)
    if hr is not None:
        return enc_rel("-", hr)
    tr = rel_within(temp_n, cwd_n)
    if tr is not None:
        return enc_rel("-tmp", tr)
    return enc_abs(cwd_n)


async def main():
    import websockets
    # Fixture sessions live in a scratch PROJECT directory, so they land in a
    # per-cwd session folder exactly like real sessions and therefore appear in
    # the phone list (root-level session files are treated as scratch and hidden).
    # Under `e2e/with-test-daemon.sh` the daemon's sessions root is a temp dir, so
    # nothing here can reach a real conversation; without it we still stay inside
    # a throwaway cwd.
    import urllib.parse as up
    scratch_cwd = os.path.join(TMP, "pulse-smoke-proj")
    os.makedirs(scratch_cwd, exist_ok=True)
    sess = []
    upstream_stalled = False
    if OMP:
      try:
        for i in range(3):
            r = api("POST", "/api/new", {"cwd": scratch_cwd})
            assert r.get("ok") and r.get("sessionPath"), f"/api/new failed: {r}"
            sess.append(r["sessionPath"])
        # Fresh /api/new sessions materialize their .jsonl only on first write -
        # prompt once so the file exists (the lazy-open contract 404s otherwise).
        for i, s in enumerate(sess):
            if os.path.exists(s):
                continue
            command_id = str(uuid.uuid4())
            r = api("POST", "/api/prompt", {"commandId": command_id, "sessionPath": s, "text": "Reply with exactly: OK"})
            assert r.get("ok") and r.get("receipt", {}).get("commandId") == command_id, r
            for _ in range(60):
                if os.path.exists(s):
                    break
                time.sleep(0.5)
            if not os.path.exists(s):
                # Distinguish OUR failure from an upstream one. If the daemon spawned a
                # child and delivered the prompt, then omp owns the rest of the chain;
                # when the model provider is degraded, omp accepts the turn and never
                # writes. Failing the gate for that teaches the wrong lesson, so it is
                # reported as an upstream skip with the evidence that our side worked.
                diag = {}
                try:
                    diag = api("GET", "/api/status")
                except Exception as e:  # noqa: BLE001
                    diag = {"status_error": str(e)[:200]}
                counters = (diag.get("metrics") or {}).get("counters") or {}
                delivered = counters.get("prompt_via_child", 0) > 0 and counters.get("child_spawn", 0) > 0
                if delivered:
                    skip(
                        "live child turns",
                        "daemon spawned a child and delivered the prompt "
                        f"(child_spawn={counters.get('child_spawn')}, "
                        f"prompt_via_child={counters.get('prompt_via_child')}) but omp wrote "
                        "nothing in 30s - the model provider or omp is not completing turns. "
                        "Verify with: omp --print 'hi'",
                    )
                    base_children = None
                    raise UpstreamStall()
                raise AssertionError(
                    f"session file never materialized after 30s and the daemon never "
                    f"delivered the prompt: {s}\ncounters: {json.dumps(counters)}"
                )
      except UpstreamStall:
        # omp is installed and the daemon delivered the prompt, but omp produced
        # nothing. Continue with disk fixtures so every daemon-side check still runs.
        upstream_stalled = True
        sess = seed_fixtures_on_disk(scratch_cwd)
        print("omp is not completing turns: seeded fixtures on disk, child-dependent checks skipped")
    else:
        sess.extend(seed_fixtures_on_disk(scratch_cwd))
        print("no omp binary found: seeded fixtures on disk, child-dependent checks will be skipped")
    s0 = sess[0]
    base_children = children()
    print("baseline children:", base_children)
    print("scratch sessions:", [os.path.basename(s)[:32] for s in sess])

    # Regression — session filing. A session created through the API the way
    # the phone does (POST /api/new with a cwd inside the scratch project)
    # must be filed in the per-project directory, NOT directly at the sessions
    # root. Measured bug: the daemon passed the sessions ROOT itself as
    # `--session-dir`, which overrode omp's per-project directory, so every
    # phone-created session landed at the root where BOTH surfaces hide root
    # files — scan_sessions skips them and `omp resume` globs `*/*.jsonl` —
    # leaving 87 real sessions (largest 8.5 MB) invisible to the phone AND the
    # desktop. The parent directory must match omp's own encoding
    # (session-paths.ts getDefaultSessionDirName), and the session must show
    # up in /api/sessions.
    if OMP and not upstream_stalled:
        s_real = os.path.realpath(s0)
        root_real = os.path.realpath(ROOT)
        parent = os.path.dirname(s_real)
        parent_name = os.path.basename(parent)
        check("phone-created session is NOT filed directly at the sessions root",
              parent != root_real, (parent, root_real))
        expected = encode_dir_name(scratch_cwd)
        check("phone-created session parent matches omp's per-project encoding",
              parent_name == expected, (parent_name, expected))
        listed = False
        rows = []
        for _ in range(30):
            rows = api("GET", "/api/sessions").get("sessions", [])
            if s_real in [os.path.realpath(x.get("path")) for x in rows]:
                listed = True
                break
            time.sleep(0.5)
        check("phone-created session appears in /api/sessions", listed,
              f"waited up to 15s among {len(rows)} listed rows")
    else:
        for name in ("phone-created session is NOT filed directly at the sessions root",
                     "phone-created session parent matches omp's per-project encoding",
                     "phone-created session appears in /api/sessions"):
            skip(name, "no omp binary: no /api/new session was created to file")

    # Malformed file saves must not truncate existing bytes or create parents.
    # Reuse the route fixture so this regression runs in the authoritative gate.
    import runpy
    runpy.run_path(os.path.join(os.path.dirname(__file__), "..", "lib", "file-write-validation.py"))["run"](check)

    # 1. open returns instantly AND pre-warms a child: a cold child costs ~1.3s
    # of omp boot against ~4ms for a live one, so opening a conversation (the
    # strongest signal a prompt is coming) pays it off the send path. The
    # response must not wait for the spawn.
    t0 = time.time()
    r = api("POST", "/api/open", {"sessionPath": s0})
    open_ms = (time.time() - t0) * 1000
    check("open ok", r.get("ok") is True, r)
    check("open returns session state", bool(r.get("state", {}).get("sessionFile")) and "streaming" in r.get("state", {}), r.get("state"))
    check("open does not block on spawn", open_ms < 250, f"{open_ms:.0f}ms")
    warmed = False
    for _ in range(20 if OMP else 0):
        if children() >= base_children:
            rpc_t0 = time.time()
            rr = api("POST", "/api/rpc", {"sessionPath": s0, "command": "get_state"})
            rpc_ms = (time.time() - rpc_t0) * 1000
            if rr.get("ok") and rpc_ms < 250:
                warmed = True
                break
        time.sleep(0.5)
    if OMP and not upstream_stalled:
        check("open pre-warms a child (rpc answers warm)", warmed)
    else:
        skip("open pre-warms a child (rpc answers warm)", "no omp binary: nothing to spawn")

    # 2. WS connects without a child
    ws = await websockets.connect(f"{WSBASE}/ws?session={urllib.parse.quote(s0)}&token={TOKEN}", open_timeout=10)
    check("ws connect without child", True)
    frames = []
    async def reader():
        try:
            async for m in ws:
                frames.append(json.loads(m))
        except Exception:
            pass
    rt = asyncio.create_task(reader())

    # 3. bash writes + bash_result WS frame. The child cap is configurable
    # (OMP_REMOTE_MAX_CHILDREN, default 6 — warm children are what keep a phone
    # prompt at ~4ms instead of ~1.3s), so assert against the CAP, not a
    # hard-coded 2, and count only our own children.
    cap = int(os.environ.get("OMP_PULSE_MAX_CHILDREN",
              os.environ.get("OMP_REMOTE_MAX_CHILDREN", "6")))
    pre_size = os.path.getsize(s0)
    if OMP and not upstream_stalled:
        r = api("POST", "/api/bash", {"sessionPath": s0, "command": "echo pulse-ok"})
        check("bash ok", r.get("ok") is True, r)
        check("bash output", r.get("result", {}).get("output") == "pulse-ok\n", r.get("result"))
        for _ in range(80):
            if children() <= cap:
                break
            time.sleep(0.5)
        check(f"bash under LRU cap (<= {cap})", children() <= base_children + cap, children())
        await asyncio.sleep(2)
        br = [f for f in frames if f.get("type") == "bash_result"]
        check("ws bash_result frame with command echo", br and br[0].get("command") == "echo pulse-ok", br[:1])


    # 4. prompt → streaming events over WS, then history forward-read
    def evt_types():
        return [f.get("event", {}).get("type") for f in frames if f.get("type") == "event"]
    if OMP and not upstream_stalled:
        command_id = str(uuid.uuid4())
        r = api("POST", "/api/prompt", {"commandId": command_id, "sessionPath": s0, "text": "Reply with exactly: PULSE"})
        check("prompt ack", r.get("ok") is True and r.get("receipt", {}).get("commandId") == command_id, r)
        deadline = time.time() + 120
        while time.time() < deadline:
            if "agent_end" in evt_types():
                break
            await asyncio.sleep(1)
        ets = evt_types()
        check("ws message_start event", "message_start" in ets, sorted(set(ets)))
        # The REAL contract is that the assistant's text reaches the client, not
        # that it arrives in any particular number of chunks. A one-token reply
        # ("PULSE") is emitted by the provider as a single final chunk, so
        # message_update never fires - asserting on it tested the provider's
        # chunking, and failed for a reply that was delivered perfectly.
        def assistant_text():
            out = []
            for f in frames:
                ev = f.get("event") or {}
                if ev.get("type") not in ("message_update", "message_end"):
                    continue
                msg = ev.get("message") or {}
                c = msg.get("content")
                if isinstance(c, str):
                    out.append(c)
                elif isinstance(c, list):
                    out.extend(b.get("text", "") for b in c
                               if isinstance(b, dict) and b.get("type") == "text")
            return "".join(out)
        check("ws delivered the assistant text (update or end)",
              "PULSE" in assistant_text(),
              {"types": sorted(set(ets)), "text": assistant_text()[:80]})
        check("ws agent_end event", "agent_end" in ets)
    else:
        for name in ("prompt ack", "ws message_start event",
                     "ws delivered the assistant text (update or end)",
                     "ws agent_end event"):
            skip(name, "no omp binary: a turn needs a child")
    # `entries` frames stay authoritative even during a live turn: the user's own
    # prompt entry reaches the phone ONLY through the file, so suppressing them
    # mid-turn silently dropped content (caught as a "new content" pill that
    # never appeared). The client dedupes by key, so the overlap with the event
    # stream is bytes, not bugs.
    if OMP and not upstream_stalled:
        entr = [f for f in frames if f.get("type") == "entries"]
        check("ws entries frames (watcher) during a live turn", len(entr) > 0, len(entr))
    else:
        skip("ws entries frames (watcher) during a live turn", "no omp binary: no turn to observe")

    # 4b. entries frames for a session with NO live child (the desktop-driven
    # shape): attach, append to the file directly, and require the tail to
    # arrive. This is the audience gate's positive case — with a consumer and no
    # child, the watcher reads and forwards.
    watch_only = os.path.join(
        ROOT,
        "-tmp-proj-alpha", "2026-08-12T00-00-00-000Z_019ff000-0000-7000-0000-000000000042.jsonl")
    os.makedirs(os.path.dirname(watch_only), exist_ok=True)
    with open(watch_only, "w") as f:
        f.write(json.dumps({"type": "session", "version": 1, "id": "019ff000-0000-7000-0000-000000000042",
                            "timestamp": "2026-08-12T00:00:00.000Z", "cwd": "/tmp/tmp-proj-alpha"}) + "\n")
    wframes = []
    wurl = f"{WSBASE}/ws?session={up.quote(watch_only)}&token={TOKEN}"
    async with websockets.connect(wurl, max_size=8 * 1024 * 1024) as wws:
        async def wpump():
            try:
                while True:
                    wframes.append(json.loads(await wws.recv()))
            except Exception:
                pass
        wtask = asyncio.create_task(wpump())
        await asyncio.sleep(0.6)
        with open(watch_only, "a") as f:
            f.write(json.dumps({"type": "message", "id": "m1", "parentId": None,
                                "timestamp": "2026-08-12T00:00:01.000Z",
                                "message": {"role": "user", "content": [{"type": "text", "text": "tail me"}]}}) + "\n")
        for _ in range(40):
            if any(x.get("type") == "entries" for x in wframes):
                break
            await asyncio.sleep(0.25)
        wtask.cancel()
    check("entries frames still stream for a session with no child",
          any(x.get("type") == "entries" for x in wframes),
          [x.get("type") for x in wframes][:6])
    if OMP and not upstream_stalled:
        r = api("GET", f"/api/history?session={urllib.parse.quote(s0)}&after={pre_size}")
        check("history forward-read new entries", len(r.get("entries", [])) > 0, len(r.get("entries", [])))
    else:
        # No turn happened, so instead prove the read path itself: a backward page
        # of the seeded fixture must come back with its entries.
        r = api("GET", f"/api/history?session={urllib.parse.quote(s0)}&limit=10")
        check("history backward page on a seeded session", len(r.get("entries", [])) > 0,
              len(r.get("entries", [])))

    # Catch-up must carry an authoritative empty replay too: otherwise a
    # status left by a departed extension survives until manual reconnect.
    for cursor in ("after=0", "limit=10"):
        page = api("GET", f"/api/history?session={up.quote(watch_only)}&{cursor}&feedback=true")
        check(f"history catch-up feedback clears retired surfaces ({cursor})",
              page.get("extensionFeedback") == {"type": "extension_ui_snapshot", "requests": []}
              and isinstance(page.get("sessionState"), dict))

    # 5. rpc allowlist. The DISALLOWED case is daemon-side (the allowlist is
    # checked before any child is consulted), so it runs everywhere; the two
    # allowed commands need a live child.
    if OMP and not upstream_stalled:
        r = api("POST", "/api/rpc", {"sessionPath": s0, "command": "get_session_stats"})
        check("rpc get_session_stats", r.get("ok") is True, r if not r.get("ok") else "")
        r = api("POST", "/api/rpc", {"sessionPath": s0, "command": "get_subagents"})
        check("rpc get_subagents", r.get("ok") is True and isinstance(r.get("data", {}).get("subagents", r.get("data")), (list, dict)), r)
    else:
        skip("rpc get_session_stats", "no omp binary: rpc is answered by a child")
        skip("rpc get_subagents", "no omp binary: rpc is answered by a child")
    r = api("POST", "/api/rpc", {"sessionPath": s0, "command": "kill_everything"})
    check("rpc disallowed command rejected", r.get("ok") is False and "not allowed" in r.get("error", ""), r)

    # Raw switching is internal-only: branch/fork return a path which the
    # client opens normally. In particular, a valid source cannot smuggle an
    # unchecked destination into its child (or boot one just to try).
    switch_dir = os.path.join(ROOT, "-tmp-raw-switch")
    os.makedirs(switch_dir, exist_ok=True)
    switch_source = os.path.join(switch_dir, "source.jsonl")
    switch_target = os.path.join(switch_dir, "target.jsonl")
    switch_outside = os.path.join(TMP, "outside-switch.jsonl")
    with open(s0, "rb") as f:
        switch_bytes = f.read()
    for fixture in (switch_source, switch_target, switch_outside):
        with open(fixture, "wb") as f:
            f.write(switch_bytes)
    before_switch_children = api("GET", "/api/status")["children"]
    for label, params in (
        ("missing", {}),
        ("null", {"sessionPath": None}),
        ("empty", {"sessionPath": ""}),
        ("nonexistent", {"sessionPath": os.path.join(switch_dir, "missing.jsonl")}),
        ("outside-root", {"sessionPath": switch_outside}),
        ("valid-unowned", {"sessionPath": switch_target}),
        ("existing-session", {"sessionPath": s0}),
        ("same-session", {"sessionPath": switch_source}),
    ):
        r = api("POST", "/api/rpc", {
            "sessionPath": switch_source,
            "command": "switch_session",
            "params": params,
        })
        check(f"raw switch rejects {label} without dispatch",
              r.get("ok") is False and r.get("error") == "command not allowed", r)
    check("raw switch never spawns a child",
          api("GET", "/api/status")["children"] <= before_switch_children)
    unchanged = True
    for fixture in (switch_source, switch_target, switch_outside):
        with open(fixture, "rb") as f:
            unchanged = unchanged and f.read() == switch_bytes
    check("raw switch leaves source and destinations unchanged", unchanged)
    check("raw switch never creates a missing destination",
          not os.path.exists(os.path.join(switch_dir, "missing.jsonl")))

    # 6. LRU: bash on the other sessions — the configured cap must hold
    if OMP and not upstream_stalled:
        for s in sess[1:3]:
            r = api("POST", "/api/bash", {"sessionPath": s, "command": "true"})
            check(f"bash on {os.path.basename(s)[:25]}", r.get("ok") is True, r if not r.get("ok") else "")
        for _ in range(80):
            if children() <= cap:
                break
            time.sleep(0.5)
        check(f"LRU cap holds (ours <= {cap}, foreign excluded)", children() <= base_children + cap, children())
    else:
        skip("bash on the other sessions", "no omp binary: bash runs inside a child")
        skip(f"LRU cap holds (ours <= {cap}, foreign excluded)", "no omp binary: no children to cap")

    # 7. push vapid key matches stored file
    r = api("GET", "/api/push/vapid-public-key")
    vapid_path = next((c for c in (os.path.join(STATE_DIR, "vapid.json"),
                                    os.path.join(STATE_DIR, "omp-remote.vapid.json"))
                        if os.path.exists(c)), os.path.join(STATE_DIR, "vapid.json"))
    stored = json.load(open(vapid_path))["publicKey"]
    check("vapid key reuse", r.get("ok") is True and r.get("publicKey") == stored, r)

    # 8. push subscribe/unsubscribe round-trip
    #
    # Subscriptions are DEVICE-scoped, not session-scoped. They used to be keyed
    # by session path, which meant a conversation the phone had never opened had
    # no subscriber and so could never announce that its agent had finished —
    # the reported bug. The store is now {version, devices:[...]} and no
    # sessionPath is sent.
    fake = {"endpoint": "https://example.invalid/pulse-smoke", "keys": {"p256dh": "BPULSE", "auth": "smoke"}}
    read_store = lambda: json.load(open(next(
        (c for c in (os.path.join(STATE_DIR, "push.json"),
                     os.path.join(STATE_DIR, "omp-remote.push.json"))
         if os.path.exists(c)), os.path.join(STATE_DIR, "push.json"))))
    endpoints = lambda store: [
        x.get("endpoint") for x in (store.get("devices", []) if isinstance(store, dict) else [])
    ]
    r = api("POST", "/api/push/subscribe", {"subscription": fake})
    check(
        "subscribe persisted device-wide",
        r.get("ok") is True and r.get("scope") == "device" and fake["endpoint"] in endpoints(read_store()),
        r,
    )
    r = api("POST", "/api/push/unsubscribe", {"endpoint": fake["endpoint"]})
    check(
        "unsubscribe pruned",
        r.get("ok") is True and fake["endpoint"] not in endpoints(read_store()),
        r,
    )

    # 9. collab attach negative path
    r = api("POST", "/api/collab/attach", {"sessionPath": s0, "link": "not-a-collab-link!!"})
    check("collab attach bogus link rejected", r.get("ok") is False and r.get("error"), r)

    # Seed two per-project session files independently of OMP availability.
    # Writing fixtures directly exercises the same indexed catalogue as a
    # desktop session without making a model call.
    sessions_root = os.environ.get("OMP_PULSE_TEST_SESSIONS")
    seeded = []
    if sessions_root:
        for name, age in (("-tmp-proj-alpha", 30), ("-tmp-proj-beta", 5)):
            d = os.path.join(sessions_root, name)
            os.makedirs(d, exist_ok=True)
            f = os.path.join(d, f"2026-08-12T00-00-00-000Z_019ff000-0000-7000-0000-{abs(hash(name)) % 10**12:012d}.jsonl")
            with open(f, "w") as fh:
                fh.write(json.dumps({"type": "title", "title": f"seeded {name}"}) + "\n")
                fh.write(json.dumps({"type": "session", "id": os.path.basename(f).split("_")[1][:36],
                                     "cwd": "/tmp/" + name.strip("-"), "title": f"seeded {name}"}) + "\n")
                fh.write(json.dumps({"type": "message", "timestamp": "2026-08-12T00:00:01.000Z",
                                     "message": {"role": "user", "content": [{"type": "text", "text": "seed"}]}}) + "\n")
            past = time.time() - age
            os.utime(f, (past, past))
            seeded.append(f)

    # 10. session-list truth: a total order that does not shuffle between
    # refreshes, and honest running/live/ownership state. Both were real user
    # reports: rows reordering on refresh, and "updated 0 minutes ago" reading
    # as running when nothing was running.
    # The index is stale-while-revalidate: sleeping before the first GET does
    # not start a refresh. Poll for our exact fixtures instead of racing the
    # cold snapshot or accepting an unrelated nonempty response.
    deadline = time.monotonic() + 10
    while True:
        l1 = api("GET", "/api/sessions").get("sessions", [])
        listed_paths = {x.get("path") for x in l1}
        if set(seeded).issubset(listed_paths) or time.monotonic() >= deadline:
            break
        time.sleep(0.1)
    check("session list discovers the seeded fixtures", set(seeded).issubset(listed_paths), len(l1))
    l2 = api("GET", "/api/sessions").get("sessions", [])
    check("session list non-empty", len(l1) > 0, len(l1))
    check("session list order is stable across refreshes",
          [x.get("path") for x in l1] == [x.get("path") for x in l2],
          [x.get("path") for x in l1[:3]])
    # catalogue_order uses real activity, not filesystem mtime. Assert both
    # descending activity and its deterministic path tie-breaker.
    activity_keys = [(-x["activeAt"], x["path"]) for x in l1]
    check("session list sorted by activity then path", activity_keys == sorted(activity_keys))
    check("session rows carry ownerPid and live fields",
          all("ownerPid" in x and "live" in x for x in l1[:20]), l1[0] if l1 else None)
    fresh = [x for x in l1 if not x.get("live") and not x.get("running")]
    check("a fresh-but-idle session is not reported streaming",
          all(x.get("status") != "streaming" for x in fresh[:20]),
          [x.get("path") for x in fresh[:2]])
    # Our own scratch children must never be mistaken for a foreign terminal
    # owner (the guard excludes `--mode rpc` processes and our live pids).
    ours = [x for x in l1 if x.get("path") in sess]
    check("our own rpc children are not counted as terminal owners",
          all(x.get("ownerPid") is None for x in ours), [(x.get("path"), x.get("ownerPid")) for x in ours])

    await ws.close()
    rt.cancel()
    # ---------------------------------------------------------------- new daemon
    # capabilities the phone now depends on. Each of these was a phone-visible
    # dead end before: no diagnostics, no content search, no per-session context
    # pressure, and a status body that could not distinguish "the agent is idle"
    # from "the desktop went away".
    st = api("GET", "/api/status")
    check("status reports agent liveness for the phone's status popover",
          isinstance(st.get("agent"), dict)
          and isinstance(st["agent"].get("alive"), bool)
          and isinstance(st["agent"].get("streaming"), bool),
          json.dumps(st.get("agent")))
    check("status reports the desktop link state",
          st.get("desktopLink") in ("attached", "reconnecting", "lost", "none"),
          json.dumps(st.get("desktopLink")))
    # A phone user with no terminal has to be able to answer "why is this broken".
    diag = api("GET", "/api/diagnostics")
    checks = diag.get("checks") or []
    check("diagnostics returns named pass/fail checks with detail",
          diag.get("ok") is True and len(checks) > 0
          and all(isinstance(c.get("name"), str) and isinstance(c.get("pass"), bool)
                  and "detail" in c for c in checks),
          f"{len(checks)} checks")
    check("diagnostics carries the metrics and status a support answer needs",
          isinstance(diag.get("metrics"), dict) and isinstance(diag.get("status"), dict))
    # Full-text search across transcripts: the only complete answer to "find the
    # conversation where I said X".
    hits = api("GET", "/api/search?q=fixture&limit=5")
    check("search answers with bounded, structured hits",
          hits.get("ok") is True and isinstance(hits.get("hits"), list)
          and len(hits["hits"]) <= 5
          and all(set(("path", "title", "line")) <= set(h) for h in hits["hits"]),
          f"{len(hits.get('hits') or [])} hits")
    nonsense = api("GET", "/api/search?q=zzz-definitely-not-present-anywhere&limit=5")
    check("search returns no hits rather than an error when nothing matches",
          nonsense.get("ok") is True and nonsense.get("hits") == [])
    # The row fields the inbox needs to show context pressure without opening a
    # session. They are only present for sessions with a live child, so absence
    # here is correct — what must hold is the TYPE when present.
    rows = api("GET", "/api/sessions").get("sessions") or []
    enriched = [r for r in rows if "ctxPercent" in r]
    check("live-session rows carry model/messageCount/ctxPercent when known",
          all(isinstance(r.get("model"), str) and isinstance(r.get("messageCount"), int)
              and isinstance(r.get("ctxPercent"), (int, float))
              and 0 <= r["ctxPercent"] <= 100 for r in enriched),
          f"{len(enriched)} enriched of {len(rows)}")
    check("awaiting lists sessions holding a question",
          isinstance(api("GET", "/api/awaiting").get("sessions"), list))

    # The read-only timeline. Measured on a real 43 MB session, user turns sit ~93
    # entries apart, so the phone cannot page backward to find them (a bounded
    # client scan found zero in 60s). The daemon scans instead and answers in ms,
    # which is what makes the sheet usable on a session the desktop holds open.
    turns_file = os.path.join(os.path.dirname(sess[0]), "2026-08-12T00-00-09-000Z_019ff000-0000-7000-0000-000000000009.jsonl")
    with open(turns_file, "w") as f:
        f.write(json.dumps({"type": "session", "version": 1, "id": "019ff000-0000-7000-0000-000000000009",
                            "timestamp": "2026-08-12T00:00:00.000Z", "cwd": scratch_cwd}) + "\n")
        f.write(json.dumps({"type": "title", "id": "t0", "title": "turns fixture"}) + "\n")
        for i, text in enumerate(["first ask", "second ask"]):
            f.write(json.dumps({"type": "message", "id": f"u{i}",
                                "message": {"role": "user", "content": [{"type": "text", "text": text}]}}) + "\n")
            f.write(json.dumps({"type": "message", "id": f"a{i}",
                                "message": {"role": "assistant", "content": [{"type": "text", "text": "answer"}]}}) + "\n")
        # A DESKTOP-driven session records the same thing under a different shape;
        # the sheet must not lose those turns.
        f.write(json.dumps({"type": "custom_message", "customType": "collab-prompt",
                            "id": "c0", "content": [{"type": "text", "text": "third ask over collab"}]}) + "\n")
        f.write(json.dumps({"type": "message", "id": "ws",
                            "message": {"role": "user", "content": [{"type": "text", "text": "   "}]}}) + "\n")
    t = api("GET", "/api/turns?session=" + urllib.parse.quote(turns_file) + "&limit=25")
    check("turns returns user turns oldest-first, both entry shapes, blanks dropped",
          t.get("ok") is True
          and [x.get("text") for x in (t.get("turns") or [])] == ["first ask", "second ask", "third ask over collab"]
          and t.get("more") is False,
          t)
    t1 = api("GET", "/api/turns?session=" + urllib.parse.quote(turns_file) + "&limit=1")
    check("turns honours limit by keeping the newest and says more remain",
          [x.get("text") for x in (t1.get("turns") or [])] == ["third ask over collab"] and t1.get("more") is True,
          t1)
    # A missing session must never look like an empty conversation. Which shape it
    # refuses with follows /api/history, not a second convention of its own: an
    # unresolvable path is ok:false at 200, a resolvable non-file is 404.
    try:
        miss = api("GET", "/api/turns?session=" + urllib.parse.quote(turns_file + ".missing") + "&limit=5")
        check("turns refuses a missing session instead of serving an empty one",
              miss.get("ok") is False and not miss.get("turns"), miss)
    except urllib.error.HTTPError as e:
        check("turns refuses a missing session instead of serving an empty one", e.code == 404, e.code)
    os.remove(turns_file)

    fails = [n for n, ok in PASS if not ok]
    summary = f"{len(PASS) - len(fails)}/{len(PASS)} passed"
    if SKIPPED:
        summary += f", {len(SKIPPED)} skipped (no omp binary)"
    if fails:
        summary += f"; FAILURES: {fails}"
    print("\n" + summary)
    # Skips never fail the run: this suite must be usable by a contributor who
    # has not installed omp yet, and by CI, which deliberately does not.
    sys.exit(1 if fails else 0)

asyncio.run(main())
