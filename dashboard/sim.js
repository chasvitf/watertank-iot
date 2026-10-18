// In-browser stand-in for the ESP32, for when the real board is offline. It runs
// the same control logic (control.js) on a toy tank and talks over the same MQTT
// topics, so the dashboard code path is identical. Nothing it publishes is
// retained, so it leaves no trace on the broker.
import { Controller, UsageMeter, settingsValid } from "./control.js";

const SPEED = 10;          // simulated seconds per real second, so a refill takes about a minute
const TICK_MS = 1000;
const PUBLISH_MS = 2000;
const TANK_LITRES = 1000;
const PUMP_LPM = 100;      // refill pump, litres per minute

export class Simulator {
  constructor(client, base) {
    this.client = client;
    this.base = base;
    this.ctl = new Controller();
    this.usage = new UsageMeter();
    this.settings = { start: 30, stop: 90, alarm: 15, autoMode: true };
    this.level = 47;
    this.out = { pump: false, alarm: false, fault: "none" };
    this.silenced = false;
    this.valveClosed = false;   // "break" the supply to show the no-rise protection
    this.clock = 7 * 3600 * 1000; // simulated ms since midnight; start at 07:00
    this.bootClock = this.clock;
    this.history = [];
    this.timers = [];
    this.onCmd = (topic, payload) => {
      if (topic === `${this.base}/cmd`) this.command(JSON.parse(payload.toString()));
    };
  }

  start() {
    this.client.subscribe(`${this.base}/cmd`);
    this.client.on("message", this.onCmd);
    // Fast-forward one real hour so the chart has history straight away.
    const startReal = Date.now() - 60 * 60000;
    for (let m = 0; m < 60; m++) {
      let level = 0, pump = 0;
      for (let s = 0; s < 60; s++) {
        this.step(1000);
        level += this.level;
        pump += this.out.pump ? 100 : 0;
      }
      this.history.push([Math.round((startReal + m * 60000) / 1000), +(level / 60).toFixed(1), Math.round(pump / 60)]);
    }
    this.publish("status", "online");
    this.publishConfig();
    this.publish("history", JSON.stringify(this.history));
    this.publishState();
    this.timers.push(setInterval(() => { if (this.step(TICK_MS)) this.publishState(); }, TICK_MS));
    this.timers.push(setInterval(() => this.publishState(), PUBLISH_MS));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.client.removeListener("message", this.onCmd);
    this.client.unsubscribe(`${this.base}/cmd`);
    this.publish("status", "offline");
  }

  // Toy household: water use peaks in the morning and evening, the pump adds
  // 100 L/min unless the supply valve is "closed".
  step(realMs) {
    const dt = (realMs * SPEED) / 1000;            // simulated seconds
    this.clock += dt * 1000;
    const hour = (this.clock / 3600000) % 24;
    const peak = Math.exp(-((hour - 7) ** 2) / 2) + Math.exp(-((hour - 19) ** 2) / 3);
    const useLpm = 0.8 + 12 * peak * (0.6 + Math.random() * 0.8);  // about 1,000 L a day
    const inLpm = this.out.pump && !this.valveClosed ? PUMP_LPM : 0;
    this.level += (((inLpm - useLpm) / 60) * dt * 100) / TANK_LITRES;
    this.level = Math.min(100, Math.max(0, this.level));
    const measured = this.level + (Math.random() - 0.5) * 0.3;   // ultrasonic noise
    const before = this.out;
    this.out = this.ctl.update(measured, true, this.settings, this.clock);
    this.usage.update(measured, this.out.pump, Math.floor(this.clock / 86400000) + 1, TANK_LITRES);
    if (!this.out.alarm) this.silenced = false;
    return before.pump !== this.out.pump || before.fault !== this.out.fault || before.alarm !== this.out.alarm;
  }

  command(cmd) {
    if (typeof cmd.mode === "string") {
      const auto = cmd.mode === "auto";
      if (!auto && this.settings.autoMode) this.ctl.setManualPump(this.out.pump);
      this.settings.autoMode = auto;
    }
    if (!this.settings.autoMode && typeof cmd.pump === "boolean") this.ctl.setManualPump(cmd.pump);
    if (cmd.reset) this.ctl.clearFault();
    if (cmd.silence) this.silenced = true;
    if (typeof cmd.valveClosed === "boolean") this.valveClosed = cmd.valveClosed;  // simulator only
    const start = cmd.start ?? this.settings.start, stop = cmd.stop ?? this.settings.stop, alarm = cmd.alarm ?? this.settings.alarm;
    if (settingsValid(start, stop, alarm)) Object.assign(this.settings, { start, stop, alarm });
    this.step(0);
    this.publishConfig();
    this.publishState();
  }

  publish(sub, payload) {
    this.client.publish(`${this.base}/${sub}`, payload, { retain: false });
  }

  publishConfig() {
    const s = this.settings;
    this.publish("config", JSON.stringify({ mode: s.autoMode ? "auto" : "manual", start: s.start, stop: s.stop, alarm: s.alarm, tankLitres: TANK_LITRES }));
  }

  publishState() {
    const level = +this.level.toFixed(1);
    this.publish("state", JSON.stringify({
      ts: Math.round(Date.now() / 1000), level, litres: Math.round((level / 100) * TANK_LITRES),
      distance: +(120 - level).toFixed(1), sensorOk: true, ...this.out, silenced: this.silenced,
      mode: this.settings.autoMode ? "auto" : "manual", usedToday: Math.round(this.usage.used), refillsToday: this.usage.refills,
      valveClosed: this.valveClosed, rssi: -55 - Math.round(Math.random() * 10),
      uptime: Math.round((this.clock - this.bootClock) / 1000 / SPEED), fw: "sim",
    }));
  }
}
