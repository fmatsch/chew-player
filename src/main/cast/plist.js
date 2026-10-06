// Minimal binary property list (bplist00) encoder/decoder — enough for AirPlay's
// /play request and /playback-info response (dicts, arrays, strings, numbers, booleans, data).

export function encodeBplist(root) {
  const objects = [];
  const flatten = (v) => {
    const idx = objects.length;
    objects.push(null);
    if (Array.isArray(v)) objects[idx] = { type: 'array', refs: v.map(flatten) };
    else if (v && typeof v === 'object' && !Buffer.isBuffer(v)) {
      const keys = Object.keys(v).filter((k) => v[k] !== undefined);
      const krefs = keys.map(flatten);
      objects[idx] = { type: 'dict', krefs, vrefs: keys.map((k) => flatten(v[k])) };
    } else objects[idx] = { type: 'value', v };
    return idx;
  };
  flatten(root);
  const refSize = objects.length < 256 ? 1 : 2;
  const ref = (n) => (refSize === 1 ? Buffer.from([n]) : Buffer.from([n >> 8, n & 255]));
  const marker = (type, len) => {
    if (len < 15) return Buffer.from([(type << 4) | len]);
    return Buffer.concat([Buffer.from([(type << 4) | 15]), encodeInt(len)]);
  };
  const encodeInt = (n) => {
    if (n < 0) { const b = Buffer.alloc(9); b[0] = 0x13; b.writeBigInt64BE(BigInt(n), 1); return b; }
    if (n < 256) return Buffer.from([0x10, n]);
    if (n < 65536) { const b = Buffer.alloc(3); b[0] = 0x11; b.writeUInt16BE(n, 1); return b; }
    if (n < 2 ** 32) { const b = Buffer.alloc(5); b[0] = 0x12; b.writeUInt32BE(n, 1); return b; }
    const b = Buffer.alloc(9); b[0] = 0x13; b.writeBigInt64BE(BigInt(n), 1); return b;
  };
  const chunks = [Buffer.from('bplist00')];
  const offsets = [];
  let pos = 8;
  for (const o of objects) {
    offsets.push(pos);
    let buf;
    if (o.type === 'array') buf = Buffer.concat([marker(0xA, o.refs.length), ...o.refs.map(ref)]);
    else if (o.type === 'dict') buf = Buffer.concat([marker(0xD, o.krefs.length), ...o.krefs.map(ref), ...o.vrefs.map(ref)]);
    else {
      const v = o.v;
      if (v === null || v === undefined) buf = Buffer.from([0x00]);
      else if (v === false) buf = Buffer.from([0x08]);
      else if (v === true) buf = Buffer.from([0x09]);
      else if (Buffer.isBuffer(v)) buf = Buffer.concat([marker(0x4, v.length), v]);
      else if (typeof v === 'number' && Number.isInteger(v)) buf = encodeInt(v);
      else if (typeof v === 'number') { buf = Buffer.alloc(9); buf[0] = 0x23; buf.writeDoubleBE(v, 1); }
      else {
        const s = String(v);
        // eslint-disable-next-line no-control-regex
        if (/^[\x00-\x7f]*$/.test(s)) buf = Buffer.concat([marker(0x5, s.length), Buffer.from(s, 'ascii')]);
        else {
          const u = Buffer.from(s, 'utf16le');
          for (let i = 0; i < u.length; i += 2) { const t = u[i]; u[i] = u[i + 1]; u[i + 1] = t; }
          buf = Buffer.concat([marker(0x6, u.length / 2), u]);
        }
      }
    }
    chunks.push(buf);
    pos += buf.length;
  }
  const offSize = pos < 256 ? 1 : pos < 65536 ? 2 : 4;
  const table = Buffer.alloc(offsets.length * offSize);
  offsets.forEach((o, i) => table.writeUIntBE(o, i * offSize, offSize));
  const trailer = Buffer.alloc(32);
  trailer[6] = offSize;
  trailer[7] = refSize;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(pos), 24);
  return Buffer.concat([...chunks, table, trailer]);
}

export function decodeBplist(buf) {
  if (buf.subarray(0, 8).toString() !== 'bplist00') throw new Error('not a bplist');
  const t = buf.subarray(buf.length - 32);
  const offSize = t[6];
  const refSize = t[7];
  const count = Number(t.readBigUInt64BE(8));
  const top = Number(t.readBigUInt64BE(16));
  const tableAt = Number(t.readBigUInt64BE(24));
  const offset = (i) => buf.readUIntBE(tableAt + i * offSize, offSize);
  const readLen = (p, low) => {
    if (low !== 15) return [low, p + 1];
    const m = buf[p + 1];
    const n = 1 << (m & 0xf);
    return [buf.readUIntBE(p + 2, n), p + 2 + n];
  };
  const parse = (i) => {
    if (i >= count) return null;
    const p = offset(i);
    const m = buf[p];
    const type = m >> 4;
    const low = m & 0xf;
    switch (type) {
      case 0x0: return low === 9 ? true : low === 8 ? false : null;
      case 0x1: { const n = 1 << low; return n === 8 ? Number(buf.readBigInt64BE(p + 1)) : buf.readUIntBE(p + 1, n); }
      case 0x2: return low === 2 ? buf.readFloatBE(p + 1) : buf.readDoubleBE(p + 1);
      case 0x3: return new Date((978307200 + buf.readDoubleBE(p + 1)) * 1000);
      case 0x4: { const [len, s] = readLen(p, low); return buf.subarray(s, s + len); }
      case 0x5: { const [len, s] = readLen(p, low); return buf.subarray(s, s + len).toString('ascii'); }
      case 0x6: {
        const [len, s] = readLen(p, low);
        const u = Buffer.from(buf.subarray(s, s + len * 2));
        for (let k = 0; k < u.length; k += 2) { const x = u[k]; u[k] = u[k + 1]; u[k + 1] = x; }
        return u.toString('utf16le');
      }
      case 0xA: {
        const [len, s] = readLen(p, low);
        return Array.from({ length: len }, (_, k) => parse(buf.readUIntBE(s + k * refSize, refSize)));
      }
      case 0xD: {
        const [len, s] = readLen(p, low);
        const o = {};
        for (let k = 0; k < len; k++) {
          const key = parse(buf.readUIntBE(s + k * refSize, refSize));
          o[key] = parse(buf.readUIntBE(s + (len + k) * refSize, refSize));
        }
        return o;
      }
      default: return null;
    }
  };
  return parse(top);
}
