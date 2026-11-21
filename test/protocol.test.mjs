import { test } from 'node:test';
// Nicht-strikte Variante: vermeidet Prototyp-Mismatch bei Arrays aus der vm-Sandbox.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

// protocol.js hängt sich an `window` – hier ein Shim, um es in Node zu laden.
const here = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(here, '..', 'js', 'protocol.js'), 'utf8');
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const P = sandbox.window.NaveeProtocol;

test('parseHex akzeptiert verschiedene Trenner', () => {
  assert.deepEqual(P.parseHex('5A A5'), [0x5a, 0xa5]);
  assert.deepEqual(P.parseHex('5a:a5,20'), [0x5a, 0xa5, 0x20]);
  assert.deepEqual(P.parseHex('0x5A 0xA5'), [0x5a, 0xa5]);
});

test('parseHex wirft bei Unsinn', () => {
  assert.throws(() => P.parseHex('ZZ'));
});

test('{speed} wird eingesetzt und geclamped', () => {
  const r = P.buildCommand({ template: 'AA {speed} BB', speed: 30, checksum: 'none' });
  assert.deepEqual(r.bytes, [0xaa, 30, 0xbb]);
  const hi = P.buildCommand({ template: '{speed}', speed: 999, checksum: 'none' });
  assert.deepEqual(hi.bytes, [255]);
});

test('{speed_lo}/{speed_hi} mit Skalierung', () => {
  // 30 km/h * 100 = 3000 = 0x0BB8 -> lo=B8 hi=0B
  const r = P.buildCommand({ template: '{speed_lo} {speed_hi}', speed: 30, scale: 100, checksum: 'none' });
  assert.deepEqual(r.bytes, [0xb8, 0x0b]);
});

test('XOR8-Checksumme über alle Bytes', () => {
  const r = P.buildCommand({ template: '01 02 {speed} {chk}', speed: 0x04, checksum: 'xor8' });
  // 01 ^ 02 ^ 04 = 07
  assert.deepEqual(r.bytes, [0x01, 0x02, 0x04, 0x07]);
});

test('SUM8-Checksumme', () => {
  const r = P.buildCommand({ template: '10 20 {chk}', speed: 0, checksum: 'sum8' });
  assert.deepEqual(r.bytes, [0x10, 0x20, 0x30]);
});

test('Checksumme nur nach Header', () => {
  // Header 2 Bytes übersprungen: chk über [03,04] = 07 (xor)
  const r = P.buildCommand({
    template: '5A A5 03 04 {chk}', speed: 0, checksum: 'xor8',
    checksumScope: 'after_header', checksumHeaderLen: 2,
  });
  assert.deepEqual(r.bytes, [0x5a, 0xa5, 0x03, 0x04, 0x07]);
});

test('SUM16_LE liefert 2 Bytes little-endian', () => {
  // Summe = 0x01+0xFF+0x01 = 0x0101 -> lo=01 hi=01
  const r = P.buildCommand({ template: '01 FF 01 {chk}', speed: 0, checksum: 'sum16_le' });
  assert.deepEqual(r.bytes, [0x01, 0xff, 0x01, 0x01, 0x01]);
});

test('Ninebot-Checksumme: (~Summe)&0xFFFF little-endian', () => {
  // Summe=0x03 -> ~=0xFFFC -> lo=FC hi=FF
  const r = P.buildCommand({ template: '01 02 {chk}', speed: 0, checksum: 'ninebot' });
  assert.deepEqual(r.bytes, [0x01, 0x02, 0xfc, 0xff]);
});

test('{len} zählt Bytes bis zur Checksumme', () => {
  // nach {len} folgen 03,04,{speed} -> 3 Bytes
  const r = P.buildCommand({ template: 'A5 {len} 03 04 {speed} {chk}', speed: 0x09, checksum: 'none' });
  assert.deepEqual(r.bytes, [0xa5, 0x03, 0x03, 0x04, 0x09]);
});

test('unbekannter Platzhalter wirft', () => {
  assert.throws(() => P.buildCommand({ template: '{bogus}', speed: 1, checksum: 'none' }));
});
