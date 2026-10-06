// Finds TVs and receivers on the local network:
//   • AirPlay (Apple TV) and Google Cast (Android TV, Google TV, Chromecast) via Bonjour/mDNS
//   • DLNA/UPnP media renderers (smart TVs, Fire TV with a receiver app, Kodi, …) via SSDP

import { EventEmitter } from 'node:events';
import dgram from 'node:dgram';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Bonjour } = require('bonjour-service');

const localAddresses = () => new Set(Object.values(os.networkInterfaces()).flat().filter(Boolean).map((i) => i.address));
const pickIPv4 = (addresses = []) => addresses.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));

const tag = (xml, name) => {
  const m = new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`, 'i').exec(xml);
  return m ? m[1].trim().replace(/&amp;/g, '&') : null;
};

export class Discovery extends EventEmitter {
  constructor() {
    super();
    this.devices = new Map();
  }

  list() {
    return [...this.devices.values()].sort((a, b) => a.protocol.localeCompare(b.protocol) || a.name.localeCompare(b.name));
  }

  add(dev) {
    const known = this.devices.get(dev.id);
    this.devices.set(dev.id, { ...known, ...dev, seen: Date.now() });
    if (!known) this.emit('changed');
  }

  start() {
    if (this.bonjour) return;
    this.bonjour = new Bonjour();
    const own = localAddresses();

    this.bonjour.find({ type: 'airplay' }, (svc) => {
      const host = pickIPv4(svc.addresses);
      if (!host || own.has(host)) return; // skip this computer's own AirPlay receiver
      const txt = svc.txt || {};
      const features = Number.parseInt(String(txt.features || '0').split(',')[0], 16) || 0;
      if (!(features & 1)) return; // no video support (HomePod, speakers)
      this.add({ id: `airplay:${txt.deviceid || svc.name}`, protocol: 'airplay', name: svc.name, host, port: svc.port, model: txt.model || null });
    });

    this.bonjour.find({ type: 'googlecast' }, (svc) => {
      const host = pickIPv4(svc.addresses);
      if (!host) return;
      const txt = svc.txt || {};
      this.add({ id: `cast:${txt.id || svc.name}`, protocol: 'cast', name: txt.fn || svc.name, host, port: svc.port || 8009, model: txt.md || null });
    });

    this.ssdpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.ssdpSocket.on('message', (msg) => this.onSsdp(msg.toString()));
    this.ssdpSocket.on('error', () => {});
    this.ssdpSocket.bind(() => this.searchDlna());
    this.timer = setInterval(() => this.refresh(), 60000);
  }

  refresh() {
    try { this.bonjour?.browsers?.forEach((b) => b.update()); } catch { /* ignore */ }
    this.searchDlna();
    // Forget devices that haven't been seen for a while.
    for (const [id, d] of this.devices) if (Date.now() - d.seen > 5 * 60000) this.devices.delete(id);
  }

  searchDlna() {
    const msg = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n');
    try { this.ssdpSocket?.send(msg, 1900, '239.255.255.250'); } catch { /* not bound yet */ }
  }

  async onSsdp(text) {
    const location = /LOCATION:\s*(\S+)/i.exec(text)?.[1];
    if (!location || this.pendingLocations?.has(location)) return;
    (this.pendingLocations ||= new Set()).add(location);
    try {
      const xml = await (await fetch(location, { signal: AbortSignal.timeout(4000) })).text();
      const udn = tag(xml, 'UDN');
      const services = [...xml.matchAll(/<service>([\s\S]*?)<\/service>/gi)].map((m) => m[1]);
      const find = (type) => services.find((s) => tag(s, 'serviceType')?.includes(type));
      const avt = find('AVTransport');
      if (!avt) return;
      const base = tag(xml, 'URLBase') || location;
      const abs = (u) => new URL(u, base).toString();
      const cm = find('ConnectionManager');
      let video = true;
      if (cm) {
        // Ask what the renderer accepts; audio-only speakers (e.g. Sonos) don't list video formats.
        const info = await soapCall(abs(tag(cm, 'controlURL')), 'urn:schemas-upnp-org:service:ConnectionManager:1', 'GetProtocolInfo', {}).catch(() => '');
        if (info) video = /video\//i.test(tag(info, 'Sink') || '');
      }
      this.add({
        id: `dlna:${udn || location}`,
        protocol: 'dlna',
        name: tag(xml, 'friendlyName') || 'DLNA device',
        host: new URL(location).hostname,
        model: [tag(xml, 'manufacturer'), tag(xml, 'modelName')].filter(Boolean).join(' ') || null,
        controlURL: abs(tag(avt, 'controlURL')),
        video,
      });
    } catch { /* unreachable renderer */ } finally {
      setTimeout(() => this.pendingLocations.delete(location), 30000);
    }
  }

  stop() {
    clearInterval(this.timer);
    try { this.bonjour?.destroy(); } catch { /* ignore */ }
    try { this.ssdpSocket?.close(); } catch { /* ignore */ }
    this.bonjour = null;
  }
}

export async function soapCall(controlURL, service, action, args) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:${action} xmlns:u="${service}">${Object.entries(args).map(([k, v]) => `<${k}>${v}</${k}>`).join('')}</u:${action}></s:Body></s:Envelope>`;
  const res = await fetch(controlURL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"${service}#${action}"` },
    body,
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${action} failed (${res.status}${tag(text, 'errorDescription') ? `: ${tag(text, 'errorDescription')}` : ''})`);
  return text;
}

export { tag };
