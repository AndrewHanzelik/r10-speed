# R10 Speed

A small, static Web Bluetooth client for the Garmin Approach R10. It supports both dry/practice swings and normal shots with a ball.

The site has no backend, no account, and no runtime dependencies. After the page loads, R10 communication happens directly between the browser and the launch monitor over Bluetooth LE.

## What it shows

For dry/practice swings, the app can show clubhead speed, club path, attack angle, swing tempo, session average/max, and recent history.

When ball data is present, it also shows ball speed, launch angle, launch direction, total spin, spin axis, and a locally calculated carry estimate. Carry is simulated from the measured launch conditions using a standard atmosphere and no wind; it is not Garmin Golf's proprietary carry number.

## Voice and sound feedback

Voice readout is configurable independently for:

- Club speed
- Ball speed
- Carry

The app only reads values that are available for the captured shot. Status tones for recording, successful capture, rejected swing, and error are always enabled after the user taps **Connect R10**. The app also uses full-page color feedback so the current radar state is visible from farther away.

## iPhone requirements

Safari on iOS does not currently expose Web Bluetooth to normal web pages. Use a Web Bluetooth-capable iOS browser such as **Bluefy**.

You need:

1. Garmin Approach R10
2. iPhone with Bluetooth enabled
3. A Web Bluetooth-capable browser
4. This site served over HTTPS

Do not keep Garmin Golf or another R10 client actively connected at the same time.

## Use

1. Power on the R10 and place it behind the hitting area.
2. Open the deployed site in Bluefy or another compatible browser.
3. Tap **Connect R10**.
4. Select the Approach R10 from the Bluetooth picker.
5. Wait until the status reads **Ready**.
6. Take a dry swing or hit a ball.
7. The latest metrics update automatically.

## Carry calculation

`src/carry.js` contains a carry-only golf-ball flight simulation adapted from the MIT-licensed OpenFairway aerodynamics model. It uses regulation golf-ball mass/radius, aerodynamic drag, Magnus lift, spin decay, the R10's ball speed/launch/spin data, standard air density, and no wind. Simulation stops at first ground contact, so rollout is intentionally excluded.

## GitHub Pages deployment

The included workflow runs automated tests and deploys the static files whenever `main` is updated. The tests include protocol framing, a real firmware 4.50 no-ball practice-swing fixture, ball-metric parsing, carry sanity checks, and JavaScript syntax checks for the browser entry points.

## Local development

There are no npm dependencies. Node is used only for tests.

```bash
npm test
```

To reveal a fake ball-shot button for UI testing, add `?demo=1` to the URL.

## Architecture

```text
R10
  ↓ Bluetooth LE
Web Bluetooth browser
  ↓
R10 BLE transport
  ↓
R10 protobuf parser
  ↓
Club + ball metrics
  ├─ UI/session history
  ├─ configurable voice readout
  └─ local carry simulation
```

Important code lives in:

- `src/r10/ble.js` — Web Bluetooth connection, handshake, requests, acknowledgements
- `src/r10/framing.js` — COBS, CRC, outer framing, BLE chunking
- `src/r10/proto.js` — minimal dependency-free protobuf encoder/decoder and R10 messages
- `src/carry.js` — local carry-only ball-flight simulation
- `src/app.js` — session, UI, speech, and sound behavior
- `tests/` — protocol, ball-data, and carry regression tests

## Privacy

This project contains no analytics or backend. Swing data is processed in the browser and is not uploaded by the application. Readout preferences are stored only in browser local storage. Session swings are held in memory and disappear when the page is reloaded.

## Attribution

The R10 protocol implementation is based on reverse-engineering work from OSSGolf R10Kit and Matthew Holowczak's `mholow/gsp-r10-adapter`. Carry physics are adapted from `digitalhand/openfairway`. These projects are MIT licensed; see `THIRD_PARTY_NOTICES.md`.

This project is unofficial and is not affiliated with or endorsed by Garmin.
