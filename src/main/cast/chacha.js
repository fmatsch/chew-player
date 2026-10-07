// ChaCha20-Poly1305 AEAD (RFC 8439).
// Electron's crypto (BoringSSL) doesn't expose this cipher through createCipheriv, but AirPlay's
// encrypted control channel and pairing need it. Uses the native cipher when available, otherwise
// this small pure-JS implementation (only control messages go through it, so speed doesn't matter).

import crypto from 'node:crypto';

const native = (() => {
  try {
    crypto.createCipheriv('chacha20-poly1305', Buffer.alloc(32), Buffer.alloc(12), { authTagLength: 16 });
    return true;
  } catch {
    return false;
  }
})();

const rotl = (v, n) => ((v << n) | (v >>> (32 - n))) >>> 0;

function quarter(s, a, b, c, d) {
  s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 7);
}

function block(key, counter, nonce) {
  const init = new Uint32Array(16);
  init[0] = 0x61707865; init[1] = 0x3320646e; init[2] = 0x79622d32; init[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) init[4 + i] = key.readUInt32LE(i * 4);
  init[12] = counter >>> 0;
  for (let i = 0; i < 3; i++) init[13 + i] = nonce.readUInt32LE(i * 4);
  const s = Uint32Array.from(init);
  for (let i = 0; i < 10; i++) {
    quarter(s, 0, 4, 8, 12); quarter(s, 1, 5, 9, 13); quarter(s, 2, 6, 10, 14); quarter(s, 3, 7, 11, 15);
    quarter(s, 0, 5, 10, 15); quarter(s, 1, 6, 11, 12); quarter(s, 2, 7, 8, 13); quarter(s, 3, 4, 9, 14);
  }
  const out = Buffer.alloc(64);
  for (let i = 0; i < 16; i++) out.writeUInt32LE((s[i] + init[i]) >>> 0, i * 4);
  return out;
}

export function chacha20(key, counter, nonce, data) {
  const out = Buffer.alloc(data.length);
  for (let off = 0, n = counter; off < data.length; off += 64, n++) {
    const ks = block(key, n, nonce);
    for (let i = 0; i < 64 && off + i < data.length; i++) out[off + i] = data[off + i] ^ ks[i];
  }
  return out;
}

const leBig = (buf) => { let v = 0n; for (let i = buf.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(buf[i]); return v; };
const P = (1n << 130n) - 5n;

export function poly1305(key, msg) {
  const r = leBig(key.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
  const s = leBig(key.subarray(16, 32));
  let acc = 0n;
  for (let i = 0; i < msg.length; i += 16) {
    const chunk = msg.subarray(i, i + 16);
    acc = ((acc + leBig(chunk) + (1n << BigInt(chunk.length * 8))) * r) % P;
  }
  acc = (acc + s) & ((1n << 128n) - 1n);
  const tag = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) { tag[i] = Number(acc & 0xffn); acc >>= 8n; }
  return tag;
}

function macData(aad, ct) {
  const pad = (n) => Buffer.alloc((16 - (n % 16)) % 16);
  const lens = Buffer.alloc(16);
  lens.writeBigUInt64LE(BigInt(aad.length), 0);
  lens.writeBigUInt64LE(BigInt(ct.length), 8);
  return Buffer.concat([aad, pad(aad.length), ct, pad(ct.length), lens]);
}

// Returns ciphertext || 16-byte tag.
export function seal(key, nonce, plain, aad = Buffer.alloc(0)) {
  if (native) {
    const c = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    if (aad.length) c.setAAD(aad, { plaintextLength: plain.length });
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  }
  const ct = chacha20(key, 1, nonce, plain);
  return Buffer.concat([ct, poly1305(block(key, 0, nonce).subarray(0, 32), macData(aad, ct))]);
}

// Takes ciphertext || tag, returns the plaintext or throws when the tag doesn't match.
export function open(key, nonce, sealed, aad = Buffer.alloc(0)) {
  const ct = sealed.subarray(0, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);
  if (native) {
    const d = crypto.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    if (aad.length) d.setAAD(aad, { plaintextLength: ct.length });
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  }
  const expect = poly1305(block(key, 0, nonce).subarray(0, 32), macData(aad, ct));
  if (!crypto.timingSafeEqual(expect, tag)) throw new Error('Decryption failed (bad tag)');
  return chacha20(key, 1, nonce, ct);
}
