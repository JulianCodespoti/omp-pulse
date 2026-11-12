#!/usr/bin/env python3
"""Prepare a signed private conversation snapshot, or receive its authenticated result.

Only counts and status are printed. Source trees are always opened read-only.
"""

import argparse
from contextlib import contextmanager
import ctypes
from datetime import datetime, timezone
import errno
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import stat
import subprocess
import sys
import tempfile
import uuid
import zipfile


FORMAT = "omp-conversations-v1"
MAX_FILES = 100000
MAX_FILE = 512 * 1024 * 1024
MAX_TOTAL = 4 * 1024 * 1024 * 1024
MAX_METADATA = 64 * 1024
MAX_RECEIPT = 16 * 1024 * 1024
RESERVED_PORTS = {7681, 7682, 7690, 7691}
NOFOLLOW = os.O_NOFOLLOW | os.O_CLOEXEC


class TransferError(Exception):
    """Public, content-free diagnostic."""


class PrivateArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise TransferError("invalid command arguments")


def check_port(port):
    if type(port) is not int or not 1024 <= port <= 65535 or port in RESERVED_PORTS:
        raise TransferError("invalid callback port")


def safe_path(path):
    if not isinstance(path, str) or not path or "\\" in path or ":" in path:
        return False
    parts = path.split("/")
    return (all(p and p not in (".", "..") for p in parts)
            and not any(ord(c) < 32 or ord(c) == 127 for c in path)
            and parts[0] in ("sessions", "blobs") and len(parts) > 1
            and not any(excluded_name(p) for p in parts))


def excluded_name(name):
    name = name.lower()
    return name in (".owner", ".lock", "lock") or name.endswith((".owner", ".lock"))


def absolute_nosymlink(path):
    path = Path(path)
    if not path.is_absolute() or ".." in path.parts:
        raise TransferError("absolute non-symlink path required")
    for part in reversed((path, *path.parents)):
        try:
            if stat.S_ISLNK(part.lstat().st_mode):
                raise TransferError("symlink path rejected")
        except FileNotFoundError:
            pass
    return path


def private_output(path, sources=(), create=False):
    path = absolute_nosymlink(path)
    for prefix in ("/sdcard", "/storage", "/mnt/media_rw", "/data/media"):
        if path == Path(prefix) or Path(prefix) in path.parents:
            raise TransferError("shared output rejected")
    for root in sources:
        if path == root or root in path.parents or path in root.parents:
            raise TransferError("output overlaps source")
    if create:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o700):
        raise TransferError("private owned output directory required")
    return path


def stamp(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns)


@contextmanager
def open_relative(root_fd, relative, directory=False):
    """Walk every component with openat/O_NOFOLLOW, including all parents."""
    fd = os.dup(root_fd)
    try:
        parts = relative.split("/") if relative else []
        for index, part in enumerate(parts):
            flags = os.O_RDONLY | NOFOLLOW | os.O_NONBLOCK
            if directory or index < len(parts) - 1:
                flags |= os.O_DIRECTORY
            next_fd = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        yield fd
    finally:
        os.close(fd)


