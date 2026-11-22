/*
 * ble.js — Web-Bluetooth-Verbindungsmanager.
 * Kümmert sich um Scan/Connect, GATT-Discovery, Schreiben und Notifications.
 * Reines Transport-Layer, kein Protokollwissen.
 *
 * WICHTIG (Web-Bluetooth-Einschränkung): Der Browser gibt nur Zugriff auf Services, deren UUID
 * VOR dem Verbinden in `optionalServices` angemeldet wurde. Unbekannte Services sind unsichtbar.
 * Darum meldet connect() eine breite Kandidatenliste + frei eintragbare Extra-UUIDs an.
 */

const BASE_UUID_SUFFIX = '-0000-1000-8000-00805f9b34fb';

/** Gängige Service-UUIDs von BLE-Scootern/UART-Bridges, die wir "auf Verdacht" anmelden. */
const CANDIDATE_SERVICES = [
  '0x1800', '0x1801', '0x180a', '0x180f',                     // Standard (Generic Access, Device Info, Battery)
  '0xfff0', '0xffe0', '0xffe5', '0xffd0', '0xffb0', '0xffc0', // häufige Hersteller-UART-Dienste
  '0xff00', '0xff10', '0xfee0', '0xfee7', '0xfe95', '0xae00', '0xabf0', '0xa000',
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e',                     // Nordic UART
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',                     // ISSC Transparent UART
  '00010203-0405-0607-0809-0a0b0c0d1910',                     // Telink
  '0000fff0-0000-1000-8000-00805f9b34fb',
  '0000d0ff-3c17-d293-8e48-14fe2e4da212',                     // beim ST3 Pro gefunden: B001 read, B002 write, B003 notify
  '87290102-3c51-43b1-a1a9-11b9dc38478b',                     // beim ST3 Pro gefunden: nur read
];

/** "fff0" / "0xfff0" / "0000fff0-…" -> kanonische 128-Bit-UUID (lowercase) oder null. */
function normalizeUuid(input) {
  if (input == null) return null;
  const s = String(input).trim().toLowerCase().replace(/^0x/, '');
  if (/^[0-9a-f]{4}$/.test(s)) return `0000${s}${BASE_UUID_SUFFIX}`;
  if (/^[0-9a-f]{8}$/.test(s)) return `${s}${BASE_UUID_SUFFIX}`;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)) return s;
  return null;
}

const PROPERTY_NAMES = [
  'broadcast', 'read', 'writeWithoutResponse', 'write', 'notify', 'indicate',
  'authenticatedSignedWrites', 'reliableWrite', 'writableAuxiliaries',
];

class BleManager {
  constructor(logger) {
    this.log = logger || (() => {});
    this.device = null;
    this.server = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.onNotify = null;        // callback(DataView)
    this.onDisconnect = null;    // callback()
  }

  get isConnected() {
    return !!(this.server && this.server.connected);
  }

  _assertSupported() {
    if (!('bluetooth' in navigator)) {
      throw new Error(
        'Web Bluetooth wird hier nicht unterstützt. Nutze Chrome/Edge auf Android oder Desktop ' +
        '(iPhone: Bluefy-App) und öffne die Seite über HTTPS (oder localhost).'
      );
    }
  }

  /**
   * Verbindet. Ohne serviceUuid/namePrefix werden alle BLE-Geräte angezeigt (acceptAllDevices).
   * extraServices: zusätzliche UUIDs (kurz oder lang), die für den späteren Zugriff angemeldet werden.
   */
  async connect({ serviceUuid, namePrefix, extraServices = [] } = {}) {
    this._assertSupported();

    const primary = normalizeUuid(serviceUuid);
    if (serviceUuid && !primary) throw new Error(`Ungültige Service-UUID: "${serviceUuid}"`);

    const extras = [];
    for (const raw of extraServices) {
      const n = normalizeUuid(raw);
      if (!n) throw new Error(`Ungültige Extra-UUID: "${raw}"`);
      extras.push(n);
    }
    const candidates = CANDIDATE_SERVICES.map(normalizeUuid);
    const optionalServices = [...new Set([...(primary ? [primary] : []), ...extras, ...candidates])];

    const filters = [];
    // Service-UUID NICHT als Scan-Filter nutzen: viele Scooter kuendigen ihre Dienste nicht im Advertising an.
    if (namePrefix) filters.push({ namePrefix });

    const requestOpts = filters.length
      ? { filters, optionalServices }
      : { acceptAllDevices: true, optionalServices };

    this.log('Öffne Geräteauswahl …');
    this.device = await navigator.bluetooth.requestDevice(requestOpts);
    this.log(`Gerät gewählt: ${this.device.name || '(ohne Namen)'} [${this.device.id}]`);

    // Chrome liefert für dasselbe physische Geraet oft dasselbe BluetoothDevice-Objekt zurueck,
    // auch bei einem neuen requestDevice()-Aufruf. Ohne das hier wuerden sich bei jedem erneuten
    // Verbinden weitere Listener aufstapeln und "Verbindung getrennt" mehrfach geloggt werden.
    if (this._onGattDisconnected) {
      this.device.removeEventListener('gattserverdisconnected', this._onGattDisconnected);
    }
    this._onGattDisconnected = () => {
      this.log('⚠️ Verbindung getrennt.');
      this.writeChar = null;
      this.notifyChar = null;
      if (this.onDisconnect) this.onDisconnect();
    };
    this.device.addEventListener('gattserverdisconnected', this._onGattDisconnected);

    this.log('Verbinde mit GATT-Server …');
    this.server = await this.device.gatt.connect();
    this.log('✅ Verbunden.');
    return this.device;
  }

