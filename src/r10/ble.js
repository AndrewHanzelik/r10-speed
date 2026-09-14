import {
	FrameAssembler,
	HANDSHAKE_REQUEST,
	HANDSHAKE_RESPONSE_PREFIX,
	R10_OPCODE,
	buildAckPayload,
	buildProtoRequestPayload,
	chunkFrame,
	encodeOuter,
	readUint32LE,
	startsWithBytes,
} from "./framing.js";
import {
	ProtoReader,
	buildAlertSupportRequest,
	buildShotConfigRequest,
	buildStatusRequest,
	buildSubscribeRequest,
	buildTiltRequest,
	buildWakeUpRequest,
	parseShotFromProto,
} from "./proto.js";

export const R10_UUID = Object.freeze({
	SERVICE: "6a4e2800-667b-11e3-949a-0800200c9a66",
	NOTIFIER: "6a4e2812-667b-11e3-949a-0800200c9a66",
	WRITER: "6a4e2822-667b-11e3-949a-0800200c9a66",
});

const R10_STATE = Object.freeze({
	STANDBY: 0,
	INTERFERENCE_TEST: 1,
	WAITING: 2,
	RECORDING: 3,
	PROCESSING: 4,
	ERROR: 5,
});

const R10_STATE_NAME = Object.freeze({
	0: "Standby",
	1: "Interference test",
	2: "Waiting",
	3: "Recording",
	4: "Processing",
	5: "Error",
});

function bytesFromDataView(view) {
	return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}

function findLengthDelimited(bytes, targetField) {
	const reader = new ProtoReader(bytes);
	while (!reader.isAtEnd) {
		const { field, wire } = reader.readTag();
		if (field === targetField && wire === 2) {
			return reader.readLengthDelimited();
		}
		reader.skip(wire);
	}
	return null;
}

function parseRadarStateFromProto(protoBytes) {
	const eventSharing = findLengthDelimited(protoBytes, 30);
	if (!eventSharing) {
		return null;
	}

	const notification = findLengthDelimited(eventSharing, 3);
	if (!notification) {
		return null;
	}

	const notificationReader = new ProtoReader(notification);
	let details = null;
	while (!notificationReader.isAtEnd) {
		const { field, wire } = notificationReader.readTag();
		if (field === 1001 && wire === 2) {
			details = notificationReader.readLengthDelimited();
		} else {
			notificationReader.skip(wire);
		}
	}
	if (!details) {
		return null;
	}

	const detailsReader = new ProtoReader(details);
	while (!detailsReader.isAtEnd) {
		const { field, wire } = detailsReader.readTag();
		if (field === 1 && wire === 2) {
			const stateBytes = detailsReader.readLengthDelimited();
			const stateReader = new ProtoReader(stateBytes);
			while (!stateReader.isAtEnd) {
				const stateTag = stateReader.readTag();
				if (stateTag.field === 1 && stateTag.wire === 0) {
					return stateReader.readVarint();
				}
				stateReader.skip(stateTag.wire);
			}
		} else {
			detailsReader.skip(wire);
		}
	}

	return null;
}

export class R10Client extends EventTarget {
	#device = null;
	#server = null;
	#writer = null;
	#notifier = null;
	#assembler = new FrameAssembler();
	#sessionByte = 0;
	#counter = 0;
	#pending = new Map();
	#processedShotIds = new Set();
	#handshakeResolve = null;
	#handshakeReject = null;
	#writeChain = Promise.resolve();
	#inboundChain = Promise.resolve();
	#disconnectHandler = null;
	#notificationHandler = null;
	#sawRecordingThisCycle = false;
	#sawMetricsThisCycle = false;
	#wakeInFlight = null;

