// AirPlay video client for Apple TV.
//
// Modern tvOS only accepts /play over an authenticated, encrypted connection. We do the same
// HomeKit-style handshake an iPhone does:
//   • transient pairing (SRP with the fixed PIN 3939) when the Apple TV allows "Everyone on the
//     same network", or
//   • one-time PIN pairing (the Apple TV shows a 4-digit code) followed by pair-verify with the
//     stored keys on every later connection.
// Afterwards every HTTP request/response is framed and encrypted with ChaCha20-Poly1305.

import net from 'node:net';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { encodeBplist, decodeBplist } from './plist.js';

const require = createRequire(import.meta.url);
const { SRP, SrpClient } = require('fast-srp-hap');

// ---------------------------------------------------------------- TLV8

const T = { Method: 0, Identifier: 1, Salt: 2, PublicKey: 3, Proof: 4, EncryptedData: 5, State: 6, Error: 7, Signature: 10, Flags: 19 };

function tlvEncode(items) {
  const parts = [];
  for (const [type, value] of items) {
    let v = Buffer.isBuffer(value) ? value : Buffer.from([value]);
    if (v.length === 0) parts.push(Buffer.from([type, 0]));
    while (v.length) {
      const chunk = v.subarray(0, 255);
      parts.push(Buffer.from([type, chunk.length]), chunk);
      v = v.subarray(255);
    }
  }
  return Buffer.concat(parts);
}

function tlvDecode(buf) {
  const out = {};
  let i = 0;
  let last = null;
  while (i < buf.length) {
    const type = buf[i];
    const len = buf[i + 1];
    const val = buf.subarray(i + 2, i + 2 + len);
    out[type] = last === type && out[type] ? Buffer.concat([out[type], val]) : Buffer.from(val);
    last = type;
    i += 2 + len;
  }
  return out;
}

// ---------------------------------------------------------------- crypto helpers

const hkdf = (ikm, salt, info) => Buffer.from(crypto.hkdfSync('sha512', ikm, Buffer.from(salt), Buffer.from(info), 32));

function chachaSeal(key, nonce, plain, aad) {
  const c = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  if (aad) c.setAAD(aad, { plaintextLength: plain.length });
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}

function chachaOpen(key, nonce, sealed, aad) {
  const d = crypto.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  if (aad) d.setAAD(aad, { plaintextLength: sealed.length - 16 });
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
}

const padNonce = (s) => Buffer.concat([Buffer.alloc(4), Buffer.from(s)]);

const ED_PRIV_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED_PUB_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const X_PUB_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const edPrivate = (seed) => crypto.createPrivateKey({ key: Buffer.concat([ED_PRIV_PREFIX, seed]), format: 'der', type: 'pkcs8' });
const edPublic = (raw) => crypto.createPublicKey({ key: Buffer.concat([ED_PUB_PREFIX, raw]), format: 'der', type: 'spki' });
const rawPublic = (keyObj) => keyObj.export({ format: 'der', type: 'spki' }).subarray(-32);

// ---------------------------------------------------------------- connection

