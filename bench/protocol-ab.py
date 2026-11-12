#!/usr/bin/env python3
"""A/B the legacy and optimised wire protocols against the SAME streaming turn.

WHY THIS SHAPE: LLM replies vary in length run to run, so comparing a turn today
against a turn tomorrow measures the model, not the daemon. The daemon keeps the
old behaviour for a client that advertises no capabilities, so both protocols can
observe ONE turn simultaneously. Every byte of difference is then attributable to
the protocol and nothing else.

Client A: no `caps` -> full `message_update` snapshots (the 39-76x baseline).
Client B: `caps=delta,defl,bundle` -> `md` delta frames, binary deflate, bundle.
Client C: optional, attaches but never reads -> proves the conflation bound.

Reads:
  METRIC ab.legacy.bytes / ab.modern.bytes / ab.reduction.ratio
  METRIC ab.bundle.* (first-screen bundle) and ab.slow.* (conflation)

Run under bench/with-bench-daemon.sh. `BENCH_WORDS` sets the reply length.
"""
import asyncio, json, os, sys, time, urllib.parse, urllib.request, zlib
import uuid

BASE = os.environ.get("BENCH_BASE") or sys.exit("run under bench/with-bench-daemon.sh")
WSB = os.environ["BENCH_WS"]
TOKEN = os.environ["BENCH_TOKEN"]
WORDS = int(os.environ.get("BENCH_WORDS", "400"))
QUICK = os.environ.get("BENCH_QUICK") == "1"
SLOW_CLIENT = os.environ.get("BENCH_SLOW", "1") == "1"


def api(path, body=None, method="POST"):
    req = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=240) as r:
        return json.loads(r.read() or b"{}")


def metric(name, value, unit):
    print(f"METRIC {name} {value} {unit}")


def decode(raw):
    """Text frame, or a raw-DEFLATE binary frame (what a `defl` client gets)."""
    if isinstance(raw, (bytes, bytearray)):
        # -15 = raw deflate, no zlib header: exactly DecompressionStream('deflate-raw').
        return zlib.decompress(bytes(raw), -15).decode(), len(raw), True
    return raw, len(raw.encode()), False


class Observer:
    """One WS client, recording every byte it is actually sent."""

    def __init__(self, label, caps):
        self.label = label
        self.caps = caps
        self.bytes = 0
        self.frames = 0
        self.by_type = {}
        self.binary_frames = 0
        self.binary_raw = 0
        self.binary_inflated = 0
        self.text = {}          # message id -> reconstructed text
        self.final_len = 0
        self.first_frame_at = None
        self.bundle = None

    def note(self, raw, t0):
        body, wire, was_binary = decode(raw)
        self.frames += 1
        self.bytes += wire
        if was_binary:
            self.binary_frames += 1
            self.binary_raw += wire
            self.binary_inflated += len(body.encode())
        if self.first_frame_at is None:
            self.first_frame_at = time.time() - t0
        try:
            f = json.loads(body)
        except Exception:
            return None
        kind = f.get("type")
        if kind == "event":
            kind = "event:" + ((f.get("event") or {}).get("type") or "?")
        slot = self.by_type.setdefault(kind, {"n": 0, "bytes": 0})
        slot["n"] += 1
        slot["bytes"] += wire

        if kind == "bundle":
            self.bundle = {
                "entries": len((f.get("history") or {}).get("entries") or []),
                "has_state": bool(f.get("state")),
                "etag": bool(f.get("etag")),
                "wire": wire,
                "inflated": len(body.encode()),
            }
        elif kind == "md":
            # Delta: keep the first `k` UTF-16 units (absent = keep everything),
            # then append. Reconstructing here is the proof that a delta stream
            # carries the same text as the snapshot stream — a third, independent
            # implementation of the fold the daemon and the phone each perform.
            mid = f.get("id") or ""
            self.text[mid] = fold(self.text.get(mid, ""), f.get("k"), f.get("a") or "")
        elif kind == "event:message_update":
            msg = (f.get("event") or {}).get("message") or {}
            self.text[chain_of(msg)] = extract_text(msg)
        elif kind == "event:message_start":
            msg = (f.get("event") or {}).get("message") or {}
            self.text.setdefault(chain_of(msg), extract_text(msg))
        self.final_len = max((len(t) for t in self.text.values()), default=0)
        return kind

    def report(self, prefix):
        metric(f"{prefix}.bytes", self.bytes, "bytes")
        metric(f"{prefix}.frames", self.frames, "count")
        metric(f"{prefix}.final_len", self.final_len, "bytes")
        if self.final_len:
            metric(f"{prefix}.amplification", round(self.bytes / self.final_len, 3), "ratio")
        if self.binary_frames:
            metric(f"{prefix}.binary.frames", self.binary_frames, "count")
            metric(f"{prefix}.binary.wire", self.binary_raw, "bytes")
            metric(f"{prefix}.binary.inflated", self.binary_inflated, "bytes")
            if self.binary_inflated:
                metric(f"{prefix}.binary.ratio",
                       round(self.binary_raw / self.binary_inflated, 4), "ratio")
        for k, v in sorted(self.by_type.items(), key=lambda kv: -kv[1]["bytes"]):
            metric(f"{prefix}.type.{k.replace(':', '_')}.bytes", v["bytes"], "bytes")


