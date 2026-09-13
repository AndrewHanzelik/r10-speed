const WIRE = Object.freeze({
	VARINT: 0,
	FIXED64: 1,
	LENGTH_DELIMITED: 2,
	FIXED32: 5,
});

const encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

function concatBytes(...parts) {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const output = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.length;
	}
	return output;
}

function encodeVarint(value) {
	let remaining = BigInt(value);
	if (remaining < 0n) {
		throw new Error("Negative protobuf varints are not supported here");
	}

	const output = [];
	do {
		let byte = Number(remaining & 0x7Fn);
		remaining >>= 7n;
		if (remaining !== 0n) {
			byte |= 0x80;
		}
		output.push(byte);
	} while (remaining !== 0n);
	return Uint8Array.from(output);
}

function encodeTag(field, wire) {
	return encodeVarint(BigInt((field << 3) | wire));
}

function float32Bytes(value) {
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setFloat32(0, value, true);
	return bytes;
}

export class ProtoWriter {
	#parts = [];

	writeVarint(field, value) {
		this.#parts.push(encodeTag(field, WIRE.VARINT), encodeVarint(value));
	}

	writeFloat(field, value) {
		this.#parts.push(encodeTag(field, WIRE.FIXED32), float32Bytes(value));
	}

	writeBytes(field, bytes) {
		this.#parts.push(
			encodeTag(field, WIRE.LENGTH_DELIMITED),
			encodeVarint(bytes.length),
			bytes,
		);
	}

	writeString(field, value) {
		if (!encoder) {
			throw new Error("TextEncoder is unavailable");
		}
		this.writeBytes(field, encoder.encode(value));
	}

	writeMessage(field, callback) {
		const child = new ProtoWriter();
		callback(child);
		this.writeBytes(field, child.finish());
	}

	finish() {
		return concatBytes(...this.#parts);
	}
}

export class ProtoReader {
	constructor(bytes) {
		this.bytes = bytes;
		this.offset = 0;
	}

	get isAtEnd() {
		return this.offset >= this.bytes.length;
	}

	readVarint() {
		let result = 0n;
		let shift = 0n;
		for (let i = 0; i < 10; i += 1) {
			if (this.offset >= this.bytes.length) {
				throw new Error("Unexpected end of protobuf varint");
			}
			const byte = this.bytes[this.offset];
			this.offset += 1;
			result |= BigInt(byte & 0x7F) << shift;
			if ((byte & 0x80) === 0) {
				const asNumber = Number(result);
				if (!Number.isSafeInteger(asNumber)) {
					throw new Error("Protobuf varint exceeds JavaScript safe integer range");
				}
				return asNumber;
			}
			shift += 7n;
		}
		throw new Error("Malformed protobuf varint");
	}

	readTag() {
		const tag = this.readVarint();
		return {
			field: tag >>> 3,
			wire: tag & 0x07,
		};
	}

	readFixed32() {
		this.#require(4);
		const view = new DataView(
			this.bytes.buffer,
			this.bytes.byteOffset + this.offset,
			4,
		);
		const value = view.getUint32(0, true);
		this.offset += 4;
		return value;
	}

	readFloat32() {
		this.#require(4);
		const view = new DataView(
			this.bytes.buffer,
			this.bytes.byteOffset + this.offset,
			4,
		);
		const value = view.getFloat32(0, true);
		this.offset += 4;
		return value;
	}

	readLengthDelimited() {
		const length = this.readVarint();
		this.#require(length);
		const result = this.bytes.slice(this.offset, this.offset + length);
		this.offset += length;
		return result;
	}

	skip(wire) {
		switch (wire) {
			case WIRE.VARINT:
				this.readVarint();
				return;
			case WIRE.FIXED64:
				this.#require(8);
				this.offset += 8;
				return;
			case WIRE.LENGTH_DELIMITED: {
				const length = this.readVarint();
				this.#require(length);
				this.offset += length;
				return;
			}
			case WIRE.FIXED32:
				this.#require(4);
				this.offset += 4;
				return;
			default:
				throw new Error(`Unsupported protobuf wire type ${wire}`);
		}
	}

	#require(count) {
		if (this.offset + count > this.bytes.length) {
			throw new Error("Unexpected end of protobuf payload");
		}
	}
}

