import { decode, encode } from './rencode.ts';
import { decompress } from './lz4.ts';
import type { Packet } from './value.ts';

export interface RecordLimits { recordBytes: number; decodedBytes: number; queuedBytes: number }
export const recordDefaults: RecordLimits = { recordBytes: 16 * 1024 ** 2, decodedBytes: 64 * 1024 ** 2, queuedBytes: 64 * 1024 ** 2 };
export function record(packet: Packet): Uint8Array {
  const payload = encode(packet);
  const result = new Uint8Array(8 + payload.length);
  result.set([80, 16, 0, 0]);
  new DataView(result.buffer).setUint32(4, payload.length);
  result.set(payload, 8); return result;
}

export class RecordReader {
  private header = new Uint8Array(8);
  private headerLength = 0;
  private payload?: Uint8Array;
  private payloadLength = 0;
  private chunks = new Map<number, Uint8Array>();
  private chunkBytes = 0;
  private failed = false;
  private stopped = false;
  established = false;
  private receive: (packet: Packet) => void;
  readonly limits: RecordLimits;
  constructor(receive: (packet: Packet) => void, limits: RecordLimits = recordDefaults) { this.receive = receive; this.limits = limits; }
  stop() { this.stopped = true; this.payload = undefined; this.chunks.clear(); }
  feed(data: Uint8Array) {
    if (this.stopped) return;
    if (this.failed) throw new Error('Record stream already failed');
    try {
      let offset = 0;
      while (offset < data.length && !this.stopped) {
        if (this.headerLength < 8) {
          const n = Math.min(8 - this.headerLength, data.length - offset);
          this.header.set(data.subarray(offset, offset + n), this.headerLength);
          this.headerLength += n; offset += n;
          if (this.headerLength < 8) continue;
          const [magic, flags, compression, index] = this.header;
          const length = new DataView(this.header.buffer).getUint32(4);
          const main = index === 0;
          if (magic !== 80 || index! > 15 || (main ? flags !== 16 && flags !== 24 : flags !== 0)) throw new Error('Invalid record header or unsupported encoder');
          if (compression !== 0 && ((compression! & 0xf0) !== 16 || (compression! & 15) === 0)) throw new Error('Unsupported record compression');
          const limit = this.established ? this.limits.recordBytes : 16 * 1024;
          if (!length || length > limit || length + this.chunkBytes > this.limits.queuedBytes) throw new Error('Record length limit exceeded');
          this.payload = new Uint8Array(length);
        }
        const payload = this.payload!;
        const n = Math.min(payload.length - this.payloadLength, data.length - offset);
        payload.set(data.subarray(offset, offset + n), this.payloadLength);
        this.payloadLength += n; offset += n;
        if (this.payloadLength !== payload.length) continue;
        const index = this.header[3]!;
        const content = this.header[2] ? decompress(payload, this.limits.decodedBytes) : payload;
        if (content.length > this.limits.decodedBytes || content.length + this.chunkBytes > this.limits.queuedBytes) throw new Error('Decoded packet limit exceeded');
        this.headerLength = 0; this.payloadLength = 0; this.payload = undefined;
        if (index) {
          if (this.chunks.size >= 3 || this.chunks.has(index)) throw new Error('Invalid raw chunk sequence');
          this.chunks.set(index, content); this.chunkBytes += content.length;
          continue;
        }
        const packet = decode(content, { maxBytes: this.limits.decodedBytes });
        if (!Array.isArray(packet) || typeof packet[0] !== 'string') throw new Error('Expected a packet list with a string type');
        for (const [position, chunk] of this.chunks) {
          if (position >= packet.length) throw new Error('Raw chunk index outside packet');
          packet[position] = chunk;
        }
        this.chunks.clear(); this.chunkBytes = 0;
        this.receive(packet as Packet);
      }
    } catch (error) { this.failed = true; this.payload = undefined; this.chunks.clear(); throw error; }
  }
}
