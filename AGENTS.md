# AGENTS.md

## Project goal

Keep this project a small, static, mobile-first Web Bluetooth client for Garmin Approach R10 practice swings. Do not introduce a backend, account system, database, native iOS wrapper, or large framework unless a concrete requirement makes one necessary.

## Validation

Before changing R10 transport or parsing code, run:

```bash
npm test
```

The real firmware 4.50 practice-swing fixture is a regression boundary. Never change parser behavior in a way that breaks that fixture merely to make synthetic data cleaner.

## R10 transport invariants

- Proprietary service: `6A4E2800-667B-11E3-949A-0800200C9A66`
- Notify characteristic: `6A4E2812-667B-11E3-949A-0800200C9A66`
- Write characteristic: `6A4E2822-667B-11E3-949A-0800200C9A66`
- The R10 does not reliably advertise the proprietary service, so device selection is name-based and the service is requested as an optional service.
- Subscribe to notifications before starting the R10 session handshake.
- The initial session handshake is not an ordinary framed protobuf message.
- After handshake, preserve the R10 session byte as the first byte of each BLE transport chunk.
- Encoded outer frames are split into at most 19 data bytes per BLE write plus the one-byte session header.
- Outer frames use CRC-16/ARC and COBS with zero-byte frame delimiters.
- Inbound protocol messages must be acknowledged. Do not remove ACK handling as "unused" traffic.
- The application intentionally allows only one outbound protocol request at a time during priming.
- R10 firmware 4.50 has been observed encoding alert type as a one-byte length-delimited value instead of the canonical protobuf varint. Continue accepting both forms.
- Clubhead speed is reported in meters/second and converted to mph with `2.2369362920544`.

## Prime sequence

After the transport handshake, keep the known-good sequence:

1. Wake up
2. Alert-support query
3. Status
4. Tilt
5. Shot configuration
6. Subscribe to activity-start, activity-stop, and launch-monitor alerts

If changing the sequence, document the reason and validate it against hardware.

## UI scope

Prioritize quick outdoor/range use on a phone:

- Large latest-speed number
- Minimal taps
- Voice speed readout
- Clear connected/ready/error state
- Session summary

Avoid adding UI complexity before the physical R10 connection path is proven on iPhone.
