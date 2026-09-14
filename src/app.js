import { R10Client } from "./r10/ble.js";
import { calculateCarryYards } from "./carry.js";

const MPH_PER_MPS = 2.2369362920544;
const client = new R10Client();
const swings = [];
const soundState = {
	audioContext: null,
	unlocked: false,
};
const feedbackTimers = new Set();

const elements = {
	statusPill: document.querySelector("#statusPill"),
	statusText: document.querySelector("#statusText"),
	browserWarning: document.querySelector("#browserWarning"),
	speedValue: document.querySelector("#speedValue"),
	swingHint: document.querySelector("#swingHint"),
	pathValue: document.querySelector("#pathValue"),
	attackValue: document.querySelector("#attackValue"),
	tempoValue: document.querySelector("#tempoValue"),
	ballCard: document.querySelector("#ballCard"),
	ballSpeedValue: document.querySelector("#ballSpeedValue"),
	carryValue: document.querySelector("#carryValue"),
	launchValue: document.querySelector("#launchValue"),
	directionValue: document.querySelector("#directionValue"),
	spinValue: document.querySelector("#spinValue"),
	spinAxisValue: document.querySelector("#spinAxisValue"),
	averageValue: document.querySelector("#averageValue"),
	fastestValue: document.querySelector("#fastestValue"),
	swingCount: document.querySelector("#swingCount"),
	history: document.querySelector("#history"),
	clubReadoutToggle: document.querySelector("#clubReadoutToggle"),
	ballReadoutToggle: document.querySelector("#ballReadoutToggle"),
	carryReadoutToggle: document.querySelector("#carryReadoutToggle"),
	connectButton: document.querySelector("#connectButton"),
	disconnectButton: document.querySelector("#disconnectButton"),
	resetButton: document.querySelector("#resetButton"),
	demoButton: document.querySelector("#demoButton"),
	errorText: document.querySelector("#errorText"),
};

const connectingStates = new Set(["selecting", "connecting", "handshaking", "priming"]);
const readoutSettings = [
	[elements.clubReadoutToggle, "r10-speed:read-club", true],
	[elements.ballReadoutToggle, "r10-speed:read-ball", true],
	[elements.carryReadoutToggle, "r10-speed:read-carry", true],
];

for (const [toggle, key, defaultValue] of readoutSettings) {
	const stored = localStorage.getItem(key);
	toggle.checked = stored == null ? defaultValue : stored === "true";
	toggle.addEventListener("change", () => {
		localStorage.setItem(key, String(toggle.checked));
	});
}

elements.connectButton.addEventListener("click", async () => {
	clearError();
	await ensureAudioReady(true);
	try {
		await client.connect();
	} catch (error) {
		showError(error);
		setConnectionState("disconnected", "Disconnected");
	}
});

elements.disconnectButton.addEventListener("click", () => {
	client.disconnect();
});

elements.resetButton.addEventListener("click", () => {
	swings.length = 0;
	renderSession();
	resetLatestMetrics();
	elements.swingHint.textContent = client.connected ? "Ready for a swing." : "Connect your R10 to begin.";
	setFeedbackState("idle");
});

elements.demoButton.addEventListener("click", async () => {
	await ensureAudioReady(true);
	indicateRecording();
	window.setTimeout(() => {
		const clubSpeedMph = 88 + Math.random() * 8;
		const ballSpeedMph = 130 + Math.random() * 15;
		handleShot({
			shotId: Date.now(),
			shotType: 1,
			clubHeadSpeedMps: clubSpeedMph / MPH_PER_MPS,
			clubHeadSpeedMph: clubSpeedMph,
			ballSpeedMps: ballSpeedMph / MPH_PER_MPS,
			launchAngleDeg: 16 + Math.random() * 4,
			launchDirectionDeg: -2 + Math.random() * 4,
			totalSpinRpm: 4800 + Math.random() * 1000,
			spinAxisDeg: -4 + Math.random() * 8,
			clubPathDeg: -2 + Math.random() * 4,
			attackAngleDeg: -2 + Math.random() * 4,
			tempoRatio: 2.7 + Math.random() * 0.8,
		});
	}, 450);
});

client.addEventListener("state", (event) => {
	const { state, message } = event.detail;
	setConnectionState(state, message);
});

client.addEventListener("radarstate", (event) => {
	const { state, name } = event.detail;
	showRadarState(state, name);
});

