import type { Draw, WindowSurface } from '../core/types.ts';
import { decompress } from '../protocol/lz4.ts';
import { integer, list, text } from '../protocol/value.ts';

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is unavailable');
  return ctx;
}
export function rgbPixels(draw: Draw, maxBytes = 64 * 1024 ** 2): ImageData {
  const format = draw.options.rgb_format === undefined ? (draw.encoding === 'rgb24' ? 'RGB' : 'RGBX') : text(draw.options.rgb_format);
  if (!['RGB', 'BGR', 'RGBA', 'BGRA', 'RGBX', 'BGRX'].includes(format)) throw new Error(`Unsupported pixel format: ${format}`);
  if (draw.options.zstd !== undefined) throw new Error('Zstandard pixels were not negotiated');
  const pixels = draw.options.lz4 ? decompress(draw.data, maxBytes) : draw.data;
  const stride = draw.rowstride;
  if (stride < draw.width * format.length || stride * draw.height !== pixels.length) throw new Error('Invalid RGB rowstride or payload size');
  const output = new Uint8ClampedArray(draw.width * draw.height * 4);
  const blueFirst = format.startsWith('B');
  for (let y = 0; y < draw.height; y++) for (let x = 0; x < draw.width; x++) {
    const s = y * stride + x * format.length, d = (y * draw.width + x) * 4;
    output[d] = pixels[s + (blueFirst ? 2 : 0)]!;
    output[d + 1] = pixels[s + 1]!;
    output[d + 2] = pixels[s + (blueFirst ? 0 : 2)]!;
    output[d + 3] = format.endsWith('A') ? pixels[s + 3]! : 255;
  }
  return new ImageData(output, draw.width, draw.height);
}

export class CanvasSurface implements WindowSurface {
  private backing = document.createElement('canvas');
  private alive = true;
  readonly canvas: HTMLCanvasElement;
  private maxBytes: number;
  constructor(canvas: HTMLCanvasElement, width: number, height: number, maxBytes = 64 * 1024 ** 2) { this.canvas = canvas; this.maxBytes = maxBytes; this.resize(width, height); }
  resize(width: number, height: number) {
    if (!this.alive || this.backing.width === width && this.backing.height === height && this.canvas.width === width && this.canvas.height === height) return;
    const next = document.createElement('canvas'); next.width = width; next.height = height;
    context(next).drawImage(this.backing, 0, 0);
    this.backing.width = this.backing.height = 0; this.backing = next;
    this.canvas.width = width; this.canvas.height = height;
    this.present();
  }
  private present() {
    const ctx = context(this.canvas); ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); ctx.drawImage(this.backing, 0, 0);
  }
  async draw(draw: Draw) {
    if (!this.alive) return;
    const flush = draw.options.flush === undefined ? 0 : integer(draw.options.flush, 0, 65535);
    const paint = draw.options.paint !== false;
    const target = context(this.backing);
    if (draw.encoding === 'png') {
      const data = draw.data;
      if (data.length < 33 || ![137,80,78,71,13,10,26,10].every((b, i) => data[i] === b) || ![73,72,68,82].every((b, i) => data[12 + i] === b)) throw new Error('Invalid PNG header');
      const header = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const width = header.getUint32(16), height = header.getUint32(20);
      if (!width || !height || width > 8192 || height > 8192 || width * height * 4 > this.maxBytes) throw new Error('PNG dimensions exceed budget');
      const scaled = draw.options.scaled_size === undefined ? [draw.width, draw.height] : list(draw.options.scaled_size);
      if (integer(scaled[0], 1, 8192) !== width || integer(scaled[1], 1, 8192) !== height) throw new Error('PNG dimensions do not match draw');
      const bitmap = await createImageBitmap(new Blob([data.slice().buffer], { type: 'image/png' }));
      try {
        if (!this.alive) return;
        if (paint) { target.clearRect(draw.x, draw.y, draw.width, draw.height); target.drawImage(bitmap, draw.x, draw.y, draw.width, draw.height); }
      } finally { bitmap.close(); }
    } else if (draw.encoding === 'rgb24' || draw.encoding === 'rgb32') {
      if (draw.options.scaled_size !== undefined) {
        const size = list(draw.options.scaled_size);
        const width = integer(size[0], 1, 8192), height = integer(size[1], 1, 8192);
        if (width * height * 4 > this.maxBytes) throw new Error('Scaled RGB dimensions exceed budget');
        const pixels = rgbPixels({ ...draw, width, height }, this.maxBytes);
        if (paint) {
          const temp = document.createElement('canvas'); temp.width = width; temp.height = height;
          context(temp).putImageData(pixels, 0, 0); target.clearRect(draw.x, draw.y, draw.width, draw.height);
          target.drawImage(temp, draw.x, draw.y, draw.width, draw.height); temp.width = temp.height = 0;
        }
      } else { const pixels = rgbPixels(draw, this.maxBytes); if (paint) target.putImageData(pixels, draw.x, draw.y); }
    } else throw new Error(`Unsupported picture encoding: ${draw.encoding}`);
    if (this.alive && !flush) this.present();
  }
  dispose() { this.alive = false; this.backing.width = this.backing.height = 0; this.canvas.width = this.canvas.height = 0; }
}