class Snapshot:
    """Inventory plus stable read-only descriptors; no source content retained."""

    def __init__(self, sessions, blobs):
        self.roots = {}
        self.files = []
        self.directories = []
        self.skipped = 0
        try:
            for label, root in (("sessions", sessions), ("blobs", blobs)):
                root = absolute_nosymlink(root)
                fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW)
                self.roots[label] = (root, fd)
                self._walk(label, fd, "")
            self.files.sort(key=lambda item: item[0])
            if len(self.files) > MAX_FILES or sum(item[2][3] for item in self.files) > MAX_TOTAL:
                raise TransferError("snapshot limits exceeded")
            self.validate()
        except BaseException:
            self.close()
            raise

    def _walk(self, label, fd, relative):
        before = stamp(os.fstat(fd))
        self.directories.append((label, relative, before))
        with os.scandir(fd) as entries:
            names = sorted(entry.name for entry in entries)
        for name in names:
            child = relative + "/" + name if relative else name
            if excluded_name(name):
                self.skipped += 1
                continue
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                nested = os.open(name, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=fd)
                try:
                    if stamp(os.fstat(nested)) != stamp(info):
                        raise TransferError("source changed during snapshot")
                    self._walk(label, nested, child)
                finally:
                    os.close(nested)
            elif stat.S_ISREG(info.st_mode):
                path = label + "/" + child
                if not safe_path(path) or info.st_size > MAX_FILE:
                    raise TransferError("unsupported source file")
                self.files.append((path, child, stamp(info)))
                if len(self.files) > MAX_FILES:
                    raise TransferError("snapshot limits exceeded")
            else:
                self.skipped += 1
        if stamp(os.fstat(fd)) != before:
            raise TransferError("source changed during snapshot")

    def validate(self):
        for label, (root, fd) in self.roots.items():
            absolute_nosymlink(root)
            if stamp(root.lstat()) != stamp(os.fstat(fd)):
                raise TransferError("source changed during snapshot")
        for label, relative, expected in self.directories:
            with open_relative(self.roots[label][1], relative, directory=True) as fd:
                if stamp(os.fstat(fd)) != expected:
                    raise TransferError("source changed during snapshot")
        for item in self.files:
            with self.open_file(item):
                pass

    @contextmanager
    def open_file(self, item):
        path, relative, expected = item
        label = path.split("/", 1)[0]
        with open_relative(self.roots[label][1], relative) as fd:
            if stamp(os.fstat(fd)) != expected:
                raise TransferError("source changed during snapshot")
            with os.fdopen(os.dup(fd), "rb") as source:
                yield source
            if stamp(os.fstat(fd)) != expected:
                raise TransferError("source changed during snapshot")
            with open_relative(self.roots[label][1], relative) as current:
                if stamp(os.fstat(current)) != expected:
                    raise TransferError("source changed during snapshot")

    def headers(self):
        count, cwds = 0, set()
        for item in self.files:
            path = item[0]
            if not (path.startswith("sessions/") and path.count("/") == 2
                    and path.endswith(".jsonl")):
                continue
            count += 1
            # Match src/sessions/jsonl.rs::parse_header: the bounded header
            # region can start with a padded title record before the session.
            with self.open_file(item) as source:
                region = source.read(4096)
            for line in region.split(b"\n"):
                try:
                    header = json.loads(line)
                except (ValueError, UnicodeError, RecursionError):
                    continue
                if not isinstance(header, dict) or header.get("type") != "session":
                    continue
                cwd = header.get("cwd")
                if not isinstance(cwd, str):
                    continue
                if (cwd.startswith("/") and not cwd.startswith("//") and cwd != "/"
                        and len(cwd) <= 4096 and str(PurePosixPath(cwd)) == cwd
                        and not any(p in (".", "..") for p in cwd.split("/")[1:])
                        and not any(ord(c) < 32 or ord(c) == 127 for c in cwd)):
                    cwds.add(cwd)
                break
        return count, sorted(cwds)

    def write_archive(self, destination, properties):
        records = []
        with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_STORED) as archive:
            archive.writestr("transfer.properties", properties)
            for item in self.files:
                digest, size = hashlib.sha256(), 0
                with self.open_file(item) as source, archive.open(item[0], "w", force_zip64=True) as output:
                    while True:
                        block = source.read(1024 * 1024)
                        if not block:
                            break
                        size += len(block)
                        if size > item[2][3]:
                            raise TransferError("source changed during snapshot")
                        digest.update(block)
                        output.write(block)
                if size != item[2][3]:
                    raise TransferError("source changed during snapshot")
                records.append({"path": item[0], "bytes": size, "sha256": digest.hexdigest()})
        self.validate()
        return records

    def close(self):
        for _, fd in self.roots.values():
            os.close(fd)
        self.roots.clear()

    def __enter__(self):
        return self

    def __exit__(self, *unused):
        self.close()


