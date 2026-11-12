#!/usr/bin/env python3
"""Memory-efficiency measurement for omp-pulse.

WHAT it measures
  The daemon is ~34 MB at rest, but every `omp --mode rpc` child is ~287 MB and
  the LRU cap is 6 (worst case ~1.7 GB). This script finds where memory actually
  goes and whether anything grows without bound:

    1. Baseline & steady state  - daemon RSS at boot, after listing the full
       session corpus, and after opening+streaming; anon-vs-file-backed split
       from /proc/<pid>/smaps_rollup (heap vs mapping growth).
    2. Per-WS-client cost       - attach K held clients to ONE session (only the
       first pre-warms a child) and report the marginal RSS per extra client.
    3. Per-watched-session cost - watch W distinct sessions (each watch also
       pre-warms a child, up to the cap) and report RSS delta per watch, plus
       the effect of an unterminated >1 MiB tail line on the watcher's
       PathState.partial buffer.
    4. Child lifecycle          - child RSS from /proc, idle survival (no idle
       TTL exists), LRU eviction enforcement, and the total system footprint
       (daemon RSS + all children) at the default cap.
    5. Slow-consumer probe      - THE safety question: the hub keeps an
       UNBOUNDED UnboundedSender<String> per client (src/server/ws.rs). A client that
       never reads from the socket while a session streams proves or disproves
       unbounded growth: attach a raw-socket WS client that stops reading,
       append data, and watch daemon RSS track the appended bytes. A reading
       client is the control (RSS must stay flat).
    6. Leak/churn soak          - continuous attach/detach + /api/history
       churn; linear-regression RSS slope is the pass/fail number.

WHY these numbers matter for a phone-driven daemon
  The phone talks to this daemon over WS on cellular. If per-client or
  per-watch memory is unbounded, a handful of phones with flaky networks can
  OOM the daemon (or force it to swap) long before the child cap is hit. The
  child pre-warm on plain WS attach decides whether *watching* a conversation
  costs ~287 MB of RSS, which is the difference between a 34 MB daemon and a
  1.7 GB footprint.

HOW to read the output
  Every measurement is one line:  METRIC <dotted.name> <value> <unit>
  A `=== SUMMARY` section at the end ranks the findings. Run under
  bench/with-bench-daemon.sh (exports BENCH_BASE/BENCH_TOKEN/BENCH_PID/
  BENCH_CORPUS/BENCH_RSS_LOG). BENCH_QUICK=1 runs a small fast version.

SAFETY
  - Only the harness's isolated daemon is touched (own port/token/state dir).
  - Children are spawned only against PRIVATE session files created under
    $BENCH_CORPUS/mem-bench-<pid>/ and deleted at the end: an omp child is the
    write path and can rewrite a session file on exit, so the shared seeded
    corpus is used for read-only listing/history only, never opened/attached.
  - No prompt-driven turns: all RPC work is open/negotiate at spawn. No token,
    no collab link, no session content is printed.
"""
import asyncio
import base64
import json
import os
import random
import shutil
import socket
import statistics
import subprocess
import sys
import time
import urllib.parse
import urllib.request

QUICK = os.environ.get("BENCH_QUICK") == "1"

BASE = os.environ.get("BENCH_BASE", "http://127.0.0.1:7690")
WSBASE = BASE.replace("http://", "ws://").replace("https://", "wss://")
TOKEN = os.environ.get("BENCH_TOKEN")
if not TOKEN:
    print("BENCH_TOKEN is unset: run under bench/with-bench-daemon.sh", file=sys.stderr)
    sys.exit(2)
DAEMON = int(os.environ["BENCH_PID"])
CORPUS = os.environ["BENCH_CORPUS"]
RSS_LOG = os.environ.get("BENCH_RSS_LOG")
PORT = urllib.parse.urlparse(BASE).port or 7690
SOAK_SECS = int(os.environ.get("BENCH_SOAK_SECS", "15" if QUICK else "120"))

random.seed(20260812)

PROSE = ("The daemon watches the session file with inotify and forwards appended "
         "entries to every attached client, serializing each event exactly once. ")

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def metric(name, value, unit):
    print(f"METRIC {name} {value} {unit}")


