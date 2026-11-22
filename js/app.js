/* app.js — UI-Verdrahtung. */
(function () {
  'use strict';

  const { buildCommand, toHex, ChecksumMode } = window.NaveeProtocol;

  const $ = (id) => document.getElementById(id);
  const logEl = $('log');

  function log(msg) {
    const ts = new Date().toLocaleTimeString();
    logEl.textContent += `[${ts}] ${msg}\n`;
    logEl.scrollTop = logEl.scrollHeight;
  }


  // Bluefy/WebBLE liefern teils Fehler ohne .message -> immer etwas Lesbares ausgeben.
  function errText(e) {
    if (e == null) return '(unbekannter Fehler)';
    if (typeof e === 'string') return e;
    const parts = [e.name, e.message].filter(Boolean);
    return parts.length ? parts.join(': ') : String(e);
  }

  const ble = new window.BleManager(log);

  // ---------- Konfiguration laden/speichern ----------
  const CONFIG_KEY = 'navee_speed_cfg_v1';
  const defaultCfg = {
    serviceUuid: '',
    writeCharUuid: '',
    notifyCharUuid: '',
    namePrefix: '',
    extraServices: '',
    template: '5A A5 02 20 7D {speed} {chk}',
    checksum: ChecksumMode.XOR8,
    checksumScope: 'all',
    checksumHeaderLen: 2,
    scale: 1,
    withResponse: false,
  };

  function loadCfg() {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      if (raw) return { ...defaultCfg, ...JSON.parse(raw) };
    } catch (e) { /* ignore */ }
    return { ...defaultCfg };
  }
  function saveCfg(cfg) {
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
  }

  function readFormCfg() {
    return {
      serviceUuid: $('serviceUuid').value.trim().toLowerCase(),
      writeCharUuid: $('writeCharUuid').value.trim().toLowerCase(),
      notifyCharUuid: $('notifyCharUuid').value.trim().toLowerCase(),
      namePrefix: $('namePrefix').value.trim(),
      extraServices: $('extraServices').value.trim(),
      template: $('template').value.trim(),
      checksum: $('checksum').value,
      checksumScope: $('checksumScope').value,
      checksumHeaderLen: parseInt($('checksumHeaderLen').value, 10) || 0,
      scale: parseFloat($('scale').value) || 1,
      withResponse: $('withResponse').checked,
    };
  }

  function writeFormCfg(cfg) {
    $('serviceUuid').value = cfg.serviceUuid;
    $('writeCharUuid').value = cfg.writeCharUuid;
    $('notifyCharUuid').value = cfg.notifyCharUuid;
    $('namePrefix').value = cfg.namePrefix;
    $('extraServices').value = cfg.extraServices || '';
    $('template').value = cfg.template;
    $('checksum').value = cfg.checksum;
    $('checksumScope').value = cfg.checksumScope;
    $('checksumHeaderLen').value = cfg.checksumHeaderLen;
    $('scale').value = cfg.scale;
    $('withResponse').checked = cfg.withResponse;
  }

  // ---------- Geschwindigkeits-Slider ----------
  function currentSpeed() {
    return parseInt($('speed').value, 10);
  }

  function updateSpeedUi() {
    const v = currentSpeed();
    $('speedValue').textContent = v;
    previewCommand();
  }

  function previewCommand() {
    try {
      const cfg = readFormCfg();
      const { hex } = buildCommand({
        template: cfg.template,
        speed: currentSpeed(),
        scale: cfg.scale,
        checksum: cfg.checksum,
        checksumScope: cfg.checksumScope,
        checksumHeaderLen: cfg.checksumHeaderLen,
      });
      $('preview').textContent = hex || '(leer)';
      $('preview').classList.remove('error');
    } catch (e) {
      $('preview').textContent = 'Fehler: ' + errText(e);
      $('preview').classList.add('error');
    }
  }

  // ---------- Status-UI ----------
  function setConnected(connected) {
    $('connectBtn').disabled = connected;
    $('disconnectBtn').disabled = !connected;
    $('discoverBtn').disabled = !connected;
    $('sendBtn').disabled = !connected;
    $('statusDot').className = connected ? 'dot on' : 'dot off';
    $('statusText').textContent = connected ? 'verbunden' : 'getrennt';
  }

  // ---------- Aktionen ----------
  async function doConnect() {
    const cfg = readFormCfg();
    saveCfg(cfg);
    try {
      await ble.connect({
        serviceUuid: cfg.serviceUuid || undefined,
        namePrefix: cfg.namePrefix || undefined,
        extraServices: cfg.extraServices.split(/[\s,;]+/).filter(Boolean),
      });
      setConnected(true);

      // Notify + Write einrichten, wenn UUIDs bekannt sind
      ble.onNotify = (dv) => {
        const bytes = [];
        for (let i = 0; i < dv.byteLength; i++) bytes.push(dv.getUint8(i));
        log('⇐ Notify: ' + toHex(bytes));
      };
      ble.onDisconnect = () => setConnected(false);

      if (cfg.serviceUuid && cfg.notifyCharUuid) {
        try { await ble.setupNotify(cfg.serviceUuid, cfg.notifyCharUuid); }
        catch (e) { log('Notify konnte nicht eingerichtet werden: ' + errText(e)); }
      }
      if (cfg.serviceUuid && cfg.writeCharUuid) {
        try { await ble.setupWrite(cfg.serviceUuid, cfg.writeCharUuid); }
        catch (e) { log('Schreib-Characteristic konnte nicht eingerichtet werden: ' + errText(e)); }
      } else {
        log('ℹ️ Service/Write-UUID noch nicht gesetzt — nutze "Dienste scannen", um sie zu finden.');
      }
    } catch (e) {
      log('❌ Verbindung fehlgeschlagen: ' + errText(e));
      setConnected(false);
    }
  }

  async function doDisconnect() {
    await ble.disconnect();
    setConnected(false);
  }

  async function doDiscover() {
    try {
      log('Scanne GATT-Dienste …');
      const services = await ble.discover();
      const box = $('gatt');
      box.innerHTML = '';
      for (const svc of services) {
        const sEl = document.createElement('div');
        sEl.className = 'svc';
        sEl.innerHTML = `<div class="svc-head">Service <code>${svc.uuid}</code>
          <button data-uuid="${svc.uuid}" class="mini use-svc">als Service</button></div>`;
        for (const ch of svc.characteristics) {
          const cEl = document.createElement('div');
          cEl.className = 'char';
          cEl.innerHTML = `<code>${ch.uuid}</code> <span class="props">${ch.properties.join(', ')}</span>
            <span class="charbtns">
              <button class="mini use-write" data-svc="${svc.uuid}" data-uuid="${ch.uuid}">→ Write</button>
              <button class="mini use-notify" data-svc="${svc.uuid}" data-uuid="${ch.uuid}">→ Notify</button>
            </span>`;
          sEl.appendChild(cEl);
        }
        box.appendChild(sEl);
      }
      log(`Fertig: ${services.length} Dienst(e) gefunden.`);
      if (services.length === 0) {
        log('ℹ️ Keiner der angemeldeten Dienste existiert am Gerät. Ermittle die Service-UUIDs mit der App ' +
            '"nRF Connect" und trage sie unter "Zusätzliche Service-UUIDs" ein, dann neu verbinden.');
      }

      box.querySelectorAll('.use-svc').forEach((b) =>
        b.addEventListener('click', () => { $('serviceUuid').value = b.dataset.uuid; previewCommand(); }));
      box.querySelectorAll('.use-write').forEach((b) =>
        b.addEventListener('click', async () => {
          $('serviceUuid').value = b.dataset.svc; $('writeCharUuid').value = b.dataset.uuid; previewCommand();
          saveCfg(readFormCfg());
          // Sofort einrichten, falls noch verbunden (der Scooter trennt die Verbindung schnell).
          if (ble.isConnected) {
            try { await ble.setupWrite(b.dataset.svc, b.dataset.uuid); }
            catch (e) { log('❌ Write-Setup fehlgeschlagen: ' + errText(e)); }
          }
        }));
      box.querySelectorAll('.use-notify').forEach((b) =>
        b.addEventListener('click', async () => {
          $('serviceUuid').value = b.dataset.svc; $('notifyCharUuid').value = b.dataset.uuid;
          saveCfg(readFormCfg());
          if (ble.isConnected) {
            try { await ble.setupNotify(b.dataset.svc, b.dataset.uuid); }
            catch (e) { log('❌ Notify-Setup fehlgeschlagen: ' + errText(e)); }
          }
        }));
    } catch (e) {
      log('❌ Scan fehlgeschlagen: ' + errText(e));
    }
  }

  async function doSend() {
    const cfg = readFormCfg();
    saveCfg(cfg);

    if (!ble.writeChar) {
      if (cfg.serviceUuid && cfg.writeCharUuid) {
        try { await ble.setupWrite(cfg.serviceUuid, cfg.writeCharUuid); }
        catch (e) { log('❌ Write-Setup fehlgeschlagen: ' + errText(e)); return; }
      } else {
        log('❌ Bitte zuerst Service- und Write-Characteristic-UUID setzen (via "Dienste scannen").');
        return;
      }
    }

    const speed = currentSpeed();
    // Sicherheitsabfrage bei hohen Werten
    if (speed > 25 && !$('ackSafety').checked) {
      log('⛔ Werte über 25 km/h erfordern die Bestätigung der Sicherheits-Checkbox.');
      $('ackSafety').focus();
      return;
    }

    let cmd;
    try {
      cmd = buildCommand({
        template: cfg.template, speed, scale: cfg.scale,
        checksum: cfg.checksum, checksumScope: cfg.checksumScope,
        checksumHeaderLen: cfg.checksumHeaderLen,
      });
    } catch (e) {
      log('❌ Kommando-Bau fehlgeschlagen: ' + errText(e));
      return;
    }

    try {
      await ble.write(cmd.bytes, { withResponse: cfg.withResponse });
      log(`⇒ Gesendet (${speed} km/h): ${cmd.hex}`);
    } catch (e) {
      log('❌ Senden fehlgeschlagen: ' + errText(e));
    }
  }

  // ---------- Init ----------
  function init() {
    writeFormCfg(loadCfg());
    setConnected(false);
    updateSpeedUi();

    $('speed').addEventListener('input', updateSpeedUi);
    ['template', 'checksum', 'checksumScope', 'checksumHeaderLen', 'scale']
      .forEach((id) => $(id).addEventListener('input', () => { saveCfg(readFormCfg()); previewCommand(); }));
    ['serviceUuid', 'writeCharUuid', 'notifyCharUuid', 'namePrefix', 'extraServices', 'withResponse']
      .forEach((id) => $(id).addEventListener('change', () => saveCfg(readFormCfg())));

    $('connectBtn').addEventListener('click', doConnect);
    $('disconnectBtn').addEventListener('click', doDisconnect);
    $('discoverBtn').addEventListener('click', doDiscover);
    $('sendBtn').addEventListener('click', doSend);
    $('resetCfgBtn').addEventListener('click', () => {
      writeFormCfg({ ...defaultCfg });
      saveCfg({ ...defaultCfg });
      previewCommand();
      log('Konfiguration auf Standard zurückgesetzt.');
    });

    if (!('bluetooth' in navigator)) {
      log('⚠️ navigator.bluetooth fehlt. Nutze Chrome/Edge (Android/Desktop) über HTTPS oder localhost.');
    } else {
      log('Bereit. Tipp: zuerst verbinden, dann "Dienste scannen", um Service/Characteristics zu finden.');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
