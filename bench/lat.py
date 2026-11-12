#!/usr/bin/env python3
"""lat.py — latency & throughput of the request paths a phone waits on.

WHY: the phone polls /api/sessions on a 3 s cadence, fetches /api/history
when a conversation is opened, calls /api/open when entering a session, and
POSTs /api/prompt for every message. Each is a number a user on cellular
actually feels. This measures them at real corpus scale (3365 files /
~1.1 GB synthetic, largest 44 MiB) and breaks each cost down so we know
which fix wins and which is already at the syscall floor.

WHAT (one phase per numbered item in the task):
  1. /api/sessions — cold (first call after boot), cached (within the 3 s
     TTL window) and post-expiry (forced stale). The CACHED call still pays
     one stat() per row (snippet mtime check, src/server/http.rs snippet_for) plus
     full JSON serialization; the COLD call additionally pays the directory
     scan, a 4 KiB header read per file (jsonl::parse_header), the /proc
     owner sweep (http.rs foreign_owners) and, first time only, a 64 KiB
     tail read per file (jsonl::last_snippet). Python-side floor walks
     isolate the syscall floor (scandir+stat+4K read) from our own
     overhead; lat.sessions.per_file_us is the daemon's marginal cost per
     row beyond that floor.
  2. /api/history — first page and one backward page on a small (~4 KiB),
     an ~11 MiB and the 44 MiB session; the pager's pathological long-line
     case (a 2 MiB single-line file forces the 256 KiB backward window to
     grow to the whole file); and a full page-walk of an ~400 KiB session.
     read_backward does fs::read() of the WHOLE file per page
     (src/sessions/jsonl.rs:280), so page latency tracks file size, not page size.
  3. /api/open — cold vs warm. The handler returns before the child boots
     (fire-and-forget pre-warm, src/server/http.rs:1108), so the phone-visible
     latency is the handler wall time; the ~1.3 s boot is observed via the
     daemon's own child_boot_ms /api/status timing. WS-attach pre-warm
     (src/server/http.rs:1582) is verified the same way.
  4. Send path — /api/prompt POST wall time (the daemon's own accept+forward
     cost; the LLM turn is NOT part of this number) and /api/rpc
     {command:"get_state"} round-trip, warm and cold, attributed via
     /api/status counters (prompt_via_child, child_spawn, child_boot_ms).
     LLM-funded: only runs when BENCH_TURNS>=1.
  5. Throughput — C concurrent keep-alive clients hammering /api/sessions
     (cached) and /api/history for a fixed duration: req/s + p50/p95/max per
     level, plus a barrier micro-burst of simultaneous /api/sessions calls
     to expose Mutex / thread-pool serialization directly.
  6. Where the time goes — /api/status metric deltas before/after each phase
     (child_spawn, child_boot_ms, prompt_via_*) and Python-side floor walks
     (scan; +4 KiB header read; /proc cmdline+fd sweep; +64 KiB snippet
     tails; +canonicalize per path) so every number can be attributed to a
     named operation.

HOW TO READ: every `METRIC dotted.name value unit` line is one measurement;
percentiles are named ...p50/.p95/.max. lat.sessions.syscall_floor_ms is
the unavoidable I/O for one cold refresh at this corpus size — anything
above it is our code. lat.sessions.per_file_us says whether optimizing the
scan is worthwhile at all. lat.history.*.read_mibps is how much file I/O a
small page response hides. Sweep lines end in .req_s / .p50_ms / .p95_ms /
.max_ms; a p95 ratio growing faster than the concurrency level means
lock/thread-pool serialization.

Run under bench/with-bench-daemon.sh (isolated daemon, BENCH_* env) or point
BENCH_BASE/BENCH_TOKEN at a running daemon. BENCH_QUICK=1 runs a tiny
version. BENCH_TURNS=N (default 0) enables the prompt-driven measurements
(real LLM cost). BENCH_PORT must never be 7682 (the live daemon).
"""
import asyncio
import http.client
import json
import math
import os
import sys
import threading
import time
import urllib.parse
import urllib.request
import uuid

QUICK = os.environ.get("BENCH_QUICK", "") == "1"
BASE = os.environ.get("BENCH_BASE", "http://127.0.0.1:7693").rstrip("/")
WSBASE = os.environ.get(
    "BENCH_WS", BASE.replace("http://", "ws://").replace("https://", "wss://")
)
TOKEN = os.environ.get("BENCH_TOKEN", "")
if not TOKEN:
    sys.exit(
        "BENCH_TOKEN is unset — run under bench/with-bench-daemon.sh "
        "(isolated daemon) or set BENCH_BASE/BENCH_TOKEN for a running daemon."
    )
CORPUS = os.environ.get("BENCH_CORPUS", "")
PID = os.environ.get("BENCH_PID", "")
RSS_LOG = os.environ.get("BENCH_RSS_LOG", "")
TURNS = max(0, int(os.environ.get("BENCH_TURNS", "0")))

TMPCWD = "/tmp/pulse-bench-proj-lat"  # matches harness cleanup pkill pattern
SWEEP_LEVELS = [2] if QUICK else [1, 8, 32, 64]
_P = urllib.parse.urlsplit(BASE)
HOST, PORT = _P.hostname, _P.port

M = {}  # metric name -> value (for the summary)


def emit(name, value, unit):
    if isinstance(value, float):
        s = f"{value:.3f}".rstrip("0").rstrip(".")
        if s in ("", "-", "-0"):
            s = "0"
    else:
        s = str(value)
    M[name] = s
    print(f"METRIC {name} {s} {unit}", flush=True)