  async disconnect() {
    if (this.device && this.device.gatt.connected) {
      this.device.gatt.disconnect();
    }
  }

  /** Listet alle ANGEMELDETEN Services + Characteristics auf (GATT-Explorer). */
  async discover() {
    if (!this.isConnected) throw new Error('Nicht verbunden.');
    let services = [];
    try {
      services = await this.server.getPrimaryServices();
    } catch (e) {
      // Chrome wirft NotFoundError, wenn keiner der angemeldeten Services existiert.
      this.log(`ℹ️ ${e.name}: ${e.message}`);
    }
    const result = [];
    for (const svc of services) {
      let chars = [];
      try {
        chars = await svc.getCharacteristics();
      } catch (e) {
        this.log(`  (Characteristics von ${svc.uuid} nicht lesbar: ${e.message})`);
      }
      result.push({
        uuid: svc.uuid,
        characteristics: chars.map((c) => ({
          uuid: c.uuid,
          // Chrome liefert die Flags als Prototyp-Getter (Object.entries waere leer) -> Namen explizit abfragen.
          properties: PROPERTY_NAMES.filter((k) => c.properties && c.properties[k]),
        })),
      });
    }
    return result;
  }

  async _getChar(serviceUuid, charUuid) {
    const svc = await this.server.getPrimaryService(normalizeUuid(serviceUuid) || serviceUuid);
    return svc.getCharacteristic(normalizeUuid(charUuid) || charUuid);
  }

  /** Richtet die Schreib-Characteristic ein. */
  async setupWrite(serviceUuid, charUuid) {
    this.writeChar = await this._getChar(serviceUuid, charUuid);
    this.log(`Schreib-Characteristic bereit: ${charUuid}`);
  }

  /**
   * Abonniert Notifications (für Status/ACK vom Scooter).
   * Direkt nach dem Verbinden lehnt Chrome auf macOS startNotifications() manchmal kurzzeitig mit
   * "NotSupportedError: GATT operation failed for unknown reason" ab (CoreBluetooth braucht einen
   * Moment, bis der GATT-Cache des Geräts bereitsteht). Darum hier ein paar Wiederholungsversuche.
   */
  async setupNotify(serviceUuid, charUuid, { retries = 4, delayMs = 400 } = {}) {
    this.notifyChar = await this._getChar(serviceUuid, charUuid);
    for (let attempt = 1; ; attempt++) {
      try {
        await this.notifyChar.startNotifications();
        break;
      } catch (e) {
        if (attempt > retries) throw e;
        this.log(`Notify-Versuch ${attempt} fehlgeschlagen (${e.name || e}), versuche erneut …`);
        await new Promise((r) => setTimeout(r, delayMs * attempt));
      }
    }
    this.notifyChar.addEventListener('characteristicvaluechanged', (ev) => {
      if (this.onNotify) this.onNotify(ev.target.value);
    });
    this.log(`Notifications abonniert: ${charUuid}`);
  }

  /** Schreibt Bytes. withResponse=false nutzt Write-Without-Response (oft nötig bei Scootern). */
  async write(bytes, { withResponse = true } = {}) {
    if (!this.writeChar) throw new Error('Keine Schreib-Characteristic eingerichtet.');
    const data = Uint8Array.from(bytes);
    if (withResponse && this.writeChar.properties.write) {
      await this.writeChar.writeValueWithResponse(data);
    } else if (this.writeChar.properties.writeWithoutResponse) {
      await this.writeChar.writeValueWithoutResponse(data);
    } else {
      // Fallback
      await this.writeChar.writeValue(data);
    }
  }
}

window.BleManager = BleManager;
window.BleManager.normalizeUuid = normalizeUuid;