client.addEventListener("rejected", () => {
	indicateRejected();
	elements.swingHint.textContent = "R10 saw that swing, but did not return metrics. Try a normal full-speed swing through the same impact position.";
});

client.addEventListener("shot", (event) => {
	handleShot(event.detail);
});

client.addEventListener("error", (event) => {
	indicateError();
	showError(event.detail.error);
});

document.addEventListener("visibilitychange", () => {
	if (!document.hidden && client.connected) {
		void ensureAudioReady(false);
	}
});

document.addEventListener("pointerdown", () => {
	void ensureAudioReady(false);
}, { passive: true });

if (!navigator.bluetooth) {
	elements.browserWarning.classList.remove("hidden");
	elements.connectButton.disabled = true;
}

if (new URLSearchParams(window.location.search).has("demo")) {
	elements.demoButton.classList.remove("hidden");
}

renderSession();
resetLatestMetrics();
setFeedbackState("idle");

function handleShot(metrics) {
	const ballSpeedMph = Number.isFinite(metrics.ballSpeedMph)
		? metrics.ballSpeedMph
		: Number.isFinite(metrics.ballSpeedMps)
			? metrics.ballSpeedMps * MPH_PER_MPS
			: null;

	const carryYards = calculateCarryYards({
		ballSpeedMps: metrics.ballSpeedMps,
		launchAngleDeg: metrics.launchAngleDeg,
		launchDirectionDeg: metrics.launchDirectionDeg,
		totalSpinRpm: metrics.totalSpinRpm,
		spinAxisDeg: metrics.spinAxisDeg,
	});

	const shot = {
		...metrics,
		ballSpeedMph,
		carryYards,
		receivedAt: new Date(),
	};
	swings.unshift(shot);
	if (swings.length > 50) {
		swings.length = 50;
	}

	elements.speedValue.textContent = Number.isFinite(shot.clubHeadSpeedMph)
		? shot.clubHeadSpeedMph.toFixed(1)
		: "--.-";
	elements.pathValue.textContent = formatDegrees(shot.clubPathDeg);
	elements.attackValue.textContent = formatDegrees(shot.attackAngleDeg);
	elements.tempoValue.textContent = Number.isFinite(shot.tempoRatio) ? `${shot.tempoRatio.toFixed(2)}:1` : "--";
	renderBallData(shot);
	elements.swingHint.textContent = Number.isFinite(shot.ballSpeedMph) ? "Ball shot captured." : "Practice swing captured.";
	clearError();
	renderSession();
	indicateSuccess();
	speakShot(shot);
}

function renderBallData(shot) {
	const hasBall = Number.isFinite(shot.ballSpeedMph);
	elements.ballCard.classList.toggle("hidden", !hasBall);
	if (!hasBall) {
		return;
	}

	elements.ballSpeedValue.textContent = `${shot.ballSpeedMph.toFixed(1)} mph`;
	elements.carryValue.textContent = Number.isFinite(shot.carryYards) ? `${Math.round(shot.carryYards)} yd` : "--";
	elements.launchValue.textContent = formatDegrees(shot.launchAngleDeg);
	elements.directionValue.textContent = formatDegrees(shot.launchDirectionDeg);
	elements.spinValue.textContent = Number.isFinite(shot.totalSpinRpm) ? `${Math.round(shot.totalSpinRpm)} rpm` : "--";
	elements.spinAxisValue.textContent = formatDegrees(shot.spinAxisDeg);
}

function resetLatestMetrics() {
	elements.speedValue.textContent = "--.-";
	elements.pathValue.textContent = "--";
	elements.attackValue.textContent = "--";
	elements.tempoValue.textContent = "--";
	elements.ballCard.classList.add("hidden");
	elements.ballSpeedValue.textContent = "--";
	elements.carryValue.textContent = "--";
	elements.launchValue.textContent = "--";
	elements.directionValue.textContent = "--";
	elements.spinValue.textContent = "--";
	elements.spinAxisValue.textContent = "--";
}

