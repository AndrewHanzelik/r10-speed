# R10 Speed

A small, static Web Bluetooth client for the Garmin Approach R10. It is focused on **dry/practice swings without a golf ball** and displays the club data the R10 reports directly.

The site has no backend, no account, and no runtime dependencies. After the page loads, R10 communication happens directly between the browser and the launch monitor over Bluetooth LE.

## Current status

The protocol/framing/parser implementation is covered by automated tests, including a real R10 firmware 4.50 no-ball practice-swing capture from the open-source R10Kit project. The fixture decodes clubhead speed, club path, attack angle, and swing timing.

The remaining validation step is an end-to-end test with a physical R10 through an iPhone Web Bluetooth browser. Browser BLE behavior can differ from native CoreBluetooth, so treat the first hardware session as integration testing.

## What it shows

- Clubhead speed in mph
- Club path
- Attack angle
- Swing tempo
- Session average
- Session fastest speed
- Recent swing history
- Optional spoken speed after every captured swing

No golf ball is required for the practice-swing metrics above. Metrics that inherently require a ball, such as ball speed, launch, and spin, are not part of this UI.

## iPhone requirements

Safari on iOS does not currently expose Web Bluetooth to normal web pages. Use a Web Bluetooth-capable iOS browser such as **Bluefy**.

You need:

1. Garmin Approach R10
2. iPhone with Bluetooth enabled
3. A Web Bluetooth-capable browser
4. This site served over HTTPS (GitHub Pages works well)

Do not keep Garmin Golf or another R10 client actively connected at the same time.

## Use

1. Power on the R10 and place it normally behind the hitting area.
2. Open the deployed site in your Web Bluetooth browser.
3. Tap **Connect R10**.
4. Select the Approach R10 from the Bluetooth picker.
5. Wait until the status reads **Ready**.
6. Make a normal dry swing in the R10's detection area.
7. The latest speed and club metrics should update automatically.

Enable **Speak speed** if you want the phone to announce each result without looking at the screen.

## GitHub Pages deployment

The included workflow runs the protocol tests and deploys the static files whenever `main` is updated.

For a new repository, the one-time setup is:

1. Create a public GitHub repository, e.g. `r10-speed`, or use a GitHub plan that supports Pages for private repositories.
2. Put these files on the `main` branch.
3. Open **Settings → Pages** in GitHub.
4. Set the Pages source to **GitHub Actions** if GitHub has not already selected it.
5. Run or re-run the **Test and deploy GitHub Pages** workflow.

The resulting URL will normally be:

```text
https://<username>.github.io/r10-speed/
```

## Local development

There are no npm dependencies. Node is used only for tests.

```bash
npm test
```

You can serve the project with any basic static HTTP server for desktop development. Web Bluetooth requires a secure context; browsers generally treat `localhost` as secure for development, while the phone deployment should use HTTPS.

To reveal a fake-swing button for UI testing, add `?demo=1` to the URL.

## Architecture

```text
R10
  ↓ Bluetooth LE
Web Bluetooth browser
  ↓
R10 BLE transport
  ├─ proprietary GATT service
  ├─ R10 session handshake
  ├─ COBS framing
  ├─ CRC-16/ARC
  └─ request/ack handling
  ↓
R10 protobuf parser
  ↓
Normalized swing metrics
  ↓
Static browser UI
```

Important code lives in:

- `src/r10/ble.js` — Web Bluetooth connection, handshake, requests, acknowledgements
- `src/r10/framing.js` — COBS, CRC, outer framing, BLE chunking
- `src/r10/proto.js` — minimal dependency-free protobuf encoder/decoder and R10 messages
- `src/main.js` — session/UI behavior
- `tests/` — framing, request-byte, and captured practice-swing regression tests

## Privacy

This project contains no analytics or backend. Swing data is processed in the browser and is not uploaded by the application. The only persisted setting is the speak-speed preference in browser local storage. Session swings are held in memory and disappear when the page is reloaded.

## Protocol attribution

The R10 protocol implementation is based on reverse-engineering work from:

- OSSGolf `unofficial-r10-ios-sdk` / R10Kit
- Matthew Holowczak's `mholow/gsp-r10-adapter`

Both are MIT licensed. See `THIRD_PARTY_NOTICES.md`.

This project is unofficial and is not affiliated with or endorsed by Garmin.
