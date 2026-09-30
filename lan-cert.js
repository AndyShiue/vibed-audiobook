// Local certificate authority for using the app over HTTPS on your home network.
//
// Phones only allow the microphone on secure origins, and a browser can only trust https://192.168.x.x if a
// certificate authority it trusts vouches for it. So the first time we create a small personal CA
// (.certs/ca.*) plus a server certificate for this computer's addresses (.certs/server.*). You install the
// CA certificate on each phone once (the server hands it out on the setup page); after that the phone trusts
// every certificate we issue, and the server certificate is renewed automatically whenever the computer's IP
// address changes.
//
// The CA carries a *name constraint*: even if its private key leaked, phones would reject any certificate it
// signed for a public site — it is only valid for private IP ranges, localhost and *.local names.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import forge from 'node-forge';

const { pki, asn1, util } = forge;

const PERMITTED_IPV4 = [ // address, prefix length
  ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10], ['127.0.0.0', 8],
];
const DAY = 86400_000;

const ipBytes = (ip) => ip.split('.').map((n) => Number(n).toString(16).padStart(2, '0')).join('');
const maskBytes = (prefix) => { let m = ''; for (let i = 0; i < 4; i++) { const bits = Math.max(0, Math.min(8, prefix - i * 8)); m += ((0xff << (8 - bits)) & 0xff).toString(16).padStart(2, '0'); } return m; };

function nameConstraintsExtension(dnsNames) {
  const seq = (children) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, children);
  const subtrees = [
    ...PERMITTED_IPV4.map(([ip, prefix]) => seq([asn1.create(asn1.Class.CONTEXT_SPECIFIC, 7, false, util.hexToBytes(ipBytes(ip) + maskBytes(prefix)))])),
    ...dnsNames.map((n) => seq([asn1.create(asn1.Class.CONTEXT_SPECIFIC, 2, false, n)])),
  ];
  const permitted = asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, subtrees);
  return { id: '2.5.29.30', critical: true, value: asn1.toDer(seq([permitted])).getBytes() };
}

const serial = () => '00' + crypto.randomBytes(15).toString('hex'); // leading 00 keeps the integer positive

export function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}

export function localHostnames() {
  const host = os.hostname().toLowerCase();
  return [...new Set(['localhost', host, `${host}.local`])];
}

function makeCa(dnsNames) {
  const keys = pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - DAY);
  cert.validity.notAfter = new Date(Date.now() + 3650 * DAY);
  const subject = [{ name: 'commonName', value: `Audiobook Companion Local CA (${os.hostname()})` }, { name: 'organizationName', value: 'Audiobook Companion (personal, private networks only)' }];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    nameConstraintsExtension(dnsNames),
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { keys, cert };
}

function makeLeaf(ca, sans) {
  const keys = pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - DAY);
  cert.validity.notAfter = new Date(Date.now() + 800 * DAY); // Apple rejects longer than 825 days
  cert.setSubject([{ name: 'commonName', value: 'audiobook.local' }]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: sans.map((s) => (/^[\d.]+$/.test(s) ? { type: 7, ip: s } : { type: 2, value: s })) },
    { name: 'authorityKeyIdentifier', keyIdentifier: ca.cert.generateSubjectKeyIdentifier().getBytes() },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(ca.keys.privateKey, forge.md.sha256.create());
  return { keys, cert };
}

/**
 * Makes sure a CA and a server certificate covering this machine's current addresses exist in `dir`.
 * @returns {{key, cert, caPem, caDer, sans, createdCa, renewed}}
 */
export function ensureLanCerts(dir, { ips = lanAddresses(), hostnames = localHostnames() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const f = (n) => path.join(dir, n);
  const sans = [...new Set([...hostnames, '127.0.0.1', ...ips])].sort();

  let createdCa = false;
  let ca;
  if (fs.existsSync(f('ca.key.pem')) && fs.existsSync(f('ca.crt'))) {
    ca = { keys: { privateKey: pki.privateKeyFromPem(fs.readFileSync(f('ca.key.pem'), 'utf8')) }, cert: pki.certificateFromPem(fs.readFileSync(f('ca.crt'), 'utf8')) };
  } else {
    ca = makeCa(hostnames);
    fs.writeFileSync(f('ca.key.pem'), pki.privateKeyToPem(ca.keys.privateKey), { mode: 0o600 });
    fs.writeFileSync(f('ca.crt'), pki.certificateToPem(ca.cert));
    createdCa = true;
    for (const stale of ['server.key.pem', 'server.crt.pem', 'meta.json']) fs.rmSync(f(stale), { force: true });
  }

  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(f('meta.json'), 'utf8')); } catch { /* first run */ }
  const covered = Array.isArray(meta.sans) && sans.every((s) => meta.sans.includes(s));
  const fresh = meta.expires && meta.expires - Date.now() > 30 * DAY;
  let renewed = false;
  if (!(covered && fresh && fs.existsSync(f('server.key.pem')) && fs.existsSync(f('server.crt.pem')))) {
    const leaf = makeLeaf(ca, sans);
    fs.writeFileSync(f('server.key.pem'), pki.privateKeyToPem(leaf.keys.privateKey), { mode: 0o600 });
    fs.writeFileSync(f('server.crt.pem'), pki.certificateToPem(leaf.cert));
    fs.writeFileSync(f('meta.json'), JSON.stringify({ sans, expires: leaf.cert.validity.notAfter.getTime() }, null, 2));
    renewed = true;
  }

  const caPem = fs.readFileSync(f('ca.crt'), 'utf8');
  const caDer = Buffer.from(asn1.toDer(pki.certificateToAsn1(pki.certificateFromPem(caPem))).getBytes(), 'binary');
  return { key: fs.readFileSync(f('server.key.pem')), cert: fs.readFileSync(f('server.crt.pem')), caPem, caDer, sans, createdCa, renewed };
}

/** Issues a throw-away leaf for arbitrary names — used by tests to prove the name constraint is enforced. */
export function issueForTest(dir, sans) {
  const caKey = pki.privateKeyFromPem(fs.readFileSync(path.join(dir, 'ca.key.pem'), 'utf8'));
  const caCert = pki.certificateFromPem(fs.readFileSync(path.join(dir, 'ca.crt'), 'utf8'));
  const leaf = makeLeaf({ keys: { privateKey: caKey }, cert: caCert }, sans);
  return { key: pki.privateKeyToPem(leaf.keys.privateKey), cert: pki.certificateToPem(leaf.cert) };
}