function showRadarState(state, name) {
	switch (state) {
		case 0:
			setFeedbackState("standby");
			elements.swingHint.textContent = "R10 entered standby. Waking it back up…";
			break;
		case 1:
			setFeedbackState("processing");
			elements.swingHint.textContent = "R10 is checking radar interference…";
			break;
		case 2:
			if (document.body.dataset.feedbackState !== "success" && document.body.dataset.feedbackState !== "rejected") {
				setFeedbackState("idle");
			}
			elements.swingHint.textContent = "R10 is waiting and ready for another swing.";
			break;
		case 3:
			indicateRecording();
			elements.swingHint.textContent = "R10 sees your swing — recording…";
			break;
		case 4:
			setFeedbackState("processing");
			elements.swingHint.textContent = "R10 is processing that swing…";
			break;
		case 5:
			indicateError();
			elements.swingHint.textContent = "R10 reported a radar/device error. Check its alignment and indicator light.";
			break;
		default:
			elements.swingHint.textContent = `R10 radar state: ${name}.`;
			break;
	}
}

function renderSession() {
	if (swings.length === 0) {
		elements.averageValue.textContent = "--";
		elements.fastestValue.textContent = "--";
		elements.swingCount.textContent = "0";
		elements.history.innerHTML = '<p class="empty-history">Your recent swings will appear here.</p>';
		return;
	}

	const clubSpeeds = swings
		.map((swing) => swing.clubHeadSpeedMph)
		.filter(Number.isFinite);
	if (clubSpeeds.length > 0) {
		const average = clubSpeeds.reduce((sum, value) => sum + value, 0) / clubSpeeds.length;
		elements.averageValue.textContent = average.toFixed(1);
		elements.fastestValue.textContent = Math.max(...clubSpeeds).toFixed(1);
	} else {
		elements.averageValue.textContent = "--";
		elements.fastestValue.textContent = "--";
	}
	elements.swingCount.textContent = String(swings.length);

	elements.history.replaceChildren(...swings.slice(0, 10).map((swing, index) => {
		const row = document.createElement("div");
		row.className = "history-row";

		const number = document.createElement("span");
		number.className = "number";
		number.textContent = `#${swings.length - index}`;

		const details = document.createElement("span");
		details.className = "details";
		const bits = [];
		if (Number.isFinite(swing.ballSpeedMph)) {
			bits.push(`Ball ${swing.ballSpeedMph.toFixed(1)}`);
		}
		if (Number.isFinite(swing.carryYards)) {
			bits.push(`Carry ${Math.round(swing.carryYards)} yd`);
		}
		if (Number.isFinite(swing.clubPathDeg)) {
			bits.push(`Path ${formatDegrees(swing.clubPathDeg)}`);
		}
		details.textContent = bits.join(" · ") || "Practice swing";

		const speed = document.createElement("strong");
		if (Number.isFinite(swing.clubHeadSpeedMph)) {
			speed.textContent = `${swing.clubHeadSpeedMph.toFixed(1)} mph`;
		} else if (Number.isFinite(swing.ballSpeedMph)) {
			speed.textContent = `${swing.ballSpeedMph.toFixed(1)} ball`;
		} else {
			speed.textContent = "--";
		}

		row.append(number, details, speed);
		return row;
	}));
}

function setConnectionState(state, message) {
	elements.statusPill.dataset.state = state;
	elements.statusText.textContent = shortStatus(state);
	elements.connectButton.disabled = connectingStates.has(state);

	const ready = state === "ready";
	elements.connectButton.classList.toggle("hidden", ready);
	elements.disconnectButton.classList.toggle("hidden", !ready);

	if (ready) {
		elements.swingHint.textContent = "Ready for a swing. Ball optional.";
		clearError();
		void ensureAudioReady(false);
		if (document.body.dataset.feedbackState === "standby") {
			setFeedbackState("idle");
		}
	} else if (connectingStates.has(state)) {
		elements.swingHint.textContent = message;
		setFeedbackState("idle");
	} else if (state === "disconnected") {
		elements.swingHint.textContent = "Connect your R10 to begin.";
		setFeedbackState("idle");
	}
}

function shortStatus(state) {
	switch (state) {
		case "ready": return "Ready";
		case "selecting": return "Selecting";
		case "connecting": return "Connecting";
		case "handshaking": return "Handshake";
		case "priming": return "Preparing";
		default: return "Disconnected";
	}
}

function formatDegrees(value) {
	if (!Number.isFinite(value)) {
		return "--";
	}
	const sign = value > 0 ? "+" : "";
	return `${sign}${value.toFixed(1)}°`;
}

