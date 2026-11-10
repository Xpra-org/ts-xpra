import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XpraClient } from '../src/core/client.ts';
import type { ClientOptions, Draw, Transport } from '../src/core/types.ts';
import type { Packet } from '../src/protocol/value.ts';
import { dict } from '../src/protocol/value.ts';
import { record, RecordReader } from '../src/protocol/records.ts';

const serverHello: Packet = ['hello', { 'protocol-version':[8,0], encoders:['rencodeplus'], compressors:['none','lz4'], display:{desktop_size:[1280,720]} }];
const create: Packet = ['window-create',100,10,50,100,80,{title:'Test'},{}];
const draw = (id: number, sequence = 1): Packet => ['window-draw',id,0,0,1,1,'rgb24',Uint8Array.of(255,0,0),sequence,3,{}];
class FakeTransport implements Transport {
  packets: Packet[] = [];
  reader = new RecordReader(p=>this.packets.push(p));
  handlers?: Parameters<Transport['open']>[1];
  async open(_url: string, handlers: Parameters<Transport['open']>[1]) { this.handlers = handlers; }
  send(data: Uint8Array) { this.reader.feed(data); }
  close() {}
  receive(packet: Packet) { this.handlers!.data(record(packet)); }
}
const tick = () => new Promise(resolve=>setTimeout(resolve,10));
function setup(extra: Partial<ClientOptions> = {}) {
  const transports: FakeTransport[] = [], draws: Draw[] = [];
  const client = new XpraClient({ transport:()=>{const t=new FakeTransport();transports.push(t);return t;}, renderer:{create:()=>({resize(){},dispose(){},async draw(d){draws.push(d);}})}, ...extra });
  return { client, transports, draws };
}
test('hello, windows, input, resize counters, readonly, and shutdown', async t => {
  const {client,transports} = setup(); t.after(()=>client.disconnect());
  await client.connect({url:'ws://localhost/'}); const transport=transports[0]!;
  const hello=dict(transport.packets[0]![1]); assert.equal(hello.steal,true); assert.equal(hello.version,'8.0'); assert.equal(hello.share,false);
  transport.receive(serverHello); transport.receive(create);
  assert.equal(transport.packets.at(-1)![0],'window-map');
  transport.receive(['window-resized',100,120,90,42]);
  client.configureWindow(100,{x:20,y:50,width:130,height:90});
  assert.equal(dict(transport.packets.at(-1)![2])['resize-counter'],42);
  client.keyboard(100,'a',true,['shift'],'A'); assert.equal(transport.packets.at(-1)![0],'keyboard-event');
  client.closeWindow(100); assert.equal(client.snapshot().windows.length,1);
  transport.receive(['window-destroy',100]); assert.equal(client.snapshot().windows.length,0);
  transport.receive(['connection-close','done']); assert.equal(client.snapshot().state,'disconnected');
  await client.connect({url:'ws://localhost/',share:true});
  const second=transports[1]!; assert.equal(dict(second.packets[0]![1]).uuid,hello.uuid); assert.equal(dict(second.packets[0]![1]).steal,false);
  second.receive(['hello',{...dict(serverHello[1]),readonly:true}]); second.receive(create);
  const count=second.packets.length; client.keyboard(100,'a',true,[]); client.closeWindow(100); assert.equal(second.packets.length,count);
});
test('draws stay ordered while ping replies bypass decoding; destruction still acknowledges', async t => {
  let complete!: ()=>void; const seen:number[]=[];
  const {client,transports} = setup({renderer:{create:()=>({resize(){},dispose(){},async draw(d){seen.push(d.sequence);if(d.sequence===1) await new Promise<void>(r=>complete=r);}})}});
  t.after(()=>client.disconnect()); await client.connect({url:'ws://localhost/'}); const transport=transports[0]!;
  transport.receive(serverHello);transport.receive(create);transport.receive(draw(100,1));transport.receive(draw(100,2));await tick();
  transport.receive(['ping',123,456,'source']); assert.deepEqual(transport.packets.at(-1),['ping-echo',123,0,0,0,-1,'source']); assert.deepEqual(seen,[1]);
  transport.receive(['window-destroy',100]); complete(); await tick();
  const acks=transport.packets.filter(p=>p[0]==='window-ack'); assert.equal(acks.length,2); assert.deepEqual(acks.map(p=>p[5]),[0,0]);
  transport.receive(draw(999)); assert.equal(transport.packets.at(-1)![5],-2);
});
test('decode failures acknowledge once, and stale work cannot write to a new connection', async t => {
  let complete!: ()=>void;
  const {client,transports} = setup({renderer:{create:()=>({resize(){},dispose(){},async draw(d){if(d.sequence===1)throw new Error('decode failure');await new Promise<void>(r=>complete=r);}})}});
  t.after(()=>client.disconnect());await client.connect({url:'ws://localhost/'});const first=transports[0]!;first.receive(serverHello);first.receive(create);first.receive(draw(100));await tick();
  assert.equal(first.packets.at(-1)![5],-1);
  first.receive(draw(100,2));await tick();await client.connect({url:'ws://localhost/'});const second=transports[1]!;second.receive(serverHello);complete();await tick();
  assert.equal(second.packets.filter(p=>p[0]==='window-ack').length,0);
});
test('unexpected application packets and duplicate windows fail cleanly', async t => {
  const {client,transports}=setup();t.after(()=>client.disconnect());await client.connect({url:'ws://localhost/'});
  transports[0]!.receive(create);assert.equal(client.snapshot().state,'error');
  await client.connect({url:'ws://localhost/'});const transport=transports[1]!;transport.receive(serverHello);transport.receive(create);transport.receive(create);assert.equal(client.snapshot().state,'error');
});
test('extension conflicts, dispatch, and cleanup', async t => {
  const {client,transports}=setup(); t.after(()=>client.disconnect()); let called=0,cleaned=false;
  client.register({name:'test',capabilities:{test:{enabled:true}},handlers:{'test-event':()=>{called++;}},start:()=>()=>{cleaned=true;}});
  assert.throws(()=>client.register({name:'test',capabilities:{},handlers:{}}));
  assert.throws(()=>client.register({name:'bad',capabilities:{},handlers:{ping:()=>{}}}));
  await client.connect({url:'ws://localhost/'});const transport=transports[0]!;transport.receive(serverHello);transport.receive(['test-event']);assert.equal(called,1);client.disconnect();assert.equal(cleaned,true);
});
test('repeated challenges use fresh credentials and complete hello capabilities', async t => {
  const prompts:string[]=[];const {client,transports}=setup({credentials:async request=>{prompts.push(request.prompt);return 'second';}});t.after(()=>client.disconnect());
  await client.connect({url:'ws://localhost/',password:'first'});const transport=transports[0]!;
  const challenge:Packet=['challenge',new Uint8Array(64),{},'hmac+sha256','hmac+sha256','Password'];
  transport.receive(challenge);await tick();assert.equal(transport.packets.length,2);assert.ok(dict(transport.packets[1]![1]).window);
  transport.receive(['challenge',challenge[1]!,{},'hmac+sha256','hmac+sha256','One-time password']);await tick();assert.deepEqual(prompts,['One-time password']);transport.receive(serverHello);assert.equal(client.snapshot().state,'connected');
});
test('window and draw budgets fail closed, including empty-payload draw floods', async t => {
  const {client,transports}=setup({limits:{maxPendingDraws:1}});t.after(()=>client.disconnect());await client.connect({url:'ws://localhost/'});
  const transport=transports[0]!;transport.receive(serverHello);transport.receive(create);
  const empty=draw(100);empty[7]=new Uint8Array(0);transport.receive(empty);transport.receive(empty);
  assert.equal(client.snapshot().state,'error');assert.match(client.snapshot().reason,/queue limit/);
  await client.connect({url:'ws://localhost/'});const second=transports[1]!;second.receive(serverHello);
  second.receive(['window-create',100,0,0,8192,8192,{},{}]);assert.match(client.snapshot().reason,/pixel budget/);
});
test('disconnect stops dispatch within a coalesced record stream', async t => {
  const {client,transports}=setup();t.after(()=>client.disconnect());await client.connect({url:'ws://localhost/'});const transport=transports[0]!;transport.receive(serverHello);
  transport.handlers!.data(Buffer.concat([record(['connection-close','done']),record(create)]));
  assert.equal(client.snapshot().state,'disconnected');assert.equal(client.snapshot().windows.length,0);
});