function findLengthDelimited(bytes, targetField) {
	const reader = new ProtoReader(bytes);
	while (!reader.isAtEnd) {
		const { field, wire } = reader.readTag();
		if (field === targetField && wire === WIRE.LENGTH_DELIMITED) {
			return reader.readLengthDelimited();
		}
		reader.skip(wire);
	}
	return null;
}

function parseClubMetrics(bytes) {
	const output = {};
	const reader = new ProtoReader(bytes);
	while (!reader.isAtEnd) {
		const { field, wire } = reader.readTag();
		if (wire !== WIRE.FIXED32) {
			reader.skip(wire);
			continue;
		}

		const value = reader.readFloat32();
		switch (field) {
			case 1:
				output.clubHeadSpeedMps = value;
				break;
			case 2:
				output.clubFaceDeg = value;
				break;
			case 3:
				output.clubPathDeg = value;
				break;
			case 4:
				output.attackAngleDeg = value;
				break;
			default:
				break;
		}
	}
	return output;
}

function parseBallMetrics(bytes) {
	const output = {};
	const reader = new ProtoReader(bytes);
	while (!reader.isAtEnd) {
		const { field, wire } = reader.readTag();
		if (wire === WIRE.FIXED32) {
			const value = reader.readFloat32();
			switch (field) {
				case 1:
					output.launchAngleDeg = value;
					break;
				case 2:
					output.launchDirectionDeg = value;
					break;
				case 3:
					output.ballSpeedMps = value;
					break;
				case 4:
					output.spinAxisDeg = value;
					break;
				case 5:
					output.totalSpinRpm = value;
					break;
				default:
					break;
			}
		} else if (wire === WIRE.VARINT && (field === 6 || field === 7)) {
			const value = reader.readVarint();
			if (field === 6) {
				output.spinCalcType = value;
			} else {
				output.golfBallType = value;
			}
		} else {
			reader.skip(wire);
		}
	}
	return output;
}

function parseSwingMetrics(bytes) {
	const output = {};
	const reader = new ProtoReader(bytes);
	while (!reader.isAtEnd) {
		const { field, wire } = reader.readTag();
		if (wire !== WIRE.VARINT) {
			reader.skip(wire);
			continue;
		}

		const value = reader.readVarint() >>> 0;
		switch (field) {
			case 1:
				output.backSwingStartMs = value;
				break;
			case 2:
				output.downSwingStartMs = value;
				break;
			case 3:
				output.impactMs = value;
				break;
			case 4:
				output.followThroughEndMs = value;
				break;
			case 5:
				output.endRecordingMs = value;
				break;
			default:
				break;
		}
	}
	return output;
}

function parseMetrics(bytes) {
	const output = {};
	const reader = new ProtoReader(bytes);
	while (!reader.isAtEnd) {
		const { field, wire } = reader.readTag();
		switch (field) {
			case 1:
				if (wire === WIRE.VARINT) {
					output.shotId = reader.readVarint() >>> 0;
				} else {
					reader.skip(wire);
				}
				break;
			case 2:
				if (wire === WIRE.VARINT) {
					output.shotType = reader.readVarint();
				} else {
					reader.skip(wire);
				}
				break;
			case 3:
				if (wire === WIRE.LENGTH_DELIMITED) {
					Object.assign(output, parseBallMetrics(reader.readLengthDelimited()));
				} else {
					reader.skip(wire);
				}
				break;
			case 4:
				if (wire === WIRE.LENGTH_DELIMITED) {
					Object.assign(output, parseClubMetrics(reader.readLengthDelimited()));
				} else {
					reader.skip(wire);
				}
				break;
			case 5:
				if (wire === WIRE.LENGTH_DELIMITED) {
					Object.assign(output, parseSwingMetrics(reader.readLengthDelimited()));
				} else {
					reader.skip(wire);
				}
				break;
			default:
				reader.skip(wire);
				break;
		}
	}
	return output;
}

