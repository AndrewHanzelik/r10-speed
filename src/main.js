import { R10Client } from "./r10/ble.js";

const client = new R10Client();
const swings = [];

const elements = {
	statusPill: document.querySelector("#statusPill"),
	statusText: document.querySelector("#statusText"),
	browserWarning: document.querySelector("#browserWarning"),
	speedValue: document.querySelector("#speedValue"),
	swingHint: document.querySelector("#swingHint"),
	pathValue: document.querySelector("#pathValue"),
	attackValue: document.querySelector("#attackValue"),
	tempoValue: document.querySelector("#tempoValue"),
	averageValue: document.querySelector("#averageValue"),
	fastestValue: document.querySelector("#fastestValue"),
	swingCount: document.querySelector("#swingCount"),
	history: document.querySelector("#history"),
	voiceToggle: document.querySelector("#voiceToggle"),
	connectButton: document.querySelector("#connectButton"),
	disconnectButton: document.querySelector("#disconnectButton"),
	resetButton: document.querySelector("#resetButton"),
	demoButton: document.querySelector("#demoButton"),
	errorText: document.querySelector("#errorText"),
};

const connectingStates = new Set(["selecting", "connecting", "handshaking", "priming"]);
const savedVoice = localStorage.getItem("r10-speed:speak");
elements.voiceToggle.checked = savedVoice === "true";

elements.voiceToggle.addEventListener("change", () => {
	localStorage.setItem("r10-speed:speak", String(elements.voiceToggle.checked));
});

elements.connectButton.addEventListener("click", async () => {
	clearError();
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
	elements.speedValue.textContent = "--.-";
	elements.pathValue.textContent = "--";
	elements.attackValue.textContent = "--";
	elements.tempoValue.textContent = "--";
	elements.swingHint.textContent = client.connected ? "Ready for a swing." : "Connect your R10 to begin.";
});

elements.demoButton.addEventListener("click", () => {
	const speed = 104 + Math.random() * 10;
	handleShot({
		shotId: Date.now(),
		shotType: 0,
		clubHeadSpeedMps: speed / 2.2369362920544,
		clubHeadSpeedMph: speed,
		clubPathDeg: -2 + Math.random() * 4,
		attackAngleDeg: 1 + Math.random() * 5,
		tempoRatio: 2.7 + Math.random() * 0.8,
	});
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
	elements.swingHint.textContent = "R10 saw that swing, but did not return club metrics. Try a normal full-speed swing through the same imaginary ball position.";
});

client.addEventListener("shot", (event) => {
	handleShot(event.detail);
});

client.addEventListener("error", (event) => {
	showError(event.detail.error);
});

if (!navigator.bluetooth) {
	elements.browserWarning.classList.remove("hidden");
	elements.connectButton.disabled = true;
}

if (new URLSearchParams(window.location.search).has("demo")) {
	elements.demoButton.classList.remove("hidden");
}

renderSession();

function handleShot(metrics) {
	const shot = {
		...metrics,
		receivedAt: new Date(),
	};
	swings.unshift(shot);
	if (swings.length > 50) {
		swings.length = 50;
	}

	elements.speedValue.textContent = shot.clubHeadSpeedMph.toFixed(1);
	elements.pathValue.textContent = formatDegrees(shot.clubPathDeg);
	elements.attackValue.textContent = formatDegrees(shot.attackAngleDeg);
	elements.tempoValue.textContent = Number.isFinite(shot.tempoRatio) ? `${shot.tempoRatio.toFixed(2)}:1` : "--";
	elements.swingHint.textContent = shot.shotType === 0 ? "Practice swing captured." : "Swing captured.";
	clearError();
	renderSession();

	if (elements.voiceToggle.checked) {
		speakSpeed(shot.clubHeadSpeedMph);
	}
}

function showRadarState(state, name) {
	switch (state) {
		case 0:
			elements.swingHint.textContent = "R10 entered standby. Waking it back up…";
			break;
		case 1:
			elements.swingHint.textContent = "R10 is checking radar interference…";
			break;
		case 2:
			elements.swingHint.textContent = "R10 is waiting and ready for another swing.";
			break;
		case 3:
			elements.swingHint.textContent = "R10 sees your swing — recording…";
			break;
		case 4:
			elements.swingHint.textContent = "R10 is processing that swing…";
			break;
		case 5:
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

	const speeds = swings.map((swing) => swing.clubHeadSpeedMph);
	const average = speeds.reduce((sum, value) => sum + value, 0) / speeds.length;
	const fastest = Math.max(...speeds);
	elements.averageValue.textContent = average.toFixed(1);
	elements.fastestValue.textContent = fastest.toFixed(1);
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
		if (Number.isFinite(swing.clubPathDeg)) {
			bits.push(`Path ${formatDegrees(swing.clubPathDeg)}`);
		}
		if (Number.isFinite(swing.attackAngleDeg)) {
			bits.push(`AoA ${formatDegrees(swing.attackAngleDeg)}`);
		}
		details.textContent = bits.join(" · ") || "Practice swing";

		const speed = document.createElement("strong");
		speed.textContent = `${swing.clubHeadSpeedMph.toFixed(1)} mph`;

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
		elements.swingHint.textContent = "Ready for a swing. No ball required.";
		clearError();
	} else if (connectingStates.has(state)) {
		elements.swingHint.textContent = message;
	} else if (state === "disconnected") {
		elements.swingHint.textContent = "Connect your R10 to begin.";
	}
}

function shortStatus(state) {
	switch (state) {
		case "ready":
			return "Ready";
		case "selecting":
			return "Selecting";
		case "connecting":
			return "Connecting";
		case "handshaking":
			return "Handshake";
		case "priming":
			return "Preparing";
		default:
			return "Disconnected";
	}
}

function formatDegrees(value) {
	if (!Number.isFinite(value)) {
		return "--";
	}
	const sign = value > 0 ? "+" : "";
	return `${sign}${value.toFixed(1)}°`;
}

function speakSpeed(mph) {
	if (!("speechSynthesis" in window)) {
		return;
	}
	window.speechSynthesis.cancel();
	const utterance = new SpeechSynthesisUtterance(String(Math.round(mph)));
	utterance.rate = 1.05;
	window.speechSynthesis.speak(utterance);
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