def property_escape(value):
    return "".join("\\" + c if c in "\\:=#! " else "\\n" if c == "\n" else
                   "\\r" if c == "\r" else "\\t" if c == "\t" else c for c in str(value))


def properties_bytes(values):
    data = "".join(property_escape(k) + "=" + property_escape(v) + "\n" for k, v in values.items()).encode("utf-8")
    if len(data) > MAX_METADATA:
        raise TransferError("metadata limit exceeded")
    return data


def read_gradle_properties(path):
    """Read Java-properties escaping/continuations without logging values."""
    if not path.exists():
        return {}
    text = path.read_text(encoding="utf-8")
    logical, pending = [], ""
    for line in text.splitlines():
        line = pending + (line.lstrip() if pending else line)
        trailing = len(line) - len(line.rstrip("\\"))
        if trailing % 2:
            pending = line[:-1]
        else:
            logical.append(line)
            pending = ""
    if pending:
        logical.append(pending)

    def unescape(value):
        def replace(match):
            escaped = match.group(1)
            if escaped.startswith("u"):
                return chr(int(escaped[1:], 16))
            return {"t": "\t", "n": "\n", "r": "\r", "f": "\f"}.get(escaped, escaped)
        return re.sub(r"\\(u[0-9a-fA-F]{4}|.)", replace, value)

    result = {}
    for line in logical:
        line = line.lstrip()
        if not line or line.startswith(("#", "!")):
            continue
        match = re.match(r"((?:\\.|[^\\:=\s])*)(?:\s*[:=]\s*|\s+)?(.*)$", line)
        if match:
            result[unescape(match[1])] = unescape(match[2])
    return result


def signing_config(properties_path):
    props = read_gradle_properties(properties_path)
    names = (("ompPulseStoreFile", "OMP_PULSE_KEYSTORE"),
             ("ompPulseStorePassword", "OMP_PULSE_STORE_PASSWORD"),
             ("ompPulseKeyAlias", "OMP_PULSE_KEY_ALIAS"),
             ("ompPulseKeyPassword", "OMP_PULSE_KEY_PASSWORD"))
    values = [props.get(key) or os.environ.get(env) for key, env in names]
    if not all(values):
        raise TransferError("release signing configuration required")
    # Gradle app/build.gradle resolves relative storeFile paths against app/.
    keystore = Path(values[0]).expanduser()
    if not keystore.is_absolute():
        keystore = Path(__file__).resolve().parents[2] / "mobile/android/app" / keystore
    return str(keystore), values[1], values[2], values[3]


def run_private(command, environment):
    try:
        return subprocess.run(command, env=environment, stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
                              timeout=300)
    except (OSError, subprocess.TimeoutExpired):
        raise TransferError("signing tool unavailable") from None


def inspect_manifest(source, limit, budget):
    """Mirror ConversationArchive.inspectManifest before JAR authentication."""
    budget[0] += 1
    if budget[0] > 10000:
        raise TransferError("signed archive metadata limits exceeded")
    size = section_attributes = line_length = field_length = 0
    have_attribute = pending_cr = False
    while True:
        block = source.read(min(8192, limit - size + 1))
        if not block:
            break
        size += len(block)
        if size > limit:
            raise TransferError("signed archive metadata limits exceeded")
        for value in block:
            if pending_cr:
                if value != 10:
                    raise TransferError("signed archive metadata limits exceeded")
                pending_cr = False
                continue
            if value in (10, 13):
                if line_length == 0:
                    budget[0] += 1
                    if budget[0] > 10000:
                        raise TransferError("signed archive metadata limits exceeded")
                    section_attributes = field_length = 0
                    have_attribute = False
                line_length = 0
                pending_cr = value == 13
                continue
            if line_length == 0:
                if value == 32:
                    if not have_attribute:
                        raise TransferError("signed archive metadata limits exceeded")
                else:
                    budget[1] += 1
                    section_attributes += 1
                    if budget[1] > 40000 or section_attributes > 32:
                        raise TransferError("signed archive metadata limits exceeded")
                    have_attribute = True
                    field_length = 0
            line_length += 1
            field_length += 1
            budget[2] += 1
            if field_length > 8192 or budget[2] > 4 * 1024 * 1024:
                raise TransferError("signed archive metadata limits exceeded")
    if pending_cr or line_length:
        raise TransferError("signed archive metadata limits exceeded")
    return size


