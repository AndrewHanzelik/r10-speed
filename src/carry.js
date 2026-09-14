// Carry-only golf-ball flight estimate adapted from OpenFairway's MIT-licensed
// aerodynamic model. Standard atmosphere, no wind, first ground contact only.

const MASS_KG = 0.04592623;
const RADIUS_M = 0.021335;
const AREA_M2 = Math.PI * RADIUS_M * RADIUS_M;
const AIR_DENSITY = 1.225;
const AIR_VISCOSITY = 1.81e-5;
const GRAVITY = 9.81;
const DT = 1 / 120;
const SPIN_DECAY_TAU_S = 5;
const METERS_PER_YARD = 0.9144;
const RAD_PER_RPM = 2 * Math.PI / 60;

const PROFILE = Object.freeze({
	cdPolyA: 1.1948,
	cdPolyB: -0.0000209661,
	cdPolyC: 1.42472e-10,
	cdPolyD: -3.14383e-16,
	highReCdCap: 0.2,
	lowReCdFloor: 0.38,
	cdAt50k: 0.4632,
	clMaxBase: 0.268,
	clMaxHighSpin: 0.32,
	spinDragMultiplierCoeff: 4,
	spinDragMultiplierMax: 1.20,
	spinDragMultiplierHighSpinMax: 1.03,
	spinDragMultiplierUltraHighSpinMax: 1.21,
	midSpinClBoostMax: 0.45,
});

export function calculateCarryYards({
	ballSpeedMps,
	launchAngleDeg,
	launchDirectionDeg = 0,
	totalSpinRpm,
	spinAxisDeg = 0,
}) {
	if (
		!Number.isFinite(ballSpeedMps) || ballSpeedMps <= 0 ||
		!Number.isFinite(launchAngleDeg) ||
		!Number.isFinite(totalSpinRpm) || totalSpinRpm < 0
	) {
		return null;
	}

	const vla = degreesToRadians(launchAngleDeg);
	const hla = degreesToRadians(Number.isFinite(launchDirectionDeg) ? launchDirectionDeg : 0);
	const axis = degreesToRadians(Number.isFinite(spinAxisDeg) ? spinAxisDeg : 0);
	const horizontalSpeed = ballSpeedMps * Math.cos(vla);
	let velocity = [
		horizontalSpeed * Math.sin(hla),
		ballSpeedMps * Math.sin(vla),
		horizontalSpeed * Math.cos(hla),
	];

	const omegaMagnitude = totalSpinRpm * RAD_PER_RPM;
	let omega = [
		-omegaMagnitude * Math.cos(axis),
		omegaMagnitude * Math.sin(axis),
		0,
	];
	let position = [0, 0, 0];
	let previousPosition = position.slice();
	const spinDecayStep = Math.exp(-DT / SPIN_DECAY_TAU_S);

	for (let step = 0; step < 2400; step += 1) {
		const speed = length3(velocity);
		if (speed < 0.5) {
			return null;
		}

		const omegaLength = length3(omega);
		const reynolds = AIR_DENSITY * speed * RADIUS_M * 2 / AIR_VISCOSITY;
		const spinRatio = omegaLength * RADIUS_M / speed;
		const cd = dragCoefficient(reynolds) *
			spinDragMultiplier(spinRatio, reynolds) *
			highLaunchDragScale(launchAngleDeg, spinRatio);
		const cl = liftCoefficient(reynolds, spinRatio) *
			lowLaunchLiftScale(launchAngleDeg, spinRatio, reynolds) *
			midSpinLiftBoost(spinRatio);

		const dragForce = scale3(velocity, -0.5 * cd * AIR_DENSITY * AREA_M2 * speed);
		let magnusForce = [0, 0, 0];
		if (omegaLength > 0.1 && cl > 0) {
			magnusForce = scale3(
				cross3(omega, velocity),
				0.5 * cl * AIR_DENSITY * AREA_M2 * speed / omegaLength,
			);
		}

		const acceleration = [
			(dragForce[0] + magnusForce[0]) / MASS_KG,
			(dragForce[1] + magnusForce[1]) / MASS_KG - GRAVITY,
			(dragForce[2] + magnusForce[2]) / MASS_KG,
		];

		previousPosition = position.slice();
		velocity = add3(velocity, scale3(acceleration, DT));
		position = add3(position, scale3(velocity, DT));
		omega = scale3(omega, spinDecayStep);

		if (step > 10 && position[1] <= 0 && velocity[1] < 0) {
			const previousHeight = previousPosition[1];
			const heightDelta = previousHeight - position[1];
			const landingT = heightDelta > 0 ? previousHeight / heightDelta : 0;
			const landingX = previousPosition[0] + (position[0] - previousPosition[0]) * landingT;
			const landingZ = previousPosition[2] + (position[2] - previousPosition[2]) * landingT;
			return Math.hypot(landingX, landingZ) / METERS_PER_YARD;
		}
	}

	return null;
}

function dragCoefficient(reynolds) {
	if (reynolds > 200000) {
		return PROFILE.highReCdCap;
	}
	if (reynolds >= 50000) {
		return PROFILE.cdPolyA +
			PROFILE.cdPolyB * reynolds +
			PROFILE.cdPolyC * reynolds * reynolds +
			PROFILE.cdPolyD * reynolds * reynolds * reynolds;
	}
	if (reynolds <= 30000) {
		return PROFILE.lowReCdFloor;
	}
	return lerp(PROFILE.lowReCdFloor, PROFILE.cdAt50k, smoothStepRange(reynolds, 30000, 50000));
}

