export const R10_OPCODE = Object.freeze({
	PROTO_REQUEST: [0xB3, 0x13],
	PROTO_RESPONSE: [0xB4, 0x13],
	ACK: [0x88, 0x13],
});

export const HANDSHAKE_REQUEST = new Uint8Array([
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00,
]);

export const HANDSHAKE_RESPONSE_PREFIX = new Uint8Array([
	0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00,
]);

function concatBytes(...parts) {
	const length = parts.reduce((sum, part) => sum + part.length, 0);
	const output = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.length;
	}
	return output;
}

function writeUint16LE(value) {
	return new Uint8Array([value & 0xFF, (value >>> 8) & 0xFF]);
}

function writeUint32LE(value) {
	return new Uint8Array([
		value & 0xFF,
		(value >>> 8) & 0xFF,
		(value >>> 16) & 0xFF,
		(value >>> 24) & 0xFF,
	]);
}

export function readUint32LE(bytes, offset = 0) {
	return (
		(bytes[offset]) |
		(bytes[offset + 1] << 8) |
		(bytes[offset + 2] << 16) |
		(bytes[offset + 3] << 24)
	) >>> 0;
}

export function crc16(input) {
	let crc = 0;
	for (const byte of input) {
		let value = (crc ^ byte) & 0xFF;
		for (let bit = 0; bit < 8; bit += 1) {
			value = (value & 1) !== 0 ? (value >>> 1) ^ 0xA001 : value >>> 1;
		}
		crc = ((crc >>> 8) ^ value) & 0xFFFF;
	}
	return crc;
}

export function cobsEncode(input) {
	if (input.length === 0) {
		return new Uint8Array();
	}

	const output = [];
	let codeIndex = 0;
	let code = 1;
	output.push(0);

	for (const byte of input) {
		if (byte === 0) {
			output[codeIndex] = code;
			codeIndex = output.length;
			output.push(0);
			code = 1;
			continue;
		}

		output.push(byte);
		code += 1;
		if (code === 0xFF) {
			output[codeIndex] = 0xFF;
			codeIndex = output.length;
			output.push(0);
			code = 1;
		}
	}

	output[codeIndex] = code;
	return Uint8Array.from(output);
}

export function cobsDecode(input) {
	const output = [];
	let offset = 0;

	while (offset < input.length) {
		const code = input[offset];
		if (code === 0) {
			throw new Error("Invalid COBS frame: zero code byte");
		}

		const blockEnd = offset + code;
		if (blockEnd > input.length) {
			throw new Error("Invalid COBS frame: block exceeds input");
		}

		for (let i = offset + 1; i < blockEnd; i += 1) {
			if (input[i] === 0) {
				throw new Error("Invalid COBS frame: embedded zero");
			}
			output.push(input[i]);
		}

		offset = blockEnd;
		if (code !== 0xFF && offset < input.length) {
			output.push(0);
		}
	}

	return Uint8Array.from(output);
}

export function encodeOuter(payload) {
	if (payload.length > 0xFFFF - 4) {
		throw new Error("R10 payload exceeds 16-bit outer-frame length");
	}

	const declaredLength = payload.length + 4;
	const bodyWithoutCrc = concatBytes(writeUint16LE(declaredLength), payload);
	const crc = crc16(bodyWithoutCrc);
	const inner = concatBytes(bodyWithoutCrc, writeUint16LE(crc));
	return concatBytes(new Uint8Array([0]), cobsEncode(inner), new Uint8Array([0]));
}

export function decodeOuter(cobsBytes) {
	const decoded = cobsDecode(cobsBytes);
	if (decoded.length < 4) {
		throw new Error("R10 frame is too short");
	}

	const declaredLength = decoded[0] | (decoded[1] << 8);
	if (declaredLength !== decoded.length) {
		throw new Error(`R10 frame length mismatch: expected ${declaredLength}, got ${decoded.length}`);
	}

	const crcOffset = decoded.length - 2;
	const body = decoded.slice(0, crcOffset);
	const expectedCrc = crc16(body);
	const actualCrc = decoded[crcOffset] | (decoded[crcOffset + 1] << 8);
	if (expectedCrc !== actualCrc) {
		throw new Error("R10 frame CRC mismatch");
	}

	return decoded.slice(2, crcOffset);
}

export function chunkFrame(encoded, sessionByte) {
	const chunks = [];
	for (let offset = 0; offset < encoded.length; offset += 19) {
		const body = encoded.slice(offset, offset + 19);
		chunks.push(concatBytes(new Uint8Array([sessionByte]), body));
	}
	return chunks;
}

export function buildProtoRequestPayload(counter, protoBytes) {
	const length = writeUint32LE(protoBytes.length);
	return concatBytes(
		new Uint8Array(R10_OPCODE.PROTO_REQUEST),
		writeUint32LE(counter),
		new Uint8Array([0, 0]),
		length,
		length,
		protoBytes,
	);
}

export function buildAckPayload(inboundPayload) {
	if (inboundPayload.length < 2) {
		return new Uint8Array();
	}

	const opcode0 = inboundPayload[0];
	const opcode1 = inboundPayload[1];
	const output = [
		...R10_OPCODE.ACK,
		opcode0,
		opcode1,
		0x00,
	];

	const isProto = (
		(opcode0 === R10_OPCODE.PROTO_REQUEST[0] && opcode1 === R10_OPCODE.PROTO_REQUEST[1]) ||
		(opcode0 === R10_OPCODE.PROTO_RESPONSE[0] && opcode1 === R10_OPCODE.PROTO_RESPONSE[1])
	);

	if (isProto && inboundPayload.length >= 4) {
		output.push(inboundPayload[2], inboundPayload[3]);
		output.push(0, 0, 0, 0, 0, 0, 0);
	}

	return Uint8Array.from(output);
}

export function startsWithBytes(bytes, prefix) {
	if (bytes.length < prefix.length) {
		return false;
	}
	for (let i = 0; i < prefix.length; i += 1) {
		if (bytes[i] !== prefix[i]) {
			return false;
		}
	}
	return true;
}

export class FrameAssembler {
	#buffer = [];
	#handshakeComplete = false;

	reset() {
		this.#buffer = [];
		this.#handshakeComplete = false;
	}

	markHandshakeComplete() {
		this.#handshakeComplete = true;
	}

	feed(chunk) {
		if (chunk.length === 0) {
			return [];
		}

		const header = chunk[0];
		const body = chunk.slice(1);
		if (header === 0 || !this.#handshakeComplete) {
			return [{ type: "handshake", body }];
		}

		const outputs = [];
		for (const byte of body) {
			if (byte === 0) {
				if (this.#buffer.length > 0) {
					const complete = Uint8Array.from(this.#buffer);
					this.#buffer = [];
					try {
						outputs.push({ type: "payload", payload: decodeOuter(complete) });
					} catch {
						// Drop a malformed frame and keep scanning for the next delimiter.
					}
				}
				continue;
			}

			this.#buffer.push(byte);
			if (this.#buffer.length > 4096) {
				this.#buffer = [];
				throw new Error("R10 frame assembly exceeded safety limit");
			}
		}

		return outputs;
	}
}
