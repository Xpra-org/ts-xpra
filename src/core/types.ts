import type { Dict, Packet } from '../protocol/value.ts';
import type { RecordLimits } from '../protocol/records.ts';

export interface Transport {
  open(url: string, handlers: { data(data: Uint8Array): void; close(reason: string): void; error(error: Error): void }): Promise<void>;
  send(data: Uint8Array): void;
  close(): void;
}
export interface Geometry { x: number; y: number; width: number; height: number }
export interface RemoteWindow extends Geometry {
  id: number;
  metadata: Dict;
  resizeCounter: number;
  minimized: boolean;
}
export interface Draw {
  id: number; x: number; y: number; width: number; height: number;
  encoding: string; data: Uint8Array; sequence: number; rowstride: number; options: Dict;
}
export interface WindowSurface {
  resize(width: number, height: number): void;
  draw(draw: Draw): Promise<void>;
  dispose(): void;
}
export interface Renderer { create(window: RemoteWindow): WindowSurface }
export interface CredentialRequest { prompt: string; step: number; signal: AbortSignal }
export type CredentialProvider = (request: CredentialRequest) => Promise<string | undefined>;
export type ConnectionState = 'disconnected' | 'connecting' | 'handshaking' | 'authenticating' | 'connected' | 'error';
export interface SessionSnapshot {
  state: ConnectionState; reason: string; readonly: boolean; ready: boolean;
  focused: number; capabilities: Dict; windows: RemoteWindow[];
}
export type ClientEvent =
  | { type: 'state'; snapshot: SessionSnapshot }
  | { type: 'window'; action: 'create' | 'change' | 'destroy' | 'raise'; window: RemoteWindow }
  | { type: 'diagnostic'; level: 'info' | 'warning'; message: string };
export interface ClientLimits extends RecordLimits {
  maxWindows: number; maxDimension: number; maxWindowPixels: number; maxTotalPixels: number; drawQueueBytes: number; maxPendingDraws: number;
}
export interface ConnectOptions { url: string; username?: string; password?: string; share?: boolean; readonly?: boolean }
export interface ClientOptions {
  transport: () => Transport;
  renderer: Renderer;
  credentials?: CredentialProvider;
  limits?: Partial<ClientLimits>;
  width?: number; height?: number;
}
export interface SubsystemContext {
  send(packet: Packet): void;
  snapshot(): SessionSnapshot;
  signal: AbortSignal;
}
export interface Subsystem {
  name: string;
  capabilities: Dict;
  handlers: Record<string, (packet: Packet, context: SubsystemContext) => void>;
  start?(context: SubsystemContext): void | (() => void);
}