function speakShot(shot) {
	if (!("speechSynthesis" in window)) {
		return;
	}

	const parts = [];
	if (elements.clubReadoutToggle.checked && Number.isFinite(shot.clubHeadSpeedMph)) {
		parts.push(`Club speed ${Math.round(shot.clubHeadSpeedMph)}`);
	}
	if (elements.ballReadoutToggle.checked && Number.isFinite(shot.ballSpeedMph)) {
		parts.push(`Ball speed ${Math.round(shot.ballSpeedMph)}`);
	}
	if (elements.carryReadoutToggle.checked && Number.isFinite(shot.carryYards)) {
		parts.push(`Carry ${Math.round(shot.carryYards)} yards`);
	}
	if (parts.length === 0) {
		return;
	}

	window.speechSynthesis.cancel();
	const utterance = new SpeechSynthesisUtterance(parts.join(". "));
	utterance.rate = 1.05;
	window.speechSynthesis.speak(utterance);
}

async function ensureAudioReady(warmUp) {
	const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
	if (!AudioContextCtor) {
		return false;
	}

	if (!soundState.audioContext) {
		soundState.audioContext = new AudioContextCtor();
	}

	if (soundState.audioContext.state === "suspended") {
		try {
			await soundState.audioContext.resume();
		} catch {
			return false;
		}
	}

	soundState.unlocked = soundState.audioContext.state === "running";
	if (warmUp && soundState.unlocked) {
		playSilentWarmup(soundState.audioContext);
	}
	return soundState.unlocked;
}

function playSilentWarmup(context) {
	const gain = context.createGain();
	const oscillator = context.createOscillator();
	gain.gain.setValueAtTime(0.00001, context.currentTime);
	oscillator.frequency.setValueAtTime(440, context.currentTime);
	oscillator.connect(gain);
	gain.connect(context.destination);
	oscillator.start();
	oscillator.stop(context.currentTime + 0.015);
}

async function playPattern(notes) {
	const ready = await ensureAudioReady(false);
	if (!ready || !soundState.audioContext) {
		return;
	}

	const context = soundState.audioContext;
	let cursor = context.currentTime + 0.01;
	for (const note of notes) {
		const gain = context.createGain();
		const oscillator = context.createOscillator();
		oscillator.type = note.type ?? "sine";
		oscillator.frequency.setValueAtTime(note.frequency, cursor);
		gain.gain.setValueAtTime(0.0001, cursor);
		gain.gain.exponentialRampToValueAtTime(note.gain ?? 0.08, cursor + 0.01);
		gain.gain.exponentialRampToValueAtTime(0.0001, cursor + note.duration);
		oscillator.connect(gain);
		gain.connect(context.destination);
		oscillator.start(cursor);
		oscillator.stop(cursor + note.duration + 0.02);
		cursor += note.duration + (note.gap ?? 0.03);
	}
}

function indicateRecording() {
	setFeedbackState("recording");
	void playPattern([{ frequency: 740, duration: 0.08, gain: 0.05, type: "triangle" }]);
}

function indicateRejected() {
	setFeedbackState("rejected", 1500);
	void playPattern([
		{ frequency: 330, duration: 0.11, gain: 0.07, type: "sawtooth", gap: 0.03 },
		{ frequency: 240, duration: 0.17, gain: 0.07, type: "sawtooth" },
	]);
}

function indicateSuccess() {
	setFeedbackState("success", 1250);
	void playPattern([
		{ frequency: 660, duration: 0.07, gain: 0.045, type: "triangle", gap: 0.02 },
		{ frequency: 990, duration: 0.12, gain: 0.06, type: "triangle" },
	]);
}

function indicateError() {
	setFeedbackState("error", 1800);
	void playPattern([
		{ frequency: 220, duration: 0.18, gain: 0.06, type: "square", gap: 0.04 },
		{ frequency: 220, duration: 0.18, gain: 0.05, type: "square" },
	]);
}

function setFeedbackState(state, resetAfterMs = 0) {
	document.body.dataset.feedbackState = state;
	clearFeedbackTimers();
	if (resetAfterMs > 0) {
		const timeoutId = window.setTimeout(() => {
			feedbackTimers.delete(timeoutId);
			document.body.dataset.feedbackState = "idle";
		}, resetAfterMs);
		feedbackTimers.add(timeoutId);
	}
}

function clearFeedbackTimers() {
	for (const timeoutId of feedbackTimers) {
		window.clearTimeout(timeoutId);
	}
	feedbackTimers.clear();
}

function showError(error) {
	const message = error instanceof Error ? error.message : String(error);
	elements.errorText.textContent = message;
	elements.errorText.classList.remove("hidden");
}

function clearError() {
	elements.errorText.textContent = "";
	elements.errorText.classList.add("hidden");
}
