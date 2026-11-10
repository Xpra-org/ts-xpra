declare module 'lz4js' {
  export function decompressBlock(src: Uint8Array, dst: Uint8Array, sIndex: number, sLength: number, dIndex: number): number;
}
