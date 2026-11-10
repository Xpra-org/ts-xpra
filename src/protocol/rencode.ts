import type { Value } from './value.ts';

const utf8 = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export interface CodecLimits { maxBytes: number; maxDepth: number; maxItems: number }
const defaults: CodecLimits = { maxBytes: 64 * 1024 ** 2, maxDepth: 64, maxItems: 100_000 };

export function encode(value: Value, limits: Partial<CodecLimits> = {}): Uint8Array {
  const bound = { ...defaults, ...limits };
  let buffer = new Uint8Array(Math.min(1024, bound.maxBytes));
  let offset = 0;
  let items = 0;
  function room(n: number) {
    if (offset + n > bound.maxBytes) throw new Error('Encoded value too large');
    if (offset + n > buffer.length) {
      const next = new Uint8Array(Math.min(bound.maxBytes, Math.max(offset + n, buffer.length * 2)));
      next.set(buffer); buffer = next;
    }
  }
  function byte(n: number) { room(1); buffer[offset++] = n; }
  function raw(data: Uint8Array) { room(data.length); buffer.set(data, offset); offset += data.length; }
  function number(n: bigint) {
    if (n >= 0n && n <= 43n) return byte(Number(n));
    if (n < 0n && n >= -32n) return byte(69 - Number(n));
    const sizes = [1, 2, 4, 8];
    const index = sizes.findIndex(size => n >= -(1n << BigInt(size * 8 - 1)) && n < (1n << BigInt(size * 8 - 1)));
    if (index < 0) {
      const s = n.toString();
      if (s.length < 18 || s.length > 63) throw new Error('Integer outside rencodeplus range');
      byte(61); raw(utf8.encode(s)); byte(127); return;
    }
    byte(62 + index);
    const size = sizes[index]!;
    const u = BigInt.asUintN(size * 8, n);
    for (let i = size - 1; i >= 0; i--) byte(Number((u >> BigInt(i * 8)) & 255n));
  }
  function write(v: Value, depth: number) {
    if (++items > bound.maxItems || depth > bound.maxDepth) throw new Error('Value complexity limit exceeded');
    if (v === null) return byte(69);
    if (typeof v === 'boolean') return byte(v ? 67 : 68);
    if (typeof v === 'bigint') return number(v);
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new Error('Non-finite number');
      if (Number.isInteger(v)) {
        if (!Number.isSafeInteger(v)) throw new Error('Use bigint for large integers');
        return number(BigInt(v));
      }
      byte(44); room(8); new DataView(buffer.buffer).setFloat64(offset, v); offset += 8; return;
    }
    if (typeof v === 'string' || v instanceof Uint8Array) {
      const data = typeof v === 'string' ? utf8.encode(v) : v;
      if (typeof v === 'string' && data.length < 64) byte(128 + data.length);
      else raw(utf8.encode(`${data.length}${typeof v === 'string' ? ':' : '/'}`));
      raw(data); return;
    }
    if (Array.isArray(v)) {
      byte(v.length < 64 ? 192 + v.length : 59);
      for (const item of v) write(item, depth + 1);
      if (v.length >= 64) byte(127);
      return;
    }
    const pairs = v instanceof Map ? [...v.entries()] : Object.entries(v);
    byte(pairs.length < 25 ? 102 + pairs.length : 60);
    for (const [key, item] of pairs) { write(key, depth + 1); write(item, depth + 1); }
    if (pairs.length >= 25) byte(127);
  }
  write(value, 0);
  return buffer.slice(0, offset);
}

export function decode(data: Uint8Array, limits: Partial<CodecLimits> = {}): Value {
  const bound = { ...defaults, ...limits };
  if (data.length > bound.maxBytes) throw new Error('Encoded value too large');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  let items = 0;
  function take(n: number): Uint8Array {
    if (!Number.isSafeInteger(n) || n < 0 || offset + n > data.length) throw new Error('Truncated rencodeplus value');
    const result = data.subarray(offset, offset + n); offset += n; return result;
  }
  function narrow(n: bigint): number | bigint { return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n; }
  function read(depth: number): Value {
    if (++items > bound.maxItems || depth > bound.maxDepth) throw new Error('Value complexity limit exceeded');
    const code = take(1)[0]!;
    if (code < 44) return code;
    if (code >= 70 && code <= 101) return 69 - code;
    if (code === 67) return true;
    if (code === 68) return false;
    if (code === 69) return null;
    if (code === 44 || code === 66) {
      const start = offset; take(code === 44 ? 8 : 4);
      const n = code === 44 ? view.getFloat64(start) : view.getFloat32(start);
      if (!Number.isFinite(n)) throw new Error('Non-finite number');
      return n;
    }
    if (code >= 62 && code <= 65) {
      const size = 2 ** (code - 62);
      let n = 0n;
      for (const b of take(size)) n = (n << 8n) | BigInt(b);
      return narrow(BigInt.asIntN(size * 8, n));
    }
    if (code === 61) {
      const start = offset;
      while (offset < data.length && data[offset] !== 127 && offset - start <= 63) offset++;
      const s = decoder.decode(data.subarray(start, offset));
      if (data[offset++] !== 127 || s.length < 18 || s.length > 63 || !/^-?\d+$/.test(s)) throw new Error('Invalid decimal integer');
      return narrow(BigInt(s));
    }
    if (code >= 128 && code <= 191) return decoder.decode(take(code - 128));
    if (code >= 48 && code <= 57) {
      let length = code - 48;
      let digits = 1;
      while (data[offset]! >= 48 && data[offset]! <= 57) {
        if (++digits > 10) throw new Error('Invalid string length');
        length = length * 10 + take(1)[0]! - 48;
      }
      const separator = take(1)[0];
      if (separator !== 58 && separator !== 47) throw new Error('Invalid string separator');
      const value = take(length);
      return separator === 58 ? decoder.decode(value) : value.slice();
    }
    if (code === 59 || code >= 192) {
      const result: Value[] = [];
      const count = code === 59 ? Infinity : code - 192;
      while (result.length < count) {
        if (code === 59 && data[offset] === 127) { offset++; break; }
        result.push(read(depth + 1));
      }
      return result;
    }
    if (code === 60 || (code >= 102 && code <= 126)) {
      const result = new Map<string | number | bigint, Value>();
      const count = code === 60 ? Infinity : code - 102;
      for (let i = 0; i < count; i++) {
        if (code === 60 && data[offset] === 127) { offset++; break; }
        const key = read(depth + 1);
        if (typeof key !== 'string' && typeof key !== 'bigint' && !(typeof key === 'number' && Number.isSafeInteger(key))) throw new Error('Invalid map key');
        if (result.has(key)) throw new Error('Duplicate map key');
        result.set(key, read(depth + 1));
      }
      return result;
    }
    throw new Error(`Invalid rencodeplus code ${code}`);
  }
  const result = read(0);
  if (offset !== data.length) throw new Error('Trailing rencodeplus bytes');
  return result;
}