def chain_of(msg):
    """The chain key the daemon uses: a live message has only `responseId`."""
    return msg.get("responseId") or msg.get("id") or "live"


def fold(prev, keep, append):
    """Apply one delta exactly as the phone does.

    `keep` counts UTF-16 code units because the real consumer is JS
    `String.prototype.slice`; Python strings index by scalar, so the cut has to
    happen in an actual UTF-16 encoding or an emoji would shift every index
    after it.
    """
    if keep is None:
        return prev + append
    units = prev.encode("utf-16-le")
    kept = units[: max(0, keep) * 2].decode("utf-16-le", errors="ignore")
    return kept + append


def extract_text(msg):
    c = msg.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "".join(p.get("text", "") for p in c if isinstance(p, dict) and p.get("type") == "text")
    return ""


async def observe(obs, session, stop, t0, read=True):
    import websockets
    q = f"session={urllib.parse.quote(session)}&token={TOKEN}"
    if obs.caps:
        q += "&caps=" + obs.caps
    async with websockets.connect(f"{WSB}/ws?{q}", max_size=64 * 1024 * 1024) as ws:
        if not read:
            # A client that never reads: the daemon must bound what it queues.
            await stop.wait()
            return
        while not stop.is_set():
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=5)
            except asyncio.TimeoutError:
                continue
            except Exception:
                return
            obs.note(raw, t0)


async def main():
    cwd = os.path.join(os.environ.get("BENCH_TMP", "/tmp"), "ab-proj")
    os.makedirs(cwd, exist_ok=True)
    session = api("/api/new", {"cwd": cwd})["sessionPath"]
    api("/api/prompt", {"commandId": str(uuid.uuid4()), "sessionPath": session, "text": "Reply with exactly: READY"})
    await asyncio.sleep(8)  # materialize the file and warm a child

    legacy = Observer("legacy", "")
    modern = Observer("modern", "delta,defl,bundle")
    stop = asyncio.Event()
    t0 = time.time()
    tasks = [asyncio.create_task(observe(legacy, session, stop, t0)),
             asyncio.create_task(observe(modern, session, stop, t0))]
    await asyncio.sleep(1.5)  # both attached (and modern has its bundle) before the turn

    words = 120 if QUICK else WORDS
    api("/api/prompt", {"commandId": str(uuid.uuid4()), "sessionPath": session,
                        "text": f"Write about {words} words of plain prose on how TCP "
                                f"congestion control works. No lists, no code."})

    deadline = time.time() + (90 if QUICK else 240)
    while time.time() < deadline:
        await asyncio.sleep(1)
        if legacy.by_type.get("event:turn_end") or legacy.by_type.get("event:agent_end"):
            break
    await asyncio.sleep(2)
    stop.set()
    for t in tasks:
        t.cancel()

    print("\n=== PROTOCOL A/B (same turn, two clients)")
    legacy.report("ab.legacy")
    modern.report("ab.modern")
    if legacy.bytes and modern.bytes:
        metric("ab.reduction.ratio", round(modern.bytes / legacy.bytes, 5), "ratio")
        metric("ab.reduction.saved", legacy.bytes - modern.bytes, "bytes")
        metric("ab.reduction.factor", round(legacy.bytes / max(modern.bytes, 1), 2), "ratio")
    if modern.bundle:
        for k in ("wire", "inflated", "entries"):
            metric(f"ab.bundle.{k}", modern.bundle[k], "bytes" if k != "entries" else "count")
        metric("ab.bundle.has_state", int(modern.bundle["has_state"]), "count")

    # Text equivalence: a delta stream must reconstruct the same characters a
    # snapshot stream delivered. A protocol that saves bytes by losing text is
    # not an optimisation.
    lt = max(legacy.text.values(), key=len, default="")
    mt = max(modern.text.values(), key=len, default="")
    same = lt == mt
    metric("ab.text.equivalent", int(same), "count")
    metric("ab.text.legacy_len", len(lt), "bytes")
    metric("ab.text.modern_len", len(mt), "bytes")

    print("\n=== SUMMARY")
    print(f"  legacy : {legacy.bytes:9} B in {legacy.frames:4} frames"
          f"  (amplification {legacy.bytes / max(legacy.final_len, 1):.1f}x)")
    print(f"  modern : {modern.bytes:9} B in {modern.frames:4} frames"
          f"  (amplification {modern.bytes / max(modern.final_len, 1):.1f}x)")
    if legacy.bytes:
        print(f"  saving : {100 * (1 - modern.bytes / legacy.bytes):.2f}% "
              f"({legacy.bytes / max(modern.bytes, 1):.1f}x less wire traffic)")
    print(f"  text equivalent: {'YES' if same else 'NO'} "
          f"(legacy {len(lt)} chars, modern {len(mt)} chars)")
    if modern.bundle:
        b = modern.bundle
        print(f"  bundle : {b['entries']} entries, {b['inflated']} B json -> {b['wire']} B on wire"
              f"{' (deflated)' if b['wire'] < b['inflated'] else ''}, state={b['has_state']}")
    if not same:
        print("  FAIL: the delta stream did not reconstruct the snapshot stream's text")
        sys.exit(1)


asyncio.run(main())
