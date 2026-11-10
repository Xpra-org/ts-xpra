import { decompressBlock } from 'lz4js';

/** Validate block structure before passing untrusted bytes to the dependency. */
export function decompress(data: Uint8Array, maxBytes: number): Uint8Array {
  if (data.length < 4) throw new Error('Missing LZ4 length prefix');
  const size = new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true);
  if (size > maxBytes) throw new Error('LZ4 output limit exceeded');
  let input = 4;
  let output = 0;
  function length(n: number): number {
    if (n === 15) {
      let extra: number;
      do {
        if (input >= data.length) throw new Error('Truncated LZ4 length');
        extra = data[input++]!; n += extra;
        if (n > size) throw new Error('LZ4 length exceeds output');
      } while (extra === 255);
    }
    return n;
  }
  while (input < data.length) {
    const token = data[input++]!;
    const literals = length(token >> 4);
    input += literals; output += literals;
    if (input > data.length || output > size) throw new Error('Invalid LZ4 literals');
    if (input === data.length) break;
    if (input + 2 > data.length) throw new Error('Truncated LZ4 offset');
    const distance = data[input]! | (data[input + 1]! << 8); input += 2;
    if (!distance || distance > output) throw new Error('Invalid LZ4 match offset');
    output += length(token & 15) + 4;
    if (output > size) throw new Error('LZ4 output overflow');
  }
  if (output !== size) throw new Error('LZ4 output size mismatch');
  const result = new Uint8Array(size);
  const actual = decompressBlock(data, result, 4, data.length - 4, 0);
  if (actual !== size) throw new Error('LZ4 decoder size mismatch');
  return result;
}
