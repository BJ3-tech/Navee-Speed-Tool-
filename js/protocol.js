/*
 * protocol.js — Konfigurierbarer BLE-Kommando-Encoder für den Navee ST3 Pro (und ähnliche Scooter).
 *
 * WICHTIG / EHRLICH:
 * Das exakte Navee-Frameformat (Header, Adressen, Kommando-ID, Verschlüsselung) ist in dieser App
 * NICHT fest verdrahtet, weil es nicht öffentlich verifiziert vorliegt. Du trägst das reale Protokoll
 * über ein Template ein (siehe UI). Dieser Encoder baut daraus die zu sendenden Bytes inkl. Checksumme.
 *
 * Template-Syntax (Hex, Leerzeichen/Doppelpunkte egal):
 *   - Feste Bytes:   "5A A5 20 7D"
 *   - Platzhalter:
 *       {speed}        -> 1 Byte: Sollgeschwindigkeit in km/h (0..255)
 *       {speed_lo}     -> Low-Byte von (speed * {scale})
 *       {speed_hi}     -> High-Byte von (speed * {scale})
 *       {len}          -> Anzahl Bytes zwischen diesem Platzhalter und der Checksumme
 *       {chk}          -> hier wird die berechnete Checksumme eingefügt (1 oder 2 Byte, je nach Modus)
 *
 * Beispiel-Template (Platzhalter – NICHT als korrekt bestätigt!):
 *   "5A A5 02 20 7D {speed} {chk}"
 */

const ChecksumMode = Object.freeze({
  NONE: 'none',
  SUM8: 'sum8',           // (Summe aller Bytes) & 0xFF
  XOR8: 'xor8',           // XOR aller Bytes
  SUM16_LE: 'sum16_le',   // 16-Bit-Summe, little-endian (2 Byte)
  NINEBOT: 'ninebot',     // Ninebot/Xiaomi-Stil: (~Summe) & 0xFFFF, little-endian (2 Byte)
});

function parseHex(str) {
  const cleaned = String(str).replace(/0x/gi, ' ').replace(/[,:]/g, ' ');
  const tokens = cleaned.trim().split(/\s+/).filter(Boolean);
  const bytes = [];
  for (const t of tokens) {
    if (!/^[0-9a-fA-F]{1,2}$/.test(t)) {
      throw new Error(`Ungültiges Hex-Byte: "${t}"`);
    }
    bytes.push(parseInt(t, 16) & 0xff);
  }
  return bytes;
}

function toHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function computeChecksum(bytes, mode) {
  switch (mode) {
    case ChecksumMode.NONE:
      return [];
    case ChecksumMode.SUM8: {
      let s = 0;
      for (const b of bytes) s = (s + b) & 0xff;
      return [s];
    }
    case ChecksumMode.XOR8: {
      let x = 0;
      for (const b of bytes) x ^= b;
      return [x & 0xff];
    }
    case ChecksumMode.SUM16_LE: {
      let s = 0;
      for (const b of bytes) s = (s + b) & 0xffff;
      return [s & 0xff, (s >> 8) & 0xff];
    }
    case ChecksumMode.NINEBOT: {
      let s = 0;
      for (const b of bytes) s = (s + b) & 0xffff;
      const c = (~s) & 0xffff;
      return [c & 0xff, (c >> 8) & 0xff];
    }
    default:
      throw new Error(`Unbekannter Checksummen-Modus: ${mode}`);
  }
}

/**
 * Baut das Kommando aus dem Template.
 * @param {Object} opts
 * @param {string} opts.template   Hex-Template mit Platzhaltern
 * @param {number} opts.speed      Sollgeschwindigkeit in km/h
 * @param {number} [opts.scale=1]  Skalierung für {speed_lo}/{speed_hi} (z.B. 100 => km/h*100)
 * @param {string} [opts.checksum] ChecksumMode
 * @param {('all'|'after_header')} [opts.checksumScope='all']  Welche Bytes in die Checksumme eingehen
 * @param {number} [opts.checksumHeaderLen=0] Bei 'after_header': so viele führende Bytes überspringen
 * @returns {{bytes:number[], hex:string}}
 */
function buildCommand(opts) {
  const {
    template,
    speed,
    scale = 1,
    checksum = ChecksumMode.NONE,
    checksumScope = 'all',
    checksumHeaderLen = 0,
  } = opts;

  if (!Number.isFinite(speed)) throw new Error('speed muss eine Zahl sein');
  const sp = Math.max(0, Math.min(255, Math.round(speed)));
  const scaled = Math.round(speed * scale);
  const spLo = scaled & 0xff;
  const spHi = (scaled >> 8) & 0xff;

  // Template in Tokens zerlegen (Platzhalter vs. Hex-Gruppen)
  const rawTokens = template.match(/\{[a-z_]+\}|[^{}\s]+/gi) || [];

  // Erst alles außer {chk} auflösen, {chk}-Position merken.
  const pre = [];      // Bytes vor der Checksumme
  const post = [];     // Bytes nach der Checksumme (selten, aber möglich)
  let chkSeen = false;
  let lenPlaceholderIndex = -1;

  for (const tok of rawTokens) {
    const low = tok.toLowerCase();
    if (low === '{chk}') {
      chkSeen = true;
      continue;
    }
    let bytes;
    if (low === '{speed}') bytes = [sp];
    else if (low === '{speed_lo}') bytes = [spLo];
    else if (low === '{speed_hi}') bytes = [spHi];
    else if (low === '{len}') {
      bytes = [0]; // Platzhalter, wird unten nachgetragen
      if (!chkSeen) lenPlaceholderIndex = pre.length;
    } else if (/^\{.+\}$/.test(low)) {
      throw new Error(`Unbekannter Platzhalter: ${tok}`);
    } else {
      bytes = parseHex(tok);
    }
    (chkSeen ? post : pre).push(...bytes);
  }

  // {len}: Anzahl Bytes zwischen dem len-Byte (exklusiv) und der Checksumme (exklusiv)
  if (lenPlaceholderIndex >= 0) {
    const count = pre.length - (lenPlaceholderIndex + 1);
    pre[lenPlaceholderIndex] = count & 0xff;
  }

  // Checksummen-Eingabebytes bestimmen
  let chkInput = pre;
  if (checksumScope === 'after_header') {
    chkInput = pre.slice(checksumHeaderLen);
  }
  const chk = chkSeen ? computeChecksum(chkInput, checksum) : [];

  const bytes = [...pre, ...chk, ...post];
  return { bytes, hex: toHex(bytes) };
}

// Export für Browser (global) – kein Modul-Bundler nötig.
window.NaveeProtocol = { ChecksumMode, parseHex, toHex, computeChecksum, buildCommand };
