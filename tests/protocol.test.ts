import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode } from '../src/protocol/rencode.ts';
import { RecordReader, record, recordDefaults } from '../src/protocol/records.ts';
import { decompress } from '../src/protocol/lz4.ts';
import { capability, dict } from '../src/protocol/value.ts';
import type { Packet, Value } from '../src/protocol/value.ts';

test('documentation-defined rencodeplus literal representations', () => {
  const vectors: [Value, number[]][] = [
    [0, [0]], [43, [43]], [-1, [70]], [-32, [101]], [true, [67]], [false, [68]], [null, [69]],
    [44, [62,44]], [-33, [62,223]], [128, [63,0,128]], [32768, [64,0,0,128,0]],
    ['é', [130,195,169]], [new Uint8Array([0,255]), [50,47,0,255]], [[], [192]],
    [['ping', 1], [194,132,112,105,110,103,1]], [new Map([[0, 'a']]), [103,0,129,97]],
  ];
  for (const [value, encoded] of vectors) { assert.deepEqual([...encode(value)], encoded); assert.deepEqual(decode(Uint8Array.from(encoded)), value); }
  assert.equal(decode(Uint8Array.from([49,58,97])), 'a'); // long-form short string
  assert.deepEqual(decode(Uint8Array.from([59,1,2,127])), [1,2]);
  assert.deepEqual(decode(Uint8Array.from([60,129,97,1,127])), new Map([['a',1]]));
  assert.equal(decode(Uint8Array.from([66,63,192,0,0])), 1.5);
});
test('rencodeplus full forms, integer precision, and safe maps', () => {
  const values: Value[] = [-(2n ** 63n), 2n ** 63n - 1n, 2n ** 80n, 1.25, 'x'.repeat(100), Array.from({length:64}, (_,i) => i), new Map(Array.from({length:25}, (_,i) => [i, String(i)]))];
  for (const value of values) assert.deepEqual(decode(encode(value)), value);
  const map = dict(decode(encode({ '__proto__': null, constructor: 'safe' })));
  assert.equal(Object.getPrototypeOf(map), null); assert.equal(map.constructor, 'safe');
  assert.throws(() => encode(Number.MAX_SAFE_INTEGER + 1), /bigint/);
});
test('malformed and excessive rencodeplus input is rejected', () => {
  for (const bad of [[45], [127], [62], [129], [49,47], [59,1], [60,1], [69,69], [129,255], [103,67,1]]) assert.throws(() => decode(Uint8Array.from(bad)));
  assert.throws(() => decode(encode([[[1]]]), { maxDepth:1 }));
  assert.throws(() => decode(encode([1,2,3]), { maxItems:3 }));
  assert.throws(() => encode('abc', { maxBytes:2 }));
});
test('flat capabilities take precedence, including nested and empty-key forms', () => {
  assert.equal(capability({ 'a.b': 1, a: { b:2 } }, 'a.b'), 1);
  assert.equal(capability({ a: { 'b.c':3, b:{c:4} } }, 'a.b.c'), 3);
  assert.deepEqual(capability({ encodings: { '': ['png'], core:['png'] } }, 'encodings'), ['png']);
  assert.equal(capability(dict(decode(encode({ wheel: { precise:true } }))), 'wheel.precise'), true);
});
test('record stream handles every byte boundary and multiple records', () => {
  const packets: Packet[] = [['ping',1,2,'id'], ['startup-complete']];
  const stream = Buffer.concat(packets.map(p => record(p)));
  for (let cut = 0; cut <= stream.length; cut++) {
    const seen: Packet[] = []; const reader = new RecordReader(p => seen.push(p));
    reader.feed(stream.subarray(0,cut)); reader.feed(stream.subarray(cut)); assert.deepEqual(seen, packets);
  }
  const seen: Packet[] = []; const reader = new RecordReader(p => seen.push(p));
  for (const b of stream) reader.feed(Uint8Array.of(b)); assert.deepEqual(seen, packets);
});
function raw(index: number, data: Uint8Array) {
  const result = new Uint8Array(data.length+8); result.set([80,0,0,index]); new DataView(result.buffer).setUint32(4,data.length); result.set(data,8); return result;
}
test('raw chunks replace only existing arguments and enforce count/indices', () => {
  const seen: Packet[] = [], reader = new RecordReader(p => seen.push(p));
  reader.feed(raw(1, Uint8Array.of(7))); reader.feed(record(['test', ''])); assert.deepEqual(seen, [['test', Uint8Array.of(7)]]);
  assert.throws(() => { const r = new RecordReader(()=>{}); r.feed(raw(2,Uint8Array.of(1))); r.feed(record(['test',''])); }, /outside packet/);
  assert.throws(() => { const r = new RecordReader(()=>{}); r.feed(raw(1,Uint8Array.of(1))); r.feed(raw(1,Uint8Array.of(2))); }, /chunk sequence/);
  assert.throws(() => new RecordReader(()=>{}).feed(raw(16,Uint8Array.of(1))));
});
test('LZ4 literal and overlapping-match blocks, size and structural validation', () => {
  assert.deepEqual([...decompress(Uint8Array.from([3,0,0,0,0x30,97,98,99]), 10)], [97,98,99]);
  assert.equal(new TextDecoder().decode(decompress(Uint8Array.from([9,0,0,0,0x14,97,1,0]),10)), 'aaaaaaaaa');
  for (const bad of [[1,0,0,0], [2,0,0,0,0x30,1], [4,0,0,0,0,0,0], [4,0,0,0,0,1,0]]) assert.throws(() => decompress(Uint8Array.from(bad),10));
  assert.throws(() => decompress(Uint8Array.from([255,255,255,127]), 100));
  const compressed = Uint8Array.from([80,16,17,0,0,0,0,7,2,0,0,0,0x20,193,128]);
  const seen: Packet[] = []; new RecordReader(p=>seen.push(p)).feed(compressed); assert.deepEqual(seen,[['']]);
});
test('record headers, lengths and terminal parser failure are enforced before allocation', () => {
  for (const header of [[0,16,0,0,0,0,0,1], [80,0,0,0,0,0,0,1], [80,20,0,0,0,0,0,1], [80,16,1,0,0,0,0,1], [80,16,16,0,0,0,0,1], [80,16,0,0,127,0,0,0]]) {
    const reader = new RecordReader(()=>{}); assert.throws(()=>reader.feed(Uint8Array.from(header))); assert.throws(()=>reader.feed(record(['ping'])), /already failed/);
  }
  const reader = new RecordReader(()=>{}, { ...recordDefaults, decodedBytes:1 }); assert.throws(()=>reader.feed(record(['ping'])));
});