def validate_signature_prefix(archive):
    """Reject signed output that exceeds the importer's pre-auth budgets."""
    entries = archive.infolist()
    index = 0
    if entries and entries[0].filename.upper() == "META-INF/":
        if not entries[0].is_dir() or entries[0].file_size:
            raise TransferError("signed archive metadata limits exceeded")
        index += 1
    if (index == len(entries) or entries[index].filename.upper() != "META-INF/MANIFEST.MF"
            or entries[index].is_dir()):
        raise TransferError("signed archive metadata limits exceeded")
    budget = [0, 0, 0]  # Sections, noncontinuation attributes, retained bytes.
    with archive.open(entries[index]) as source:
        total = inspect_manifest(source, 4 * 1024 * 1024, budget)
    names = {"META-INF/MANIFEST.MF"}
    blocks = 0
    index += 1
    while index < len(entries) and entries[index].filename.upper().startswith("META-INF/"):
        entry = entries[index]
        name = entry.filename.upper()
        leaf = name[9:]
        if (name in names or entry.is_dir() or "/" in leaf
                or not leaf.endswith((".SF", ".RSA", ".DSA", ".EC"))):
            raise TransferError("signed archive metadata limits exceeded")
        names.add(name)
        remaining = 8 * 1024 * 1024 - total
        with archive.open(entry) as source:
            if leaf.endswith(".SF"):
                total += inspect_manifest(source, min(4 * 1024 * 1024, remaining), budget)
            else:
                limit = min(256 * 1024, 1024 * 1024 - blocks, remaining)
                size = 0
                while True:
                    block = source.read(min(8192, limit - size + 1))
                    if not block:
                        break
                    size += len(block)
                    if size > limit:
                        raise TransferError("signed archive metadata limits exceeded")
                blocks += size
                total += size
        index += 1
    if index == len(entries):
        raise TransferError("signed archive metadata limits exceeded")
    # Include the first content local header and ZipInputStream's bounded
    # inflater read-ahead when bounding the captured compressed prefix.
    archive.fp.seek(entries[index].header_offset)
    header = archive.fp.read(30)
    if len(header) != 30 or header[:4] != bytes((80, 75, 3, 4)):
        raise TransferError("signed archive metadata limits exceeded")
    header_end = (entries[index].header_offset + 30
                  + int.from_bytes(header[26:28], "little")
                  + int.from_bytes(header[28:30], "little"))
    if header_end + 512 > 9 * 1024 * 1024:
        raise TransferError("signed archive metadata limits exceeded")


def sign_archive(unsigned, signed, config):
    jdk = Path(os.environ.get("OMP_PULSE_JDK", "/usr/lib/jvm/java-17-openjdk"))
    environment = os.environ.copy()
    version = run_private([str(jdk / "bin/java"), "-version"], environment)
    if version.returncode or not re.search(rb'version "17(?:[.\"+-])', version.stdout + version.stderr):
        raise TransferError("JDK 17 required")
    keystore, password, alias, key_password = config
    environment["OMP_TRANSFER_STORE_PASSWORD"] = password
    environment["OMP_TRANSFER_KEY_PASSWORD"] = key_password
    signer = str(jdk / "bin/jarsigner")
    command = [signer, "-keystore", keystore, "-storepass:env", "OMP_TRANSFER_STORE_PASSWORD",
               "-keypass:env", "OMP_TRANSFER_KEY_PASSWORD", "-sigalg", "SHA256withRSA",
               "-digestalg", "SHA-256", "-signedjar", str(signed), str(unsigned), alias]
    if run_private(command, environment).returncode:
        raise TransferError("archive signing failed")
    if run_private([signer, "-verify", str(signed)], environment).returncode:
        raise TransferError("archive signature verification failed")
    with zipfile.ZipFile(signed) as archive:
        names = archive.namelist()
        content = [name for name in names if not name.upper().startswith("META-INF/")]
        with zipfile.ZipFile(unsigned) as original:
            expected = original.namelist()
        if (content != expected or not content or content[0] != "transfer.properties"
                or len(names) > MAX_FILES
                or len(names) != len(set(names))
                or not any(name.upper().endswith(".SF") and name.upper().startswith("META-INF/") for name in names)
                or not any(name.upper().endswith(".RSA") and name.upper().startswith("META-INF/") for name in names)):
            raise TransferError("signed archive layout rejected")
        validate_signature_prefix(archive)