function liftCoefficient(reynolds, spinRatio) {
	if (spinRatio <= 0 || reynolds <= 30000) {
		return 0;
	}

	const cap = clMax(spinRatio);
	let cl;
	if (reynolds < 50000) {
		cl = clamp(clAt50k(spinRatio), 0, cap) * smoothStepRange(reynolds, 30000, 50000);
		return attenuateLowReHighSpin(spinRatio, cl);
	}

	if (reynolds < 75000) {
		const rePoints = [50000, 60000, 65000, 70000, 75000];
		const clPoints = [
			clAt50k(spinRatio),
			clAt60k(spinRatio),
			clAt65k(spinRatio),
			clAt70k(spinRatio),
			clHighRe(spinRatio),
		];
		let highIndex = 1;
		while (highIndex < rePoints.length - 1 && reynolds > rePoints[highIndex]) {
			highIndex += 1;
		}
		const lowIndex = highIndex - 1;
		const t = (reynolds - rePoints[lowIndex]) / (rePoints[highIndex] - rePoints[lowIndex]);
		cl = lerp(Math.max(0, clPoints[lowIndex]), Math.max(0, clPoints[highIndex]), t);
		return attenuateLowReHighSpin(spinRatio, clamp(cl, 0, cap));
	}

	return attenuateHighSpin(spinRatio, clamp(clHighRe(spinRatio), 0, cap));
}

function spinDragMultiplier(spinRatio, reynolds) {
	if (spinRatio <= 0) {
		return 1;
	}
	const highSpinWeight = smoothStepRange(spinRatio, 0.30, 0.48);
	const reReliefWeight = 1 - smoothStepRange(reynolds, 90000, 105000);
	let effectiveCap = lerp(
		PROFILE.spinDragMultiplierMax,
		PROFILE.spinDragMultiplierHighSpinMax,
		highSpinWeight * reReliefWeight,
	);
	effectiveCap += 0.25 * smoothStepRange(spinRatio, 0.33, 0.50);
	effectiveCap = lerp(
		effectiveCap,
		PROFILE.spinDragMultiplierUltraHighSpinMax,
		smoothStepRange(spinRatio, 0.57, 0.77),
	);
	return Math.min(1 + PROFILE.spinDragMultiplierCoeff * spinRatio * spinRatio, effectiveCap);
}

function lowLaunchLiftScale(launchAngleDeg, spinRatio, reynolds) {
	const launchFactor = smoothStepRange(9.5 - launchAngleDeg, 0, 3);
	const reFactor = smoothStepRange(reynolds, 85000, 110000);
	const spinFactor = 1 - smoothStepRange(spinRatio, 0.18, 0.22);
	return lerp(1, 1.08, launchFactor * reFactor * spinFactor);
}

function highLaunchDragScale(launchAngleDeg, spinRatio) {
	const launchFactor = smoothStepRange(launchAngleDeg, 24.5, 31.5);
	const spinFactor = smoothStepRange(spinRatio, 0.50, 0.70);
	return lerp(1, 1.24, launchFactor * spinFactor);
}

function midSpinLiftBoost(spinRatio) {
	const t = smoothStepRange(spinRatio, 0.17, 0.31);
	return 1 + PROFILE.midSpinClBoostMax * t * (1 - t) * 4;
}

function clMax(spinRatio) {
	if (spinRatio <= 0.35) {
		return PROFILE.clMaxBase;
	}
	if (spinRatio >= 0.50) {
		return PROFILE.clMaxHighSpin;
	}
	return lerp(PROFILE.clMaxBase, PROFILE.clMaxHighSpin, smoothStepRange(spinRatio, 0.35, 0.50));
}

function clHighRe(spinRatio) {
	const gain = 16;
	const cap = clMax(spinRatio);
	return cap * spinRatio * gain / (1 + spinRatio * gain);
}

function clAt50k(spinRatio) {
	return 0.0472121 + 2.84795 * spinRatio - 23.4342 * spinRatio ** 2 + 45.4849 * spinRatio ** 3;
}

function clAt60k(spinRatio) {
	return 0.320524 - 4.7032 * spinRatio + 14.0613 * spinRatio ** 2;
}

function clAt65k(spinRatio) {
	return 0.266667 - 4 * spinRatio + 13.3333 * spinRatio ** 2;
}

function clAt70k(spinRatio) {
	return 0.0496189 + 0.00211396 * spinRatio + 2.34201 * spinRatio ** 2;
}

function attenuateHighSpin(spinRatio, cl) {
	const highSpin = 1 - 0.09 * smoothStepRange(spinRatio, 0.45, 0.55);
	const ultraHighSpin = 1 - 0.10 * smoothStepRange(spinRatio, 0.58, 0.85);
	return cl * highSpin * ultraHighSpin;
}

function attenuateLowReHighSpin(spinRatio, cl) {
	const highSpin = 1 - 0.10 * smoothStepRange(spinRatio, 0.45, 0.55);
	const ultraHighSpin = 1 - 0.06 * smoothStepRange(spinRatio, 0.58, 0.85);
	return cl * highSpin * ultraHighSpin;
}

function smoothStepRange(value, start, end) {
	if (end <= start) {
		return value >= end ? 1 : 0;
	}
	const t = clamp((value - start) / (end - start), 0, 1);
	return t * t * (3 - 2 * t);
}

function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

function lerp(a, b, t) {
	return a + (b - a) * t;
}

function degreesToRadians(value) {
	return value * Math.PI / 180;
}

function add3(a, b) {
	return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale3(v, scalar) {
	return [v[0] * scalar, v[1] * scalar, v[2] * scalar];
}

function length3(v) {
	return Math.hypot(v[0], v[1], v[2]);
}

function cross3(a, b) {
	return [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
}
