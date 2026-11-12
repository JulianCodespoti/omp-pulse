#!/usr/bin/env python3
"""Seed a synthetic session corpus that matches the real one statistically.

WHY: the read paths (`/api/sessions` scan, `/api/history` paging, header parse)
are only interesting at real scale. The live corpus is 3365 files / 4.0 GB across
~60 project dirs, largest 44 MB. Benchmarking against the REAL corpus is not an
option: our own RPC children write to session files, so a bench run could damage a
real conversation. This generates an equivalent-shaped corpus we own.

Idempotent: a marker file records the shape, so re-runs are free.

  bench/seed-corpus.py --root /path/to/sessions [--files 3365] [--dirs 60]
"""
import argparse, json, os, random, sys, time, uuid

AP = argparse.ArgumentParser()
AP.add_argument("--root", required=True)
AP.add_argument("--files", type=int, default=3365)
AP.add_argument("--dirs", type=int, default=60)
# Size mix mirrors the real corpus: a long tail of small sessions, a few large.
AP.add_argument("--big-mb", type=float, default=44.0, help="largest session size")
AP.add_argument("--mid-mb", type=float, default=11.0, help="a typical 'heavy' session")
args = AP.parse_args()

root = os.path.abspath(args.root)
marker = os.path.join(root, ".bench-corpus.json")
shape = {"format": 2, "files": args.files, "dirs": args.dirs, "big_mb": args.big_mb, "mid_mb": args.mid_mb}
if os.path.exists(marker):
    try:
        if json.load(open(marker)) == shape:
            print(f"corpus already seeded: {args.files} files across {args.dirs} dirs")
            sys.exit(0)
    except Exception:
        pass

random.seed(1729)  # reproducible corpus: benchmark numbers must be comparable
os.makedirs(root, exist_ok=True)

PROSE = (
    "The daemon watches the session file with inotify and forwards appended "
    "entries to every attached client, serializing each event exactly once. "
)


def entry(role, text, i):
    # Real omp shape: role/content nest under `message`. A flat {role,content}
    # loads fine in our own reader but CRASHES omp's session loader
    # (`msg.role` undefined), so a child spawned against a flat corpus dies with
    # "open failure" — which is exactly how two bench slices lost an afternoon.
    return json.dumps({
        "type": "message",
        "id": f"m{i}",
        "parentId": None,
        "timestamp": "2026-08-12T00:00:00.000Z",
        "message": {
            "role": role,
            "content": [{"type": "text", "text": text}],
            "timestamp": 1786000000000 + i,
        },
    })


def write_session(path, target_bytes, title):
    sid = str(uuid.uuid4())
    with open(path, "w") as f:
        f.write(json.dumps({
            "type": "session", "version": 1, "id": sid,
            "timestamp": "2026-08-12T00:00:00.000Z", "cwd": os.path.dirname(path),
        }) + "\n")
        f.write(json.dumps({"type": "title", "id": "t0", "title": title}) + "\n")
        written, i = 0, 0
        while written < target_bytes:
            # Vary line length: the backward pager grows its window for long lines.
            n = random.choice([1, 1, 1, 2, 6, 40])
            line = entry("user" if i % 2 == 0 else "assistant", PROSE * n, i)
            f.write(line + "\n")
            written += len(line) + 1
            i += 1


t0 = time.time()
dirs = [os.path.join(root, f"-tmp-bench-proj{d:02d}") for d in range(args.dirs)]
for d in dirs:
    os.makedirs(d, exist_ok=True)

big = int(args.big_mb * 1048576)
mid = int(args.mid_mb * 1048576)
for i in range(args.files):
    d = dirs[i % len(dirs)]
    # ISO-prefixed names, newest last, so mtime and name order agree.
    stamp = f"2026-0{1 + i % 8}-{1 + i % 27:02d}T{i % 24:02d}-{i % 60:02d}-00-000Z"
    path = os.path.join(d, f"{stamp}_{uuid.uuid4()}.jsonl")
    if i == 0:
        size = big
    elif i < 4:
        size = mid
    else:
        size = random.choice([4_000, 12_000, 40_000, 120_000, 400_000, 1_200_000])
    write_session(path, size, f"bench session {i}")
    os.utime(path, (1786000000 + i * 60, 1786000000 + i * 60))

json.dump(shape, open(marker, "w"))
total = sum(
    os.path.getsize(os.path.join(dp, f))
    for dp, _, fs in os.walk(root) for f in fs if f.endswith(".jsonl")
)
print(f"seeded {args.files} sessions across {args.dirs} dirs, {total/1e9:.2f} GB, in {time.time()-t0:.1f}s")
