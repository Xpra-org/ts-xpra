import { test } from 'node:test';
import assert from 'node:assert/strict';
import { challengeResponse } from '../src/core/auth.ts';
const server = Uint8Array.from({length:64},(_,i)=>i), client = Uint8Array.from({length:32},(_,i)=>0xa0+i);
test('authentication matches permitted documentation SHA-256/SHA-512 vectors', async () => {
  for (const [digest, expected] of [
    ['hmac+sha256','9d85c3522cfa016edb779f946f077ee9c34d647b35e3b6cc388d090dc809c323'],
    ['hmac+sha512','78f1bdb7b59b05229c7675f71c38b63155c788ba2184e2f5b669f3f35d8159468713de185e90622a66d89dc3f02d67baf7bae6acb89515b7a7c08a8513d6d3f9'],
  ]) {
    const response = await challengeResponse('secret',server,digest!,digest!,client);
    assert.equal(new TextDecoder().decode(response.challenge_response),expected);
    assert.equal(response.challenge_padding.length + response.challenge_response.length,512);
    assert.deepEqual(response.challenge_client_salt,client);
  }
  const result = await challengeResponse('pässwörd€',server,'hmac+sha256','hmac+sha256',client);
  assert.equal(new TextDecoder().decode(result.challenge_response),'35ecd3610ec3de9d10cefd1d5be0719c4f0a10a4a821b0dada4392fb9f010850');
});
test('authentication rejects invalid salts and unsupported mechanisms', async () => {
  await assert.rejects(challengeResponse('secret',server,'xor','hmac+sha256',client));
  await assert.rejects(challengeResponse('secret',new Uint8Array(2),'hmac+sha256','hmac+sha256',client));
  const a = await challengeResponse('é',server,'hmac+sha256','hmac+sha256',client);
  const b = await challengeResponse('Ã©',server,'hmac+sha256','hmac+sha256',client);
  assert.notDeepEqual(a.challenge_response,b.challenge_response);
});
