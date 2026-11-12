"""Real temporary filesystem/HTTP/JDK regression tests; never read user sessions/keys.

Run: python3 -m unittest discover -s scripts/android/tests -p 'test_*.py' -v
"""

from contextlib import contextmanager, redirect_stderr, redirect_stdout
import hashlib
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
import zipfile


SCRIPT = Path(__file__).resolve().parents[1] / "transfer-conversations.py"
SPEC = importlib.util.spec_from_file_location("conversation_transfer", SCRIPT)
TRANSFER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TRANSFER)
REQUEST_ID = "12345678-1234-4234-8234-123456789abc"
TOKEN = "ab" * 32


class TemporarySources(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="conversation-export-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.sessions = self.root / "sessions"
        self.blobs = self.root / "blobs"
        self.sessions.mkdir()
        self.blobs.mkdir()

    def put(self, path, data):
        destination = self.root / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        return destination

    def snapshot(self, cls=TRANSFER.Snapshot):
        return cls(self.sessions, self.blobs)


class SnapshotTests(TemporarySources):
    def test_callback_port_boundaries_match_receiver(self):
        for port in (1024, 18765, 65535):
            TRANSFER.check_port(port)
        for port in (0, 1, 1023, 65536, 7681, 7682, 7690, 7691, True):
            with self.subTest(port=port), self.assertRaises(TRANSFER.TransferError):
                TRANSFER.check_port(port)

    def test_inventory_preserves_headers_nested_artifacts_and_binary_blobs(self):
        expected = {
            "sessions/project/chat.jsonl": b'{"type":"session","cwd":"/root/projects/caf\xc3\xa9"}\n{"type":"message","text":"untouched"}\n',
            "sessions/project/chat/subagent.jsonl": b'{"type":"session","cwd":"/not/a/top/header"}\n',
            "sessions/project/chat/tool-results/output.bin": b"\x00\xff\r\nraw\x80",
            "sessions/project/other.jsonl": b'{"type":"session","cwd":"/tmp/work"}\n',
            "blobs/one.png": b"\x89PNG\x00\r\n\xff",
        }
        for path, data in expected.items():
            self.put(path, data)
        self.put("sessions/project/.owner", b"private owner")
        self.put("sessions/project/chat.jsonl.OWNER", b"private owner")
        self.put("sessions/project/.LOCK", b"private lock")
        self.put("sessions/project/chat/write.LoCk", b"private lock")
        self.put("sessions/project/ignored.lock/nested.jsonl", b"must be excluded")
        external = self.put("outside.jsonl", b"do not follow")
        (self.sessions / "project/symlink.jsonl").symlink_to(external)
        (self.sessions / "project/linked-directory").symlink_to(self.blobs, target_is_directory=True)
        os.mkfifo(self.sessions / "project/pipe")
        unix = socket.socket(socket.AF_UNIX)
        self.addCleanup(unix.close)
        unix.bind(str(self.sessions / "project/socket"))
        archive_path = self.root / "snapshot.jar"
        metadata = b"format=omp-conversations-v1\n"
        with self.snapshot() as snapshot:
            self.assertEqual(snapshot.headers(), (2, ["/root/projects/caf\u00e9", "/tmp/work"]))
            self.assertEqual(snapshot.skipped, 9)
            records = snapshot.write_archive(archive_path, metadata)
        with zipfile.ZipFile(archive_path) as archive:
            self.assertEqual(archive.namelist(), ["transfer.properties"] + sorted(expected))
            self.assertEqual(archive.read("transfer.properties"), metadata)
            for path, data in expected.items():
                self.assertEqual(archive.read(path), data)
        self.assertEqual(records, [{"path": path, "bytes": len(expected[path]),
                                   "sha256": hashlib.sha256(expected[path]).hexdigest()}
                                  for path in sorted(expected)])
        for path, data in expected.items():
            self.assertEqual((self.root / path).read_bytes(), data)
        self.assertEqual(external.read_bytes(), b"do not follow")
        self.assertTrue((self.sessions / "project/.owner").exists())
        self.assertTrue(stat.S_ISFIFO((self.sessions / "project/pipe").lstat().st_mode))

    def test_cwd_discovery_uses_only_bounded_top_level_header_region(self):
        title = json.dumps({"type": "title", "v": 1, "title": "fixture", "pad": " " * 1024}).encode()
        self.put("sessions/project/valid.jsonl", title + b'\n{"type":"session","cwd":"/tmp/safe"}\n{"cwd":"/tmp/ignored"}\n')
        for index, cwd in enumerate(("/", "/tmp/../unsafe", "/tmp/./unsafe", "//tmp/unsafe", "relative", "/tmp/unsafe\nvalue")):
            self.put(f"sessions/project/unsafe{index}.jsonl", json.dumps({"type": "session", "cwd": cwd}).encode() + b"\n")
        self.put("sessions/project/malformed.jsonl", b'not json\n{"type":"message","cwd":"/tmp/ignored"}\n')
        self.put("sessions/project/large.jsonl", b"x" * 4096 + b'\n{"type":"session","cwd":"/tmp/outside-header"}\n')
        self.put("sessions/project/child/nested.jsonl", b'{"type":"session","cwd":"/tmp/nested"}\n')
        with self.snapshot() as snapshot:
            self.assertEqual(snapshot.headers(), (9, ["/tmp/safe"]))

    def test_changes_after_inventory_are_rejected_even_with_restored_mtime(self):
        source = self.put("sessions/project/chat.jsonl", b"old bytes")
        with self.snapshot() as snapshot:
            original = source.stat()
            source.write_bytes(b"new bytes")
            os.utime(source, ns=(original.st_atime_ns, original.st_mtime_ns))
            with self.assertRaises(TRANSFER.TransferError):
                snapshot.write_archive(self.root / "changed.jar", b"metadata")

    def test_mutation_while_streaming_is_detected(self):
        source_path = self.put("sessions/project/chat.jsonl", b"a" * (2 * 1024 * 1024))

        class MutatingSnapshot(TRANSFER.Snapshot):
            @contextmanager
            def open_file(self, item):
                with super().open_file(item) as source:
                    class Reader:
                        def read(self, size):
                            block = source.read(size)
                            if block:
                                with source_path.open("ab") as writer:
                                    writer.write(b"real concurrent append")
                            return block
                    yield Reader()

        with self.snapshot(MutatingSnapshot) as snapshot:
            with self.assertRaises(TRANSFER.TransferError):
                snapshot.write_archive(self.root / "torn.jar", b"metadata")

    def test_replaced_original_path_and_symlink_parent_are_rejected(self):
        source = self.put("sessions/project/chat.jsonl", b"same bytes")
        with self.snapshot() as snapshot:
            source.rename(source.with_suffix(".old"))
            source.write_bytes(b"same bytes")
            with self.assertRaises(TRANSFER.TransferError):
                snapshot.write_archive(self.root / "replaced.jar", b"metadata")
        with self.snapshot() as snapshot:
            directory = self.sessions / "project"
            directory.rename(self.sessions / "moved")
            directory.symlink_to(self.sessions / "moved", target_is_directory=True)
            with self.assertRaises((TRANSFER.TransferError, OSError)):
                snapshot.write_archive(self.root / "symlink.jar", b"metadata")

    def test_added_file_invalidates_tree_snapshot(self):
        self.put("sessions/project/chat.jsonl", b"original")
        with self.snapshot() as snapshot:
            self.put("sessions/project/new.jsonl", b"new")
            with self.assertRaises(TRANSFER.TransferError):
                snapshot.write_archive(self.root / "added.jar", b"metadata")


class PrivateOutputTests(TemporarySources):
    def test_refuses_shared_relative_source_and_symlink_outputs(self):
        for output in ("relative", "/sdcard/transfer", "/storage/emulated/0/transfer",
                       self.sessions / "export", self.blobs, self.root):
            with self.subTest(output=str(output)), self.assertRaises(TRANSFER.TransferError):
                TRANSFER.private_output(output, (self.sessions, self.blobs), create=True)
        target = self.root / "private"
        target.mkdir(mode=0o700)
        linked = self.root / "linked"
        linked.symlink_to(target, target_is_directory=True)
        with self.assertRaises(TRANSFER.TransferError):
            TRANSFER.private_output(linked / "export", create=True)
        self.assertFalse((target / "export").exists())

    def test_refuses_nonprivate_directory_and_state(self):
        output = self.root / "public"
        output.mkdir(mode=0o755)
        output.chmod(0o755)
        with self.assertRaises(TRANSFER.TransferError):
            TRANSFER.private_output(output)
        state = self.put("state.json", b"{}")
        state.chmod(0o644)
        with self.assertRaises(TRANSFER.TransferError):
            TRANSFER.private_json(state)
        state.chmod(0o600)
        symlink = self.root / "state-link.json"
        symlink.symlink_to(state)
        with self.assertRaises(OSError):
            TRANSFER.private_json(symlink)

    def test_atomic_publication_preserves_existing_file_and_symlink(self):
        source = self.put("private-source", b"new private bytes")
        destination = self.root / "private-destination"
        TRANSFER.publish_exclusive(source, destination)
        self.assertFalse(source.exists())
        self.assertFalse(destination.is_symlink())
        self.assertEqual(destination.read_bytes(), b"new private bytes")
        source.write_bytes(b"must not overwrite")
        with self.assertRaises(FileExistsError):
            TRANSFER.publish_exclusive(source, destination)
        self.assertEqual(source.read_bytes(), b"must not overwrite")
        self.assertEqual(destination.read_bytes(), b"new private bytes")
        dangling = self.root / "dangling"
        dangling.symlink_to(self.root / "missing")
        with self.assertRaises(FileExistsError):
            TRANSFER.publish_exclusive(source, dangling)
        self.assertTrue(dangling.is_symlink())
        self.assertEqual(source.read_bytes(), b"must not overwrite")
        self.assertFalse(any(path.name.startswith(".l2s") for path in self.root.iterdir()))

    def test_prepare_failure_publishes_nothing_and_preserves_originals(self):
        source = self.put("sessions/project/chat.jsonl", b"private fixture bytes")
        output = self.root / "failed-output"
        environment = {key: value for key, value in os.environ.items()
                       if key not in {"OMP_PULSE_KEYSTORE", "OMP_PULSE_STORE_PASSWORD",
                                      "OMP_PULSE_KEY_ALIAS", "OMP_PULSE_KEY_PASSWORD"}}
        result = subprocess.run([sys.executable, str(SCRIPT), "prepare", "--output-dir", str(output),
                                 "--target-package", "com.omppulse.app.next", "--callback-port", "18765",
                                 "--sessions-root", str(self.sessions), "--blobs-root", str(self.blobs),
                                 "--gradle-properties", str(self.root / "absent.properties")],
                                env=environment, capture_output=True, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b"")
        self.assertNotIn(b"private fixture bytes", result.stderr)
        self.assertEqual(list(output.iterdir()), [])
        self.assertEqual(source.read_bytes(), b"private fixture bytes")

    def test_argument_errors_never_echo_unrecognized_secret(self):
        output = io.StringIO()
        with redirect_stderr(output):
            self.assertEqual(TRANSFER.main(["prepare", "--password=do-not-print"]), 1)
        self.assertNotIn("do-not-print", output.getvalue())


class CallbackTests(TemporarySources):
    def setUp(self):
        super().setUp()
        self.output = self.root / "output"
        self.output.mkdir(mode=0o700)
        self.state = {"requestId": REQUEST_ID, "callbackToken": TOKEN, "fileCount": 1}
        self.receipt = {"status": "completed", "requestId": REQUEST_ID, "imported": 1,
                        "unchanged": 0, "indexedSessionCount": 1,
                        "files": [{"path": "sessions/project/chat.jsonl", "bytes": 5,
                                   "sha256": hashlib.sha256(b"hello").hexdigest()}]}
        for attempt in range(10):
            with socket.socket() as reservation:
                reservation.bind(("127.0.0.1", 0))
                port = reservation.getsockname()[1]
            try:
                self.server = TRANSFER.callback_server(self.output, port, self.state)
                break
            except OSError:
                if attempt == 9:
                    raise
        self.port = self.server.server_port
        thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()

        def stop():
            self.server.shutdown()
            self.server.server_close()
            thread.join(timeout=5)
        self.addCleanup(stop)
        self.assertEqual(self.server.server_address, ("127.0.0.1", self.port))

    def request(self, method="POST", path="/result", value=None, headers=None, body=None):
        if body is None:
            body = json.dumps(self.receipt if value is None else value).encode()
        fields = [("Host", f"127.0.0.1:{self.port}"), ("Authorization", "Bearer " + TOKEN),
                  ("Content-Type", "application/json"), ("Content-Length", str(len(body)))]
        for key, value in (headers or []):
            fields = [(k, v) for k, v in fields if k.lower() != key.lower()]
            if value is not None:
                fields.append((key, value))
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        try:
            connection.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
            for key, value in fields:
                connection.putheader(key, value)
            connection.endheaders(body)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def test_health_is_public_but_exact_route_and_host_are_required(self):
        self.assertEqual(self.request("GET", "/health", headers=[("Authorization", None)])[0], 200)
        for method, path, headers in (("GET", "/health?x=1", []), ("POST", "/result?x=1", []),
                                      ("POST", "/result", [("Host", "evil.invalid")])):
            self.assertEqual(self.request(method, path, headers=headers)[0], 404)
        self.assertFalse((self.output / "receipt.json").exists())

    def test_requires_exact_bearer_token(self):
        for authorization in (None, TOKEN, "bearer " + TOKEN, "Bearer " + "ac" * 32, "Bearer " + TOKEN + "x"):
            with self.subTest(authorization=authorization):
                self.assertEqual(self.request(headers=[("Authorization", authorization)])[0], 401)
        self.assertFalse((self.output / "receipt.json").exists())

    def test_rejects_unbounded_ambiguous_or_non_json_requests(self):
        cases = [([("Content-Length", None)], b"{}", 400),
                 ([("Content-Length", "-1")], b"", 400),
                 ([("Content-Length", str(TRANSFER.MAX_RECEIPT + 1))], b"", 413),
                 ([("Transfer-Encoding", "chunked")], b"0\r\n\r\n", 400),
                 ([("Content-Type", "text/plain")], b"{}", 400),
                 ([], b"not json", 400), ([], b'{"status":"failed","status":"completed"}', 400)]
        for headers, body, expected in cases:
            with self.subTest(headers=headers, body=body):
                self.assertEqual(self.request(headers=headers, body=body)[0], expected)
        self.assertFalse((self.output / "receipt.json").exists())

    def test_rejects_request_mismatch_bad_counts_paths_and_digests(self):
        bad = []
        for changes in ({"requestId": "other"}, {"status": "anything"}, {"imported": True},
                        {"imported": 2}, {"files": []}, {"error": "sensitive text"},
                        {"errorPhase": "publish"}):
            bad.append(dict(self.receipt, **changes))
        for path in ("../escape", "sessions/project/../escape", "sessions/project/.owner", "blobs/a.lock", "/blobs/a", "sessions/a\\b"):
            bad.append(dict(self.receipt, files=[dict(self.receipt["files"][0], path=path)]))
        for changes in ({"sha256": "wrong"}, {"bytes": -1}, {"bytes": True}, {"content": "secret"}):
            bad.append(dict(self.receipt, files=[dict(self.receipt["files"][0], **changes)]))
        for receipt in bad:
            with self.subTest(receipt=receipt):
                self.assertEqual(self.request(value=receipt)[0], 400)
        self.assertFalse((self.output / "receipt.json").exists())

    def test_valid_result_is_private_exact_and_not_overwritten(self):
        public = io.StringIO()
        with redirect_stdout(public):
            self.assertEqual(self.request()[0], 200)
        receipt_path = self.output / "receipt.json"
        self.assertEqual(json.loads(receipt_path.read_text()), self.receipt)
        self.assertEqual(stat.S_IMODE(receipt_path.stat().st_mode), 0o600)
        self.assertEqual(receipt_path.stat().st_nlink, 1)
        self.assertEqual(set(path.name for path in self.output.iterdir()), {"receipt.json"})
        self.assertEqual(json.loads(public.getvalue()), {"status": "completed", "imported": 1, "unchanged": 0, "fileCount": 1})
        self.assertEqual(self.request()[0], 409)
        self.assertEqual(json.loads(receipt_path.read_text()), self.receipt)

    def test_publication_failure_reports_only_bounded_structured_details(self):
        receipt = {"status": "failed", "requestId": REQUEST_ID, "imported": 0,
                   "unchanged": 0, "files": [], "errorPhase": "publish",
                   "publication": {"operation": "move", "entryIndex": 0, "errno": 18}}
        for field, value in (("operation", "private error text"), ("entryIndex", 1), ("errno", 4096)):
            invalid = dict(receipt, publication=dict(receipt["publication"], **{field: value}))
            self.assertEqual(self.request(value=invalid)[0], 400)
        with redirect_stdout(io.StringIO()):
            self.assertEqual(self.request(value=receipt)[0], 200)
        self.assertEqual(json.loads((self.output / "receipt.json").read_text()), receipt)

    def test_failed_result_permits_only_generic_error_phase(self):
        receipt = {"status": "failed", "requestId": REQUEST_ID, "imported": 0,
                   "unchanged": 0, "files": [], "errorPhase": "archive_validation"}
        with redirect_stdout(io.StringIO()):
            self.assertEqual(self.request(value=receipt)[0], 200)
        self.assertEqual(json.loads((self.output / "receipt.json").read_text()), receipt)


class SignedPrepareTests(TemporarySources):
    @classmethod
    def setUpClass(cls):
        cls.jdk = Path(os.environ.get("OMP_PULSE_JDK", "/usr/lib/jvm/java-17-openjdk"))
        if not all((cls.jdk / "bin" / name).is_file() for name in ("java", "keytool", "jarsigner")):
            raise unittest.SkipTest("JDK 17 signing tools unavailable; set OMP_PULSE_JDK")
        result = subprocess.run([str(cls.jdk / "bin/java"), "-version"], capture_output=True, check=False)
        if b'version "17' not in result.stdout + result.stderr:
            raise unittest.SkipTest("JDK 17 required")

    def signing_environment(self):
        keystore = self.root / "temporary-test-key.p12"
        environment = os.environ.copy()
        environment.update(OMP_PULSE_JDK=str(self.jdk), OMP_PULSE_KEYSTORE=str(keystore),
                           OMP_PULSE_STORE_PASSWORD="temporary-test-password", OMP_PULSE_KEY_ALIAS="test-only",
                           OMP_PULSE_KEY_PASSWORD="temporary-test-password")
        generated = subprocess.run([str(self.jdk / "bin/keytool"), "-genkeypair", "-alias", "test-only",
                                    "-keyalg", "RSA", "-keysize", "2048", "-validity", "2",
                                    "-dname", "CN=Temporary Conversation Export Test", "-keystore", str(keystore),
                                    "-storepass:env", "OMP_PULSE_STORE_PASSWORD", "-keypass:env", "OMP_PULSE_KEY_PASSWORD"],
                                   env=environment, capture_output=True, check=False)
        self.assertEqual(generated.returncode, 0, "temporary test key generation failed")
        return environment

    def test_prepare_real_signed_jar_metadata_order_and_manifest_digests(self):
        expected = {"sessions/project/chat.jsonl": b'{"type":"session","cwd":"/tmp/fixture"}\n',
                    "sessions/project/chat/tools/result": b"\x00exact\xffbytes\n", "blobs/image": b"image bytes"}
        for path, data in expected.items():
            self.put(path, data)
        self.put("sessions/project/chat.owner", b"excluded")
        environment = self.signing_environment()
        output = self.root / "output"
        completed = subprocess.run([sys.executable, str(SCRIPT), "prepare", "--output-dir", str(output),
                                    "--target-package", "com.omppulse.app.next", "--callback-port", "18765",
                                    "--sessions-root", str(self.sessions), "--blobs-root", str(self.blobs),
                                    "--gradle-properties", str(self.root / "nonexistent.properties")],
                                   env=environment, capture_output=True, check=False)
        self.assertEqual(completed.returncode, 0, "private prepare failed")
        self.assertEqual(json.loads(completed.stdout), {"status": "prepared", "fileCount": 3,
                                                       "conversationCount": 1, "skippedCount": 1})
        self.assertEqual(completed.stderr, b"")
        self.assertEqual({path.name for path in output.iterdir()}, {"transfer.jar", "request-state.json", "source-manifest.json"})
        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o700)
        for path in output.iterdir():
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        state = json.loads((output / "request-state.json").read_text())
        manifest = json.loads((output / "source-manifest.json").read_text())
        self.assertEqual(manifest["requestId"], state["requestId"])
        self.assertEqual(manifest["files"], [{"path": path, "bytes": len(expected[path]),
                                           "sha256": hashlib.sha256(expected[path]).hexdigest()}
                                          for path in sorted(expected)])
        with zipfile.ZipFile(output / "transfer.jar") as archive:
            content = [name for name in archive.namelist() if not name.upper().startswith("META-INF/")]
            self.assertEqual(content, ["transfer.properties"] + sorted(expected))
            metadata = archive.read("transfer.properties").decode()
            self.assertIn("callbackToken=" + state["callbackToken"] + "\n", metadata)
            self.assertIn("requestId=" + state["requestId"] + "\n", metadata)
            for path, data in expected.items():
                self.assertEqual(archive.read(path), data)
                self.assertEqual((self.root / path).read_bytes(), data)
        verified = subprocess.run([str(self.jdk / "bin/jarsigner"), "-verify", str(output / "transfer.jar")], capture_output=True)
        self.assertEqual(verified.returncode, 0, "real archive signature verification failed")
        self.assertNotIn(state["callbackToken"].encode(), completed.stdout + completed.stderr)
        tampered = self.root / "tampered.jar"
        with zipfile.ZipFile(output / "transfer.jar") as original, zipfile.ZipFile(tampered, "w") as changed:
            for entry in original.infolist():
                data = original.read(entry.filename)
                if entry.filename == "sessions/project/chat.jsonl":
                    data += b"tampering"
                changed.writestr(entry, data)
        rejected = subprocess.run([str(self.jdk / "bin/jarsigner"), "-verify", str(tampered)], capture_output=True)
        self.assertNotEqual(rejected.returncode, 0, "JDK accepted tampered signed data")

    def test_signed_manifest_section_limit_rejects_before_publication(self):
        # Each JAR data entry adds a section to both MANIFEST.MF and .SF.
        # Five thousand files exceed the combined 10000-section budget while
        # remaining below every raw byte/entry bound and cryptographically valid.
        for index in range(5000):
            self.put(f"blobs/fixture-{index:05d}", b"")
        unsigned, signed = self.root / "large-unsigned.jar", self.root / "large-signed.jar"
        metadata = TRANSFER.properties_bytes({
            "format": "omp-conversations-v1", "targetPackage": "com.omppulse.app.next",
            "requestId": REQUEST_ID, "callbackUrl": "http://127.0.0.1:18765/result",
            "callbackToken": TOKEN, "fileCount": 5000, "conversationCount": 0,
            "snapshotTime": "2026-10-28T00:00:00Z", "cwdCount": 0,
        })
        with self.snapshot() as snapshot:
            snapshot.write_archive(unsigned, metadata)
        environment = self.signing_environment()
        signing = subprocess.run([str(self.jdk / "bin/jarsigner"), "-keystore", environment["OMP_PULSE_KEYSTORE"],
                                  "-storepass:env", "OMP_PULSE_STORE_PASSWORD", "-keypass:env", "OMP_PULSE_KEY_PASSWORD",
                                  "-sigalg", "SHA256withRSA", "-digestalg", "SHA-256",
                                  "-signedjar", str(signed), str(unsigned), "test-only"],
                                 env=environment, capture_output=True, check=False)
        self.assertEqual(signing.returncode, 0, "temporary oversized fixture signing failed")
        verified = subprocess.run([str(self.jdk / "bin/jarsigner"), "-verify", str(signed)],
                                  capture_output=True, check=False)
        self.assertEqual(verified.returncode, 0, "oversized fixture must have a valid real signature")
        with zipfile.ZipFile(signed) as archive:
            manifests = [archive.read(entry) for entry in archive.infolist()
                         if entry.filename.upper() == "META-INF/MANIFEST.MF" or entry.filename.upper().endswith(".SF")]
            sections = sum(1 + data.replace(b"\r\n", b"\n").count(b"\n\n") for data in manifests)
            self.assertGreater(sections, 10000)
            self.assertTrue(all(len(data) <= 4 * 1024 * 1024 for data in manifests))
            with self.assertRaisesRegex(TRANSFER.TransferError, "metadata limits exceeded"):
                TRANSFER.validate_signature_prefix(archive)
        output = self.root / "rejected-output"
        result = subprocess.run([sys.executable, str(SCRIPT), "prepare", "--output-dir", str(output),
                                 "--target-package", "com.omppulse.app.next", "--callback-port", "18765",
                                 "--sessions-root", str(self.sessions), "--blobs-root", str(self.blobs),
                                 "--gradle-properties", str(self.root / "nonexistent.properties")],
                                env=environment, capture_output=True, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, b"conversation-transfer: signed archive metadata limits exceeded\n")
        self.assertEqual(list(output.iterdir()), [])
        self.assertEqual(sum(1 for _ in self.blobs.iterdir()), 5000)


if __name__ == "__main__":
    unittest.main()