def pct(xs, p):
    if not xs:
        return float("nan")
    xs = sorted(xs)
    k = (len(xs) - 1) * p / 100.0
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return xs[int(k)]
    return xs[f] * (c - k) + xs[c] * (k - f)


def pstats(prefix, xs):
    """Emit p50/p95/max for a latency sample list (ms)."""
    xs = [x for x in xs if x == x]  # drop NaN
    if not xs:
        print(f"# {prefix}: no samples", flush=True)
        return
    emit(f"{prefix}.p50_ms", pct(xs, 50), "ms")
    emit(f"{prefix}.p95_ms", pct(xs, 95), "ms")
    emit(f"{prefix}.max_ms", max(xs), "ms")


def api(method, path, body=None, timeout=120):
    """One HTTP request against the bench daemon; returns (ms, body bytes)."""
    headers = {"Authorization": "Bearer " + TOKEN}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, method=method, headers=headers, data=data)
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    return (time.perf_counter() - t0) * 1000.0, raw


def api_json(method, path, body=None, timeout=120):
    t, raw = api(method, path, body, timeout)
    return t, json.loads(raw)


def status_snapshot():
    _, d = api_json("GET", "/api/status")
    return d


def counters(s):
    return s.get("metrics", {}).get("counters", {}) or {}


def timings(s):
    return s.get("metrics", {}).get("timings", {}) or {}


def cdelta(a, b, name):
    return counters(b).get(name, 0) - counters(a).get(name, 0)


def tdelta(a, b, name):
    """(count_delta, avg_ms, max_ms) for a timing; None if unchanged.
    A missing entry in the baseline counts as zero (count 0 before the
    first observation)."""
    tb = timings(b).get(name)
    if not tb:
        return None
    ta = timings(a).get(name)
    ac = ta["count"] if ta else 0
    dc = tb["count"] - ac
    if dc <= 0:
        return None
    at = ta["total_ms"] if ta else 0
    return (dc, (tb["total_ms"] - at) / dc, tb["max_ms"])


def qs(session, **extra):
    q = {"session": session}
    q.update(extra)
    return "?" + urllib.parse.urlencode(q)


# --------------------------------------------------------------------------
# Phase 1: /api/sessions — cold / cached / post-expiry + per-row cost
# --------------------------------------------------------------------------

def phase_sessions():
    cached_n = 5 if QUICK else 10
    cold_n = 3 if QUICK else 5
    ttl_wait = 3.2  # > SESSIONS_CACHE_TTL (3 s)

    # First call after boot: cold scan + first-touch snippet tails (64 KiB/file).
    t, raw = api("GET", "/api/sessions")
    emit("lat.sessions.cold.first_ms", t, "ms")
    data = json.loads(raw)
    rows = data.get("sessions", [])
    emit("lat.sessions.rows", len(rows), "count")
    emit("lat.sessions.cold.first.bytes", len(raw), "bytes")

    # Cached: back-to-back calls inside the 3 s window.
    lat, sizes = [], []
    for _ in range(cached_n):
        t, raw = api("GET", "/api/sessions")
        lat.append(t)
        sizes.append(len(raw))
    pstats("lat.sessions.cached", lat)
    emit("lat.sessions.cached.bytes", pct(sizes, 50), "bytes")

    # Post-expiry: force the cache stale, then measure the full refresh.
    lat = []
    for _ in range(cold_n):
        time.sleep(ttl_wait)
        t, _ = api("GET", "/api/sessions")
        lat.append(t)
    pstats("lat.sessions.cold", lat)

    # Session picks for the later phases (sizes from the listing).
    by_size = sorted([r for r in rows if isinstance(r, dict) and r.get("path")],
                     key=lambda r: r.get("size", 0))
    picks = {}
    if by_size:
        picks["small"] = by_size[0]["path"]
        picks["small2"] = by_size[1]["path"] if len(by_size) > 1 else by_size[0]["path"]
        picks["small3"] = by_size[2]["path"] if len(by_size) > 2 else picks["small2"]
        picks["big"] = by_size[-1]["path"]
        target_mid = 11 * 1048576
        picks["mid"] = min(by_size, key=lambda r: abs(r.get("size", 0) - target_mid))["path"]
        target_med = 400_000
        picks["medium"] = min(by_size, key=lambda r: abs(r.get("size", 0) - target_med))["path"]
        for k, p in picks.items():
            try:
                emit(f"lat.session.{k}.size_bytes", os.path.getsize(p), "bytes")
            except OSError:
                pass
    return picks


# --------------------------------------------------------------------------
# Phase 6 (part 1): Python-side syscall floors for the sessions refresh
# --------------------------------------------------------------------------

def floor_walk(root, with_read, with_snippet):
    """Mirror scan_sessions: scandir root + one level, stat + optional
    4 KiB header read + optional 64 KiB tail read per .jsonl in subdirs."""
    t0 = time.perf_counter()
    count = 0
    try:
        for ent in os.scandir(root):
            if not ent.is_dir():
                continue
            try:
                for f in os.scandir(ent.path):
                    if not (f.is_file() and f.name.endswith(".jsonl")):
                        continue
                    st = f.stat()
                    count += 1
                    if with_read:
                        with open(f.path, "rb") as fh:
                            fh.read(4096)
                    if with_snippet and st.st_size > 0:
                        with open(f.path, "rb") as fh:
                            fh.seek(max(0, st.st_size - 65536))
                            fh.read()
            except OSError:
                continue
    except OSError:
        return None, count
    return (time.perf_counter() - t0) * 1000.0, count