def write_json(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        json.dump(value, output, ensure_ascii=True, separators=(",", ":"))
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())


def publish_exclusive(source, destination):
    """Atomically move a private file without replacement or emulated links.

    Guest proot link2symlink emulates os.link with hidden files and symlinks.
    Linux renameat2(RENAME_NOREPLACE) instead preserves regular-file identity
    and rejects every existing destination, including dangling symlinks.
    Fail closed if libc/kernel/filesystem cannot provide that guarantee.
    """
    libc = ctypes.CDLL(None, use_errno=True)
    try:
        rename = libc.renameat2
    except AttributeError:
        raise OSError(errno.ENOTSUP, "exclusive atomic publication unavailable") from None
    rename.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int,
                       ctypes.c_char_p, ctypes.c_uint)
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1) != 0:
        raise OSError(ctypes.get_errno(), "exclusive atomic publication failed")


def prepare(args):
    check_port(args.callback_port)
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+", args.target_package):
        raise TransferError("invalid target package")
    sessions, blobs = absolute_nosymlink(args.sessions_root), absolute_nosymlink(args.blobs_root)
    output = private_output(args.output_dir, (sessions, blobs), create=True)
    if any(output.iterdir()):
        raise TransferError("empty private output directory required")
    lock = output / ".prepare.lock"
    fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600)
    os.close(fd)
    published = []
    try:
        config = signing_config(Path(args.gradle_properties).expanduser())
        with tempfile.TemporaryDirectory(prefix=".prepare-", dir=output) as temporary:
            work = Path(temporary)
            with Snapshot(sessions, blobs) as snapshot:
                conversations, cwds = snapshot.headers()
                request_id = str(uuid.uuid4())
                token = secrets.token_hex(32)
                timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
                values = {"format": FORMAT, "targetPackage": args.target_package,
                          "requestId": request_id,
                          "callbackUrl": f"http://127.0.0.1:{args.callback_port}/result",
                          "callbackToken": token, "fileCount": len(snapshot.files),
                          "conversationCount": conversations, "snapshotTime": timestamp,
                          "cwdCount": len(cwds)}
                values.update({f"cwd.{i}": cwd for i, cwd in enumerate(cwds)})
                unsigned, signed = work / "unsigned.jar", work / "transfer.jar"
                records = snapshot.write_archive(unsigned, properties_bytes(values))
                sign_archive(unsigned, signed, config)
                # Snapshot validation after signing also refuses changes while JDK runs.
                snapshot.validate()
                skipped = snapshot.skipped
            os.chmod(signed, 0o600)
            state = {"format": "omp-conversations-state-v1", "requestId": request_id,
                     "callbackToken": token, "callbackPort": args.callback_port,
                     "targetPackage": args.target_package, "fileCount": len(records),
                     "conversationCount": conversations, "snapshotTime": timestamp}
            write_json(work / "source-manifest.json", {"format": "omp-conversations-manifest-v1",
                       "requestId": request_id, "files": records})
            write_json(work / "request-state.json", state)
            for name in ("transfer.jar", "source-manifest.json", "request-state.json"):
                publish_exclusive(work / name, output / name)
                published.append(output / name)
        print(json.dumps({"status": "prepared", "fileCount": len(records),
                          "conversationCount": conversations, "skippedCount": skipped}))
    except BaseException:
        for path in published:
            path.unlink()
        raise
    finally:
        lock.unlink()