function parseAlertDetails(bytes) {
	const reader = new ProtoReader(bytes);
	let metrics = null;
	let state = null;

	while (!reader.isAtEnd) {
		const { field, wire } = reader.readTag();
		if (field === 1 && wire === WIRE.LENGTH_DELIMITED) {
			const stateBytes = reader.readLengthDelimited();
			const stateReader = new ProtoReader(stateBytes);
			while (!stateReader.isAtEnd) {
				const tag = stateReader.readTag();
				if (tag.field === 1 && tag.wire === WIRE.VARINT) {
					state = stateReader.readVarint();
				} else {
					stateReader.skip(tag.wire);
				}
			}
		} else if (field === 2 && wire === WIRE.LENGTH_DELIMITED) {
			metrics = parseMetrics(reader.readLengthDelimited());
		} else {
			reader.skip(wire);
		}
	}

	if (metrics) {
		metrics.state = state;
	}
	return metrics;
}

function parseAlertNotification(bytes) {
	const reader = new ProtoReader(bytes);
	let alertType = null;
	let metrics = null;

	while (!reader.isAtEnd) {
		const { field, wire } = reader.readTag();
		if (field === 1 && wire === WIRE.VARINT) {
			alertType = reader.readVarint();
		} else if (field === 1 && wire === WIRE.LENGTH_DELIMITED) {
			const wrappedType = reader.readLengthDelimited();
			alertType = wrappedType.length > 0 ? wrappedType[0] : null;
		} else if (field === 1001 && wire === WIRE.LENGTH_DELIMITED) {
			metrics = parseAlertDetails(reader.readLengthDelimited());
		} else {
			reader.skip(wire);
		}
	}

	if (metrics) {
		metrics.alertType = alertType;
	}
	return metrics;
}

export function parseShotFromProto(protoBytes) {
	const eventSharing = findLengthDelimited(protoBytes, 30);
	if (!eventSharing) {
		return null;
	}

	const notification = findLengthDelimited(eventSharing, 3);
	if (!notification) {
		return null;
	}

	const metrics = parseAlertNotification(notification);
	if (!metrics || metrics.shotId == null || metrics.clubHeadSpeedMps == null) {
		return null;
	}

	metrics.clubHeadSpeedMph = metrics.clubHeadSpeedMps * 2.2369362920544;
	if (
		metrics.backSwingStartMs != null &&
		metrics.downSwingStartMs != null &&
		metrics.impactMs != null
	) {
		const backswingMs = metrics.downSwingStartMs - metrics.backSwingStartMs;
		const downswingMs = metrics.impactMs - metrics.downSwingStartMs;
		if (backswingMs > 0) {
			metrics.backswingMs = backswingMs;
		}
		if (downswingMs > 0) {
			metrics.downswingMs = downswingMs;
			metrics.tempoRatio = backswingMs / downswingMs;
		}
	}

	return metrics;
}

export function buildWakeUpRequest() {
	const writer = new ProtoWriter();
	writer.writeMessage(38, (service) => {
		service.writeMessage(3, () => {});
	});
	return writer.finish();
}

export function buildStatusRequest() {
	const writer = new ProtoWriter();
	writer.writeMessage(38, (service) => {
		service.writeMessage(1, () => {});
	});
	return writer.finish();
}

export function buildTiltRequest() {
	const writer = new ProtoWriter();
	writer.writeMessage(38, (service) => {
		service.writeMessage(5, () => {});
	});
	return writer.finish();
}

export function buildAlertSupportRequest() {
	const writer = new ProtoWriter();
	writer.writeMessage(30, (event) => {
		event.writeMessage(4, () => {});
	});
	return writer.finish();
}

export function buildShotConfigRequest({
	temperatureF = 70,
	humidity = 0.5,
	altitudeFt = 0,
	airDensity = 1.225,
	teeRangeFt = 6,
} = {}) {
	const writer = new ProtoWriter();
	writer.writeMessage(38, (service) => {
		service.writeMessage(11, (config) => {
			config.writeFloat(1, temperatureF);
			config.writeFloat(2, humidity);
			config.writeFloat(3, altitudeFt);
			config.writeFloat(4, airDensity);
			config.writeFloat(5, teeRangeFt);
		});
	});
	return writer.finish();
}

export function buildSubscribeRequest(alertTypes = [0, 1, 8]) {
	const writer = new ProtoWriter();
	writer.writeMessage(30, (event) => {
		event.writeMessage(1, (request) => {
			for (const alertType of alertTypes) {
				request.writeMessage(1, (alert) => {
					alert.writeVarint(1, alertType);
				});
			}
		});
	});
	return writer.finish();
}