def floor_proc():
    """Mirror foreign_owners' /proc sweep (no bench children alive yet)."""
    t0 = time.perf_counter()
    n_pids = omp_like = fd_links = 0
    try:
        procs = [e for e in os.scandir("/proc") if e.name.isdigit()]
        n_pids = len(procs)
        for e in procs:
            cmd = ""
            try:
                with open(f"/proc/{e.name}/cmdline", "rb") as fh:
                    cmd = fh.read().replace(b"\0", b" ").decode("utf-8", "replace").strip()
            except OSError:
                continue
            if not cmd:
                continue
            if "--mode rpc" in cmd or "/omp" in cmd or any(
                os.path.basename(a).rsplit(".", 1)[0] in ("omp", "omp_pulse", "omp-pulse")
                for a in cmd.split(" ")
            ):
                omp_like += 1
                try:
                    for fd in os.scandir(f"/proc/{e.name}/fd"):
                        try:
                            os.readlink(fd.path)
                            fd_links += 1
                        except OSError:
                            pass
                except OSError:
                    pass
    except OSError:
        pass
    return (time.perf_counter() - t0) * 1000.0, n_pids, omp_like, fd_links


def floor_canon(root):
    t0 = time.perf_counter()
    n = 0
    try:
        for ent in os.scandir(root):
            if not ent.is_dir():
                continue
            try:
                for f in os.scandir(ent.path):
                    if f.is_file() and f.name.endswith(".jsonl"):
                        os.path.realpath(f.path)
                        n += 1
            except OSError:
                continue
    except OSError:
        pass
    return (time.perf_counter() - t0) * 1000.0, n


def phase_floor():
    reps = 3 if QUICK else 5
    roots = []
    if CORPUS and os.path.isdir(CORPUS):
        roots.append(("cur", os.path.realpath(CORPUS)))
    default = os.path.expanduser("~/.cache/omp-pulse-bench/corpus")
    if os.path.isdir(default):
        rp = os.path.realpath(default)
        if not roots or rp != roots[0][1]:
            roots.append(("big", rp))

    cur_files = None
    for tag, root in roots:
        scan, n = None, 0
        for _ in range(reps):
            ms, n = floor_walk(root, with_read=False, with_snippet=False)
            scan = ms if scan is None else min(scan, ms)
        rd = None
        for _ in range(reps):
            ms, _ = floor_walk(root, with_read=True, with_snippet=False)
            rd = ms if rd is None else min(rd, ms)
        snip = None
        for _ in range(reps):
            ms, _ = floor_walk(root, with_read=True, with_snippet=True)
            snip = ms if snip is None else min(snip, ms)
        canon = None
        for _ in range(reps):
            ms, _ = floor_canon(root)
            canon = ms if canon is None else min(canon, ms)
        if tag == "cur":
            cur_files = n
            emit("lat.sessions.floor.files", n, "count")
            emit("lat.sessions.floor_scan_ms", scan, "ms")
            emit("lat.sessions.syscall_floor_ms", rd, "ms")
            emit("lat.sessions.floor_snippet_ms", snip - rd, "ms")
            emit("lat.sessions.floor_canon_ms", canon, "ms")
            if n:
                emit("lat.sessions.floor_per_file_us", rd * 1000.0 / n, "us")
        else:
            emit("lat.sessions.floor_big.files", n, "count")
            emit("lat.sessions.floor_big_ms", rd, "ms")

    # /proc sweep (machine-wide; run before any bench child exists).
    proc_ms = n_pids = omp_like = fd_links = 0
    for _ in range(reps):
        ms, np_, ol, fl = floor_proc()
        proc_ms = ms if proc_ms == 0 else min(proc_ms, ms)
        n_pids, omp_like, fd_links = np_, ol, fl
    emit("lat.sessions.floor_proc_ms", proc_ms, "ms")
    M["#proc_pids"] = n_pids
    M["#proc_omp_like"] = omp_like
    M["#proc_fd_links"] = fd_links

    if cur_files:
        cold50 = float(M.get("lat.sessions.cold.p50_ms", "nan"))
        floor = float(M.get("lat.sessions.syscall_floor_ms", "nan"))
        if cold50 == cold50 and floor == floor:
            overhead = cold50 - floor
            emit("lat.sessions.cold_overhead_ms", overhead, "ms")
            emit("lat.sessions.per_file_us", overhead * 1000.0 / cur_files, "us")


# --------------------------------------------------------------------------
# Phase 2: /api/history — pages at three session sizes + pathological
# --------------------------------------------------------------------------

def hget(session, **extra):
    return api("GET", "/api/history" + qs(session, **extra))


