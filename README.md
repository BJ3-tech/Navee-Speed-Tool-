# Navee ST3 Pro – Speed-Tool (Web Bluetooth)

Ein schlankes Web-Bluetooth-Werkzeug, mit dem du dich per BLE mit einem Navee ST3 Pro
verbindest, das GATT-Profil erkundest und eine **Sollgeschwindigkeit von 20–50 km/h** als
Kommando sendest. Gedacht für **Tests auf geschlossenen Strecken / Privatgelände**.

> **Es gibt keine Store-App – das hier ist eine statische Web-App.** Sie läuft in
> Chrome/Edge auf Android oder Desktop. Keine Installation, kein Build nötig.

---

## ⚠️ Sicherheit & Recht (bitte lesen)

- **Nur auf geschlossener Strecke / Privatgelände.** Über die Werkseinstellung hinaus
  betriebene Scooter können Bremsen, Reifen, Motor und Rahmen überlasten.
- In Deutschland (eKFV/StVO) und vielen EU-Ländern macht eine Entdrosselung den Scooter
  **nicht mehr zulassungs-/versicherungsfähig** für den öffentlichen Verkehr.
- Entdrosseln lässt in der Regel die **Garantie erlöschen**.
- Trag Helm und Schutzausrüstung. Taste dich in kleinen Schritten heran.

Du bist für den Einsatz selbst verantwortlich.

---

## Warum du das Protokoll selbst eintragen musst

Das genaue Navee-BLE-Frameformat (Service-/Characteristic-UUIDs, Kommando-Aufbau,
evtl. Verschlüsselung) ist **nicht öffentlich verifiziert** und hier bewusst **nicht**
fest eincodiert. Erfundene Befehlsbytes oder Keys würden nur nicht funktionieren.

Stattdessen gibt dir die App alle Bausteine, um das reale Protokoll einzuhängen:

1. **GATT-Explorer** – listet Dienste + Characteristics deines Scooters auf.
2. **Kommando-Template** – du beschreibst das Frame als Hex mit Platzhaltern.
3. **Checksummen-Modul** – gängige Verfahren (XOR8, SUM8, SUM16, Ninebot) integriert.

### Woher bekomme ich das reale Frame?

Übliche Wege, das Protokoll eines eigenen Geräts zu analysieren:

- **Android HCI-Snoop-Log** aktivieren (Entwickleroptionen → „Bluetooth-HCI-Snoop-Log"),
  mit der offiziellen Navee-App einmal die Geschwindigkeit/Modus ändern, Log mit
  Wireshark öffnen und die `ATT Write`-Pakete auf der Write-Characteristic ansehen.
- **nRF Connect** (Nordic): verbinden, Characteristic mit `WRITE` suchen, Werte
  beobachten/nachspielen.
- Bestehende Reverse-Engineering-Projekte zum ST3 Pro als Referenz.

Trag die gefundenen Werte in Abschnitt 3 der App ein (Write-UUID + Template + Checksumme).

---

## Kommando-Template-Syntax

Hex-Bytes, Trennung per Leerzeichen/`:`/`,` egal. Platzhalter:

| Platzhalter   | Bedeutung                                                        |
|---------------|------------------------------------------------------------------|
| `{speed}`     | 1 Byte: Geschwindigkeit in km/h (0–255)                          |
| `{speed_lo}`  | Low-Byte von `speed × Skalierung`                                |
| `{speed_hi}`  | High-Byte von `speed × Skalierung`                               |
| `{len}`       | Anzahl Bytes zwischen diesem Byte und der Checksumme             |
| `{chk}`       | hier wird die berechnete Checksumme eingesetzt (1–2 Byte)        |

**Beispiel** (Platzhalter – nicht als korrekt bestätigt):

```
5A A5 02 20 7D {speed} {chk}
```

mit Checksumme `XOR8`, Bereich „nach Header", Header-Länge `2` ergäbe für 30 km/h ein
konkretes Byte-Array, das du in der Vorschau siehst, bevor du sendest.

---

## Starten

Web Bluetooth braucht einen **sicheren Kontext** (HTTPS oder `localhost`). Drei Optionen:

### A) Lokal mit Python
```bash
cd Navee-Speed-Tool-
python3 -m http.server 8080
# dann im Chrome öffnen: http://localhost:8080
```
Für das Handy im selben WLAN geht `http://<PC-IP>:8080` **nicht** (kein sicherer Kontext).
Nutze dafür Option B oder C.

### B) GitHub Pages (HTTPS, fürs Handy ideal)
Repo-Root per GitHub Pages ausliefern (Settings → Pages → Branch `main`, Ordner `/ (root)`) → die `https://…`-URL
direkt im Android-Chrome öffnen.

### C) Tunnel
```bash
npx serve .        # oder: python3 -m http.server 8080
# in zweitem Terminal z.B.:  npx localtunnel --port 8080
```

---

## Bedienung (Kurz)

1. **Verbinden** (Service-UUID leer lassen, wenn unbekannt).
2. **Dienste scannen** → unter jeder Characteristic „→ Write" / „→ Notify" übernehmen.
3. **Template & Checksumme** in Abschnitt 3 an das reale Protokoll anpassen.
4. **Slider** auf 20–50 km/h, **Vorschau** prüfen.
5. Sicherheits-Checkbox (ab >25 km/h), **„An Scooter senden"**.

Die Konfiguration wird lokal im Browser gespeichert.

---

## Projektstruktur

```
Navee-Speed-Tool-/
├─ index.html          UI
├─ css/style.css       Styling (dark, mobil)
├─ js/protocol.js      Kommando-Encoder (Template + Checksummen)
├─ js/ble.js           Web-Bluetooth-Transport (Connect/Discover/Write/Notify)
├─ js/app.js           UI-Logik
└─ test/protocol.test.mjs  Encoder-Tests (node --test)
```

## Encoder-Tests

```bash
node --test test/protocol.test.mjs
```
