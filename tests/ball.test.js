import assert from "node:assert/strict";
import test from "node:test";
import { calculateCarryYards } from "../src/carry.js";
import { ProtoWriter, parseShotFromProto } from "../src/r10/proto.js";

const MPH_PER_MPS = 2.2369362920544;

test("parses ball metrics alongside club metrics", () => {
	const writer = new ProtoWriter();
	writer.writeMessage(30, (event) => {
		event.writeMessage(3, (notification) => {
			notification.writeVarint(1, 8);
			notification.writeMessage(1001, (details) => {
				details.writeMessage(2, (metrics) => {
					metrics.writeVarint(1, 42);
					metrics.writeVarint(2, 1);
					metrics.writeMessage(3, (ball) => {
						ball.writeFloat(1, 12.5);
						ball.writeFloat(2, -0.5);
						ball.writeFloat(3, 150 / MPH_PER_MPS);
						ball.writeFloat(4, 2.0);
						ball.writeFloat(5, 2800);
					});
					metrics.writeMessage(4, (club) => {
						club.writeFloat(1, 100 / MPH_PER_MPS);
						club.writeFloat(3, -1.2);
						club.writeFloat(4, 1.5);
					});
				});
			});
		});
	});

	const shot = parseShotFromProto(writer.finish());
	assert.ok(shot);
	assert.equal(shot.shotId, 42);
	assert.equal(shot.shotType, 1);
	assert.ok(Math.abs(shot.ballSpeedMps * MPH_PER_MPS - 150) < 0.01);
	assert.ok(Math.abs(shot.clubHeadSpeedMph - 100) < 0.01);
	assert.ok(Math.abs(shot.launchAngleDeg - 12.5) < 0.001);
	assert.ok(Math.abs(shot.launchDirectionDeg + 0.5) < 0.001);
	assert.ok(Math.abs(shot.totalSpinRpm - 2800) < 0.01);
});

test("carry model returns plausible first-impact distances", () => {
	const driverCarry = calculateCarryYards({
		ballSpeedMps: 150 / MPH_PER_MPS,
		launchAngleDeg: 12.5,
		launchDirectionDeg: 0,
		totalSpinRpm: 2800,
		spinAxisDeg: 0,
	});
	const wedgeCarry = calculateCarryYards({
		ballSpeedMps: 100 / MPH_PER_MPS,
		launchAngleDeg: 28,
		launchDirectionDeg: 0,
		totalSpinRpm: 9000,
		spinAxisDeg: 0,
	});

	assert.ok(driverCarry > 235 && driverCarry < 265);
	assert.ok(wedgeCarry > 115 && wedgeCarry < 145);
	assert.ok(driverCarry > wedgeCarry);
});