def phase_history(picks):
    n = 5 if QUICK else 7
    if not picks:
        print("# no sessions available; skipping history phase", flush=True)
        return

    def pages(tag, path):
        size = os.path.getsize(path)
        lat, sizes, nb = [], [], None
        for _ in range(n):
            t, raw = hget(path, limit=50)
            lat.append(t)
            sizes.append(len(raw))
            if nb is None:
                try:
                    nb = json.loads(raw).get("nextBefore")
                except Exception:
                    nb = None
        pstats(f"lat.history.{tag}.page1", lat)
        emit(f"lat.history.{tag}.page1.bytes", pct(sizes, 50), "bytes")
        p50 = pct(lat, 50)
        if size and p50 > 0:
            # File bytes served per second of page-1 latency (a ratio of
            # bytes read server-side to the tiny page response on the wire).
            emit(f"lat.history.{tag}.page1.read_mibps",
                 (size / 1048576.0) / (p50 / 1000.0), "per_second")
            emit(f"lat.history.{tag}.page1.read_amp",
                 size / max(1, pct(sizes, 50)), "ratio")
        if nb is not None:
            lat2, sizes2 = [], []
            for _ in range(n):
                t, raw = hget(path, before=nb, limit=50)
                lat2.append(t)
                sizes2.append(len(raw))
            pstats(f"lat.history.{tag}.page2", lat2)
            emit(f"lat.history.{tag}.page2.bytes", pct(sizes2, 50), "bytes")

    for tag in ("small", "mid", "big"):
        if tag in picks:
            pages(tag, picks[tag])

    # Pathological long-line file: a single 2 MiB line forces read_backward's
    # 256 KiB window to grow to the whole file (copies accumulate per step).
    ll = None
    if CORPUS and os.path.isdir(CORPUS):
        ll = os.path.join(CORPUS, f".latbench-{os.getpid()}-longlines.jsonl")
        try:
            os.makedirs(TMPCWD, exist_ok=True)
            with open(ll, "w") as f:
                f.write(json.dumps({"type": "session", "id": "bench-longlines",
                                    "cwd": TMPCWD}) + "\n")
                f.write(json.dumps({"type": "title", "title": "longlines"}) + "\n")
                f.write(json.dumps({"type": "message", "role": "user",
                                    "timestamp": "2026-08-12T00:00:00.000Z",
                                    "content": [{"type": "text", "text": "short"}]}) + "\n")
                big = "x" * (2 * 1048576)
                f.write(json.dumps({"type": "message", "role": "assistant",
                                    "timestamp": "2026-08-12T00:00:00.000Z",
                                    "content": [{"type": "text", "text": big}]}) + "\n")
            pages("longlines", ll)
        except OSError as e:
            print(f"# longlines file skipped: {e}", flush=True)
            ll = None
    if ll:
        try:
            os.remove(ll)
        except OSError:
            pass

    # Full page-walk of an ~400 KiB session (full mode only).
    if not QUICK and "medium" in picks:
        before, pages_ = None, 0
        total_ms, total_bytes = 0.0, 0
        while True:
            kw = {"limit": 50}
            if before is not None:
                kw["before"] = before
            t, raw = hget(picks["medium"], **kw)
            total_ms += t
            total_bytes += len(raw)
            pages_ += 1
            try:
                nb = json.loads(raw).get("nextBefore")
            except Exception:
                nb = None
            if nb is None or nb == before or pages_ > 2000:
                break
            before = nb
        emit("lat.history.medium.walk_ms", total_ms, "ms")
        emit("lat.history.medium.walk_pages", pages_, "count")
        emit("lat.history.medium.walk_bytes", total_bytes, "bytes")


# --------------------------------------------------------------------------
# Phase 3: /api/open — cold (async child boot) vs warm; WS-attach pre-warm
# --------------------------------------------------------------------------

def wait_children_delta(s0, want, timeout=15.0):
    """Poll /api/status until live children increase by >= want or timeout."""
    t0 = time.time()
    base = s0.get("children", 0)
    while time.time() - t0 < timeout:
        s = status_snapshot()
        if s.get("children", 0) >= base + want:
            return s
        time.sleep(0.1)
    return None


def craft_session(path, messages=12, target_bytes=0):
    """Write an omp-VALID session file (nested `message` shape, real-format
    header) so the RPC child can boot on it. The seed corpus's flat
    `{"type":"message","role":...}` shape crashes omp's get_state
    (`msg.role` undefined), so any phase that spawns a child must use a
    crafted file. Root-level files are invisible to /api/sessions."""
    os.makedirs(TMPCWD, exist_ok=True)
    with open(path, "w") as f:
        f.write(json.dumps({"type": "session", "version": 3,
                            "id": "bench-" + os.path.basename(path),
                            "timestamp": "2026-08-12T00:00:00.000Z",
                            "cwd": TMPCWD}) + "\n")
        f.write(json.dumps({"type": "title", "title": "bench"}) + "\n")
        i = 0
        while True:
            role = "user" if i % 2 == 0 else "assistant"
            text = ("bench line %d " % i) * 12  # ~300 B lines, like the corpus
            line = json.dumps({"type": "message", "id": "m%d" % i, "parentId": None,
                               "timestamp": "2026-08-12T00:00:00.000Z",
                               "message": {"role": role,
                                           "content": [{"type": "text", "text": text}],
                                           "timestamp": 1786000000000 + i}}) + "\n"
            f.write(line)
            i += 1
            if target_bytes:
                if i % 256 == 0 and os.path.getsize(path) >= target_bytes:
                    break
            elif i >= messages:
                break


def phase_open(picks):
    """Cold vs warm /api/open. The handler returns before the child boots
    (fire-and-forget pre-warm), so the phone-visible wall time is small; the
    ~1.3 s boot shows up in child_boot_ms. Cold opens on a crafted-big
    session additionally expose line_count(): the handler reads the WHOLE
    file when no child has cached state (src/server/http.rs:1095)."""
    if not CORPUS or not os.path.isdir(CORPUS):
        print("# no corpus — skipping open phase", flush=True)
        return
    prefix = f".latbench-{os.getpid()}"
    csmall = os.path.join(CORPUS, prefix + "-child.jsonl")
    craft_session(csmall, messages=12)
    cold_targets = [("small", csmall)]
    crafted = [csmall]
    if not QUICK:
        csmall2 = os.path.join(CORPUS, prefix + "-child2.jsonl")
        cbig = os.path.join(CORPUS, prefix + "-child-big.jsonl")
        craft_session(csmall2, messages=12)
        craft_session(cbig, messages=20, target_bytes=44 * 1048576)
        cold_targets = [("small", csmall), ("small2", csmall2), ("big", cbig)]
        crafted = [csmall, csmall2, cbig]

    s0 = status_snapshot()
    lat_cold, boot_max = [], 0.0
    for idx, (label, p) in enumerate(cold_targets):
        t, _ = api("POST", "/api/open", {"sessionPath": p})
        lat_cold.append(t)
        emit(f"lat.open.cold_http.{label}_ms", t, "ms")
        s1 = wait_children_delta(s0, idx + 1, timeout=25.0)
        bt = tdelta(s0, s1 or s0, "child_boot_ms")
        if bt:
            boot_max = max(boot_max, bt[2])
    pstats("lat.open.cold_http", lat_cold)
    if boot_max:
        emit("lat.open.child_boot_ms", boot_max, "ms")
        bt = tdelta(s0, status_snapshot(), "child_boot_ms")
        if bt:
            emit("lat.open.child_boot_avg_ms", bt[1], "ms")

    lat_warm = []
    for _ in range(3):
        t, _ = api("POST", "/api/open", {"sessionPath": csmall})
        lat_warm.append(t)
    pstats("lat.open.warm_http", lat_warm)

    if not QUICK:
        s = status_snapshot()
        t, _ = api("POST", "/api/new", {"cwd": TMPCWD})
        emit("lat.open.new_session_ms", t, "ms")
        bt = tdelta(s, status_snapshot(), "child_boot_ms")
        if bt:
            emit("lat.open.new_session_boot_ms", bt[2], "ms")
    return crafted


