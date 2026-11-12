import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const INSTALL_SH = fileURLToPath(new URL("../../install.sh", import.meta.url));
const SET_REPO_SH = fileURLToPath(new URL("./set-repo.sh", import.meta.url));

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

function close(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function targetForHost() {
  const os = process.platform === "linux" ? "linux" : process.platform === "darwin" ? "darwin" : null;
  const arch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : null;
  if (!os || !arch) return null;
  return os === "linux" ? `${arch}-unknown-linux-musl` : `${arch}-apple-darwin`;
}

test("install.sh verifies SHA256SUMS, installs executable, and rejects tampered archives", async (t) => {
  const target = targetForHost();
  if (!target) return t.skip(`host ${process.platform}/${process.arch} is outside install.sh targets`);

  const work = mkdtempSync(join(tmpdir(), "pulse-install-test-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));

  const binSrc = join(work, "src");
  mkdirSync(binSrc);
  writeFileSync(join(binSrc, "omp-pulse"), "#!/bin/sh\necho 'omp-pulse 0.1.0'\n", { mode: 0o755 });

  const assetName = `omp-pulse-0.1.0-${target}.tar.gz`;
  const archivePath = join(work, assetName);
  execFileSync("tar", ["-czf", archivePath, "-C", binSrc, "omp-pulse"]);
  const archiveBytes = readFileSync(archivePath);
  const sha = createHash("sha256").update(archiveBytes).digest("hex");

  let tamper = false;
  const server = createServer((req, res) => {
    res.setHeader("connection", "close");
    if (req.url === "/SHA256SUMS") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`${sha}  ${assetName}\n`);
      return;
    }
    if (req.url === `/${assetName}`) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      if (tamper) {
        const bad = Buffer.from(archiveBytes);
        bad[bad.length - 1] ^= 0xff;
        res.end(bad);
      } else {
        res.end(archiveBytes);
      }
      return;
    }
    res.writeHead(404).end("not found");
  });

  const port = await listen(server);
  t.after(() => close(server));

  const dest = join(work, "bin");
  const ok = await execFileAsync("sh", [INSTALL_SH], {
    env: {
      ...process.env,
      OMP_PULSE_VERSION: "0.1.0",
      OMP_PULSE_BASE_URL: `http://127.0.0.1:${port}`,
      OMP_PULSE_INSTALL_DIR: dest,
      PATH: "/usr/bin:/bin",
    },
  });
  const installed = join(dest, "omp-pulse");
  assert.equal(statSync(installed).mode & 0o111, 0o111);
  assert.match(ok.stdout, /note: .* is not on your PATH/);
  assert.match(execFileSync(installed, [], { encoding: "utf8" }), /omp-pulse 0\.1\.0/);

  tamper = true;
  const destBad = join(work, "bin-bad");
  await assert.rejects(
    execFileAsync("sh", [INSTALL_SH], {
      env: {
        ...process.env,
        OMP_PULSE_VERSION: "0.1.0",
        OMP_PULSE_BASE_URL: `http://127.0.0.1:${port}`,
        OMP_PULSE_INSTALL_DIR: destBad,
      },
    }),
    (err) => /SHA256 mismatch/.test(String(err.stderr)),
  );
});

test("set-repo.sh rewrites repository slugs idempotently without double-appending suffixes", (t) => {
  const work = mkdtempSync(join(tmpdir(), "pulse-set-repo-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));

  mkdirSync(join(work, "scripts/release"), { recursive: true });
  writeFileSync(join(work, "scripts/release/set-repo.sh"), readFileSync(SET_REPO_SH, "utf8"), { mode: 0o755 });
  writeFileSync(
    join(work, "Cargo.toml"),
    `[package]\nname = "omp-pulse"\nversion = "0.1.0"\nrepository = "https://github.com/acme/omp-pulse"\n`,
  );
  writeFileSync(
    join(work, "README.md"),
    `Install from https://raw.githubusercontent.com/acme/omp-pulse/main/install.sh or https://github.com/acme/omp-pulse/releases\n`,
  );

  const run1 = spawnSync("bash", [join(work, "scripts/release/set-repo.sh"), "beta", "omp-pulse-oss"], {
    cwd: work,
    encoding: "utf8",
  });
  assert.equal(run1.status, 0, run1.stdout + run1.stderr);
  assert.match(readFileSync(join(work, "Cargo.toml"), "utf8"), /github\.com\/beta\/omp-pulse-oss"/);
  assert.match(readFileSync(join(work, "README.md"), "utf8"), /beta\/omp-pulse-oss\/main\/install\.sh/);

  const run2 = spawnSync("bash", [join(work, "scripts/release/set-repo.sh"), "beta", "omp-pulse-oss"], {
    cwd: work,
    encoding: "utf8",
  });
  assert.equal(run2.status, 0, run2.stdout + run2.stderr);
  assert.match(run2.stdout, /nothing to change/);
});
