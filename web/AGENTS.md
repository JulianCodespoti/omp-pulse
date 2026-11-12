# omp-pulse web

This package is the React client: a Vite + React + TypeScript PWA served by the daemon and loaded by the Android shell. The Rust daemon and its HTTP/WebSocket protocol remain authoritative. Repository-wide rules are in the root [AGENTS.md](../AGENTS.md).

## Boundaries

- `src/domain/` is framework-free: wire types, normalized messages, and pure state concepts only.
- `src/runtime/omp-session-controller.ts` owns REST/WebSocket I/O for sessions, authentication headers, reconnects, and omp command routing.
- `src/runtime/omp-store.ts` is the client state source of truth. Components subscribe to selectors and never mutate it directly.
- `src/app/` owns presentation. Session ownership decisions never belong there, and new I/O goes through `src/runtime/`, not into components. That is the direction, not yet the whole state: today some components still call `fetch` for side panels and media (`parts/ImagePart.tsx`, `parts/ImageViewer.tsx`, `tools/AgentsTab.tsx`, `parts/MessageParts.tsx`, `tools/TasksTab.tsx`), and several read or write `localStorage` for UI preferences and drafts (`PairScreen.tsx`, `nav/SessionSwitcher.tsx`, `session-format.ts`, `chat/CollabConnectSheet.tsx`, `composer/use-draft.ts`, `composer/prompt-history-store.ts`, `sessions/ModelPicker.tsx`, `sessions/NewSessionScreen.tsx`, `tools/TerminalTab.tsx`). Do not add to that list; move code out of it when you touch it. No component opens a `WebSocket`.
- `public/` is copied verbatim into the build.

## Commands

Use a Node line that `engines` in `package.json` allows (22.22+, 24.15+ or 26+). Node 25 is unsupported because two of the app's own dependencies exclude it: `nanoid@6` declares `^22 || ^24 || >=26` and `jsdom` (the unit tests' DOM) `^22.22.2 || ^24.15.0 || >=26.0.0` (see `package-lock.json`); npm warns about it on install.

```sh
npm ci                  # install exactly what the lockfile pins
npx vite build --base=./ --outDir ../public/app --emptyOutDir --sourcemap false   # the build the daemon embeds
npm run dev             # Vite dev server over src/
npm test                # unit tests in test/ (node --test)
npm run typecheck       # tsc --noEmit
```

The daemon embeds the repository-root `public/app/` at compile time, so after a client change rebuild with the command above and then rebuild the Rust binary. `npm run build` is a plain `vite build` into `web/dist/`, which nothing uses; it is not the build that ships. Never hand-edit `public/app/`. Keep the lockfile committed and pin dependency upgrades deliberately.

Unit tests live in `test/<name>.test.mjs`; how they load `src/` (Node type stripping, or rolldown + jsdom through `test/support/react-dom.mjs`) is in [docs/contributing/testing.md](../docs/contributing/testing.md#web-client-unit-tests). Browser end-to-end suites are in `e2e/browser/`.

## Performance invariants

- Stream deltas must be coalesced at animation-frame cadence.
- Update only the active streaming message; do not replace the whole history for every token.
- Keep history message identity stable so React can reconcile it cheaply.
- One viewport owner controls focus, auto-follow, keyboard resizing, and bottom scrolling.
- Do not add DOM-reparenting scripts or MutationObserver layout repairs.

## Integration contract

`OmpSessionController` must preserve the existing `bundle`, `event`, `md`, `entries`, `partial`, `resync`, `poll`, `bash_result`, and `error` frames. Collab encryption, desktop ownership, file-tail policy, and write arbitration stay in Rust. Add a typed adapter for a new frame before adding UI for it.
