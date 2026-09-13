import assert from "node:assert/strict";
import test from "node:test";
import {
	FrameAssembler,
	crc16,
	buildAckPayload,
	buildProtoRequestPayload,
	chunkFrame,
	cobsDecode,
	cobsEncode,
	decodeOuter,
	encodeOuter,
} from "../src/r10/framing.js";


test("CRC-16/ARC matches the standard known vector", () => {
	const bytes = new TextEncoder().encode("123456789");
	assert.equal(crc16(bytes), 0xBB3D);
});

test("COBS round-trips data with embedded zeroes", () => {
	const input = Uint8Array.from([1, 2, 0, 3, 0, 0, 4, 5, 6]);
	assert.deepEqual(cobsDecode(cobsEncode(input)), input);
});

test("outer frame round-trips and validates CRC", () => {
	const payload = Uint8Array.from([0xB3, 0x13, 1, 2, 3, 0, 9]);
	const encoded = encodeOuter(payload);
	assert.equal(encoded[0], 0);
	assert.equal(encoded.at(-1), 0);
	assert.deepEqual(decodeOuter(encoded.slice(1, -1)), payload);
});

test("frame assembler reconstructs a frame split over BLE chunks", () => {
	const assembler = new FrameAssembler();
	assembler.markHandshakeComplete();
	const payload = Uint8Array.from([0xB3, 0x13, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	const chunks = chunkFrame(encodeOuter(payload), 0x2A);
	const outputs = chunks.flatMap((chunk) => assembler.feed(chunk));
	assert.equal(outputs.length, 1);
	assert.equal(outputs[0].type, "payload");
	assert.deepEqual(outputs[0].payload, payload);
});

test("builds R10 protobuf envelopes and ACK payloads", () => {
	const proto = Uint8Array.from([0xF2, 0x01, 0x00]);
	const request = buildProtoRequestPayload(7, proto);
	assert.deepEqual(Array.from(request.slice(0, 2)), [0xB3, 0x13]);
	assert.deepEqual(Array.from(request.slice(2, 6)), [7, 0, 0, 0]);
	assert.equal(request.length, 16 + proto.length);

	const ack = buildAckPayload(request);
	assert.deepEqual(Array.from(ack.slice(0, 7)), [0x88, 0x13, 0xB3, 0x13, 0x00, 0x07, 0x00]);
	assert.equal(ack.length, 14);
});
