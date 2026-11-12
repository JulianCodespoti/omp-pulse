#!/usr/bin/env python3
"""NETWORK wire-cost measurement for omp-pulse, from the phone's point of view.

WHY: the phone sits on cellular over Tailscale. Every byte the daemon pushes
costs battery and time-to-render, so we quantify what a phone actually pays on
the wire and where the fat is:

  1. STREAMING TURN  — one prompt/reply turn, every WS frame counted: total
     bytes, bytes per event.type, largest frame, and the AMPLIFICATION RATIO
     (total bytes / final assistant message length). `message_update` frames
     carry the FULL accumulating assistant message (src/bin/omp-pulse/main.rs:113 wraps the
     child event verbatim; src/omp/collab.rs:1517 forwards collab events verbatim),
     so a reply of length L is sent ~L/2 times on average => O(L^2) bytes.
     The theoretical minimum is L (sum of appended deltas = final length), so
     the achievable saving is (total - L) / total. Two reply sizes (BENCH_WORDS,
     default 120 and 600) make the quadratic visible in the data.
  2. FAN-OUT        — N WS clients on the SAME session: the hub clones the
     pre-serialized frame string once per client (src/server/ws.rs broadcast), so
     bytes scale linearly with N; we measure the per-client cost exactly.
  3. SESSION OPEN   — the real first-screen request sequence (from
     loadInitialHistory + openSession in public/index.html): POST /api/open,
     GET /api/history?limit=50 (the big one), GET /api/commands, 3x POST
     /api/rpc (get_session_stats, set_subagent_subscription, get_subagents),
     then the WS. Measured for the small, ~11 MB and ~44 MB corpus sessions.
  4. COMPRESSION    — offline gzip level 6/9 (Python zlib/gzip) on every
     captured payload class: history page JSON, /api/sessions JSON, index.html,
     sw.js, and a full turn's concatenated frames (approx. what WS
     permessage-deflate would give with a shared window). The daemon has NO
     HTTP compression (tower-http with only the "fs" feature, Cargo.toml) and
     NO permessage-deflate (tokio-tungstenite without the deflate feature).
  5. IDLE           — the daemon heartbeats every 20 s (src/server/http.rs handle_ws)
     and the phone polls /api/history?limit=50 every 60 s while visible (WS
     open) or every 5 s with the WS down (livePollInterval in index.html).
     Observed over 40-70 s and extrapolated to bytes/hour.

Run under bench/with-bench-daemon.sh (isolated daemon, own port/token/corpus).
Quick self-check:
  BENCH_QUICK=1 BENCH_PORT=7691 \
  BENCH_CACHE=/tmp/bench-wire BENCH_FILES=40 BENCH_DIRS=4 \
  bench/with-bench-daemon.sh python3 bench/wire.py

Env: BENCH_BASE/BENCH_WS/BENCH_TOKEN/BENCH_CORPUS (harness), BENCH_WORDS,
     BENCH_SIZES, BENCH_FANOUT, BENCH_QUICK, BENCH_TURNS=0 to skip LLM turns.

Output: `METRIC <dotted.name> <value> <unit>` lines, then a `=== SUMMARY`.
Never prints the token or session content beyond a short excerpt.
"""
import asyncio
import gzip
import json
import os
import statistics
import sys
import time
import urllib.parse
import urllib.request
import uuid

BASE = os.environ.get("BENCH_BASE", "http://127.0.0.1:7690")
WSBASE = os.environ.get("BENCH_WS", BASE.replace("http://", "ws://").replace("https://", "wss://"))
TOKEN = os.environ.get("BENCH_TOKEN", "")
if not TOKEN:
    sys.exit("wire.py: BENCH_TOKEN is unset — run me under bench/with-bench-daemon.sh")
