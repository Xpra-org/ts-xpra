import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { deflateSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { RecordReader } from '../../src/protocol/records.ts';
import type { Packet, Value } from '../../src/protocol/value.ts';

// Independently written fixture encoder. No Xpra implementation is used as a reference.
function wire(value: Value): Buffer {
  if (typeof value === 'string') { const b=Buffer.from(value);return Buffer.concat([b.length<64?Buffer.from([128+b.length]):Buffer.from(`${b.length}:`),b]); }
  if (value instanceof Uint8Array) return Buffer.concat([Buffer.from(`${value.length}/`),value]);
  if (typeof value === 'boolean') return Buffer.from([value?67:68]);
  if (typeof value === 'number') { const b=Buffer.alloc(5);b[0]=64;b.writeInt32BE(value,1);return b; }
  if (Array.isArray(value)) return Buffer.concat([Buffer.from([59]),...value.map(wire),Buffer.from([127])]);
  if (value && typeof value==='object') return Buffer.concat([Buffer.from([60]),...Object.entries(value).flatMap(([k,v])=>[wire(k),wire(v)]),Buffer.from([127])]);
  throw new Error('Unsupported fixture value');
}
function packet(value: Packet) { const body=wire(value),header=Buffer.from([80,16,0,0,0,0,0,0]);header.writeUInt32BE(body.length,4);return Buffer.concat([header,body]); }
function png(): Buffer {
  function chunk(name:string, data:Buffer) {
    const type=Buffer.from(name),payload=Buffer.concat([type,data]);let crc=0xffffffff;
    for (const b of payload) {crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    const size=Buffer.alloc(4),checksum=Buffer.alloc(4);size.writeUInt32BE(data.length);checksum.writeUInt32BE((crc^0xffffffff)>>>0);
    return Buffer.concat([size,payload,checksum]);
  }
  const ihdr=Buffer.from([0,0,0,1,0,0,0,1,8,6,0,0,0]);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.from([0,0,255,0,255]))),chunk('IEND',Buffer.alloc(0))]);
}
async function fixture(readonly=false) {
  const vite=await createServer({configFile:false,base:'/client/',server:{host:'127.0.0.1',port:0},logLevel:'error'});try { await vite.listen(); } catch (error) { await vite.close(); throw error; }
  const port=(vite.httpServer!.address() as {port:number}).port;
  const server=new WebSocketServer({host:'127.0.0.1',port:0,handleProtocols:protocols=>protocols.has('binary')?'binary':false});await once(server,'listening');
  const wsPort=(server.address() as {port:number}).port;
  const received:Packet[]=[];let socket:WebSocket|undefined;
  const send=(p:Packet)=>socket!.send(packet(p));
  server.on('connection',s=>{
    socket=s;const reader=new RecordReader(p=>{
      received.push(p);
      if(p[0]==='hello') {
        send(['hello',{'protocol-version':[8,0],encoders:['rencodeplus'],compressors:['none'],display:{desktop_size:[1280,720]},readonly,'wheel.emulation':true}]);
        send(['window-create',100,50,80,240,160,{title:'Test terminal'},{}]);send(['startup-complete']);
        send(['window-draw',100,0,0,1,1,'rgb24',Uint8Array.of(255,0,0),1,3,{}]);
      }
    });reader.established=true;s.on('message',data=>reader.feed(new Uint8Array(data as Buffer)));
  });
  const executablePath=process.env.CHROME_BIN ?? ['/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync);
  if (!executablePath) throw new Error('Set CHROME_BIN to a current Chrome/Chromium executable');
  const browser=await puppeteer.launch({executablePath,headless:true,pipe:true,args:['--no-sandbox','--disable-dev-shm-usage']}).catch(async error=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await vite.close();throw error;});
  const page=await browser.newPage();await page.setViewport({width:1280,height:900});
  await page.goto(`http://127.0.0.1:${port}/client/`);
  await page.locator('#endpoint').fill(`ws://127.0.0.1:${wsPort}/`);await page.click('#connect');await page.waitForSelector('.remote-window canvas');
  return {page,received,send,async close(){await browser.close();for(const client of server.clients)client.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));await vite.close();}};
}
const wait = async (condition:()=>boolean) => { for(let i=0;i<100;i++){if(condition())return;await new Promise(r=>setTimeout(r,20));}assert.fail('Timed out waiting for fixture packets'); };
test('browser workspace: RGB/PNG, batching, input, popups, window controls, and disconnect',async t=>{
  const f=await fixture();t.after(()=>f.close());const {page,received,send}=f;
  await wait(()=>received.some(p=>p[0]==='window-ack'&&p[4]===1));
  assert.deepEqual(await page.$eval('canvas',c=>Array.from(c.getContext('2d')!.getImageData(0,0,1,1).data)),[255,0,0,255]);
  send(['window-draw',100,0,0,1,1,'png',png(),2,0,{flush:1}]);await wait(()=>received.some(p=>p[0]==='window-ack'&&p[4]===2));
  assert.deepEqual(await page.$eval('canvas',c=>Array.from(c.getContext('2d')!.getImageData(0,0,1,1).data)),[255,0,0,255]);
  send(['window-draw',100,1,0,1,1,'rgb32',Uint8Array.of(255,0,0,255),3,4,{rgb_format:'BGRA',flush:0}]);await wait(()=>received.some(p=>p[0]==='window-ack'&&p[4]===3));
  assert.deepEqual(await page.$eval('canvas',c=>Array.from(c.getContext('2d')!.getImageData(0,0,2,1).data)),[0,255,0,255,0,0,255,255]);
  await page.click('canvas');await page.keyboard.type('a');await page.keyboard.press('ArrowLeft');await page.mouse.wheel({deltaY:100});
  await wait(()=>received.some(p=>p[0]==='keyboard-event'&&p[2]==='Left')&&received.some(p=>p[0]==='pointer-wheel'));
  await page.locator('[aria-label="Minimize window"]').click();assert.equal(await page.$eval('.remote-window',e=>(e as HTMLElement).hidden),true);
  await page.click('.window-task');assert.equal(await page.$eval('.remote-window',e=>(e as HTMLElement).hidden),false);
  const title=await page.$('.window-title'),box=await title!.boundingBox();await page.mouse.move(box!.x+15,box!.y+15);await page.mouse.down();await page.mouse.move(box!.x+55,box!.y+35);await page.mouse.up();
  await wait(()=>received.some(p=>p[0]==='window-configure'));
  send(['window-create',101,90,120,50,40,{'override-redirect':true,title:'Popup'},{}]);await page.waitForSelector('[data-wid="101"]');
  assert.equal(received.some(p=>p[0]==='window-map'&&p[1]===101),false);
  assert.equal(await page.$eval('[data-wid="101"] .window-chrome',e=>getComputedStyle(e).display),'none');
  send(['window-draw',999,0,0,1,1,'rgb24',Uint8Array.of(0,0,0),4,3,{}]);await wait(()=>received.some(p=>p[0]==='window-ack'&&p[4]===4&&p[5]===-2));
  await page.click('[data-wid="100"] [aria-label="Close window"]');await wait(()=>received.some(p=>p[0]==='window-close'));
  assert.ok(await page.$('[data-wid="100"]'));send(['window-destroy',100]);await page.waitForSelector('[data-wid="100"]',{hidden:true});
  await page.click('#disconnect');await page.waitForSelector('#connection',{visible:true});assert.equal(await page.$('.remote-window'),null);
});
test('browser readonly session suppresses remote keyboard and pointer input',async t=>{
  const f=await fixture(true);t.after(()=>f.close());await f.page.click('canvas');await f.page.keyboard.type('abc');await f.page.mouse.wheel({deltaY:100});
  await new Promise(r=>setTimeout(r,100));assert.equal(f.received.some(p=>['keyboard-event','pointer-button','pointer-motion','pointer-wheel'].includes(p[0])),false);
});
