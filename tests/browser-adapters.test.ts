import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rgbPixels } from '../src/browser/canvas.ts';
import { keyName, modifiers } from '../src/browser/input.ts';
import { WebSocketTransport } from '../src/browser/websocket.ts';
import type { Draw } from '../src/core/types.ts';

test('RGB channel order, padded rows, alpha, compression, and payload bounds', () => {
  // Only the ImageData container is substituted; conversion code runs unchanged.
  const previous = globalThis.ImageData;
  class ImageDataContainer {
    data: Uint8ClampedArray; width: number; height: number;
    constructor(data: Uint8ClampedArray, width: number, height: number) { this.data=data;this.width=width;this.height=height; }
  }
  globalThis.ImageData = ImageDataContainer as unknown as typeof ImageData;
  try {
    const draw: Draw = {id:1,x:0,y:0,width:1,height:2,encoding:'rgb24',data:Uint8Array.of(30,20,10,99,60,50,40,99),sequence:1,rowstride:4,options:{rgb_format:'BGR'}};
    assert.deepEqual([...rgbPixels(draw).data],[10,20,30,255,40,50,60,255]);
    assert.deepEqual([...rgbPixels({...draw,height:1,data:Uint8Array.of(30,20,10,128),options:{rgb_format:'BGRA'}}).data],[10,20,30,128]);
    assert.deepEqual([...rgbPixels({...draw,height:1,data:Uint8Array.of(30,20,10,0),options:{rgb_format:'BGRX'}}).data],[10,20,30,255]);
    assert.deepEqual([...rgbPixels({...draw,height:1,rowstride:3,data:Uint8Array.of(3,0,0,0,0x30,10,20,30),options:{lz4:1,rgb_format:'RGB'}}).data],[10,20,30,255]);
    assert.throws(()=>rgbPixels({...draw,rowstride:2}));
    assert.throws(()=>rgbPixels({...draw,options:{rgb_format:'r210'}}));
    assert.throws(()=>rgbPixels({...draw,data:new Uint8Array(0)}));
  } finally { globalThis.ImageData=previous; }
});
test('keyboard names and modifier conventions match the documented minimal keymap', () => {
  const event=(key:string,code=key,location=0)=>({key,code,location});
  assert.equal(keyName(event('a')),'a');assert.equal(keyName(event('ArrowLeft')),'Left');assert.equal(keyName(event('Shift','ShiftRight',2)),'Shift_R');
  assert.equal(keyName(event('Enter','NumpadEnter',3)),'KP_Enter');assert.equal(keyName(event(':')),'colon');assert.equal(keyName(event('Dead')),undefined);
  assert.deepEqual(modifiers({shiftKey:true,ctrlKey:false,altKey:false,metaKey:true,getModifierState:(key:string)=>key==='NumLock'}),['shift','mod3','mod2']);
});
test('WebSocket adapter selects binary, validates messages, bounds output, and cancels open', async () => {
  const previous=globalThis.WebSocket;
  let socket: FakeSocket;
  class FakeSocket {
    static OPEN=1;readyState=1;bufferedAmount=0;protocol='binary';url:string;requested:string;closed=false;
    onopen:(()=>void)|null=null;onerror:(()=>void)|null=null;onclose:((event:{code:number;reason:string})=>void)|null=null;onmessage:((event:{data:unknown})=>void)|null=null;
    sent:Uint8Array[]=[];
    constructor(url:string,requested:string){this.url=url;this.requested=requested;socket=this;}
    send(data:Uint8Array){this.sent.push(data);}
    close(){this.closed=true;}
  }
  globalThis.WebSocket=FakeSocket as unknown as typeof WebSocket;
  try {
    const transport=new WebSocketTransport(10),errors:Error[]=[],seen:Uint8Array[]=[];
    const handlers={data:(d:Uint8Array)=>seen.push(d),close:()=>{},error:(e:Error)=>errors.push(e)};
    const opening=transport.open('ws://example/',handlers);assert.equal(socket!.requested,'binary');socket!.onopen!();await opening;
    socket!.onmessage!({data:Uint8Array.of(1,2).buffer});assert.deepEqual([...seen[0]!],[1,2]);
    socket!.onmessage!({data:'text'});assert.equal(errors.length,1);
    transport.send(Uint8Array.of(3));assert.equal(socket!.sent.length,1);socket!.bufferedAmount=10;assert.throws(()=>transport.send(Uint8Array.of(1)),/queue limit/);
    transport.close();assert.equal(socket!.onmessage,null);assert.equal(socket!.closed,true);
    const pending=transport.open('ws://example/',handlers);transport.close();await assert.rejects(pending,/cancelled/);
  } finally {globalThis.WebSocket=previous;}
});
