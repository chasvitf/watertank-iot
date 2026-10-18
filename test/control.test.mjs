// The dashboard simulator's port (dashboard/control.js) must act like the firmware
// (firmware/watertank/control.h, tested in control_test.cpp). Same cases here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Controller, UsageMeter, levelPercent, settingsValid } from "../dashboard/control.js";

const S = 1000, M = 60000;
const settings = (over = {}) => ({ start: 30, stop: 90, alarm: 15, autoMode: true, ...over });

test("level from distance", () => {
  assert.equal(levelPercent(120, 120, 20), 0);
  assert.equal(levelPercent(70, 120, 20), 50);
  assert.equal(levelPercent(10, 120, 20), 100);
});

test("refills between start and stop", () => {
  const c = new Controller(), s = settings();
  let t = 0;
  assert.equal(c.update(50, true, s, t).pump, false);
  assert.equal(c.update(30, true, s, (t += S)).pump, true);
  assert.equal(c.update(60, true, s, (t += S)).pump, true);
  assert.equal(c.update(90, true, s, (t += S)).pump, false);
});

test("stops when the level does not rise, until the fault is cleared", () => {
  const c = new Controller(), s = settings();
  let t = 0, o = c.update(25, true, s, t);
  for (let i = 0; i < 180; i++) o = c.update(25.5, true, s, (t += S));
  assert.equal(o.fault, "norise");
  assert.equal(o.pump, false);
  assert.equal(c.update(25, true, s, (t += 10 * M)).pump, false);
  c.clearFault();
  assert.equal(c.update(25, true, s, (t += S)).pump, true);
});

test("sensor failure stops the pump and recovers", () => {
  const c = new Controller(), s = settings();
  let t = 0, o;
  c.update(20, true, s, t);
  for (let i = 0; i < 5; i++) o = c.update(0, false, s, (t += S));
  assert.equal(o.fault, "sensor");
  assert.equal(o.pump, false);
  o = c.update(21, true, s, (t += S));
  assert.equal(o.fault, "none");
  assert.equal(o.pump, true);
});

test("usage counts drops, not refills, and resets at midnight", () => {
  const u = new UsageMeter();
  u.update(80, false, 1, 1000);
  u.update(75, false, 1, 1000);
  assert.ok(Math.abs(u.used - 50) < 0.01);
  u.update(76, true, 1, 1000);
  u.update(90, false, 1, 1000);
  assert.equal(u.refills, 1);
  assert.ok(Math.abs(u.used - 50) < 0.01);
  u.update(88, false, 2, 1000);
  assert.equal(u.used, 0);
});

test("a refill that starts before the clock is set still counts", () => {
  const u = new UsageMeter();
  u.update(25, false, 0, 1000);
  u.update(25.5, true, 0, 1000);
  u.update(27, true, 20380, 1000);
  assert.equal(u.refills, 1);
});

test("settings validation", () => {
  assert.ok(settingsValid(30, 90, 15));
  assert.ok(!settingsValid(30, 40, 15));
  assert.ok(!settingsValid(30, 90, 30));
});
