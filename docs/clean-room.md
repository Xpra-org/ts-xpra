# Clean-room reference policy

The only reference for Xpra-specific wire formats and behavior is
`~/projects/xpra/docs`. Do not inspect source files outside that directory,
existing Xpra clients in any language, or source links embedded in the docs.
Ask the project owner when required protocol behavior is missing or ambiguous.
Do not resolve gaps by reverse engineering an existing implementation.

Initial implementation references:

- `Porting/README.md`, `Minimal-Client.md`, `Transports.md`, `Handshake.md`,
  `Authentication.md`, `Features.md`.
- `Network/Protocol.md` (modern Xpra 8.0 specification).
- `Subsystems/Window.md`, `Encoding.md`, `Keyboard.md`, `Pointer.md`,
  `Display.md`, `Ping.md`, `Cursor.md`, `Window-Focus.md`.

Protocol test bytes and authentication vectors are derived from these documents.
The browser fixture encoder is independently written. No existing Xpra
implementation was consulted. Running a server as a black-box interoperability
test is permitted by this project's plan; it must not introduce source-derived
behavior. Record discrepancies and ask for documentation clarifications.

The explicitly approved exception is a small permissively licensed generic LZ4
dependency. `lz4js` 0.2.0 is ISC-licensed according to its distributed metadata.
Its package README and raw-block API were inspected to integrate the library.
The Xpra size prefix and compression negotiation still come from the permitted
Xpra docs. Build/test tools are generic dependencies, not Xpra references.

Implementation defaults where no product policy was specified: outgoing records
are uncompressed; receive compression is LZ4 or none; only HMAC SHA-256/SHA-512
are advertised for authentication; one CSS pixel equals one server pixel;
sharing is opt-in and takeover is the default. Wheel deltas are normalized to
100 pixels or three lines per click and can be tuned in the browser input
adapter. Full international key naming is deferred rather than importing a
keysym table from another Xpra implementation.