def private_json(path):
    fd = os.open(path, os.O_RDONLY | NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or info.st_size > MAX_METADATA):
            raise TransferError("private state required")
        return json.load(source)


def integer(value, maximum=MAX_FILES):
    return type(value) is int and 0 <= value <= maximum


def validate_receipt(receipt, state):
    required = {"status", "requestId", "imported", "unchanged", "files"}
    if not isinstance(receipt, dict) or not required <= receipt.keys() or receipt.keys() - required - {"indexedSessionCount", "errorPhase", "publication"}:
        raise TransferError("invalid receipt")
    if (receipt["status"] not in ("completed", "failed") or receipt["requestId"] != state["requestId"]
            or not integer(receipt["imported"]) or not integer(receipt["unchanged"])
            or not isinstance(receipt["files"], list) or len(receipt["files"]) > MAX_FILES
            or ("indexedSessionCount" in receipt and not integer(receipt["indexedSessionCount"]))):
        raise TransferError("invalid receipt")
    if "errorPhase" in receipt and (receipt["status"] != "failed" or receipt["errorPhase"] not in
                                   ("archive_validation", "runtime_setup", "publish", "readback")):
        raise TransferError("invalid receipt")
    if "publication" in receipt:
        detail = receipt["publication"]
        if (receipt["status"] != "failed" or receipt.get("errorPhase") != "publish"
                or not isinstance(detail, dict) or set(detail) != {"operation", "entryIndex", "errno"}
                or detail["operation"] not in {"root_directory", "preflight_directory", "preflight_path",
                                               "preflight_conflict", "mkdir", "destination_race",
                                               "staged_readback", "move", "destination_readback"}
                or type(detail["entryIndex"]) is not int or not -1 <= detail["entryIndex"] < state["fileCount"]
                or not integer(detail["errno"], 4095)):
            raise TransferError("invalid receipt")
    paths, total = set(), 0
    for entry in receipt["files"]:
        if (not isinstance(entry, dict) or set(entry) != {"path", "sha256", "bytes"}
                or not safe_path(entry["path"]) or not isinstance(entry["sha256"], str)
                or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"])
                or not integer(entry["bytes"], MAX_FILE) or entry["path"] in paths):
            raise TransferError("invalid receipt")
        paths.add(entry["path"])
        total += entry["bytes"]
    count = receipt["imported"] + receipt["unchanged"]
    if total > MAX_TOTAL or count != len(paths) or count > state["fileCount"]:
        raise TransferError("invalid receipt")
    if receipt["status"] == "completed" and count != state["fileCount"]:
        raise TransferError("invalid receipt")
    return receipt


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def callback_server(output, port, state):
    """Return a loopback-only server; useful to the CLI and real HTTP tests."""
    check_port(port)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"
        server_version = "ConversationTransfer"
        sys_version = ""

        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *unused):
            pass

        def send_error(self, code, message=None, explain=None):
            self.respond(code)

        def respond(self, code, ok=False):
            body = b'{"ok":true}\n' if ok else b'{"ok":false}\n'
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
            self.close_connection = True

        def valid_host(self):
            return self.headers.get_all("Host") == [f"127.0.0.1:{self.server.server_port}"]

        def do_GET(self):
            self.respond(200 if self.path == "/health" and self.valid_host() else 404,
                         self.path == "/health" and self.valid_host())

        def do_POST(self):
            if self.path != "/result" or not self.valid_host():
                self.respond(404)
                return
            expected = ("Bearer " + state["callbackToken"]).encode("ascii")
            auth = self.headers.get_all("Authorization", [])
            if len(auth) != 1 or not hmac.compare_digest(auth[0].encode("utf-8"), expected):
                self.respond(401)
                return
            lengths = self.headers.get_all("Content-Length", [])
            content_types = self.headers.get_all("Content-Type", [])
            if (len(lengths) != 1 or not re.fullmatch(r"[0-9]+", lengths[0])
                    or len(lengths[0]) > 10 or self.headers.get("Transfer-Encoding") is not None
                    or self.headers.get("Expect") is not None
                    or len(content_types) != 1 or content_types[0].split(";", 1)[0].strip().lower() != "application/json"):
                self.respond(400)
                return
            size = int(lengths[0])
            if not 0 < size <= MAX_RECEIPT:
                self.respond(413)
                return
            if self.server.received:
                self.respond(409)
                return
            try:
                data = self.rfile.read(size)
                if len(data) != size:
                    raise ValueError("incomplete request")
                receipt = validate_receipt(json.loads(data.decode("utf-8"), object_pairs_hook=unique_object), state)
            except (ValueError, UnicodeError, RecursionError, TransferError, OSError):
                self.respond(400)
                return
            temporary = None
            try:
                fd, temporary = tempfile.mkstemp(prefix=".receipt-", dir=output)
                os.close(fd)
                os.unlink(temporary)
                write_json(temporary, receipt)
                # Exclusive atomic publication; never overwrite an earlier receipt.
                publish_exclusive(temporary, output / "receipt.json")
            except OSError:
                self.respond(409 if (output / "receipt.json").exists() else 500)
                return
            finally:
                if temporary is not None and os.path.exists(temporary):
                    os.unlink(temporary)
            self.server.received = True
            print(json.dumps({"status": receipt["status"], "imported": receipt["imported"],
                              "unchanged": receipt["unchanged"], "fileCount": len(receipt["files"])}), flush=True)
            self.respond(200, True)

    class Server(HTTPServer):
        def handle_error(self, request, client_address):
            # Never let stdlib tracebacks print request content or local paths.
            pass

    server = Server(("127.0.0.1", port), Handler)
    server.received = False
    return server