	get connected() {
		return Boolean(this.#device?.gatt?.connected && this.#writer && this.#notifier);
	}

	get deviceName() {
		return this.#device?.name ?? "Approach R10";
	}

	async connect() {
		if (!navigator.bluetooth) {
			throw new Error("This browser does not expose Web Bluetooth.");
		}

		this.#emitState("selecting", "Select your Approach R10");
		const device = await navigator.bluetooth.requestDevice({
			filters: [
				{ namePrefix: "Approach R10" },
				{ namePrefix: "Approach" },
				{ namePrefix: "R10" },
			],
			optionalServices: [R10_UUID.SERVICE],
		});

		await this.#attach(device);
	}

	async reconnect() {
		if (!this.#device) {
			return this.connect();
		}
		await this.#attach(this.#device);
	}

	disconnect() {
		this.#rejectPending(new Error("R10 disconnected"));
		if (this.#device?.gatt?.connected) {
			this.#device.gatt.disconnect();
		} else {
			this.#resetTransport();
			this.#emitState("disconnected", "Disconnected");
		}
	}

	async #attach(device) {
		const previousDevice = this.#device;
		if (this.#notifier && this.#notificationHandler) {
			this.#notifier.removeEventListener("characteristicvaluechanged", this.#notificationHandler);
		}
		if (previousDevice && this.#disconnectHandler) {
			previousDevice.removeEventListener("gattserverdisconnected", this.#disconnectHandler);
		}
		if (previousDevice && previousDevice !== device && previousDevice.gatt?.connected) {
			previousDevice.gatt.disconnect();
		}

		this.#resetTransport();
		this.#device = device;
		this.#disconnectHandler = () => this.#handleDisconnect();
		device.addEventListener("gattserverdisconnected", this.#disconnectHandler);

		try {
			this.#emitState("connecting", `Connecting to ${device.name ?? "R10"}…`);
			this.#server = await device.gatt.connect();
			const service = await this.#server.getPrimaryService(R10_UUID.SERVICE);
			this.#notifier = await service.getCharacteristic(R10_UUID.NOTIFIER);
			this.#writer = await service.getCharacteristic(R10_UUID.WRITER);

			this.#notificationHandler = (event) => {
				const bytes = bytesFromDataView(event.target.value);
				this.#inboundChain = this.#inboundChain
					.then(() => this.#processNotification(bytes))
					.catch((error) => this.#emitError(error));
			};
			this.#notifier.addEventListener("characteristicvaluechanged", this.#notificationHandler);
			await this.#notifier.startNotifications();

			this.#emitState("handshaking", "Establishing R10 session…");
			await this.#handshake();
			this.#emitState("priming", "Preparing launch monitor…");
			await this.#prime();
			this.#emitState("ready", "Ready for a swing");
		} catch (error) {
			if (this.#notifier && this.#notificationHandler) {
				this.#notifier.removeEventListener("characteristicvaluechanged", this.#notificationHandler);
			}
			device.removeEventListener("gattserverdisconnected", this.#disconnectHandler);
			if (device.gatt?.connected) {
				device.gatt.disconnect();
			}
			this.#resetTransport();
			this.#emitState("disconnected", "Connection failed");
			throw error;
		}
	}

	async #handshake() {
		const handshake = new Promise((resolve, reject) => {
			this.#handshakeResolve = resolve;
			this.#handshakeReject = reject;
		});

		let timeoutId;
		const timeout = new Promise((_, reject) => {
			timeoutId = setTimeout(() => reject(new Error("R10 session handshake timed out")), 5000);
		});

		try {
			await this.#writeRaw(new Uint8Array([0x00, ...HANDSHAKE_REQUEST]));
			await Promise.race([handshake, timeout]);
			await this.#writeRaw(new Uint8Array([0x00]));
		} finally {
			clearTimeout(timeoutId);
			this.#handshakeResolve = null;
			this.#handshakeReject = null;
		}
	}

	async #prime() {
		const requests = [
			buildWakeUpRequest(),
			buildAlertSupportRequest(),
			buildStatusRequest(),
			buildTiltRequest(),
			buildShotConfigRequest(),
			buildSubscribeRequest([0, 1, 8]),
		];

		for (const request of requests) {
			await this.#sendProtoRequest(request);
		}
	}

	async #sendProtoRequest(protoBytes) {
		const counter = this.#counter >>> 0;
		this.#counter = (this.#counter + 1) >>> 0;
		const payload = buildProtoRequestPayload(counter, protoBytes);

		let timeoutId;
		const response = new Promise((resolve, reject) => {
			timeoutId = setTimeout(() => {
				this.#pending.delete(counter);
				reject(new Error(`R10 request ${counter} timed out`));
			}, 5000);
			this.#pending.set(counter, {
				resolve: (value) => {
					clearTimeout(timeoutId);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timeoutId);
					reject(error);
				},
			});
		});

		try {
			await this.#sendPayload(payload);
			return await response;
		} catch (error) {
			this.#pending.delete(counter);
			throw error;
		}
	}

	async #sendPayload(payload) {
		const encoded = encodeOuter(payload);
		const chunks = chunkFrame(encoded, this.#sessionByte);
		for (const chunk of chunks) {
			await this.#writeRaw(chunk);
		}
	}

	#writeRaw(bytes) {
		this.#writeChain = this.#writeChain.then(async () => {
			if (!this.#writer) {
				throw new Error("R10 writer characteristic is unavailable");
			}

			const value = bytes.slice().buffer;
			if (typeof this.#writer.writeValueWithResponse === "function") {
				await this.#writer.writeValueWithResponse(value);
			} else if (typeof this.#writer.writeValue === "function") {
				await this.#writer.writeValue(value);
			} else {
				throw new Error("This Web Bluetooth implementation cannot write to the R10");
			}
		});
		return this.#writeChain;
	}

	async #processNotification(chunk) {
		const outputs = this.#assembler.feed(chunk);
		for (const output of outputs) {
			if (output.type === "handshake") {
				this.#handleHandshake(output.body);
				continue;
			}

			const payload = output.payload;
			const ack = buildAckPayload(payload);
			if (ack.length > 0) {
				await this.#sendPayload(ack);
			}
			this.#handlePayload(payload);
		}
	}

	#handleHandshake(body) {
		if (body.length < 13 || !startsWithBytes(body, HANDSHAKE_RESPONSE_PREFIX)) {
			return;
		}

		this.#sessionByte = body[12];
		this.#assembler.markHandshakeComplete();
		this.#handshakeResolve?.(this.#sessionByte);
		this.#handshakeResolve = null;
		this.#handshakeReject = null;
	}

	#handlePayload(payload) {
		if (payload.length < 2) {
			return;
		}

		const opcode0 = payload[0];
		const opcode1 = payload[1];
		const isResponse = opcode0 === R10_OPCODE.PROTO_RESPONSE[0] && opcode1 === R10_OPCODE.PROTO_RESPONSE[1];
		const isRequest = opcode0 === R10_OPCODE.PROTO_REQUEST[0] && opcode1 === R10_OPCODE.PROTO_REQUEST[1];

		if (isResponse) {
			if (payload.length < 6) {
				return;
			}
			const counter = readUint32LE(payload, 2);
			let pending = this.#pending.get(counter);
			let pendingKey = counter;

			if (!pending && this.#pending.size === 1) {
				[pendingKey, pending] = this.#pending.entries().next().value;
			}

			if (pending) {
				this.#pending.delete(pendingKey);
				pending.resolve(payload);
			}
			return;
		}

		if (!isRequest || payload.length < 16) {
			return;
		}

		const protoBytes = payload.slice(16);
		let radarState = null;
		try {
			radarState = parseRadarStateFromProto(protoBytes);
		} catch (error) {
			this.#emitError(new Error(`Could not parse R10 state data: ${error.message}`));
		}
		if (radarState != null) {
			this.#handleRadarState(radarState);
		}

		let metrics;
		try {
			metrics = parseShotFromProto(protoBytes);
		} catch (error) {
			this.#emitError(new Error(`Could not parse R10 shot data: ${error.message}`));
			return;
		}

		if (!metrics || this.#processedShotIds.has(metrics.shotId)) {
			return;
		}

		this.#sawMetricsThisCycle = true;
		this.#processedShotIds.add(metrics.shotId);
		this.dispatchEvent(new CustomEvent("shot", { detail: metrics }));
	}

	#handleRadarState(state) {
		this.dispatchEvent(new CustomEvent("radarstate", {
			detail: {
				state,
				name: R10_STATE_NAME[state] ?? `State ${state}`,
			},
		}));

		if (state === R10_STATE.RECORDING) {
			this.#sawRecordingThisCycle = true;
			this.#sawMetricsThisCycle = false;
			return;
		}

		if (state === R10_STATE.WAITING || state === R10_STATE.STANDBY) {
			const rejected = this.#sawRecordingThisCycle && !this.#sawMetricsThisCycle;
			this.#sawRecordingThisCycle = false;
			this.#sawMetricsThisCycle = false;
			if (rejected) {
				this.dispatchEvent(new CustomEvent("rejected", {
					detail: { state },
				}));
			}
		}

		if (state === R10_STATE.STANDBY && this.#pending.size === 0 && !this.#wakeInFlight) {
			this.#wakeInFlight = this.#sendProtoRequest(buildWakeUpRequest())
				.catch((error) => this.#emitError(new Error(`Could not wake R10 from standby: ${error.message}`)))
				.finally(() => {
					this.#wakeInFlight = null;
				});
		}
	}

	#handleDisconnect() {
		this.#rejectPending(new Error("R10 disconnected"));
		this.#handshakeReject?.(new Error("R10 disconnected during handshake"));
		this.#resetTransport();
		this.#emitState("disconnected", "R10 disconnected");
	}

	#rejectPending(error) {
		for (const pending of this.#pending.values()) {
			pending.reject(error);
		}
		this.#pending.clear();
	}

	#resetTransport() {
		this.#server = null;
		this.#writer = null;
		this.#notifier = null;
		this.#assembler.reset();
		this.#sessionByte = 0;
		this.#counter = 0;
		this.#processedShotIds.clear();
		this.#handshakeResolve = null;
		this.#handshakeReject = null;
		this.#notificationHandler = null;
		this.#writeChain = Promise.resolve();
		this.#inboundChain = Promise.resolve();
		this.#sawRecordingThisCycle = false;
		this.#sawMetricsThisCycle = false;
		this.#wakeInFlight = null;
	}

	#emitState(state, message) {
		this.dispatchEvent(new CustomEvent("state", {
			detail: { state, message },
		}));
	}

	#emitError(error) {
		this.dispatchEvent(new CustomEvent("error", {
			detail: { error },
		}));
	}
}