CORPUS = os.environ.get("BENCH_CORPUS", "")
QUICK = os.environ.get("BENCH_QUICK", "0") == "1"
PUBLIC = os.environ.get("BENCH_PUBLIC", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public"))
TMP = os.environ.get("BENCH_TMP", "/tmp")
CWD = os.environ.get("BENCH_WIRE_CWD", os.path.join(TMP, "pulse-bench-wire-proj"))

if QUICK:
    SIZES = [int(x) for x in os.environ.get("BENCH_SIZES", "120").split(",") if x]
    FANOUT = [int(x) for x in os.environ.get("BENCH_FANOUT", "1,8").split(",") if x]
    IDLE_SECS = float(os.environ.get("BENCH_IDLE_SECS", "40"))
    TURN_CAP = float(os.environ.get("BENCH_TURN_CAP", "90"))
else:
    SIZES = [int(x) for x in os.environ.get("BENCH_SIZES", "120,600").split(",") if x]
    FANOUT = [int(x) for x in os.environ.get("BENCH_FANOUT", "1,4,16").split(",") if x]
    IDLE_SECS = float(os.environ.get("BENCH_IDLE_SECS", "70"))
    TURN_CAP = float(os.environ.get("BENCH_TURN_CAP", "180"))
TURNS_ENABLED = os.environ.get("BENCH_TURNS", "1") != "0"
os.makedirs(CWD, exist_ok=True)

METRICS = []


def metric(name, value, unit):
    METRICS.append((name, value, unit))
    print(f"METRIC {name} {value} {unit}")


def api_bytes(method, path, body=None, timeout=120):
    """Return (status, raw_body_bytes, headers_bytes). HTTP errors and network
    failures return (status_or_0, b'', 0) instead of raising — the bench runs
    against a shared synthetic corpus that concurrent benches mutate, so a
    session file can vanish between requests."""
    req = urllib.request.Request(
        BASE + path,
        method=method,
        headers={
            "Authorization": "Bearer " + TOKEN,
            "Content-Type": "application/json",
            "Accept-Encoding": "identity",  # we measure UNCOMPRESSED payloads
        },
        data=json.dumps(body).encode() if body is not None else None,
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            hdr = str(r.headers).encode()
            return r.status, raw, len(hdr)
    except urllib.error.HTTPError as e:
        try:
            raw = e.read()
        except Exception:
            raw = b""
        return e.code, raw, 0
    except Exception:
        return 0, b"", 0


def api_json(method, path, body=None, timeout=120):
    st, raw, _ = api_bytes(method, path, body, timeout)
    return st, raw


# --------------------------------------------------------------------------
# Corpus session selection: the small / ~11 MB / ~44 MB sessions the seed
# guarantees. Runs BEFORE we create any scratch sessions so we never pick one
# of our own turn transcripts.
# --------------------------------------------------------------------------
def pick_corpus_sessions():
    if not CORPUS or not os.path.isdir(CORPUS):
        print("wire.py: BENCH_CORPUS missing — skipping corpus-backed measurements", file=sys.stderr)
        return {}
    sizes = []
    root_abs = os.path.abspath(CORPUS)
    for dp, _, fs in os.walk(CORPUS):
        for f in fs:
            if not f.endswith(".jsonl"):
                continue
            # Root-level files are scratch/test sessions (the daemon itself
            # excludes them from /api/sessions — jsonl.rs). Only pick real
            # per-project sessions.
            if os.path.abspath(dp) == root_abs:
                continue
            p = os.path.join(dp, f)
            try:
                sizes.append((os.path.getsize(p), p))
            except OSError:
                pass
    if not sizes:
        return {}
    sizes.sort()
    # "small" = the smallest STABLE session. Concurrent benches drop transient
    # scratch files (a few hundred bytes, deleted mid-run) into the shared
    # corpus; the seed's smallest real session is ~4 KB, so filter below that.
    stable = [sp for sp in sizes if sp[0] >= 3000] or sizes
    small = stable[0]
    big = sizes[-1]
    mid = min(sizes, key=lambda sp: abs(sp[0] - 11 * 1048576))
    return {"small": small[1], "mid": mid[1], "big": big[1]}


# --------------------------------------------------------------------------
# Compression (offline, level 6 / 9).
# --------------------------------------------------------------------------
def compression_metrics(name, data):
    for level in (6, 9):
        comp = gzip.compress(data, compresslevel=level)
        ratio = len(comp) / len(data) if data else 0.0
        metric(f"wire.gzip.{name}.l{level}.ratio", round(ratio, 4), "ratio")
        metric(f"wire.gzip.{name}.l{level}.saved", len(data) - len(comp), "bytes")


# --------------------------------------------------------------------------
# Turn capture.
# --------------------------------------------------------------------------
def ws_overhead(payload_len):
    if payload_len <= 125:
        return 2
    if payload_len <= 65535:
        return 4
    return 10


class TurnStats:
    def __init__(self):
        self.frames = 0
        self.payload = 0
        self.wire = 0
        self.by_type = {}
        self.largest = 0
        self.agent_end_seen = False
        self.updates = 0
        self.update_payload = 0
        self.final_len = 0
        self.delta_sum = 0
        self.prev_text_len = 0
        self.envelope_sum = 0
        self.frame_sizes = []
        self._frames = []
        self.last_frame_ts = 0.0
        self.message_end_seen = False

    def reset(self):
        self.__init__()

    def record(self, raw: str):
        n = len(raw.encode())
        self.frames += 1
        self.payload += n
        self.wire += n + ws_overhead(n)
        self.largest = max(self.largest, n)
        self.frame_sizes.append(n)
        self._frames.append(raw)
        self.last_frame_ts = time.time()
        try:
            f = json.loads(raw)
        except Exception:
            key = "unparseable"
            return self._type(key, n, f=None)
        ft = f.get("type")
        if ft == "event" and isinstance(f.get("event"), dict):
            key = "event:" + str(f["event"].get("type", "?"))
            ev = f["event"]
            if ev.get("type") == "message_update":
                self.updates += 1
                self.update_payload += n
                msg = ev.get("message") or {}
                text = extract_text(msg.get("content"))
                if text is not None:
                    self.final_len = max(self.final_len, len(text))
                    d = max(0, len(text) - self.prev_text_len)
                    self.prev_text_len = max(self.prev_text_len, len(text))
                    self.delta_sum += d
                    self.envelope_sum += n - d
            if ev.get("type") == "agent_end":
                self.agent_end_seen = True
            if ev.get("type") == "message_end":
                self.message_end_seen = True
        elif ft == "hb":
            key = "hb"
        else:
            key = str(ft) if ft else "frame:?"
        self._type(key, n, f)

    def _type(self, key, n, f):
        t = self.by_type.setdefault(key, {"n": 0, "bytes": 0})
        t["n"] += 1
        t["bytes"] += n


def extract_text(content):
    """message_update message.content: str or list of {type:'text',text} blocks."""
    if content is None:
        return None
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for p in content:
            if isinstance(p, dict) and p.get("type") == "text" and isinstance(p.get("text"), str):
                parts.append(p["text"])
        return "".join(parts)
    return None


async def collect_frames(ws, stats, deadline):
    while True:
        remaining = deadline - asyncio.get_event_loop().time()
        if remaining <= 0:
            return
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=min(remaining, 20))
        except asyncio.TimeoutError:
            return
        except Exception:
            return
        stats.record(raw)


async def run_turn(session, words, n_clients, label):
    """Attach n_clients to session, fire one prompt, capture every frame."""
    url = f"{WSBASE}/ws?session={urllib.parse.quote(session)}&token={TOKEN}"
    clients = []
    for _ in range(n_clients):
        ws = await asyncio.wait_for(
            websockets_connect(url), timeout=20
        )
        clients.append(ws)
    stats = [TurnStats() for _ in range(n_clients)]
    deadline = asyncio.get_event_loop().time() + TURN_CAP
    tasks = [
        asyncio.create_task(collect_frames(ws, st, deadline))
        for ws, st in zip(clients, stats)
    ]
    prompt = (
        f"Write a plain-prose explanation of how TCP congestion control works, "
        f"about {words} words. No lists, no code, no headings — only prose."
    )
    t0 = time.time()
    st, raw = api_json("POST", "/api/prompt", {"commandId": str(uuid.uuid4()), "sessionPath": session, "text": prompt}, timeout=200)
    if st != 200:
        print(f"wire.py: /api/prompt status {st} — {raw[:200]!r}", file=sys.stderr)
    # Completion: first client sees agent_end, then a short grace to flush the
    # watcher's trailing `entries` frames and any heartbeat. A failed turn
    # (message_end with no content, no agent_end — LLM/child hiccup) must not
    # hang the cap: after message_end, 10 s of silence ends the turn.
    while time.time() - t0 < TURN_CAP:
        if stats[0].agent_end_seen:
            await asyncio.sleep(0.6)
            break
        if (stats[0].message_end_seen
                and stats[0].last_frame_ts
                and time.time() - stats[0].last_frame_ts > 10.0):
            break
        await asyncio.sleep(0.05)
    for t in tasks:
        t.cancel()
    for ws in clients:
        try:
            await ws.close()
        except Exception:
            pass
    elapsed = time.time() - t0
    return stats, elapsed


def websockets_connect(url):
    import websockets
    return websockets.connect(url, max_size=256 * 1024 * 1024)


def emit_turn_metrics(label, stats, elapsed, fanout_n):
    s0 = stats[0]  # client 0 = the single-client cost
    final_len = s0.final_len
    metric(f"wire.turn.{label}.elapsed", round(elapsed, 3), "s")
    metric(f"wire.turn.{label}.frames", s0.frames, "count")
    metric(f"wire.turn.{label}.bytes", s0.payload, "bytes")
    metric(f"wire.turn.{label}.wire.bytes", s0.wire, "bytes")
    metric(f"wire.turn.{label}.ws_overhead.bytes", s0.wire - s0.payload, "bytes")
    metric(f"wire.turn.{label}.largest_frame", s0.largest, "bytes")
    if s0.frame_sizes:
        fs = sorted(s0.frame_sizes)
        metric(f"wire.turn.{label}.frame.p50", fs[len(fs) // 2], "bytes")
        metric(f"wire.turn.{label}.frame.p95", fs[min(len(fs) - 1, int(len(fs) * 0.95))], "bytes")
    for key, t in sorted(s0.by_type.items(), key=lambda kv: -kv[1]["bytes"]):
        metric(f"wire.turn.{label}.bytes.{key}", t["bytes"], "bytes")
        metric(f"wire.turn.{label}.frames.{key}", t["n"], "count")
    metric(f"wire.turn.{label}.final_len", final_len, "bytes")
    metric(f"wire.turn.{label}.message_updates", s0.updates, "count")
    if final_len > 0:
        metric(f"wire.turn.{label}.amplification", round(s0.payload / final_len, 3), "ratio")
        metric(f"wire.turn.{label}.amplification.wire", round(s0.wire / final_len, 3), "ratio")
        metric(f"wire.turn.{label}.theoretical_min", final_len, "bytes")
        metric(f"wire.turn.{label}.savable.bytes", s0.payload - final_len, "bytes")
        metric(f"wire.turn.{label}.savable.ratio", round((s0.payload - final_len) / s0.payload, 4), "ratio")
        metric(f"wire.turn.{label}.delta_sum", s0.delta_sum, "bytes")
        metric(f"wire.turn.{label}.envelope_min", final_len + s0.envelope_sum, "bytes")
        metric(f"wire.turn.{label}.efficiency", round(final_len / s0.payload, 4), "ratio")
    else:
        metric(f"wire.turn.{label}.failed", 1, "count")
    if fanout_n > 1 and final_len > 0:
        per_client = [st.payload for st in stats]
        total = sum(per_client)
        metric(f"wire.fanout.n{fanout_n}.total.bytes", total, "bytes")
        metric(f"wire.fanout.n{fanout_n}.per_client.bytes", round(statistics.mean(per_client), 1), "bytes")
        metric(f"wire.fanout.n{fanout_n}.per_client.min", min(per_client), "bytes")
        metric(f"wire.fanout.n{fanout_n}.per_client.max", max(per_client), "bytes")
        metric(f"wire.fanout.n{fanout_n}.linearity", round(total / (fanout_n * per_client[0]), 4), "ratio")
    return s0


# --------------------------------------------------------------------------
# Session-open cost: the real UI sequence from openSession in index.html.
# --------------------------------------------------------------------------
def session_open_sequence(session):
    """POST /api/open, GET /api/history?limit=50, GET /api/commands, 3x rpc."""
    reqs = []
    st, raw, _ = api_bytes("POST", "/api/open", {"sessionPath": session})
    reqs.append(("open", st, len(raw)))
    st, raw, _ = api_bytes("GET", f"/api/history?session={urllib.parse.quote(session)}&limit=50")
    reqs.append(("history_first_page", st, len(raw)))
    st, raw, _ = api_bytes("GET", f"/api/commands?session={urllib.parse.quote(session)}")
    reqs.append(("commands", st, len(raw)))
    for cmd, params in (
        ("get_session_stats", None),
        ("set_subagent_subscription", {"level": "events"}),
        ("get_subagents", None),
    ):
        body = {"sessionPath": session, "command": cmd}
        if params is not None:
            body["params"] = params
        st, raw, _ = api_bytes("POST", "/api/rpc", body)
        reqs.append((f"rpc:{cmd}", st, len(raw)))
    # WS connect: the upgrade request itself carries ~300-500 B of headers.
    return reqs


def emit_open_metrics(label, reqs):
    total = sum(r[2] for r in reqs)
    metric(f"wire.open.{label}.requests", len(reqs), "count")
    for name, st, n in reqs:
        metric(f"wire.open.{label}.bytes.{name}", n, "bytes")
    metric(f"wire.open.{label}.total.bytes", total, "bytes")
    return total


async def ws_open_burst(session, secs=5.0):
    """Capture what a WS client attached to `session` receives during/right
    after the open sequence: the pre-warm child's startup burst (a fresh
    spawn broadcasts `available_commands_update` ~50 KB). Returns
    (opening_client_stats, sniffer_stats) — the sniffer was attached BEFORE
    the HTTP sequence so a burst that races the opening client's attach is
    still counted."""
    url = f"{WSBASE}/ws?session={urllib.parse.quote(session)}&token={TOKEN}"
    sniffer = await asyncio.wait_for(websockets_connect(url), timeout=20)
    sniffer_stats = TurnStats()
    deadline = asyncio.get_event_loop().time() + secs + 2
    sniffer_task = asyncio.create_task(collect_frames(sniffer, sniffer_stats, deadline))
    client_ws = await asyncio.wait_for(websockets_connect(url), timeout=20)
    cstats = TurnStats()
    ctask = asyncio.create_task(collect_frames(client_ws, cstats, deadline))
    await asyncio.sleep(secs)
    ctask.cancel()
    sniffer_task.cancel()
    try:
        await client_ws.close()
        await sniffer.close()
    except Exception:
        pass
    return cstats, sniffer_stats


# --------------------------------------------------------------------------
# Idle cost.
# --------------------------------------------------------------------------
async def measure_idle(session, n_clients, secs):
    """Attach n_clients, SETTLE (drain child-startup bursts), then time the
    steady-state idle window: heartbeats every 20 s and nothing else."""
    url = f"{WSBASE}/ws?session={urllib.parse.quote(session)}&token={TOKEN}"
    clients = []
    for _ in range(n_clients):
        ws = await asyncio.wait_for(websockets_connect(url), timeout=20)
        clients.append(ws)
    stats = [TurnStats() for _ in range(n_clients)]
    DEBUG = os.environ.get("BENCH_WIRE_DEBUG", "0") == "1"
    t0 = time.time()
    # Settle: drain until 3 s of silence (child-startup bursts on a fresh
    # pre-warm child emit available_commands_update ~50 KB + a couple of
    # frames once; a live child emits nothing).
    settle_deadline = t0 + 15
    last_frame = time.time()
    while time.time() - last_frame < 3.0:
        if time.time() > settle_deadline:
            break
        got = False
        for ws, st in zip(clients, stats):
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=0.5)
            except asyncio.TimeoutError:
                continue
            except Exception:
                continue
            st.record(raw)
            if DEBUG:
                try:
                    f = json.loads(raw)
                    t = (f.get("event") or {}).get("type") or f.get("type")
                except Exception:
                    t = "?"
                print(f"  [settle] t={time.time()-t0:.1f} {t} n={len(raw.encode())}")
            got = True
        if got:
            last_frame = time.time()
    if DEBUG:
        print(f"  [idle] settle ended after {time.time()-t0:.1f}s; timed window {secs}s follows")
    for st in stats:
        st.reset()
    deadline = asyncio.get_event_loop().time() + secs
    tasks = [
        asyncio.create_task(collect_frames(ws, st, deadline))
        for ws, st in zip(clients, stats)
    ]
    await asyncio.sleep(secs + 0.3)
    for t in tasks:
        t.cancel()
    for ws in clients:
        try:
            await ws.close()
        except Exception:
            pass
    return stats


async def _idle_measure(session, secs):
    n = 3
    stats = await measure_idle(session, n, secs)
    per_client_bytes = [st.payload for st in stats]
    total_ws = sum(per_client_bytes)
    s0 = stats[0]
    hb = s0.by_type.get("hb", {}).get("bytes", 0)
    other = s0.payload - hb
    hb_rate = hb / secs * 3600
    metric("wire.idle.observed", secs, "s")
    metric("wire.idle.frames", s0.frames, "count")
    metric("wire.idle.hb.frames", s0.by_type.get("hb", {}).get("n", 0), "count")
    metric("wire.idle.hb.bytes_per_hour", round(hb_rate), "per_hour")
    metric("wire.idle.other.bytes_per_hour", round(other / secs * 3600), "per_hour")
    metric("wire.idle.observed.bytes_per_hour", round(per_client_bytes[0] / secs * 3600), "per_hour")
    metric("wire.idle.n3.observed.bytes_per_hour", round(total_ws / secs * 3600), "per_hour")
    # The phone's own polling: 60 s cadence with the WS open, 5 s with it
    # down (livePollInterval in index.html). Poll response measured live.
    st, raw, _ = api_bytes("GET", f"/api/history?session={urllib.parse.quote(session)}&limit=50")
    poll = len(raw) if st == 200 else 0
    metric("wire.idle.poll.bytes", poll, "bytes")
    metric("wire.idle.poll.bytes_per_hour", 60 * poll, "per_hour")
    metric("wire.idle.wsdown.bytes_per_hour", 720 * poll, "per_hour")
    # Steady-state per-client idle = hb + one 60 s poll (the headline).
    metric("wire.idle.bytes_per_hour", round(hb_rate) + 60 * poll, "per_hour")
    metric("wire.idle.n3.bytes_per_hour", 3 * (round(hb_rate) + 60 * poll), "per_hour")


async def main():
    # Warm the daemon + prove reachability.
    api_json("GET", "/api/status")
    metric("wire.quick", 1 if QUICK else 0, "count")

    corpus = pick_corpus_sessions()
    hdr_note = 300  # approx HTTP/1.1 response headers per request (measured per req below)

    # ---- 3. session-open cost -------------------------------------------
    if corpus:
        for key in ("small", "mid", "big"):
            session = corpus[key]
            size = os.path.getsize(session)
            st, raw, _ = api_bytes(
                "GET", f"/api/history?session={urllib.parse.quote(session)}&limit=50"
            )
            entries = len((json.loads(raw) or {}).get("entries", [])) if st == 200 else 0
            metric(f"wire.open.{key}.session_size", size, "bytes")
            metric(f"wire.open.{key}.first_page.bytes", len(raw), "bytes")
            metric(f"wire.open.{key}.first_page.entries", entries, "count")
            compression_metrics(f"history_{key}", raw)
        # Full UI sequence on the small session (and big in non-quick): the
        # opening client's HTTP requests + the WS attach, which typically
        # coincides with the pre-warm child's startup burst
        # (available_commands_update ~50 KB broadcast on a fresh spawn).
        seq_keys = ["small"] + (["big"] if not QUICK else [])
        for key in seq_keys:
            session = corpus[key]
            reqs = session_open_sequence(session)
            total = emit_open_metrics(key, reqs)
            cstats, sniffer = await ws_open_burst(session, secs=5.0)
            metric(f"wire.open.{key}.ws_attach.bytes", cstats.payload, "bytes")
            metric(f"wire.open.{key}.ws_attach.frames", cstats.frames, "count")
            for tkey, t in cstats.by_type.items():
                metric(f"wire.open.{key}.ws_attach.bytes.{tkey}", t["bytes"], "bytes")
                metric(f"wire.open.{key}.ws_attach.frames.{tkey}", t["n"], "count")
            # On the synthetic corpus the pre-warm child FAILS to open the
            # file and the daemon respawns it (~1.1 s cadence), re-broadcasting
            # the startup burst each spawn. The honest per-spawn broadcast cost
            # is total / spawn_cycles.
            spawns = cstats.by_type.get("event:available_commands_update", {}).get("n", 1)
            per_spawn = cstats.payload / max(spawns, 1)
            metric(f"wire.open.{key}.ws_attach.spawns", spawns, "count")
            metric(f"wire.open.{key}.ws_attach.per_spawn.bytes", round(per_spawn), "bytes")
            metric(f"wire.open.{key}.ws_sniffer.bytes", sniffer.payload, "bytes")
            first_screen = total + per_spawn
            metric(f"wire.open.{key}.first_screen.bytes", round(first_screen), "bytes")
            metric(f"wire.open.{key}.first_screen.wire.bytes",
                   round(first_screen + (len(reqs) + 1) * hdr_note), "bytes")
    else:
        print("wire.py: no corpus — skipping open-cost measurements", file=sys.stderr)

    # ---- 4. static compression captures (offline) ------------------------
    index_path = os.path.join(PUBLIC, "index.html")
    sw_path = os.path.join(PUBLIC, "sw.js")
    for fname, label in ((index_path, "index"), (sw_path, "sw")):
        if os.path.isfile(fname):
            data = open(fname, "rb").read()
            metric(f"wire.static.{label}.bytes", len(data), "bytes")
            compression_metrics(label, data)
    try:
        st, raw, _ = api_bytes("GET", "/api/sessions")
        metric("wire.sessions_listing.bytes", len(raw), "bytes")
        compression_metrics("sessions", raw)
    except Exception as e:
        print(f"wire.py: /api/sessions failed: {e}", file=sys.stderr)

    # ---- 1 + 2. streaming turns + fan-out --------------------------------
    turn_frames = []  # for the whole-turn deflate estimate
    last_session = None
    if TURNS_ENABLED:
        turns = [(s, 1) for s in SIZES] + [(SIZES[0], n) for n in FANOUT if n > 1]
        for words, n in turns:
            label = f"w{words}.n{n}"
            attempts = 2  # a failed turn costs ~10 s and zero tokens; retry once
            best = None
            for attempt in range(attempts):
                st, raw = api_json("POST", "/api/new", {"cwd": CWD})
                if st != 200:
                    print(f"wire.py: /api/new failed ({st}): {raw[:200]!r} — skipping turn", file=sys.stderr)
                    break
                session = json.loads(raw)["sessionPath"]
                last_session = session
                await asyncio.sleep(0.6)  # let set_session_name's write land before we watch
                stats, elapsed = await run_turn(session, words, n, label)
                if stats[0].final_len > 0:
                    best = (stats, elapsed)
                    break
                print(f"  [wire] turn {label} produced no reply (attempt {attempt + 1}/{attempts})")
                best = (stats, elapsed)
            if best is None:
                continue
            stats, elapsed = best
            s0 = emit_turn_metrics(label, stats, elapsed, n)
            print(f"  [wire] turn {label}: {elapsed:.1f}s, {s0.payload} B, "
                  f"final={s0.final_len} B, amplification="
                  f"{s0.payload / max(s0.final_len, 1) if s0.final_len else 'FAILED'}")
            # Keep the LARGEST single-client frame stream for the deflate estimate.
            if s0.payload > sum(len(f) for f in turn_frames):
                turn_frames = s0._frames
            await asyncio.sleep(2.0)  # let the previous child settle; the LLM
            # gateway is shared with concurrent benches — a breather helps
    else:
        print("wire.py: BENCH_TURNS=0 — skipping LLM turns", file=sys.stderr)

    # The command palette payload delivered TWICE on a fresh open: once via
    # REST (fetchCommands in index.html) and once as the WS
    # `available_commands_update` broadcast. REST size needs a LIVE child
    # (the corpus-session child fails to open a synthetic file).
    if last_session:
        try:
            st, raw, _ = api_bytes(
                "GET", f"/api/commands?session={urllib.parse.quote(last_session)}"
            )
            metric("wire.open.live.commands.bytes", len(raw), "bytes")
        except Exception as e:
            print(f"wire.py: /api/commands failed: {e}", file=sys.stderr)

    # ---- 5. idle ---------------------------------------------------------
    if corpus:
        # Idle session: the last turn's session has a LIVE child (no startup
        # burst, nothing writes). Fall back to a corpus session if turns were
        # skipped or the turn session vanished. One 3-client observation
        # yields per-client (== 1-client) and 3-client rates: the daemon sends
        # the same heartbeats to every client.
        session = None
        if last_session and os.path.exists(last_session):
            session = last_session
        elif corpus:
            try:
                session = min(
                    (p for p in corpus.values() if os.path.exists(p)),
                    key=os.path.getsize, default=None)
            except (OSError, ValueError):
                session = None
        if session is None:
            print("wire.py: no usable session for idle measurement — skipping", file=sys.stderr)
        else:
            await _idle_measure(session, IDLE_SECS)

    # ---- 4b. whole-turn deflate estimate ---------------------------------
    if turn_frames:
        stream = b"".join(f.encode() for f in turn_frames)
        metric("wire.deflate.turn.stream.bytes", len(stream), "bytes")
        for level in (6, 9):
            comp = gzip.compress(stream, compresslevel=level)
            metric(f"wire.deflate.turn.stream.l{level}.ratio", round(len(comp) / len(stream), 4), "ratio")
            metric(f"wire.deflate.turn.stream.l{level}.saved", len(stream) - len(comp), "bytes")
        # per-frame (independent) compression: the permessage-deflate-with-reset bound
        per_frame = sum(len(gzip.compress(f.encode(), compresslevel=6)) for f in turn_frames)
        metric("wire.deflate.turn.perframe.l6.ratio", round(per_frame / len(stream), 4), "ratio")
        metric("wire.deflate.turn.perframe.l6.saved", len(stream) - per_frame, "bytes")
        # the largest single frame alone (deflate with a fresh window)
        largest = max(turn_frames, key=len)
        comp = gzip.compress(largest.encode(), compresslevel=6)
        metric("wire.deflate.turn.largest.l6.ratio", round(len(comp) / len(largest), 4), "ratio")

    # ---- summary ---------------------------------------------------------
    print("\n=== SUMMARY")
    print(f"quick={QUICK} sizes={SIZES} fanout={FANOUT} idle={IDLE_SECS}s corpus={'present' if corpus else 'missing'}")
    if corpus:
        for key in ("small", "mid", "big"):
            try:
                sz = os.path.getsize(corpus[key]) / 1048576
                print(f"  corpus {key}: {sz:.1f} MiB")
            except OSError:
                print(f"  corpus {key}: (vanished mid-run)")
    by_name = {n: v for n, v, _ in METRICS}
    for label in [f"w{s}.n1" for s in SIZES] + [f"w{SIZES[0]}.n{n}" for n in FANOUT if n > 1]:
        amp = by_name.get(f"wire.turn.{label}.amplification")
        if amp is not None:
            print(f"  turn {label}: {by_name.get(f'wire.turn.{label}.bytes')} B payload "
                  f"({by_name.get(f'wire.turn.{label}.frames')} frames, "
                  f"final {by_name.get(f'wire.turn.{label}.final_len')} B) "
                  f"=> amplification {amp}x, savable "
                  f"{by_name.get(f'wire.turn.{label}.savable.bytes')} B "
                  f"({by_name.get(f'wire.turn.{label}.savable.ratio')})")
        elif by_name.get(f"wire.turn.{label}.failed"):
            print(f"  turn {label}: FAILED (no reply produced)")
    for n in FANOUT:
        if n > 1:
            k = f"wire.fanout.n{n}.per_client.bytes"
            if k in by_name:
                print(f"  fanout n={n}: total {by_name[f'wire.fanout.n{n}.total.bytes']} B, "
                      f"per-client {by_name[k]} B, linearity {by_name[f'wire.fanout.n{n}.linearity']}")
    for name in ("sessions", "index", "sw", "history_big"):
        r6 = by_name.get(f"wire.gzip.{name}.l6.ratio")
        if r6 is not None:
            print(f"  gzip-6 {name}: {r6}x ({by_name.get(f'wire.gzip.{name}.l6.saved')} B saved)")
    if "wire.deflate.turn.stream.l6.ratio" in by_name:
        print(f"  ws-deflate estimate (whole turn): {by_name['wire.deflate.turn.stream.l6.ratio']}x "
              f"({by_name['wire.deflate.turn.stream.l6.saved']} B saved); "
              f"per-frame {by_name['wire.deflate.turn.perframe.l6.ratio']}x")
    for k in ("wire.idle.bytes_per_hour", "wire.idle.n3.bytes_per_hour",
              "wire.idle.total.bytes_per_hour", "wire.idle.wsdown.bytes_per_hour"):
        if k in by_name:
            print(f"  {k}: {by_name[k]} B/h")


if __name__ == "__main__":
    asyncio.run(main())
