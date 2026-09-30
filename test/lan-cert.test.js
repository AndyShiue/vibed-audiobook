// The LAN certificate authority must (a) produce a chain a real TLS client accepts, (b) cover the machine's
// addresses, (c) renew when they change, and (d) refuse to vouch for public names (name constraints).
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureLanCerts, issueForTest } from '../lan-cert.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-cert-'));
const HOSTS = ['localhost', 'test-pc', 'test-pc.local'];

function serve({ key, cert }) {
  return new Promise((resolve) => {
    const s = https.createServer({ key, cert }, (req, res) => res.end('ok'));
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const connect = (port, ca) => new Promise((resolve) => {
  const sock = tls.connect({ host: '127.0.0.1', port, ca, rejectUnauthorized: true }, () => { const peer = sock.getPeerCertificate(); sock.end(); resolve({ ok: true, peer }); });
  sock.on('error', (err) => resolve({ ok: false, err }));
});

test('creates a CA and a server certificate that a strict TLS client trusts', async () => {
  const a = ensureLanCerts(dir, { ips: ['192.168.1.10', '100.64.0.5'], hostnames: HOSTS });
  assert.ok(a.createdCa && a.renewed);
  const server = await serve(a);
  try {
    const r = await connect(server.address().port, a.caPem);
    assert.ok(r.ok, `handshake failed: ${r.err?.message}`);
    // The certificate must name the LAN addresses, otherwise phones will reject it.
    assert.equal(tls.checkServerIdentity('192.168.1.10', r.peer), undefined);
    assert.equal(tls.checkServerIdentity('100.64.0.5', r.peer), undefined);
    assert.equal(tls.checkServerIdentity('test-pc.local', r.peer), undefined);
    assert.notEqual(tls.checkServerIdentity('192.168.1.99', r.peer), undefined, 'an unlisted address must not match');
    const x = new crypto.X509Certificate(a.cert);
    assert.ok((new Date(x.validTo) - Date.now()) / 86400_000 <= 825, 'Apple rejects certificates valid longer than 825 days');
    assert.ok(x.checkIssued && new crypto.X509Certificate(a.caPem).ca === true);
    assert.ok(x.verify(new crypto.X509Certificate(a.caPem).publicKey));
    // Without the CA installed, the server certificate is (rightly) untrusted.
    const untrusted = await connect(server.address().port, undefined);
    assert.equal(untrusted.ok, false);
  } finally { server.close(); }
});

test('name constraint: the CA cannot vouch for public sites, only private ranges', async () => {
  const good = issueForTest(dir, ['127.0.0.1', '10.1.2.3', 'test-pc.local']);
  const bad = issueForTest(dir, ['127.0.0.1', '8.8.8.8']);
  const badDns = issueForTest(dir, ['127.0.0.1', 'www.google.com']);
  const caPem = fs.readFileSync(path.join(dir, 'ca.crt'), 'utf8');
  for (const [label, pems, expectOk] of [['private names', good, true], ['public IP', bad, false], ['public DNS name', badDns, false]]) {
    const s = await serve(pems);
    try {
      const r = await connect(s.address().port, caPem);
      assert.equal(r.ok, expectOk, `${label}: expected ${expectOk ? 'trusted' : 'rejected'}, got ${r.ok ? 'trusted' : r.err.message}`);
      if (!expectOk) assert.match(`${r.err.code} ${r.err.message}`, /permitted|subtree|constraint/i, `${label}: rejected for the wrong reason (${r.err.message})`);
    } finally { s.close(); }
  }
});

test('renews only when the addresses change, and keeps the same CA so phones need no reinstall', () => {
  const same = ensureLanCerts(dir, { ips: ['192.168.1.10', '100.64.0.5'], hostnames: HOSTS });
  assert.equal(same.createdCa, false);
  assert.equal(same.renewed, false, 'nothing changed, so nothing to renew');
  const caBefore = same.caPem;
  const moved = ensureLanCerts(dir, { ips: ['192.168.1.77'], hostnames: HOSTS });
  assert.equal(moved.renewed, true);
  assert.equal(moved.createdCa, false);
  assert.equal(moved.caPem, caBefore);
  assert.ok(new crypto.X509Certificate(moved.cert).subjectAltName.includes('192.168.1.77'));
  assert.equal(ensureLanCerts(dir, { ips: ['192.168.1.77'], hostnames: HOSTS }).renewed, false);
  assert.ok(moved.caDer.length > 300 && moved.caDer[0] === 0x30, 'DER export of the CA looks like an ASN.1 sequence');
});
