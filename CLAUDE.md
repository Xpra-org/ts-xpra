# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A clean-room Xpra HTML5 browser client in TypeScript (native DOM, Canvas 2D, WebSocket, Web Crypto; no UI framework). It targets the modern Xpra 8.0 protocol and builds to a static bundle in `dist/` meant to be copied into an Xpra server's `www/` directory. Requires Node.js >= 22.12.

## Clean-room rule (critical)

Xpra-specific wire formats and behavior must come **only** from `~/projects/xpra/docs`. Do not read Xpra client/server source code in any language (including source links embedded in those docs), and do not resolve protocol gaps by reverse-engineering an existing implementation — ask the project owner instead. Running a real server as a black-box interop test is allowed. Full policy and the list of doc files used: `docs/clean-room.md`. The browser test fixture's encoder is independently written and must stay that way.

## Commands

```sh
npm ci
npm run dev            # Vite dev server on 127.0.0.1
npm run typecheck      # tsc --noEmit
npm test               # unit tests (tests/*.test.ts)
npm run test:browser   # puppeteer tests (tests/browser/*.test.ts)
npm run build          # typecheck + vite build -> dist/
npm run preview        # serve dist/
```

Run a single test file or test by name (tests run directly via Node's type stripping, no build step):

```sh
node --experimental-strip-types --test --experimental-test-isolation=none tests/protocol.test.ts
node --experimental-strip-types --test --experimental-test-isolation=none --test-name-pattern='hello' tests/client.test.ts
```

Browser tests need a local Chrome/Chromium (set `CHROME_BIN` if not at `/usr/bin/google-chrome|chromium|chromium-browser`) plus permission to launch it and bind local sockets. They start a Vite server under `/client/` and a `ws` fixture server that speaks the protocol.

Because tests run with `--experimental-strip-types`, source must use erasable TypeScript only (no `enum`, `namespace`, or constructor parameter properties) and imports must include the `.ts` extension. `tsconfig` is strict with `noUncheckedIndexedAccess`, `noUnused*`, and `verbatimModuleSyntax` (use `import type` for types).

## Architecture

Layering (see `docs/architecture.md` for the public API and extension examples):

- `src/protocol` — wire `Value`/`Packet` types, rencodeplus codec, record framing (`RecordReader`/`record`), raw chunks, receive-side LZ4 (via `lz4js`, the one approved third-party runtime dep).
- `src/core` — `XpraClient` (`client.ts`): session lifecycle, hello/capability negotiation, HMAC auth (`auth.ts`), window state, draw queues and acknowledgements, typed commands. **No DOM imports.** `index.ts` is the public entry point for forks.
- `src/browser` — DOM adapters: `WebSocketTransport`, `CanvasSurface` (backing + visible canvas), `bindInput` keyboard/pointer translation.
- `src/ui` — default skin (`DesktopSkin`: window chrome, taskbar, dragging/resizing) and CSS; palette lives in CSS custom properties in `theme.css`.
- `src/main.ts` — wires everything into `index.html`'s `#app`: builds the markup, connection form, credential dialog, and resize observer.

Key contracts that span files:

- The core is injected with a `Transport` factory, a `Renderer` (`create(window)` → surface with `resize`/`draw`/`dispose`), and an optional async `CredentialProvider`. Tests substitute fakes for all of these (see `FakeTransport` in `tests/client.test.ts`).
- The core serializes draws/resizes per window and owns **all** draw acknowledgements; a surface's `draw` promise resolves after decode+present, or throws so the core sends the failure ack. Skins must never ack.
- Snapshots and emitted events are detached copies; `subscribe` returns an unsubscribe function. `connect()` returns after sending the first hello — observe state events for auth/ready.
- Queued work is scoped to a connection generation so reconnect/destroy can't revive old surfaces or send stale acks. Pings are answered synchronously on receipt.
- Subsystems (`client.register`) add namespaced capabilities and packet handlers; they cannot override built-in handlers or top-level capability keys. Handlers are synchronous; async work must use `context.signal`.
- Resource limits (record size, decompressed bytes, window count/pixels, pending draws, codec nesting) are configurable via `ClientOptions.limits`; pre-hello record payloads are capped at 16 KiB.

Geometry: one CSS pixel equals one server pixel regardless of devicePixelRatio; local title bars sit above the server-reported content area. Popups/tooltips (override-redirect) stay at server positions and never send map/configure.

Deliberately deferred features (video, audio, clipboard, cursors, icons, tray, notifications, file transfer, printing, IME, touch, full international keymaps, auto-reconnect, legacy protocol) are listed in `README.md`; don't assume they exist.
