# ts-xpra

A small, independently written Xpra browser client in TypeScript. Native DOM,
Canvas 2D, WebSocket, and Web Crypto; no UI framework. MIT licensed.

## Build and install

Use Node.js 22.12 or newer and npm:

```sh
npm ci
npm run build
```

The complete static client is in `dist/`. Copy **the contents** to the server's
web directory, using an account with permission to write there:

```sh
cp -a dist/. /usr/share/xpra/www/
```

The build includes relative asset URLs and license notices. It needs no CDN,
application server, runtime npm installation, or SPA route rewriting. Serving
under a subdirectory works. Remove obsolete assets from an earlier installation
according to your deployment process; the copy command does not remove them.

```sh
npm run dev        # local development server
npm run preview    # serve dist locally after building
```

Open the page, enter the server's `ws://` or `wss://` URL, and connect. The default
address uses the page's host and path. WebSocket support must be enabled on the
Xpra server. A documentation-provided starting point is:

```sh
xpra start :100 --start=xterm --bind-tcp=127.0.0.1:10000 --daemon=no
```

Connect to `ws://127.0.0.1:10000/`. The server selects the `binary` WebSocket
subprotocol. An HTTPS page needs a WSS endpoint; password authentication needs
Web Crypto, available on HTTPS or localhost. WSS certificates are verified by
the browser. Passwords are kept in memory for the current authentication step,
never saved to storage or placed in URLs. Further challenges open a credential
dialog. The default connection takes over another attached client; select
**Share session** to request sharing instead.

## Implemented foundation

- Modern documented Xpra 8.0 protocol: rencodeplus, bounded record parsing,
  raw chunks, receive-side LZ4, negotiation, HMAC SHA-256/SHA-512, and ping replies.
- Floating windows, server geometry updates, title/decorations, popups,
  transient modal dialogs, size hints, minimize/restore, and close requests.
- Canvas PNG and RGB24/RGB32 drawing, row padding, RGB/BGR channel orders,
  alpha, scaled pictures, batched presentation, and draw acknowledgements.
- Common ASCII and special keys, modifiers, repeat, pointer buttons/motion,
  wheel negotiation, focus-loss input release, and readonly sessions.
- Connection status, bounded diagnostics, manual reconnect, fullscreen, and
  configurable resource limits.

One CSS pixel represents one server pixel; device pixel ratio does not change
protocol geometry. Server pixels describe content; local title bars occupy the
space above it. Managed windows can be dragged by their title bars and resized
at the lower right. Menus/tooltips stay at server-specified positions and do
not send map/configure packets.

Video, audio, clipboard, cursor forwarding, window icons, tray, notifications,
file transfer, printing, IME, touch input, full international key naming,
automatic reconnect, and legacy compatibility are deferred. Browser-reserved
shortcuts cannot all be forwarded. Rendering/network logic currently runs on
the main thread with asynchronous per-window draw queues; worker offloading is
a future optimization. See [architecture and extension examples](docs/architecture.md).

## Verification

```sh
npm run typecheck
npm test
npm run test:browser
```

Unit tests use Node's built-in runner. Browser tests use `puppeteer-core` with
an independently written WebSocket fixture, serving the app under `/client/`.
Install a current Chrome/Chromium and set `CHROME_BIN` if it is not at a usual
Linux system path:

```sh
CHROME_BIN=/path/to/chrome npm run test:browser
```

Browser tests need permission to launch Chrome and bind local sockets. They
cover RGB/PNG pixels, flush boundaries, controls, popups, input, and readonly
behavior. They do not replace interoperability testing with a real server.

During initial development, type checking, unit tests, and the production build
were verified. The development sandbox denied listening sockets and prevented
Chrome startup, so browser integration and live Xpra interoperability remain
unverified. Test against a modern server before relying on this client.

## Clean-room development

Xpra behavior comes exclusively from the permitted documentation directory,
`~/projects/xpra/docs`. Existing Xpra client/server source code must not be used
as a reference. See [reference policy and provenance](docs/clean-room.md).