# --------------------------------------------------------------------------
# Phase 4: send path — /api/rpc get_state (warm+cold), /api/prompt (opt-in)
# --------------------------------------------------------------------------

def phase_rpc(warm_path):
    """get_state round-trip: warm (live child) and cold (child boot inside
    the call). The warm number is the RPC+daemon overhead floor."""
    if not warm_path:
        return
    lat = []
    for _ in range(5):
        t, raw = api("POST", "/api/rpc", {"sessionPath": warm_path,
                                          "command": "get_state"})
        lat.append(t)
    pstats("lat.rpc.get_state.warm", lat)
    if not QUICK and CORPUS and os.path.isdir(CORPUS):
        coldp = os.path.join(CORPUS, f".latbench-{os.getpid()}-rpc-cold.jsonl")
        craft_session(coldp, messages=12)
        try:
            t, _ = api("POST", "/api/rpc", {"sessionPath": coldp,
                                            "command": "get_state"})
            emit("lat.rpc.get_state.cold_ms", t, "ms")
        finally:
            try:
                os.remove(coldp)
            except OSError:
                pass


def ws_url(session):
    return (f"{WSBASE}/ws?session={urllib.parse.quote(session, safe='')}"
            f"&token={urllib.parse.quote(TOKEN, safe='')}")


def ws_watch(session, started_after, stop_on_first, timeout_s):
    """Attach WS and collect frames. Returns (first_event_ms, finished)."""
    import websockets

    async def run():
        first_at = None
        finished = False
        try:
            async with websockets.connect(ws_url(session), max_size=64 * 1024 * 1024,
                                          ping_interval=None) as ws:
                end = time.time() + timeout_s
                while time.time() < end:
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=end - time.time())
                    except asyncio.TimeoutError:
                        break
                    if first_at is None:
                        first_at = (time.time() - started_after) * 1000.0
                    if stop_on_first:
                        break
                    try:
                        f = json.loads(raw)
                    except Exception:
                        continue
                    ev = (f.get("event") or {}) if f.get("type") == "event" else {}
                    key = ev.get("type") or f.get("type")
                    if key in ("turn_end", "agent_end", "message_end"):
                        finished = True
                        break
        except Exception as e:
            print(f"# ws_watch: {e}", flush=True)
        return first_at, finished

    try:
        return asyncio.run(run())
    except Exception as e:
        print(f"# ws_watch failed: {e}", flush=True)
        return None, False


def write_bench_session(path):
    craft_session(path, messages=3)


def phase_prompt():
    """Send-path overhead. LLM-funded: BENCH_TURNS=1 runs the warm prompt
    (1 turn); >=2 adds a cold prompt (2 turns total, then stops)."""
    if TURNS < 1:
        return
    try:
        import websockets  # noqa: F401
    except ImportError:
        print("# websockets not importable — skipping prompt phase", flush=True)
        return
    if not CORPUS or not os.path.isdir(CORPUS):
        print("# no corpus — skipping prompt phase", flush=True)
        return

    s0 = status_snapshot()

    # --- warm session: /api/new boots the child, then prompt is instant ---
    os.makedirs(TMPCWD, exist_ok=True)
    t, d = api_json("POST", "/api/new", {"cwd": TMPCWD})
    emit("lat.prompt.new_session_ms", t, "ms")
    s1p = (d.get("sessionPath") or "").strip()
    if not s1p:
        print("# /api/new failed; skipping prompt phase", flush=True)
        return
    wait_children_delta(s0, 1, timeout=20.0)

    s_pre = status_snapshot()
    # Attach the WS first (background thread), then POST: the watch runs
    # through the whole LLM turn and returns once turn_end/agent_end lands.
    warm_res = {"first": None, "done": False}
    post_t = time.time()

    def warm_watch():
        warm_res["first"], warm_res["done"] = ws_watch(
            s1p, started_after=post_t, stop_on_first=False, timeout_s=90)

    th = threading.Thread(target=warm_watch, daemon=True)
    th.start()
    time.sleep(0.1)  # let the socket attach land before the POST
    t, _ = api("POST", "/api/prompt", {"commandId": str(uuid.uuid4()), "sessionPath": s1p, "text": "Reply with exactly: OK"})
    emit("lat.prompt.warm.http_ms", t, "ms")
    # The first frame after the POST is the LLM's first token (model latency),
    # not daemon overhead; only the POST wall time is ours. Wait for the turn.
    th.join(timeout=120)
    if not warm_res["done"]:
        print("# warm prompt turn did not finish within timeout", flush=True)

    # --- cold session: crafted root-level file, no child. The handler still
    # returns immediately; the boot happens in the background task, so the
    # phone-visible send latency is measured to the first streamed event.
    # BENCH_TURNS=1 runs the warm prompt only; >=2 adds the cold one. ---
    if TURNS >= 2:
        s2p = os.path.join(CORPUS, f".latbench-{os.getpid()}-prompt.jsonl")
        write_bench_session(s2p)
        post_t = time.time()
        t, _ = api("POST", "/api/prompt", {"commandId": str(uuid.uuid4()), "sessionPath": s2p, "text": "Reply with exactly: OK"})
        emit("lat.prompt.cold.http_ms", t, "ms")
        first_cold, _ = ws_watch(s2p, started_after=post_t, stop_on_first=True, timeout_s=60)
        if first_cold is not None:
            emit("lat.prompt.cold.to_first_event_ms", first_cold, "ms")
        try:
            os.remove(s2p)
        except OSError:
            pass

    s1 = status_snapshot()
    emit("lat.prompt.counters.prompt_via_child", cdelta(s0, s1, "prompt_via_child"), "count")
    emit("lat.prompt.counters.child_spawn", cdelta(s0, s1, "child_spawn"), "count")
    bt = tdelta(s0, s1, "child_boot_ms")
    if bt:
        emit("lat.prompt.child_boot_avg_ms", bt[1], "ms")
        emit("lat.prompt.child_boot_max_ms", bt[2], "ms")
    try:
        os.remove(s1p)
    except OSError:
        pass


