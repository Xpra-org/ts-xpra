# Architecture and extension guide

`src/core/index.ts` is the public source entry point. Forks import it directly;
this repository builds a static application, rather than publishing a separate
npm library. Public types include `ClientOptions`, `Transport`, `Renderer`,
`WindowSurface`, `CredentialProvider`, `SessionSnapshot`, `ClientEvent`, and
`Subsystem`.

## Boundaries

| Layer | Responsibility |
| --- | --- |
| `src/protocol` | Wire values, rencodeplus, record framing, raw chunks, LZ4 |
| `src/core` | Session lifecycle, authentication, capabilities, windows, commands |
| `src/browser` | WebSocket transport, canvas rendering, DOM input translation |
| `src/ui` | Window chrome, layout, forms, theme, interactions |

The core has no DOM imports. It receives a transport factory and renderer, and
optionally an asynchronous credential provider. Core snapshots and emitted
events are detached copies, so a skin cannot mutate session state. Subscribe
returns an unsubscribe function. Commands include `connect`, `disconnect`,
`setDisplaySize`, `configureWindow`, `minimizeWindow`, `closeWindow`,
`focusWindow`, `keyboard`, `pointer`, and `wheel`.

`connect()` opens the transport and sends the first hello. It does **not** wait
for authentication or startup completion; observe connection state and `ready`
through subscriptions. A disconnected or failed connection releases session
resources. The UUID persists for the life of the client instance; reconnect is
an explicit new `connect()` call. There is no storage of connection credentials.

## Replacing the skin

Implement `Renderer.create(window)` to allocate a surface for a remote window:

```ts
import { XpraClient, type Renderer } from '../src/core/index.ts';
import { CanvasSurface } from '../src/browser/canvas.ts';
import { WebSocketTransport } from '../src/browser/websocket.ts';

const renderer: Renderer = {
  create(window) {
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    const surface = new CanvasSurface(canvas, window.width, window.height);
    return {
      resize: (width, height) => surface.resize(width, height),
      draw: draw => surface.draw(draw),
      dispose() { surface.dispose(); canvas.remove(); },
    };
  },
};
const client = new XpraClient({
  transport: () => new WebSocketTransport(), renderer,
});
client.subscribe(event => {
  if (event.type === 'window') {
    // Update your own chrome, tabs, or layout using event.window.
  }
});
await client.connect({ url: 'wss://example.test/' });
```

A surface's draw promise must resolve only after decoding and the required
presentation have completed. The core serializes draws and resizes per window,
and owns every acknowledgement. Throw on a decode error; the core sends the
documented failure acknowledgement. `dispose()` must prevent pending image
decodes from painting later. Never acknowledge draws from the skin.

Use `bindInput(canvas, () => latestWindowSnapshot, client)` for the existing
browser input translation. Call its returned cleanup function when removing
the canvas. Or implement input translation with the typed client commands.
Only the canvas captures remote keyboard events; connection controls retain
normal browser behavior. Server readonly mode suppresses outgoing input.

CSS custom properties in `src/ui/theme.css` control the default skin's palette.
Changing appearance does not require modifying transport or session code.

## Adding a subsystem

Register before connecting. A subsystem contributes an independent capability
map and handlers; built-in handlers and contributed top-level keys cannot be
overridden. Use a namespaced capability and negotiate it with a matching peer:

```ts
client.register({
  name: 'example',
  capabilities: { example: { enabled: true } },
  handlers: {
    'example-status': (packet, context) => {
      // Validate documented fields before use. Ignore unknown trailing fields.
      console.log(packet.slice(1), context.snapshot().state);
    },
  },
  start(context) {
    // Called after server hello; context.signal aborts on disconnect.
    // context.send(...) is restricted to this established session.
    const timer = setInterval(() => {
      // Only send extension packets if the server negotiated your extension.
    }, 1000);
    return () => clearInterval(timer);
  },
});
```

Handlers and lifecycle hooks are synchronous. Start asynchronous work explicitly
and cancel it using the session signal; do not let promises reject unobserved.
Old contexts cannot send into a new connection. For new codecs or receive
formats, update the renderer and its advertised capabilities together; current
built-in window/encoding capabilities are intentionally protected from plugins.

## Limits and ordering

Defaults are 16 MiB per established record, 64 MiB decompressed/queued bytes,
64 windows, 8192 pixels per edge, 16 million pixels per window and 32 million
across all windows. Before hello, the record payload limit is 16 KiB.
At most 2048 draws may be pending, including draws with empty payloads.
The codec also bounds nesting and collection items. Limits may be reduced or
raised using `ClientOptions.limits`; these are local limits, not claims that
an unimplemented protocol feature is supported.

Decoded windows use separate backing and visible canvases. Batched draws update
the backing canvas and present at a zero/absent flush value. Pings are handled
synchronously when packets arrive, without waiting for per-window image decode.
Queued work is scoped to the connection generation; destruction and reconnect
cannot revive old surfaces or send old acknowledgements to a new server.
