import { RecordReader, record, recordDefaults } from '../protocol/records.ts';
import { bytes, capability, dict, integer, list, text } from '../protocol/value.ts';
import type { Dict, Packet, Value } from '../protocol/value.ts';
import { challengeResponse } from './auth.ts';
import type { ClientEvent, ClientLimits, ClientOptions, ConnectOptions, ConnectionState, Draw, Geometry, RemoteWindow, SessionSnapshot, Subsystem, SubsystemContext, Transport, WindowSurface } from './types.ts';

const reserved = new Set(['hello', 'challenge', 'connection-close', 'ping', 'ping-echo', 'startup-complete', 'encoding-set', 'display-resized', 'window-create', 'window-metadata', 'window-move-resize', 'window-resized', 'window-destroy', 'window-raise', 'window-draw', 'window-eos']);
const defaults: ClientLimits = { ...recordDefaults, maxWindows: 64, maxDimension: 8192, maxWindowPixels: 16 * 1024 ** 2, maxTotalPixels: 32 * 1024 ** 2, drawQueueBytes: 64 * 1024 ** 2, maxPendingDraws: 2048 };
const clone = <T>(value: T): T => structuredClone(value);
interface Entry { model: RemoteWindow; surface: WindowSurface; queue: Promise<void> }

export class XpraClient {
  readonly uuid = crypto.randomUUID?.() ?? [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
  readonly limits: ClientLimits;
  private listeners = new Set<(event: ClientEvent) => void>();
  private extensions: Subsystem[] = [];
  private cleanups: (() => void)[] = [];
  private entries = new Map<number, Entry>();
  private transport?: Transport;
  private reader?: RecordReader;
  private controller = new AbortController();
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private status: ConnectionState = 'disconnected';
  private reason = '';
  private caps: Dict = {};
  private hello: Dict = {};
  private connection: ConnectOptions = { url: '' };
  private step = 0;
  private authPending = false;
  private ready = false;
  private readonly = false;
  private focused = 0;
  private queuedBytes = 0;
  private pendingDraws = 0;
  private width: number;
  private height: number;

  private options: ClientOptions;
  constructor(options: ClientOptions) {
    this.options = options;
    this.limits = { ...defaults, ...options.limits };
    for (const value of Object.values(this.limits)) integer(value, 1);
    this.width = integer(options.width ?? 1280, 1, 32767);
    this.height = integer(options.height ?? 720, 1, 32767);
  }
  subscribe(listener: (event: ClientEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  snapshot(): SessionSnapshot {
    return clone({ state: this.status, reason: this.reason, readonly: this.readonly, ready: this.ready, focused: this.focused, capabilities: this.caps, windows: [...this.entries.values()].map(e => e.model) });
  }
  register(subsystem: Subsystem) {
    if (this.transport) throw new Error('Register subsystems before connecting');
    if (!subsystem.name || this.extensions.some(s => s.name === subsystem.name)) throw new Error('Duplicate or missing subsystem name');
    for (const name of Object.keys(subsystem.handlers)) {
      if (reserved.has(name) || this.extensions.some(s => Object.hasOwn(s.handlers, name))) throw new Error(`Packet handler already registered: ${name}`);
    }
    this.extensions.push(subsystem);
  }
  private emit(event: ClientEvent) {
    for (const listener of this.listeners) {
      try { listener(clone(event)); } catch (error) { console.error('Client event listener failed', error); }
    }
  }
  private state(status: ConnectionState, reason = '') { this.status = status; this.reason = reason; this.emit({ type: 'state', snapshot: this.snapshot() }); }
  private windowEvent(action: 'create' | 'change' | 'destroy' | 'raise', entry: Entry) { this.emit({ type: 'window', action, window: entry.model }); }
  private diagnostic(message: string, level: 'info' | 'warning' = 'warning') { this.emit({ type: 'diagnostic', level, message }); }
  private timeout(ms: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(new Error('Connection or authentication timed out')), ms);
  }
  private send(packet: Packet) {
    if (!this.transport) throw new Error('Not connected');
    const data = record(packet);
    if (packet[0] === 'hello' && data.length - 8 >= 16 * 1024) throw new Error('Hello exceeds handshake limit');
    if (data.length - 8 > this.limits.recordBytes) throw new Error('Outgoing record too large');
    this.transport.send(data);
  }
  private context(): SubsystemContext {
    const generation = this.generation;
    return {
      send: packet => { if (generation !== this.generation || this.status !== 'connected') throw new Error('Subsystem session is closed'); this.send(packet); },
      snapshot: () => this.snapshot(), signal: this.controller.signal,
    };
  }
  async connect(connection: ConnectOptions): Promise<void> {
    this.disconnect();
    const url = new URL(connection.url);
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Use a WS/WSS URL without embedded credentials or a fragment');
    this.connection = { ...connection };
    this.caps = {}; this.ready = false; this.readonly = Boolean(connection.readonly); this.focused = 0; this.step = 0;
    this.controller = new AbortController();
    const generation = this.generation;
    this.hello = {
      version: '8.0', 'protocol-version': [8, 0], build: { version: '0.1.0' }, uuid: this.uuid,
      username: connection.username ?? '', encoders: ['rencodeplus'], compressors: ['lz4', 'none'], compression_level: 1,
      digest: ['hmac+sha512', 'hmac+sha256'], 'salt-digest': ['hmac+sha512', 'hmac+sha256'],
      chunks: true, ping: true, 'server-features': true, share: Boolean(connection.share), steal: !connection.share, lock: false,
      readonly: this.readonly,
      display: this.displayHello(), window: { enabled: true },
      encoding: { options: ['rgb', 'png'], core: ['rgb24', 'rgb32', 'png'], rgb_formats: ['RGB', 'BGR', 'RGBX', 'BGRX', 'RGBA', 'BGRA'], rgb_lz4: true, transparency: true },
      keyboard: true, modifiers: [], keymap: { layout: 'us', sync: false }, pointer: { double_click: { time: 400, distance: 5 } },
      'metadata.supported': ['title', 'override-redirect', 'decorations', 'transient-for', 'modal', 'iconic', 'size-constraints', 'has-alpha'],
    };
    try {
      for (const extension of this.extensions) for (const [key, value] of Object.entries(extension.capabilities)) {
        if (Object.hasOwn(this.hello, key)) throw new Error(`Capability already registered: ${key}`);
        this.hello[key] = clone(value);
      }
      this.state('connecting'); this.timeout(21_000);
      this.reader = new RecordReader(packet => this.receive(packet), this.limits);
      const transport = this.options.transport(); this.transport = transport;
      await transport.open(url.href, {
        data: data => {
          if (generation !== this.generation) return;
          try { this.reader!.feed(data); } catch (error) { this.fail(error); }
        },
        close: reason => { if (generation === this.generation) this.finish('error', reason || 'Transport closed without a connection-close packet'); },
        error: error => { if (generation === this.generation) this.fail(error); },
      });
      if (generation !== this.generation) return;
      this.state('handshaking'); this.send(['hello', this.hello]);
    } catch (error) { if (generation === this.generation) this.fail(error); }
  }
  private fail(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    try { if (this.transport) this.send(['connection-close', 'protocol error', message.slice(0, 256)]); } catch { /* Transport may already be gone. */ }
    this.finish('error', message);
  }
  private finish(state: 'disconnected' | 'error', reason: string) {
    this.generation++; this.controller.abort(); clearTimeout(this.timer);
    const transport = this.transport; this.transport = undefined; this.reader?.stop(); this.reader = undefined;
    transport?.close();
    for (const cleanup of this.cleanups.splice(0)) { try { cleanup(); } catch { /* Continue disposing the session. */ } }
    for (const entry of this.entries.values()) {
      try { entry.surface.dispose(); } catch { this.diagnostic('Window surface cleanup failed'); }
      this.windowEvent('destroy', entry);
    }
    this.entries.clear(); this.connection.password = undefined; this.hello = {}; this.queuedBytes = 0;
    this.authPending = false; this.ready = false; this.focused = 0; this.pendingDraws = 0; this.caps = {};
    this.state(state, reason);
  }
  disconnect() {
    if (this.transport) { try { this.send(['connection-close', 'client exit']); } catch { /* Best effort orderly close. */ } }
    this.finish('disconnected', '');
  }
  private receive(packet: Packet) {
    const [name] = packet;
    if (name === 'connection-close') {
      text(packet[1]);
      const reason = packet.slice(1, 9).map(v => text(v).slice(0, 256)).join(': ');
      this.finish(/error|failed|timeout/.test(reason) && !reason.includes('idle timeout') ? 'error' : 'disconnected', reason); return;
    }
    if (name === 'challenge') { this.authenticate(packet); return; }
    if (name === 'hello') {
      if (this.status !== 'handshaking' && this.status !== 'authenticating') throw new Error('Unexpected server hello');
      if (this.authPending) throw new Error('Server hello arrived before challenge response');
      this.caps = dict(packet[1]);
      const version = this.caps['protocol-version'] === undefined ? [7, 0] : list(this.caps['protocol-version']);
      if (version.length < 2 || version.length > 4) throw new Error('Invalid protocol version');
      version.forEach(v => integer(v, 0, 65535));
      if (integer(version[0]) > 8 || (version[0] === 8 && version.slice(1).some(v => integer(v) > 0))) throw new Error('Server requires a newer Xpra protocol');
      if (!list(this.caps.encoders).includes('rencodeplus') || !list(this.caps.compressors).includes('none')) throw new Error('Server does not accept required encoder/compressor');
      const display = dict(this.caps.display);
      const size = list(capability(display, 'desktop_size'));
      integer(size[0], 1, 32767); integer(size[1], 1, 32767);
      this.readonly ||= capability(this.caps, 'readonly') === true;
      this.reader!.established = true; clearTimeout(this.timer);
      if (this.connection.password !== undefined && this.step === 0) this.diagnostic('Server accepted the connection without verifying the supplied password');
      this.connection.password = undefined;
      this.state('connected');
      for (const extension of this.extensions) { const cleanup = extension.start?.(this.context()); if (cleanup) this.cleanups.push(cleanup); }
      return;
    }
    if (this.status !== 'connected') throw new Error(`Application packet before handshake: ${name}`);
    switch (name) {
      case 'ping': this.send(['ping-echo', integer(packet[1]), 0, 0, 0, -1, text(packet[3])]); return;
      case 'ping-echo': return;
      case 'startup-complete': this.ready = true; this.state('connected'); return;
      case 'encoding-set': dict(packet[1]); return;
      case 'display-resized': for (const v of packet.slice(1, 5)) integer(v, 1, 32767); return;
      case 'window-create': this.create(packet); return;
      case 'window-draw': this.draw(packet); return;
      case 'window-destroy': {
        const entry = this.entries.get(integer(packet[1], 1, 2 ** 48 - 1));
        if (entry) { entry.surface.dispose(); this.entries.delete(entry.model.id); this.windowEvent('destroy', entry); }
        return;
      }
      case 'window-metadata': {
        const update = dict(packet[2]); this.validateMetadata(update); const entry = this.find(packet[1]);
        if (entry) { Object.assign(entry.model.metadata, update); if (typeof update.iconic === 'boolean') entry.model.minimized = update.iconic; this.windowEvent('change', entry); }
        return;
      }
      case 'window-move-resize': case 'window-resized': {
        const entry = this.find(packet[1]); if (!entry) return;
        const moving = name === 'window-move-resize';
        const start = moving ? 4 : 2;
        const geometry = { x: moving ? integer(packet[2], -2147483648, 2147483647) : entry.model.x, y: moving ? integer(packet[3], -2147483648, 2147483647) : entry.model.y, width: integer(packet[start], 1, this.limits.maxDimension), height: integer(packet[start + 1], 1, this.limits.maxDimension) };
        this.checkGeometry(geometry, entry.model.id);
        entry.model.resizeCounter = integer(packet[start + 2]); Object.assign(entry.model, geometry);
        this.enqueue(entry, () => entry.surface.resize(geometry.width, geometry.height)); this.windowEvent('change', entry); return;
      }
      case 'window-raise': { const entry = this.find(packet[1]); if (entry) this.windowEvent('raise', entry); return; }
      case 'window-eos': return;
      default: {
        const extension = this.extensions.find(s => Object.hasOwn(s.handlers, name));
        if (extension) extension.handlers[name]!(packet, this.context());
        else this.diagnostic(`Ignored unsupported packet: ${name}`);
      }
    }
  }
  private authenticate(packet: Packet) {
    if (!['handshaking', 'authenticating'].includes(this.status) || this.authPending) throw new Error('Unexpected authentication challenge');
    const salt = bytes(packet[1]);
    if (Object.keys(dict(packet[2])).length) throw new Error('Packet encryption is unsupported; use WSS');
    const digest = text(packet[3]), saltDigest = text(packet[4]), prompt = text(packet[5]).slice(0, 256);
    if (![digest, saltDigest].every(d => ['hmac+sha256', 'hmac+sha512'].includes(d))) throw new Error('Unsupported authentication method');
    this.authPending = true; this.step++; this.state('authenticating'); this.timeout(120_000);
    const generation = this.generation;
    void (async () => {
      let password = this.step === 1 ? this.connection.password : undefined;
      this.connection.password = undefined;
      password ??= await this.options.credentials?.({ prompt, step: this.step, signal: this.controller.signal });
      if (generation !== this.generation) return;
      if (password === undefined) throw new Error('Authentication cancelled or no password supplied');
      const response = await challengeResponse(password, salt, digest, saltDigest);
      if (generation !== this.generation) return;
      this.send(['hello', { ...this.hello, ...response }]); this.authPending = false;
    })().catch(error => { if (generation === this.generation) this.fail(error); });
  }
  private find(id: Value | undefined) { return this.entries.get(integer(id, 1, 2 ** 48 - 1)); }
  private validateMetadata(metadata: Dict) {
    if (metadata.title !== undefined) text(metadata.title);
    for (const key of ['override-redirect', 'iconic', 'modal', 'has-alpha']) {
      if (metadata[key] !== undefined && typeof metadata[key] !== 'boolean') throw new Error(`Invalid window metadata: ${key}`);
    }
    if (metadata.decorations !== undefined) integer(metadata.decorations, -1, 2147483647);
    if (metadata['transient-for'] !== undefined) integer(metadata['transient-for'], 0, 2 ** 48 - 1);
    if (metadata['size-constraints'] !== undefined) dict(metadata['size-constraints']);
  }
  private checkGeometry(g: Geometry, replacing?: number) {
    integer(g.width, 1, this.limits.maxDimension); integer(g.height, 1, this.limits.maxDimension);
    integer(g.x, -2147483648, 2147483647); integer(g.y, -2147483648, 2147483647);
    const total = [...this.entries.values()].reduce((sum, e) => sum + (e.model.id === replacing ? 0 : e.model.width * e.model.height), 0);
    if (g.width * g.height > this.limits.maxWindowPixels || total + g.width * g.height > this.limits.maxTotalPixels) throw new Error('Window pixel budget exceeded');
  }
  private create(packet: Packet) {
    const id = integer(packet[1], 1, 2 ** 48 - 1);
    if (this.entries.has(id) || this.entries.size >= this.limits.maxWindows) throw new Error('Duplicate window or window count limit exceeded');
    const model: RemoteWindow = {
      id, x: integer(packet[2], -2147483648, 2147483647), y: integer(packet[3], -2147483648, 2147483647),
      width: integer(packet[4], 1, this.limits.maxDimension), height: integer(packet[5], 1, this.limits.maxDimension),
      metadata: Object.assign(Object.create(null) as Dict, { title: '', 'override-redirect': false, decorations: -1, iconic: false, modal: false, 'size-constraints': {} }, dict(packet[6])), resizeCounter: 0, minimized: false,
    };
    dict(packet[7]); this.validateMetadata(model.metadata); this.checkGeometry(model); model.minimized = model.metadata.iconic === true;
    const entry = { model, surface: this.options.renderer.create(clone(model)), queue: Promise.resolve() };
    this.entries.set(id, entry); this.windowEvent('create', entry);
    if (!model.minimized && !model.metadata['override-redirect']) this.map(entry);
  }
  private map(entry: Entry) {
    const w = entry.model;
    this.send(['window-map', w.id, integer(w.x, -32768, 32767), integer(w.y, -32768, 32767), w.width, w.height, {}, {}]);
  }
  private enqueue(entry: Entry, work: () => void | Promise<void>) {
    const generation = this.generation;
    entry.queue = entry.queue.then(async () => {
      if (generation === this.generation && this.entries.get(entry.model.id) === entry) await work();
    }).catch(error => { if (generation === this.generation) this.fail(error); });
  }
  private draw(packet: Packet) {
    const draw: Draw = { id: integer(packet[1], 1, 2 ** 48 - 1), x: integer(packet[2], -32768, 32767), y: integer(packet[3], -32768, 32767), width: integer(packet[4], 1, this.limits.maxDimension), height: integer(packet[5], 1, this.limits.maxDimension), encoding: text(packet[6]), data: bytes(packet[7]), sequence: integer(packet[8]), rowstride: integer(packet[9], 0, this.limits.decodedBytes), options: dict(packet[10]) };
    const entry = this.entries.get(draw.id);
    if (!entry) { this.send(['window-ack', draw.id, draw.width, draw.height, draw.sequence, -2, 'Unknown window']); return; }
    if (draw.width * draw.height > this.limits.maxWindowPixels) { this.send(['window-ack', draw.id, draw.width, draw.height, draw.sequence, -1, 'Draw pixel budget exceeded']); return; }
    if (this.queuedBytes + draw.data.length > this.limits.drawQueueBytes || this.pendingDraws >= this.limits.maxPendingDraws) throw new Error('Draw queue limit exceeded');
    this.queuedBytes += draw.data.length; this.pendingDraws++;
    const generation = this.generation;
    // Each draw owns its acknowledgement, even if its window is destroyed while queued.
    entry.queue = entry.queue.then(async () => {
      let elapsed = 0, message = '';
      const start = performance.now();
      try {
        if (generation !== this.generation) return;
        if (this.entries.get(draw.id) === entry) { await entry.surface.draw(draw); elapsed = Math.max(1, Math.min(2147483647, Math.round((performance.now() - start) * 1000))); }
      } catch (error) { elapsed = -1; message = (error instanceof Error ? error.message : String(error)).slice(0, 256); }
      finally {
        if (generation === this.generation) {
          this.queuedBytes -= draw.data.length; this.pendingDraws--;
          if (this.entries.get(draw.id) !== entry) { elapsed = 0; message = ''; }
          this.send(['window-ack', draw.id, draw.width, draw.height, draw.sequence, elapsed, message]);
        }
      }
    }).catch(error => { if (generation === this.generation) this.fail(error); });
  }
  private displayHello(): Dict { return { desktop_size: [this.width, this.height], 'monitor-relative': false, 'resize-events': true }; }
  setDisplaySize(width: number, height: number) {
    this.width = integer(width, 1, 32767); this.height = integer(height, 1, 32767);
    if (this.status === 'connected') this.send(['display-configure', { 'desktop-size': [width, height] }]);
  }
  configureWindow(id: number, geometry: Geometry) {
    const entry = this.entries.get(id); if (!entry || !this.canInput() || entry.model.metadata['override-redirect']) return;
    this.checkGeometry(geometry, id); integer(geometry.x, -32768, 32767); integer(geometry.y, -32768, 32767);
    Object.assign(entry.model, geometry);
    this.enqueue(entry, () => entry.surface.resize(geometry.width, geometry.height));
    this.send(['window-configure', id, { geometry: [geometry.x, geometry.y, geometry.width, geometry.height], 'resize-counter': entry.model.resizeCounter }]);
    this.windowEvent('change', entry);
  }
  minimizeWindow(id: number, minimized: boolean) {
    const entry = this.entries.get(id); if (!entry || this.status !== 'connected' || entry.model.metadata['override-redirect']) return;
    entry.model.minimized = minimized;
    if (minimized) { this.send(['window-unmap', id, true, {}]); if (this.focused === id) this.focusWindow(0); }
    else this.map(entry);
    this.windowEvent('change', entry);
  }
  closeWindow(id: number) { if (this.entries.has(id) && this.canInput()) this.send(['window-close', id]); }
  focusWindow(id: number, modifiers: string[] = []) {
    if (id && !this.entries.has(id)) return;
    this.focused = id;
    if (this.canInput()) this.send(['window-focus', id, modifiers]);
    if (id) this.windowEvent('raise', this.entries.get(id)!);
  }
  private canInput(): boolean { return Boolean(this.transport) && this.status === 'connected' && !this.readonly; }
  keyboard(id: number, name: string, pressed: boolean, modifiers: string[], string = '') {
    if (this.canInput() && this.entries.has(id)) this.send(['keyboard-event', id, name, pressed, { modifiers, string, keycode: -1, group: 0 }]);
  }
  pointer(id: number, position: [number, number], properties: Dict, button?: number, pressed = false) {
    if (!this.canInput() || !this.entries.has(id)) return;
    position.forEach(v => integer(v, -65535, 65535));
    this.send(button === undefined ? ['pointer-motion', -1, 0, id, position, properties] : ['pointer-button', -1, 0, id, integer(button, 1, 255), pressed, position, properties]);
  }
  wheel(id: number, button: number, distance: number, position: [number, number], modifiers: string[], buttons: number[]) {
    if (!this.canInput() || !this.entries.has(id)) return;
    integer(button, 4, 7); integer(distance, -2147483648, 2147483647); position.forEach(v => integer(v, -65535, 65535));
    if (capability(this.caps, 'wheel.precise') === true || capability(this.caps, 'wheel.emulation') === true) this.send(['pointer-wheel', id, button, distance, position, modifiers, buttons, {}]);
    else {
      // Browser adapter accumulates fractional deltas for this fallback.
      for (let i = 0; i < Math.min(100, Math.abs(Math.trunc(distance / 1000))); i++) {
        this.pointer(id, position, { modifiers, buttons }, button, true); this.pointer(id, position, { modifiers, buttons }, button, false);
      }
    }
  }
}