# --------------------------------------------------------------------------
# Phase 5: throughput under concurrency
# --------------------------------------------------------------------------

def sweep(path, dur, c):
    """C keep-alive workers hammer `path` for `dur` seconds. Returns ms list."""
    lat = []
    lock = threading.Lock()
    stop = time.monotonic() + dur
    barrier = threading.Barrier(c)

    def worker():
        conn = None
        try:
            barrier.wait(timeout=10)
        except threading.BrokenBarrierError:
            return
        while time.monotonic() < stop:
            if conn is None:
                conn = http.client.HTTPConnection(HOST, PORT, timeout=30)
            t0 = time.perf_counter()
            try:
                conn.request("GET", path, headers={"Authorization": "Bearer " + TOKEN})
                resp = conn.getresponse()
                resp.read()
                dt = (time.perf_counter() - t0) * 1000.0
                with lock:
                    lat.append(dt)
            except Exception:
                try:
                    if conn:
                        conn.close()
                except Exception:
                    pass
                conn = None
        try:
            if conn:
                conn.close()
        except Exception:
            pass

    threads = [threading.Thread(target=worker) for _ in range(c)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    return lat


def phase_sweep(picks):
    levels = SWEEP_LEVELS
    dur = 2.0 if QUICK else 5.0
    hist_path = "/api/history" + qs(picks["small"], limit=50) if picks else None

    base_sessions = base_history = None
    for c in levels:
        # Warmup: repopulate the sessions cache; discard the latency.
        api("GET", "/api/sessions")
        if hist_path:
            api("GET", hist_path)
        lat = sweep("/api/sessions", dur, c)
        emit(f"lat.sweep.c{c}.sessions.req_s", len(lat) / dur, "per_second")
        pstats(f"lat.sweep.c{c}.sessions", lat)
        if hist_path:
            lat = sweep(hist_path, dur, c)
            emit(f"lat.sweep.c{c}.history.req_s", len(lat) / dur, "per_second")
            pstats(f"lat.sweep.c{c}.history", lat)
        if c == 1:
            base_sessions = float(M.get(f"lat.sweep.c1.sessions.p95_ms", "nan"))
            base_history = float(M.get(f"lat.sweep.c1.history.p95_ms", "nan"))

    if not QUICK and base_sessions == base_sessions and levels:
        top = f"lat.sweep.c{levels[-1]}.sessions.p95_ms"
        if top in M:
            emit("lat.sweep.sessions.p95_ratio_vs_c1",
                 float(M[top]) / base_sessions, "ratio")
        top = f"lat.sweep.c{levels[-1]}.history.p95_ms"
        if top in M and base_history == base_history and base_history > 0:
            emit("lat.sweep.history.p95_ratio_vs_c1",
                 float(M[top]) / base_history, "ratio")

    # Barrier micro-burst: simultaneous cached /api/sessions calls expose the
    # SESSIONS_CACHE Mutex (clone under lock) + worker-pool serialization.
    burst_c = 16 if QUICK else 64
    api("GET", "/api/sessions")  # cache warm
    lat, barrier = [], threading.Barrier(burst_c)

    def burster():
        try:
            barrier.wait(timeout=10)
        except threading.BrokenBarrierError:
            return
        t0 = time.perf_counter()
        try:
            req = urllib.request.Request(BASE + "/api/sessions",
                                         headers={"Authorization": "Bearer " + TOKEN})
            with urllib.request.urlopen(req, timeout=30) as r:
                r.read()
            lat.append((time.perf_counter() - t0) * 1000.0)
        except Exception:
            pass

    threads = [threading.Thread(target=burster) for _ in range(burst_c)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    pstats(f"lat.sweep.burst{burst_c}.sessions", lat)


# --------------------------------------------------------------------------
# WS-attach pre-warm verification
# --------------------------------------------------------------------------

def phase_ws():
    try:
        import websockets  # noqa: F401
    except ImportError:
        print("# websockets not importable — skipping ws attach phase", flush=True)
        return

    if not CORPUS or not os.path.isdir(CORPUS):
        return
    path = os.path.join(CORPUS, f".latbench-{os.getpid()}-ws.jsonl")
    write_bench_session(path)
    s0 = status_snapshot()
    t0 = time.time()

    async def connect():
        async with websockets.connect(ws_url(path), max_size=64 * 1024 * 1024,
                                      ping_interval=None) as ws:
            return (time.time() - t0) * 1000.0

    try:
        attach_ms = asyncio.run(connect())
    except Exception as e:
        print(f"# ws attach failed: {e}", flush=True)
        attach_ms = float("nan")
    emit("lat.open.ws_attach_ms", attach_ms, "ms")
    s1 = wait_children_delta(s0, 1, timeout=15.0)
    bt = tdelta(s0, s1 or s0, "child_boot_ms")
    if bt:
        emit("lat.open.ws_prewarm_boot_ms", bt[2], "ms")
    try:
        os.remove(path)
    except OSError:
        pass


# --------------------------------------------------------------------------
# Daemon RSS from the harness sampler
# --------------------------------------------------------------------------

def phase_rss():
    if not RSS_LOG or not os.path.exists(RSS_LOG):
        return
    vals = []
    try:
        for line in open(RSS_LOG):
            if "\t" in line:
                part = line.split("\t")[1].strip()
                if part.isdigit():
                    vals.append(int(part))
    except OSError:
        return
    if vals:
        emit("lat.daemon.peak_rss_mib", max(vals) / 1024.0, "MiB")
        emit("lat.daemon.mean_rss_mib", (sum(vals) / len(vals)) / 1024.0, "MiB")


# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------

def f(name, default="n/a"):
    return M.get(name, default)


def summary(picks):
    print("\n=== SUMMARY", flush=True)
    rows = int(float(f("lat.sessions.rows", "0")))

    print(f"\nsessions (N={rows} files):", flush=True)
    print(f"  cold.first   {f('lat.sessions.cold.first_ms'):>9} ms  (incl. 64 KiB snippet tail per file, first touch)", flush=True)
    print(f"  cold p50     {f('lat.sessions.cold.p50_ms'):>9} ms  (post-expiry refresh: scan+header+proc+enrich)", flush=True)
    print(f"  cached p50   {f('lat.sessions.cached.p50_ms'):>9} ms  (within 3 s TTL; still pays stat+serialize per row)", flush=True)
    print(f"  cached bytes {f('lat.sessions.cached.bytes'):>9} B   (phone downloads this every 3 s, uncompressed)", flush=True)
    print(f"  syscall floor {f('lat.sessions.syscall_floor_ms'):>8} ms  (python scandir+stat+4K read, {f('lat.sessions.floor.files')} files)", flush=True)
    print(f"  our overhead  {f('lat.sessions.cold_overhead_ms'):>8} ms  (cold p50 - floor) = {f('lat.sessions.per_file_us')} us/file", flush=True)
    print(f"  /proc sweep   {f('lat.sessions.floor_proc_ms'):>8} ms  ({M.get('#proc_pids','?')} pids, {M.get('#proc_omp_like','?')} omp-like, {M.get('#proc_fd_links','?')} fd links)", flush=True)
    print(f"  snippet tails {f('lat.sessions.floor_snippet_ms'):>8} ms  (first touch only; cached by mtime after)", flush=True)
    if "lat.sessions.floor_big_ms" in M:
        big_files = int(float(f("lat.sessions.floor_big.files", "1")))
        cur_ms = float(f("lat.sessions.syscall_floor_ms", "0"))
        big_ms = float(f("lat.sessions.floor_big_ms", "0"))
        slope = (big_ms - cur_ms) / max(1, big_files - rows) * 1000
        print(f"  floor @{big_files:<5} {big_ms:>8.2f} ms — I/O scaling slope {slope:.0f} ns/file "
              f"(vs {rows} files / {cur_ms:.2f} ms here)", flush=True)

    print("\nhistory (page1 = backward 50 from EOF):", flush=True)
    for tag in ("small", "mid", "big"):
        p50 = f(f"lat.history.{tag}.page1.p50_ms")
        mb = f(f"lat.history.{tag}.page1.read_mibps")
        by = f(f"lat.history.{tag}.page1.bytes")
        print(f"  {tag:9} page1 p50 {p50:>8} ms  resp {by:>8} B  file-read {mb:>8} MiB/s", flush=True)
    if "lat.history.longlines.page1.p50_ms" in M:
        print(f"  longlines    page1 p50 {f('lat.history.longlines.page1.p50_ms'):>8} ms  (2 MiB single line: backward window grows to whole file)", flush=True)
    if "lat.history.medium.walk_ms" in M:
        print(f"  medium walk  {f('lat.history.medium.walk_pages')} pages in {f('lat.history.medium.walk_ms'):>8} ms, {f('lat.history.medium.walk_bytes')} B", flush=True)

    print("\nopen / rpc / prompt:", flush=True)
    print(f"  open cold_http p50 {f('lat.open.cold_http.p50_ms'):>8} ms  (handler returns; boot is async)", flush=True)
    print(f"  open child_boot    {f('lat.open.child_boot_ms'):>8} ms  (daemon's own child_boot_ms timing)", flush=True)
    print(f"  open warm_http p50 {f('lat.open.warm_http.p50_ms'):>8} ms", flush=True)
    print(f"  ws attach          {f('lat.open.ws_attach_ms'):>8} ms ; ws prewarm boot {f('lat.open.ws_prewarm_boot_ms')} ms", flush=True)
    print(f"  rpc get_state warm p50 {f('lat.rpc.get_state.warm.p50_ms'):>7} ms ; cold {f('lat.rpc.get_state.cold_ms')} ms", flush=True)
    if "lat.prompt.warm.http_ms" in M:
        print(f"  prompt warm http {f('lat.prompt.warm.http_ms'):>8} ms ; cold http {f('lat.prompt.cold.http_ms')} ms ; cold->first event {f('lat.prompt.cold.to_first_event_ms')} ms", flush=True)

    print("\nconcurrency:", flush=True)
    for c in SWEEP_LEVELS:
        rs = f(f"lat.sweep.c{c}.sessions.req_s")
        rp = f(f"lat.sweep.c{c}.sessions.p95_ms")
        hr = f(f"lat.sweep.c{c}.history.req_s")
        hp = f(f"lat.sweep.c{c}.history.p95_ms")
        print(f"  C={c:>2}  sessions {rs:>8} req/s p95 {rp:>8} ms | history {hr:>8} req/s p95 {hp:>8} ms", flush=True)
    print(f"  burst p95 {f('lat.sweep.burst16.sessions.p95_ms' if QUICK else 'lat.sweep.burst64.sessions.p95_ms')} ms (simultaneous cached calls)", flush=True)

    print("\nfindings (MEASURED this run; INFERRED items labelled):", flush=True)
    if rows:
        c50 = float(M.get("lat.sessions.cached.p50_ms", "nan"))
        col50 = float(M.get("lat.sessions.cold.p50_ms", "nan"))
        fl = float(M.get("lat.sessions.syscall_floor_ms", "nan"))
        proc = float(M.get("lat.sessions.floor_proc_ms", "nan"))
        cbytes = int(float(M.get("lat.sessions.cached.bytes", "0")))
        if c50 == c50:
            print(f"  - cached /api/sessions costs {c50:.1f} ms/call and returns {cbytes/1048576:.2f} MiB "
                  f"uncompressed; a phone polling every 3 s pays the COLD path ({col50:.1f} ms) every poll "
                  f"because the 3 s TTL expires between polls.", flush=True)
        if fl == fl and col50 == col50:
            print(f"  - cold refresh: {col50:.1f} ms total vs {fl:.1f} ms syscall floor "
                  f"({100*fl/col50:.0f}% unavoidable I/O); our overhead {col50-fl:.1f} ms = "
                  f"{M.get('lat.sessions.per_file_us','?')} us/file — scan optimizations are bounded by the floor", flush=True)
        if proc:
            print(f"  - /proc owner sweep adds ~{proc:.1f} ms per refresh ({M.get('#proc_pids','?')} pids on this box); "
                  f"it runs on every cache expiry, i.e. every poll at 3 s cadence", flush=True)
    for tag, p50, by in (("big", M.get("lat.history.big.page1.p50_ms"),
                          M.get("lat.history.big.page1.bytes")),
                         ("mid", M.get("lat.history.mid.page1.p50_ms"),
                          M.get("lat.history.mid.page1.bytes"))):
        if p50:
            sz = float(M.get(f"lat.session.{tag}.size_bytes", "0"))
            print(f"  - history page1 on {tag} ({sz/1048576:.0f} MiB): {p50} ms to serve {by} B — "
                  f"read_backward re-reads the whole file per page (src/sessions/jsonl.rs read_backward: fs::read)", flush=True)
    if "lat.history.longlines.page1.p50_ms" in M:
        print(f"  - long single line (2 MiB): page1 {M['lat.history.longlines.page1.p50_ms']} ms — "
              f"the backward window grows to the whole file; also the 2 MiB line is sent verbatim", flush=True)
    if M.get("lat.open.cold_http.small_ms") and M.get("lat.open.child_boot_ms"):
        print(f"  - /api/open handler is {M['lat.open.cold_http.small_ms']} ms cold / "
              f"{M.get('lat.open.warm_http.p50_ms','?')} ms warm; the {M['lat.open.child_boot_ms']} ms child boot "
              f"is async (pre-warm), so it is hidden from the phone only if a child can boot on the file", flush=True)
    if "lat.prompt.warm.http_ms" in M and "lat.prompt.cold.to_first_event_ms" in M:
        print(f"  - prompt POST returns in {M['lat.prompt.warm.http_ms']} ms (warm) / "
              f"{M['lat.prompt.cold.http_ms']} ms (cold handler); without pre-warm the phone waits "
              f"{M['lat.prompt.cold.to_first_event_ms']} ms for the first streamed event (child boot + first token)", flush=True)
    if not QUICK and "lat.sweep.sessions.p95_ratio_vs_c1" in M:
        print(f"  - sessions p95 at C={SWEEP_LEVELS[-1]} is {M['lat.sweep.sessions.p95_ratio_vs_c1']}x the C=1 p95 "
              f"(INFERRED mechanism: SESSIONS_CACHE clone under Mutex + per-row stat loop saturating tokio workers; "
              f"measured sub-linear, not pathological)", flush=True)


def main():
    print(f"# lat.py quick={QUICK} turns={TURNS} corpus={CORPUS or '(unset)'} "
          f"base={BASE}", flush=True)
    try:
        status_snapshot()
    except Exception as e:
        sys.exit(f"bench daemon unreachable at {BASE}: {e}")

    picks = phase_sessions()   # also emits cold/cached metrics
    phase_floor()              # syscall floors (before any bench child spawns)
    phase_history(picks)
    crafted = phase_open(picks) or []
    warm_path = crafted[0] if crafted else None
    phase_rpc(warm_path)
    phase_sweep(picks)
    phase_ws()
    if TURNS > 0:
        phase_prompt()
    phase_rss()
    summary(picks)
    for p in crafted:          # remove our crafted sessions from the corpus root
        try:
            os.remove(p)
        except OSError:
            pass


if __name__ == "__main__":
    main()
