## Summary

<!-- What changed and why, in a sentence or two. One logical change per PR. -->

## Checklist

- [ ] `scripts/ci.sh` passes (hosted CI runs it; paste a local summary below if you ran it).
- [ ] Zero warnings on the host and on `x86_64-pc-windows-gnu` (part of the gate).
- [ ] `cargo tree -i openssl-sys` matches nothing (only if `Cargo.toml` changed).
- [ ] Any E2E suites beyond the gate were run alone, through `e2e/run.sh` or `e2e/with-test-daemon.sh` (list them below).
- [ ] Tests added or updated for behaviour changes.
- [ ] Docs updated (README, `docs/`, `CHANGELOG.md` under Unreleased); `scripts/docs/codemap.sh` re-run if a `//!` header changed.
- [ ] No tokens, hostnames or private conversation content in code, fixtures or screenshots.

## Gate output

```text
<!-- paste the end of scripts/ci.sh output here -->
```

## E2E suites run

<!-- e.g. e2e/run.sh browser, or e2e/run.sh e2e/omp/verify-stop.mjs, or "none" -->