def api(method, path, body=None, timeout=60):
    req = urllib.request.Request(
        BASE + path, method=method,
        headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"},
        data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def read_status(pid):
    try:
        with open(f"/proc/{pid}/status") as f:
            d = {}
            for line in f:
                k, _, v = line.partition(":")
                d[k.strip()] = v.strip()
            return d
    except (FileNotFoundError, ProcessLookupError):
        return None


def rss_kb(pid):
    st = read_status(pid)
    if not st:
        return 0
    try:
        return int(st["VmRSS"].split()[0])
    except (KeyError, ValueError):
        return 0


def smaps(pid):
    try:
        with open(f"/proc/{pid}/smaps_rollup") as f:
            d = {}
            for line in f:
                k, _, v = line.partition(":")
                d[k.strip()] = int(v.strip().split()[0])
            return d
    except (FileNotFoundError, ProcessLookupError, ValueError):
        return {}


def pct(vals, p):
    if not vals:
        return 0.0
    s = sorted(vals)
    return s[min(len(s) - 1, int(p / 100.0 * len(s)))]


def boot_rss_from_log():
    """min of the first samples the harness sampler recorded (~true boot RSS)."""
    if not RSS_LOG or not os.path.isfile(RSS_LOG):
        return None
    try:
        vals = []
        with open(RSS_LOG) as f:
            for line in f:
                parts = line.split("\t")
                if len(parts) >= 2:
                    try:
                        vals.append(int(parts[1]))
                    except ValueError:
                        pass
                if len(vals) >= 5:
                    break
        return min(vals) if vals else None
    except OSError:
        return None


def live_children():
    """Direct children of the bench daemon (omp --mode rpc processes).

    The daemon spawns `omp --mode rpc --cwd <dir> --session-dir <root>`; the
    shim execs the real binary in place, so the pid is stable. omp does NOT
    chdir to --cwd (it keeps the daemon's cwd), so /proc/<pid>/cwd is not a
    reliable discriminator — the parent pid is: ppid==BENCH_PID excludes the
    live daemon's children and other bench runs' children.
    """
    try:
        out = subprocess.run(["pgrep", "-f", "omp --mode rpc"],
                             capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return []
    pids = []
    for tok in out.split():
        try:
            pid = int(tok)
        except ValueError:
            continue
        if pid in (os.getpid(), DAEMON):
            continue
        try:
            with open(f"/proc/{pid}/stat") as f:
                stat = f.read()
            ppid = int(stat.rsplit(")", 1)[1].split()[1])
        except Exception:
            continue
        if ppid == DAEMON:
            pids.append(pid)
    if os.environ.get("MEM_DEBUG"):
        print(f"[mem-debug] pgrep raw={out.split()!r} -> children={pids}", file=sys.stderr)
    return sorted(set(pids))


def child_stats(pids):
    rss = []
    hwm = []
    for pid in pids:
        st = read_status(pid)
        if not st:
            continue
        try:
            rss.append(int(st["VmRSS"].split()[0]) / 1024.0)
            hwm.append(int(st["VmHWM"].split()[0]) / 1024.0)
        except (KeyError, ValueError):
            pass
    return rss, hwm


async def settle(seconds=1.5, n=6):
    """Sample daemon RSS over a short window; return median (MB)."""
    vals = []
    for _ in range(n):
        vals.append(rss_kb(DAEMON))
        await asyncio.sleep(seconds / n)
    return statistics.median(vals) / 1024.0


def ws_url(session):
    return f"{WSBASE}/ws?session={urllib.parse.quote(session)}&token={TOKEN}"


async def connect_ws(session):
    import websockets
    return await websockets.connect(
        ws_url(session), max_size=64 * 1024 * 1024,
        open_timeout=10, close_timeout=1, ping_interval=None, ping_timeout=None)


_msg_seq = [0]


def entry_line(nbytes):
    """A session-file line in the REAL omp wire shape.

    CRITICAL: omp's session loader reads `message.role` (nested), so entries
    MUST be `{"type":"message","id":...,"message":{"role":...}}`. The corpus
    seeder's top-level `role` shape crashes `switch_session` with
    "msg.role is not an object" and kills the pre-warmed child (measured).
    """
    _msg_seq[0] += 1
    text = (PROSE * (nbytes // len(PROSE) + 2))[:nbytes]
    return json.dumps({
        "type": "message",
        "id": f"m{_msg_seq[0]:06d}",
        "parentId": None if _msg_seq[0] == 1 else f"m{_msg_seq[0] - 1:06d}",
        "timestamp": "2026-08-12T00:00:00.000Z",
        "message": {"role": "user", "content": [{"type": "text", "text": text}]},
    })


def seed_private_session(path, nlines=3, line_bytes=512):
    """Write a session file with the real omp header (title + session v3)."""
    sid = f"bench-{os.path.basename(path)}"
    title = {"type": "title", "v": 1, "title": sid, "source": "auto",
             "updatedAt": "2026-08-12T00:00:00.000Z", "pad": ""}
    sess = {"type": "session", "version": 3, "id": sid,
            "timestamp": "2026-08-12T00:00:00.000Z",
            "cwd": os.path.dirname(path), "title": sid, "titleSource": "auto"}
    with open(path, "w") as f:
        f.write(json.dumps(title) + "\n")
        f.write(json.dumps(sess) + "\n")
        for _ in range(nlines):
            f.write(entry_line(line_bytes) + "\n")


async def append_stream(path, total_mb, line_bytes=16 * 1024, batch=50, rate_mb_s=4.0):
    """Append valid JSONL entries to `path` at ~rate_mb_s MB/s.

    Each batch lands as one write() so the watcher always drains complete
    lines; inotify fires per batch and the drain pushes one Entries frame
    (~batch bytes) into every attached client's channel.
    """
    target = int(total_mb * 1048576)
    written = 0
    batch_bytes = batch * (line_bytes + 400)
    delay = max(0.001, batch_bytes / (rate_mb_s * 1048576))
    with open(path, "ab") as f:
        while written < target:
            lines = [entry_line(line_bytes) for _ in range(batch)]
            data = ("\n".join(lines) + "\n").encode()
            f.write(data)
            f.flush()
            written += len(data)
            await asyncio.sleep(delay)
    return written


def raw_ws_connect(session):
    """Minimal WS client that completes the upgrade then NEVER reads again.

    The point: a real phone that stops reading (cell handover, backgrounded
    app) leaves the daemon's per-client UnboundedSender to grow. A `websockets`
    library client cannot demonstrate this (its internal reader keeps draining
    the socket), so we speak the protocol by hand and then go silent — the
    kernel receive buffer fills, the daemon's socket.send() stalls, and the
    hub channel is the only place left for frames to go.
    """
    s = socket.create_connection(("127.0.0.1", PORT), timeout=5)
    s.settimeout(5)
    key = base64.b64encode(os.urandom(16)).decode()
    path = f"/ws?session={urllib.parse.quote(session)}&token={TOKEN}"
    req = (f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\n"
           f"Upgrade: websocket\r\nConnection: Upgrade\r\n"
           f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
    s.sendall(req.encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = s.recv(4096)
        if not chunk:
            raise ConnectionError("socket closed during WS upgrade")
        buf += chunk
    if b" 101 " not in buf.split(b"\r\n", 1)[0]:
        raise ConnectionError(f"WS upgrade failed: {buf[:80]!r}")
    return s  # silence: caller must never recv() from this socket again


def ls_slope(samples):
    """Least-squares slope over (epoch, rss_kb) samples -> kB per minute."""
    n = len(samples)
    if n < 3:
        return 0.0
    ts = [s[0] for s in samples]
    ys = [s[1] for s in samples]
    t0 = ts[0]
    xs = [t - t0 for t in ts]
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    den = sum((x - mx) ** 2 for x in xs)
    if den == 0:
        return 0.0
    return num / den * 60.0  # kB per minute


def soak_verdict(slope):
    if slope >= 100:
        return "GROWING (fail)"
    if slope <= -100:
        return "DECREASING (pass)"
    return "FLAT (pass)"


# ---------------------------------------------------------------------------
# phases
# ---------------------------------------------------------------------------

async def phase_baseline(private_dir, clients, seen_children):
    t0 = time.time()
    boot_log = boot_rss_from_log()
    boot = await settle(1.5, 6)
    metric("mem.daemon.boot_rss_mb", round(boot, 2), "MiB")
    if boot_log:
        metric("mem.daemon.boot_rss_log_mb", round(boot_log / 1024.0, 2), "MiB")

    # ---- listing the whole corpus (COLD: scans 3365 files + snippets) ----
    s0 = smaps(DAEMON)
    t1 = time.time()
    listing = api("GET", "/api/sessions")   # first call: cold scan
    list_ms = (time.time() - t1) * 1000.0
    sessions = [s["path"] for s in listing.get("sessions", [])]
    n_sessions = len(sessions)
    after_list = await settle(1.5, 6)
    metric("mem.daemon.sessions_count", n_sessions, "count")
    metric("mem.daemon.list_latency_ms", round(list_ms, 1), "ms")
    metric("mem.daemon.after_list_rss_mb", round(after_list, 2), "MiB")
    metric("mem.daemon.list_delta_mb", round(after_list - boot, 2), "MiB")
    s_list = smaps(DAEMON)
    metric("mem.daemon.list_anon_delta_mb",
           round((s_list.get("Anonymous", 0) - s0.get("Anonymous", 0)) / 1024.0, 2), "MiB")
    metric("mem.daemon.list_file_delta_mb",
           round(((s_list.get("Rss", 0) - s_list.get("Anonymous", 0))
                  - (s0.get("Rss", 0) - s0.get("Anonymous", 0))) / 1024.0, 2), "MiB")

    # ---- open + stream a session (open pre-warms a child, ~287 MB process) ----
    open_path = os.path.join(private_dir, "open.jsonl")
    seed_private_session(open_path)
    api("POST", "/api/open", {"sessionPath": open_path})
    await asyncio.sleep(5.0)  # fire-and-forget pre-warm child boot
    stream_path = os.path.join(private_dir, "stream.jsonl")
    seed_private_session(stream_path)
    ws = await connect_ws(stream_path)
    clients.append(ws)
    drain = asyncio.create_task(drain_frames(ws, 0.05))
    appended = await append_stream(stream_path, 6 if QUICK else 12)
    await asyncio.sleep(1.0)
    drain.cancel()
    after_stream = await settle(1.5, 6)
    metric("mem.daemon.after_stream_rss_mb", round(after_stream, 2), "MiB")
    metric("mem.daemon.stream_delta_mb", round(after_stream - after_list, 2), "MiB")
    metric("mem.daemon.stream_bytes_appended_mb", round(appended / 1048576.0, 2), "MiB")

    s1 = smaps(DAEMON)
    anon = s1.get("Anonymous", 0) / 1024.0
    file_b = (s1.get("Rss", 0) - s1.get("Anonymous", 0)) / 1024.0
    metric("mem.daemon.anon_mb", round(anon, 2), "MiB")
    metric("mem.daemon.file_backed_mb", round(file_b, 2), "MiB")
    st = read_status(DAEMON)
    metric("mem.daemon.threads", int(st["Threads"]) if st else 0, "count")

    kids = live_children()
    seen_children.update({p: time.time() for p in kids})
    crss, _ = child_stats(kids)
    metric("mem.daemon.children_alive", len(kids), "count")
    metric("mem.daemon.footprint_total_mb",
           round(after_stream + sum(crss), 2), "MiB")
    return {"boot_mb": boot, "after_list_mb": after_list, "after_stream_mb": after_stream,
            "children": kids, "sessions": sessions}


async def drain_frames(ws, per=0.05, max_wait=1.0):
    """Consume WS frames until cancelled or a quiet gap."""
    while True:
        try:
            await asyncio.wait_for(ws.recv(), timeout=per)
        except asyncio.TimeoutError:
            await asyncio.sleep(max_wait)
            return
        except Exception:
            return


async def phase_per_client(private_dir, shared_name, clients, seen_children):
    """K held clients on ONE session: isolates marginal per-client cost.

    The first attach pre-warms a child (reported separately); the rest skip
    pre-warm (has_child), so their marginal cost is pure hub + WS connection.
    """
    path = os.path.join(private_dir, shared_name)
    seed_private_session(path)
    base = await settle(1.5, 6)

    ws1 = await connect_ws(path)
    clients.append(ws1)
    await asyncio.sleep(5.0)  # pre-warm child boot
    after1 = await settle(1.5, 6)
    first_delta = after1 - base
    metric("mem.client.first_attach_delta_mb", round(first_delta, 3), "MiB")
    metric("mem.client.first_attach_incl_prewarm_children",
           len(live_children()), "count")

    targets = {"k2": 1, "k8": 6} if QUICK else {"k16": 15, "k64": 48, "k200": 136}
    for name, extra in targets.items():
        prev = after1 if name == ("k2" if QUICK else "k16") else last
        for _ in range(extra):
            clients.append(await connect_ws(path))
        await asyncio.sleep(2.0)
        now = await settle(1.5, 6)
        per = (now - prev) / extra * 1024.0
        metric(f"mem.client.extra_kib_per_client.{name}", round(per, 1), "KiB")
        metric(f"mem.client.delta_mb.{name}", round(now - base, 3), "MiB")
        last = now

    kids = live_children()
    seen_children.update({p: time.time() for p in kids})
    return {"base_mb": base, "last_mb": last}


async def phase_per_watch(private_dir, real_sessions, clients, seen_children):
    """W clients on W distinct sessions: per-watch cost (incl. pre-warm children)."""
    counts = [4] if QUICK else [4, 32, 128]
    watched = 0
    for w in counts:
        extra = w - watched
        base = await settle(1.5, 6)
        before_kids = set(live_children())
        paths = []
        for i in range(extra):
            p = os.path.join(private_dir, f"watch-{watched + i:03d}.jsonl")
            seed_private_session(p)
            paths.append(p)
            clients.append(await connect_ws(p))
        watched = w
        await asyncio.sleep(5.0)  # pre-warm children boot (up to cap, with evictions)
        after = await settle(1.5, 6)
        delta = after - base
        metric(f"mem.watch.delta_mb.w{w}", round(delta, 3), "MiB")
        metric(f"mem.watch.delta_mb_per_watch.w{w}", round(delta / w, 3), "MiB")
        kids = live_children()
        seen_children.update({p: time.time() for p in kids})
        spawned = len(set(kids) - before_kids)
        metric(f"mem.watch.prewarm_children.w{w}", len(kids), "count")
        metric(f"mem.watch.prewarm_new_children.w{w}", spawned, "count")
        crss, _ = child_stats(kids)
        metric(f"mem.watch.children_rss_mb.w{w}", round(sum(crss), 1), "MiB")
        if crss:
            metric(f"mem.watch.child_rss_p50_mb.w{w}", round(pct(crss, 50), 1), "MiB")
            metric(f"mem.watch.child_rss_max_mb.w{w}", round(max(crss), 1), "MiB")
    return {"watched": watched}


async def phase_slow_consumer(private_dir, seen_children):
    """THE safety probe: non-reading client vs reading client while streaming.

    Proves/disproves unbounded per-client queue growth with numbers:
      growth_ratio = daemon RSS growth / bytes appended. ~1.0 for a non-reading
      client (frames pile up 1:1 in the unbounded channel) and ~0.0 for a
      reading client (frames are consumed) is the unbounded verdict.
    """
    path = os.path.join(private_dir, "sc.jsonl")
    seed_private_session(path)
    sock = raw_ws_connect(path)  # never read from this socket again
    await asyncio.sleep(1.0)
    base = await settle(1.5, 6)
    metric("mem.slowconsumer.base_rss_mb", round(base, 2), "MiB")

    phases = [("a", 24 if QUICK else 150), ("b", 24 if QUICK else 150)]
    for name, mb in phases:
        before = rss_kb(DAEMON) / 1024.0
        samples = []
        stop = asyncio.Event()

        async def sampler():
            while not stop.is_set():
                samples.append((time.time(), rss_kb(DAEMON)))
                await asyncio.sleep(0.5)

        st = asyncio.create_task(sampler())
        t0 = time.time()
        appended = await append_stream(path, mb, line_bytes=4096, rate_mb_s=4.0)
        elapsed = time.time() - t0
        await asyncio.sleep(1.5)  # let drains catch up
        stop.set()
        await st
        after = rss_kb(DAEMON) / 1024.0
        growth = after - before
        appended_mb = appended / 1048576.0
        metric(f"mem.slowconsumer.appended_mb.{name}", round(appended_mb, 1), "MiB")
        metric(f"mem.slowconsumer.rss_growth_mb.{name}", round(growth, 1), "MiB")
        metric(f"mem.slowconsumer.growth_ratio.{name}",
               round(growth / appended_mb if appended_mb else 0.0, 3), "ratio")
        metric(f"mem.slowconsumer.append_rate_mb_s.{name}",
               round(appended_mb / elapsed, 1), "MiB/s")
        if len(samples) >= 3:
            metric(f"mem.slowconsumer.rss_slope_mb_per_s.{name}",
                   round(ls_slope(samples) / (60.0 * 1024.0), 3), "MiB/s")

    # ---- control: same appends, but a client that IS reading ----
    sock.close()  # RST -> daemon send fails -> handler detaches + unwatches
    await asyncio.sleep(1.0)
    ws = await connect_ws(path)
    drain = asyncio.create_task(drain_frames(ws, 0.05))
    before = rss_kb(DAEMON) / 1024.0
    appended = await append_stream(path, 16 if QUICK else 80, line_bytes=4096, rate_mb_s=4.0)
    await asyncio.sleep(1.0)
    drain.cancel()
    after = rss_kb(DAEMON) / 1024.0
    appended_mb = appended / 1048576.0
    metric("mem.slowconsumer.control_appended_mb", round(appended_mb, 1), "MiB")
    metric("mem.slowconsumer.control_rss_growth_mb", round(after - before, 1), "MiB")
    metric("mem.slowconsumer.control_growth_ratio",
           round((after - before) / appended_mb if appended_mb else 0.0, 3), "ratio")

    seen_children.update({p: time.time() for p in live_children()})
    return {"base_mb": base}


async def phase_partial(private_dir, seen_children):
    """Measure a growing unterminated tail and its release on newline.

    Both writes stay within the watcher's 8 MiB catch-up cap, so the second
    measurement is a buffered partial rather than a forced history refresh.
    """
    path = os.path.join(private_dir, "partial.jsonl")
    seed_private_session(path, nlines=1)
    ws = await connect_ws(path)
    drain = asyncio.create_task(drain_frames(ws, 0.05))
    await asyncio.sleep(2.0)  # attach + watch baseline
    base = await settle(1.5, 6)

    line_mb = 3 if QUICK else 4
    blob = b"PAD " * (line_mb * 1048576 // 4)
    with open(path, "ab") as f:
        f.write(blob)                   # unterminated: becomes the partial tail
        f.flush()
    await asyncio.sleep(1.0)
    hold1 = await settle(1.5, 6)
    metric("mem.partial.line_mb", line_mb, "MiB")
    metric("mem.partial.rss_delta_while_held_mb", round(hold1 - base, 2), "MiB")

    with open(path, "ab") as f:
        f.write(blob)                   # grow the same line
        f.flush()
    await asyncio.sleep(1.0)
    hold2 = await settle(1.5, 6)
    metric("mem.partial.line_grown_mb", line_mb * 2, "MiB")
    metric("mem.partial.rss_delta_grown_mb", round(hold2 - base, 2), "MiB")

    with open(path, "ab") as f:          # terminate the line -> partial cleared
        f.write(b"\n")
        f.flush()
    await asyncio.sleep(1.0)
    after = await settle(1.5, 6)
    metric("mem.partial.freed_after_terminate_mb", round(hold2 - after, 2), "MiB")
    drain.cancel()
    await ws.close()
    seen_children.update({p: time.time() for p in live_children()})
    return {"base_mb": base, "held_mb": hold2 - base}


async def phase_children(private_dir, seen_children):
    """Child lifecycle: RSS, idle survival (no TTL), LRU eviction enforcement."""
    before_pids = set(live_children())
    n_before = len(before_pids)
    metric("mem.child.count_before_evict", n_before, "count")

    # 7 opens on fresh sessions force spawns past the cap -> LRU evictions.
    for i in range(7):
        p = os.path.join(private_dir, f"child-{i:02d}.jsonl")
        seed_private_session(p)
        api("POST", "/api/open", {"sessionPath": p})
    await asyncio.sleep(6.0)
    after_pids = set(live_children())
    n_after = len(after_pids)
    metric("mem.child.count_after_evict", n_after, "count")
    metric("mem.child.evicted_pids", len(before_pids - after_pids), "count")
    metric("mem.child.cap_observed", n_after, "count")

    rss, hwm = child_stats(list(after_pids))
    if rss:
        metric("mem.child.rss_p50_mb", round(pct(rss, 50), 1), "MiB")
        metric("mem.child.rss_p95_mb", round(pct(rss, 95), 1), "MiB")
        metric("mem.child.rss_max_mb", round(max(rss), 1), "MiB")
        metric("mem.child.hwm_max_mb", round(max(hwm), 1), "MiB")
        metric("mem.child.total_rss_mb", round(sum(rss), 1), "MiB")

    daemon_now = rss_kb(DAEMON) / 1024.0
    metric("mem.footprint.at_cap_mb", round(daemon_now + sum(rss), 1), "MiB")
    metric("mem.footprint.daemon_share_mb", round(daemon_now, 1), "MiB")
    seen_children.update({p: time.time() for p in after_pids})
    return {"n_before": n_before, "n_after": n_after}


async def phase_soak(private_dir, real_sessions, seen_children):
    """Attach/detach + /api/history churn; RSS slope is the pass condition."""
    paths = []
    for i in range(4):
        p = os.path.join(private_dir, f"soak-{i}.jsonl")
        seed_private_session(p)
        paths.append(p)
    base = await settle(1.5, 6)
    children_start = len(live_children())

    samples = []
    stop = asyncio.Event()

    async def sampler():
        while not stop.is_set():
            samples.append((time.time(), rss_kb(DAEMON)))
            await asyncio.sleep(0.5)

    st = asyncio.create_task(sampler())
    cycles = 0
    t0 = time.time()
    try:
        while time.time() - t0 < SOAK_SECS:
            s = paths[cycles % len(paths)]
            try:
                ws = await connect_ws(s)
                try:
                    await asyncio.wait_for(ws.recv(), timeout=0.4)
                except asyncio.TimeoutError:
                    pass
                await ws.close()
            except Exception:
                pass
            rs = real_sessions[random.randrange(len(real_sessions))]
            try:
                api("GET", f"/api/history?session={urllib.parse.quote(rs)}", timeout=15)
            except Exception:
                pass
            cycles += 1
            await asyncio.sleep(0.05)
    finally:
        stop.set()
        await st

    end = await settle(1.5, 6)
    children_end = len(live_children())
    slope = ls_slope(samples)
    metric("mem.soak.duration_s", round(SOAK_SECS, 1), "count")
    metric("mem.soak.churn_cycles", cycles, "count")
    metric("mem.soak.start_rss_mb", round(base, 2), "MiB")
    metric("mem.soak.end_rss_mb", round(end, 2), "MiB")
    metric("mem.soak.delta_mb", round(end - base, 2), "MiB")
    metric("mem.soak.slope_kib_per_min", round(slope, 1), "KiB/min")
    metric("mem.soak.children_start", children_start, "count")
    metric("mem.soak.children_end", children_end, "count")
    seen_children.update({p: time.time() for p in live_children()})
    return {"start_mb": base, "end_mb": end, "slope": slope, "cycles": cycles,
            "duration_s": SOAK_SECS}


async def main():
    import websockets  # noqa: F401  (import check; connect_ws uses it)

    api("GET", "/api/status")  # auth + daemon sanity
    private_dir = os.path.join(CORPUS, f"mem-bench-{os.getpid()}")
    os.makedirs(private_dir, exist_ok=True)

    clients = []        # held websockets to close at the end
    seen_children = {}  # pid -> first-seen epoch (idle-survival evidence)

    try:
        ph1 = await phase_baseline(private_dir, clients, seen_children)
        real_sessions = ph1["sessions"]
        if not real_sessions:
            raise SystemExit("no sessions in corpus listing")
        ph2 = await phase_per_client(private_dir, "shared.jsonl", clients, seen_children)
        ph3 = await phase_per_watch(private_dir, real_sessions, clients, seen_children)
        ph4 = await phase_slow_consumer(private_dir, seen_children)
        ph5 = await phase_partial(private_dir, seen_children)
        ph6 = await phase_children(private_dir, seen_children)
        ph7 = await phase_soak(private_dir, real_sessions, seen_children)

        # End-of-run idle-survival: children spawned by WS attaches / opens
        # that are still alive after minutes of zero prompts.
        alive = set(live_children())
        surv = [(p, seen_children[p]) for p in alive if p in seen_children]
        if surv:
            oldest = min(surv, key=lambda kv: kv[1])
            idle_s = time.time() - oldest[1]
            metric("mem.child.idle_survives", 1, "count")
            metric("mem.child.max_idle_observed_s", round(idle_s, 0), "count")
        else:
            metric("mem.child.idle_survives", 0, "count")
            metric("mem.child.max_idle_observed_s", 0, "count")

        st = read_status(DAEMON)
        if st:
            metric("mem.daemon.threads_end", int(st["Threads"]), "count")
            metric("mem.daemon.hwm_delta_mb",
                   round((int(st["VmHWM"].split()[0]) - ph1["boot_mb"] * 1024) / 1024.0, 1),
                   "MiB")

        print("=== SUMMARY")
        print(f"1. daemon RSS: boot {ph1['boot_mb']:.1f} MiB, after listing "
              f"{ph1['after_list_mb']:.1f} MiB (+{ph1['after_list_mb'] - ph1['boot_mb']:.2f}), "
              f"after open+stream {ph1['after_stream_mb']:.1f} MiB "
              f"(+{ph1['after_stream_mb'] - ph1['after_list_mb']:.2f})")
        print("2. per WS client (extra clients on one session, pre-warm excluded): "
              "see METRIC mem.client.extra_kib_per_client.* "
              "(first attach incl. pre-warm child: mem.client.first_attach_delta_mb)")
        print("3. per watched session (incl. pre-warm children up to cap): "
              "see METRIC mem.watch.*")
        print("4. slow consumer (non-reading client while streaming): growth ratios "
              "mem.slowconsumer.growth_ratio.a/.b; reading-client control "
              "mem.slowconsumer.control_growth_ratio")
        print(f"5. partial tail buffer: {ph5['held_mb']:.1f} MiB held while a "
              f"{'6' if QUICK else '8'}-MiB unterminated line is open; see freed-after-terminate metric")
        print(f"6. children: RSS per child see mem.child.rss_p50_mb; LRU cap enforced "
              f"({ph6['n_before']} -> {ph6['n_after']}, {ph6['n_after']} after 7 fresh "
              f"opens); idle survival + max observed idle: mem.child.*idle*")
        print(f"7. soak {ph7['duration_s']:.0f}s, {ph7['cycles']} cycles: "
              f"start {ph7['start_mb']:.1f} MiB -> end {ph7['end_mb']:.1f} MiB "
              f"({ph7['end_mb'] - ph7['start_mb']:+.2f}), slope "
              f"{ph7['slope']:+.1f} KiB/min "
              f"({soak_verdict(ph7['slope'])})")
    finally:
        for ws in clients:
            try:
                await ws.close()
            except Exception:
                pass
        await asyncio.sleep(1.0)  # let the daemon unwatch/detach before rmtree
        shutil.rmtree(private_dir, ignore_errors=True)


asyncio.run(main())