class Connection {
  constructor(host, port) {
    this.host = host;
    this.port = port;
    this.buffer = Buffer.alloc(0);
    this.plain = Buffer.alloc(0);
    this.waiters = [];
    this.enc = null;
    this.cseq = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.sock = net.connect({ host: this.host, port: this.port }, resolve);
      this.sock.setNoDelay(true);
      this.sock.setKeepAlive(true, 10000);
      this.sock.on('data', (d) => this.onData(d));
      this.sock.on('error', (e) => { reject(e); this.fail(e); });
      this.sock.on('close', () => { this.closed = true; this.fail(new Error('Connection closed')); });
    });
  }

  fail(err) {
    for (const w of this.waiters.splice(0)) w.reject(err);
  }

  onData(d) {
    if (!this.enc) {
      this.plain = Buffer.concat([this.plain, d]);
    } else {
      this.buffer = Buffer.concat([this.buffer, d]);
      while (this.buffer.length >= 2) {
        const len = this.buffer.readUInt16LE(0);
        if (this.buffer.length < 2 + len + 16) break;
        const aad = this.buffer.subarray(0, 2);
        const sealed = this.buffer.subarray(2, 2 + len + 16);
        const nonce = Buffer.alloc(12);
        nonce.writeBigUInt64LE(this.enc.readCounter++, 4);
        this.plain = Buffer.concat([this.plain, chachaOpen(this.enc.readKey, nonce, sealed, aad)]);
        this.buffer = this.buffer.subarray(2 + len + 16);
      }
    }
    this.pump();
  }

  // Parse complete HTTP responses out of the plaintext buffer.
  pump() {
    while (this.waiters.length) {
      const end = this.plain.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = this.plain.subarray(0, end).toString();
      const lines = head.split('\r\n');
      const status = Number(lines[0].split(' ')[1]);
      const headers = {};
      for (const l of lines.slice(1)) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
      const len = Number(headers['content-length'] || 0);
      if (this.plain.length < end + 4 + len) return;
      const body = this.plain.subarray(end + 4, end + 4 + len);
      this.plain = this.plain.subarray(end + 4 + len);
      this.waiters.shift().resolve({ status, headers, body });
    }
  }

  write(data) {
    if (!this.enc) { this.sock.write(data); return; }
    for (let i = 0; i < data.length; i += 1024) {
      const chunk = data.subarray(i, i + 1024);
      const aad = Buffer.alloc(2);
      aad.writeUInt16LE(chunk.length);
      const nonce = Buffer.alloc(12);
      nonce.writeBigUInt64LE(this.enc.writeCounter++, 4);
      this.sock.write(Buffer.concat([aad, chachaSeal(this.enc.writeKey, nonce, chunk, aad)]));
    }
  }

  request(method, path, { headers = {}, body = Buffer.alloc(0), timeout = 10000 } = {}) {
    if (this.closed) return Promise.reject(new Error('Connection closed'));
    const h = {
      'User-Agent': 'AirPlay/550.10',
      'Content-Length': body.length,
      'X-Apple-Session-ID': this.sessionId,
      CSeq: ++this.cseq,
      ...headers,
    };
    const head = `${method} ${path} HTTP/1.1\r\n${Object.entries(h).filter(([, v]) => v != null).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`AirPlay ${path} timed out`)), timeout);
      this.waiters.push({ resolve: (r) => { clearTimeout(timer); resolve(r); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.write(Buffer.concat([Buffer.from(head), body]));
    });
  }

  enableEncryption(sharedKey) {
    this.enc = {
      writeKey: hkdf(sharedKey, 'Control-Salt', 'Control-Write-Encryption-Key'),
      readKey: hkdf(sharedKey, 'Control-Salt', 'Control-Read-Encryption-Key'),
      writeCounter: 0n,
      readCounter: 0n,
    };
  }

  close() { try { this.sock?.destroy(); } catch { /* ignore */ } }
}

const pairHeaders = (hkp) => ({ 'Content-Type': 'application/octet-stream', 'X-Apple-HKP': hkp });

async function srpExchange(conn, m2, pin) {
  if (m2[T.Error]) throw Object.assign(new Error('Apple TV refused pairing'), { code: m2[T.Error][0] });
  const client = new SrpClient(SRP.params.hap, m2[T.Salt], Buffer.from('Pair-Setup'), Buffer.from(pin), await SRP.genKey(32));
  client.setB(m2[T.PublicKey]);
  return client;
}

// ---------------------------------------------------------------- public API

export class AirPlayDevice {
  // device: { host, port, name, id }; credentials: { clientId, seed (hex), serverPk (hex) } from an earlier PIN pairing.
  constructor(device, credentials = null) {
    this.device = device;
    this.credentials = credentials;
    this.sessionId = crypto.randomUUID().toUpperCase();
  }

  async open() {
    this.conn = new Connection(this.device.host, this.device.port || 7000);
    this.conn.sessionId = this.sessionId;
    await this.conn.connect();
    if (this.credentials) await this.pairVerify();
    else await this.transientPair();
  }

  async transientPair() {
    const c = this.conn;
    const r2 = await c.request('POST', '/pair-setup', { headers: pairHeaders(4), body: tlvEncode([[T.Method, 0], [T.State, 1], [T.Flags, 0x10]]) });
    if (r2.status !== 200) throw Object.assign(new Error(`Pairing failed (${r2.status})`), { needsPin: true });
    const m2 = tlvDecode(r2.body);
    if (m2[T.Error]) throw Object.assign(new Error('This Apple TV requires a PIN'), { needsPin: true });
    const srp = await srpExchange(c, m2, '3939');
    const r4 = await c.request('POST', '/pair-setup', { headers: pairHeaders(4), body: tlvEncode([[T.State, 3], [T.PublicKey, srp.computeA()], [T.Proof, srp.computeM1()]]) });
    const m4 = tlvDecode(r4.body);
    if (m4[T.Error] || !m4[T.Proof]) throw Object.assign(new Error('This Apple TV requires a PIN'), { needsPin: true });
    srp.checkM2(m4[T.Proof]);
    c.enableEncryption(srp.computeK());
  }

  // Step 1 of PIN pairing: makes the Apple TV show a code on screen.
  async startPinPairing() {
    this.conn?.close();
    this.conn = new Connection(this.device.host, this.device.port || 7000);
    this.conn.sessionId = this.sessionId;
    await this.conn.connect();
    await this.conn.request('POST', '/pair-pin-start', { headers: { 'Content-Length': 0 } });
    const r2 = await this.conn.request('POST', '/pair-setup', { headers: pairHeaders(3), body: tlvEncode([[T.Method, 0], [T.State, 1]]) });
    this.pendingM2 = tlvDecode(r2.body);
    if (this.pendingM2[T.Error]) throw new Error('The Apple TV refused to pair');
  }

  // Step 2: finish with the PIN shown on the TV. Returns long-term credentials to store.
  async finishPinPairing(pin) {
    const c = this.conn;
    const srp = await srpExchange(c, this.pendingM2, String(pin));
    const r4 = await c.request('POST', '/pair-setup', { headers: pairHeaders(3), body: tlvEncode([[T.State, 3], [T.PublicKey, srp.computeA()], [T.Proof, srp.computeM1()]]) });
    const m4 = tlvDecode(r4.body);
    if (m4[T.Error] || !m4[T.Proof]) throw new Error('Wrong PIN');
    srp.checkM2(m4[T.Proof]);
    const K = srp.computeK();

    const seed = crypto.randomBytes(32);
    const priv = edPrivate(seed);
    const pub = rawPublic(crypto.createPublicKey(priv));
    const clientId = Buffer.from(crypto.randomUUID().toUpperCase());
    const x = hkdf(K, 'Pair-Setup-Controller-Sign-Salt', 'Pair-Setup-Controller-Sign-Info');
    const sig = crypto.sign(null, Buffer.concat([x, clientId, pub]), priv);
    const sub = tlvEncode([[T.Identifier, clientId], [T.PublicKey, pub], [T.Signature, sig]]);
    const encKey = hkdf(K, 'Pair-Setup-Encrypt-Salt', 'Pair-Setup-Encrypt-Info');
    const r6 = await c.request('POST', '/pair-setup', { headers: pairHeaders(3), body: tlvEncode([[T.State, 5], [T.EncryptedData, chachaSeal(encKey, padNonce('PS-Msg05'), sub)]]) });
    const m6 = tlvDecode(r6.body);
    if (m6[T.Error]) throw new Error('Pairing was rejected');
    const inner = tlvDecode(chachaOpen(encKey, padNonce('PS-Msg06'), m6[T.EncryptedData]));
    this.credentials = { clientId: clientId.toString(), seed: seed.toString('hex'), serverPk: inner[T.PublicKey].toString('hex') };
    this.conn.close();
    return this.credentials;
  }

  async pairVerify() {
    const c = this.conn;
    const { clientId, seed, serverPk } = this.credentials;
    const eph = crypto.generateKeyPairSync('x25519');
    const ephPub = rawPublic(eph.publicKey);
    const r2 = await c.request('POST', '/pair-verify', { headers: pairHeaders(3), body: tlvEncode([[T.State, 1], [T.PublicKey, ephPub]]) });
    const m2 = tlvDecode(r2.body);
    if (m2[T.Error] || !m2[T.PublicKey]) throw Object.assign(new Error('Stored pairing is no longer valid'), { needsPin: true });
    const serverEph = m2[T.PublicKey];
    const shared = crypto.diffieHellman({
      privateKey: eph.privateKey,
      publicKey: crypto.createPublicKey({ key: Buffer.concat([X_PUB_PREFIX, serverEph]), format: 'der', type: 'spki' }),
    });
    const key = hkdf(shared, 'Pair-Verify-Encrypt-Salt', 'Pair-Verify-Encrypt-Info');
    const inner = tlvDecode(chachaOpen(key, padNonce('PV-Msg02'), m2[T.EncryptedData]));
    const ok = crypto.verify(null, Buffer.concat([serverEph, inner[T.Identifier], ephPub]), edPublic(Buffer.from(serverPk, 'hex')), inner[T.Signature]);
    if (!ok) throw new Error('Apple TV identity could not be verified');
    const sig = crypto.sign(null, Buffer.concat([ephPub, Buffer.from(clientId), serverEph]), edPrivate(Buffer.from(seed, 'hex')));
    const sub = tlvEncode([[T.Identifier, Buffer.from(clientId)], [T.Signature, sig]]);
    const r4 = await c.request('POST', '/pair-verify', { headers: pairHeaders(3), body: tlvEncode([[T.State, 3], [T.EncryptedData, chachaSeal(key, padNonce('PV-Msg03'), sub)]]) });
    if (tlvDecode(r4.body)[T.Error]) throw Object.assign(new Error('Stored pairing was rejected'), { needsPin: true });
    c.enableEncryption(shared);
  }

  async play(url, startSeconds = 0, durationHint = 0) {
    const body = encodeBplist({
      'Content-Location': url,
      'Start-Position-Seconds': startSeconds,
      uuid: crypto.randomUUID().toUpperCase(),
      streamType: 1,
      mediaType: 'file',
      volume: 1.0,
      rate: 1.0,
      mightSupportStorePastisKeys: true,
      playbackRestrictions: 0,
      clientProcName: 'Chew Player',
      clientBundleID: 'io.github.fmatsch.chewplayer',
      model: 'Mac',
      SenderMACAddress: '00:00:00:00:00:00',
      ...(durationHint ? { duration: durationHint } : {}),
    });
    const r = await this.conn.request('POST', '/play', { headers: { 'Content-Type': 'application/x-apple-binary-plist' }, body, timeout: 20000 });
    if (r.status >= 300) throw new Error(`Apple TV refused to play (${r.status})`);
  }

  async status() {
    const r = await this.conn.request('GET', '/playback-info');
    if (r.status !== 200 || !r.body.length) return { position: 0, duration: 0, rate: 0, ready: false };
    const info = decodeBplist(r.body);
    return {
      position: info.position || 0,
      duration: info.duration || 0,
      rate: info.rate || 0,
      ready: !!info.readyToPlay,
      ended: info.duration > 0 && info.readyToPlay === false && !info.position,
    };
  }

  rate(value) { return this.conn.request('POST', `/rate?value=${value}`); }
  seek(seconds) { return this.conn.request('POST', `/scrub?position=${seconds.toFixed(3)}`); }
  async stop() { try { await this.conn.request('POST', '/stop', { timeout: 3000 }); } catch { /* already gone */ } }
  close() { this.conn?.close(); }
}

// Probe whether a device accepts our handshake without showing anything on screen.
export async function probeAirPlay(device, credentials) {
  const d = new AirPlayDevice(device, credentials);
  try {
    await d.open();
    const r = await d.conn.request('GET', '/playback-info');
    return { ok: true, status: r.status };
  } finally {
    d.close();
  }
}