def serve(args):
    check_port(args.port)
    output = private_output(args.output_dir)
    state = private_json(output / "request-state.json")
    if (not isinstance(state, dict) or state.get("format") != "omp-conversations-state-v1"
            or state.get("callbackPort") != args.port or not integer(state.get("fileCount"))
            or not isinstance(state.get("callbackToken"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", state["callbackToken"])
            or not isinstance(state.get("requestId"), str)
            or str(uuid.UUID(state["requestId"])) != state["requestId"]):
        raise TransferError("invalid private state")
    if os.path.lexists(output / "receipt.json"):
        raise TransferError("receipt already exists")
    with callback_server(output, args.port, state) as server:
        print(json.dumps({"status": "ready"}), flush=True)
        while not server.received:
            server.handle_request()


def main(argv=None):
    parser = PrivateArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    export = commands.add_parser("prepare", help="create a private signed source snapshot")
    export.add_argument("--output-dir", required=True)
    export.add_argument("--target-package", required=True)
    export.add_argument("--callback-port", required=True, type=int)
    export.add_argument("--sessions-root", default="/root/.local/share/omp/sessions")
    export.add_argument("--blobs-root", default="/root/.local/share/omp/blobs")
    export.add_argument("--gradle-properties", default=str(Path.home() / ".gradle/gradle.properties"))
    listener = commands.add_parser("serve", help="receive one authenticated import result")
    listener.add_argument("--output-dir", required=True)
    listener.add_argument("--port", required=True, type=int)
    # Invalid arguments must not be echoed (they may accidentally contain secrets).
    try:
        args = parser.parse_args(argv)
        os.umask(0o077)
        if args.command == "prepare":
            prepare(args)
        else:
            serve(args)
        return 0
    except TransferError as error:
        print("conversation-transfer: " + str(error), file=sys.stderr)
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile, RecursionError):
        print("conversation-transfer: operation failed", file=sys.stderr)
    except KeyboardInterrupt:
        print("conversation-transfer: interrupted", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
