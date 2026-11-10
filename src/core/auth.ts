const encoder = new TextEncoder();
const algorithms: Record<string, string> = { 'hmac+sha256': 'SHA-256', 'hmac+sha512': 'SHA-512' };
function passwordBytes(password: string): Uint8Array {
  const chars = [...password];
  return chars.every(c => c.codePointAt(0)! <= 255) ? Uint8Array.from(chars, c => c.charCodeAt(0)) : encoder.encode(password);
}
async function hmac(key: Uint8Array, data: Uint8Array, digest: string): Promise<Uint8Array> {
  if (!crypto.subtle) throw new Error('Password authentication requires HTTPS or localhost (Web Crypto)');
  const hash = algorithms[digest];
  if (!hash) throw new Error(`Unsupported authentication digest: ${digest}`);
  // Web Crypto rejects a zero-length HMAC key. One zero byte is equivalent after HMAC padding.
  const material = key.length ? key : new Uint8Array(1);
  const imported = await crypto.subtle.importKey('raw', material as Uint8Array<ArrayBuffer>, { name: 'HMAC', hash }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', imported, data as Uint8Array<ArrayBuffer>);
  return encoder.encode([...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, '0')).join(''));
}
export async function challengeResponse(password: string, serverSalt: Uint8Array, digest: string, saltDigest: string, clientSalt = crypto.getRandomValues(new Uint8Array(32))) {
  if (serverSalt.length !== 64 || clientSalt.length !== 32) throw new Error('Invalid authentication salt length');
  const combined = await hmac(clientSalt, serverSalt, saltDigest);
  const response = await hmac(passwordBytes(password), combined, digest);
  return {
    challenge_response: response,
    challenge_client_salt: clientSalt,
    challenge_padding: crypto.getRandomValues(new Uint8Array(Math.max(32, 512 - response.length))),
  };
}
