import mqtt from "https://cdn.jsdelivr.net/npm/mqtt@5.16.0/dist/mqtt.esm.js";
import { drawHistory, drawTank } from "./chart.js";
import { Simulator } from "./sim.js";
import { settingsValid } from "./control.js";
import { LocalBus } from "./localbus.js";

const BROKER = "wss://broker.emqx.io:8084/mqtt";
const params = new URLSearchParams(location.search);
const REAL_DEVICE = (params.get("device") || "demo-01").replace(/[^\w-]/g, "").slice(0, 32) || "demo-01";
const STALE_MS = 20000;   // no state for this long while "online" = treat as offline
const HISTORY_MS = 60 * 60000;
const FAULT_TEXT = {
  norise: "ปั๊มทำงานแต่น้ำไม่ขึ้น บอร์ดหยุดปั๊มแล้ว ตรวจวาล์ว ท่อ หรือน้ำประปาไม่ไหล",
  maxrun: "ปั๊มทำงานนานเกิน 20 นาที บอร์ดหยุดปั๊มแล้ว ตรวจรอยรั่วหรือลูกลอย",
  sensor: "อ่านเซนเซอร์ระดับน้ำไม่ได้ หยุดปั๊มไว้ก่อนเพื่อความปลอดภัย",
};

const $ = (id) => document.getElementById(id);
const css = getComputedStyle(document.documentElement);
const color = (name) => css.getPropertyValue(name).trim();

const state = {
  device: REAL_DEVICE,
  base: "",
  status: null,        // "online" | "offline" | null (unknown)
  last: null,          // last state message
  lastAt: 0,           // when it arrived (ms)
  config: { mode: "auto", start: 30, stop: 90, alarm: 15, tankLitres: 1000 },
  points: [],          // [{ts, level, pump}] for the chart
  log: [],
  sim: null,
  cfgDirty: false,
  notified: "",        // the alert text last pushed as a notification
};

// ---------- MQTT ----------

const client = mqtt.connect(BROKER, {
  clientId: "watertank-dash-" + Math.random().toString(16).slice(2, 10),
  clean: true,
  reconnectPeriod: 3000,
  connectTimeout: 10000,
});
client.on("connect", () => addLog("เชื่อมต่อ MQTT broker แล้ว"));
client.on("reconnect", () => setPill("connecting"));
client.on("error", (err) => console.warn("WaterTank: mqtt error", err.message));
// The simulator runs inside the page on its own bus; the real board comes through the broker.
const bus = new LocalBus();
client.on("message", (topic, payload) => { if (!state.sim) onMessage(topic, payload); });
bus.on("message", (topic, payload) => { if (state.sim) onMessage(topic, payload); });

function onMessage(topic, payload) {
  if (!topic.startsWith(state.base + "/")) return;
  const sub = topic.slice(state.base.length + 1);
  const text = payload.toString();
  try {
    if (sub === "status") onStatus(text);
    else if (sub === "state") onState(JSON.parse(text));
    else if (sub === "config") onConfig(JSON.parse(text));
    else if (sub === "history") onHistory(JSON.parse(text));
  } catch (err) {
    console.warn("WaterTank: bad message on", topic, err);
  }
}

function watch(device, simulated = false) {
  if (state.base && !state.base.includes("/sim-")) client.unsubscribe(`${state.base}/#`);
  state.device = device;
  state.base = `watertank-th/${device}`;
  state.status = null;
  state.last = null;
  state.lastAt = 0;
  state.points = [];
  state.cfgDirty = false;
  $("deviceId").textContent = device;
  $("m-topic").textContent = simulated ? "ในเบราว์เซอร์ (ไม่ผ่าน broker)" : `${state.base}/#`;
  if (!simulated) client.subscribe(`${state.base}/#`, { qos: 1 });
  render();
  // Retained messages arrive at once; if nothing says "online", show the offline banner.
  setTimeout(() => { if (state.status === null) { state.status = "offline"; render(); } }, 2500);
}

function send(cmd) {
  (state.sim ? bus : client).publish(`${state.base}/cmd`, JSON.stringify(cmd), { qos: 1 });
}

// ---------- incoming ----------

function onStatus(text) {
  if (text !== state.status) {
    if (state.status !== null) addLog(text === "online" ? "บอร์ดออนไลน์" : "บอร์ดออฟไลน์");
    state.status = text;
  }
  render();
}

function onState(s) {
  const prev = state.last;
  state.last = s;
  state.lastAt = Date.now();
  if (prev) {
    if (prev.pump !== s.pump) addLog(s.pump ? `เริ่มเติมน้ำ (น้ำเหลือ ${Math.round(s.level)}%)` : `หยุดเติมน้ำ (${Math.round(s.level)}%)`);
    if (prev.fault !== s.fault) addLog(s.fault === "none" ? "ล้างข้อผิดพลาดแล้ว" : `⚠ ${FAULT_TEXT[s.fault] || s.fault}`);
    if (!prev.alarm && s.alarm && s.fault === "none") addLog(`⚠ น้ำใกล้หมด เหลือ ${Math.round(s.level)}%`);
    if (prev.mode !== s.mode) addLog(s.mode === "auto" ? "เปลี่ยนเป็นโหมดอัตโนมัติ" : "เปลี่ยนเป็นโหมดสั่งเอง");
  }
  const ts = s.ts ? s.ts * 1000 : Date.now();
  const lastPoint = state.points[state.points.length - 1];
  if (!lastPoint || ts - lastPoint.ts >= 5000) {
    state.points.push({ ts, level: s.level, pump: s.pump ? 100 : 0 });
    trimPoints();
  }
  if (state.status !== "online" && s.ts && Date.now() - ts < STALE_MS) state.status = "online";
  notifyIfNeeded(s);
  render();
}

function onConfig(c) {
  state.config = { ...state.config, ...c };
  if (!state.cfgDirty) for (const k of ["start", "stop", "alarm"]) $(k).value = state.config[k];
  render();
}

function onHistory(rows) {
  if (!Array.isArray(rows)) return;
  const pts = rows.filter((r) => Array.isArray(r) && r[0] > 1e9).map((r) => ({ ts: r[0] * 1000, level: r[1], pump: r[2] }));
  const newest = pts.length ? pts[pts.length - 1].ts : 0;
  state.points = [...pts, ...state.points.filter((p) => p.ts > newest)];
  trimPoints();
  render();
}

function trimPoints() {
  const end = state.points.length ? state.points[state.points.length - 1].ts : Date.now();
  state.points = state.points.filter((p) => p.ts >= end - HISTORY_MS).sort((a, b) => a.ts - b.ts);
}

// ---------- alerts ----------

function alertText(s) {
  if (!s?.alarm) return "";
  return FAULT_TEXT[s.fault] || `น้ำในแท็งก์เหลือน้อย ${Math.round(s.level)}% (ต่ำกว่า ${state.config.alarm}%)`;
}

// Browser notification when an alert starts (only if the user allowed it, and only live data).
function notifyIfNeeded(s) {
  const text = isLive() || state.sim ? alertText(s) : "";
  if (text && text !== state.notified && "Notification" in window && Notification.permission === "granted") {
    new Notification("WaterTank แจ้งเตือน", { body: text, icon: "/favicon.svg", tag: "watertank" });
  }
  state.notified = text;
}

// ---------- rendering ----------

function setPill(kind) {
  const pill = $("status");
  pill.className = "pill " + kind;
  pill.querySelector("b").textContent = {
    online: "ออนไลน์", offline: "ออฟไลน์", sim: "อุปกรณ์จำลอง", connecting: "กำลังเชื่อมต่อ…",
  }[kind];
}

// When the data was measured: the board's NTP timestamp if it sent one,
// otherwise when the message arrived (retained messages arrive at once, so
// that alone would make old data look fresh).
function dataTime() {
  return state.last?.ts ? state.last.ts * 1000 : state.lastAt;
}

function isLive() {
  return state.status === "online" && Date.now() - dataTime() < STALE_MS;
}

function render() {
  const s = state.last;
  const live = isLive();
  const cfg = state.config;
  setPill(state.sim ? "sim" : state.status === null ? "connecting" : live ? "online" : "offline");
  $("offline").hidden = !!state.sim || state.status === null || live;
  $("simBanner").hidden = !state.sim;
  if (!live && !state.sim) {
    $("offlineTitle").textContent = `บอร์ด ${state.device} ออฟไลน์อยู่`;
    $("offlineText").textContent = s?.ts
      ? `ข้อมูลที่เห็นคือค่าล่าสุดที่บอร์ดส่งไว้เมื่อ ${new Date(s.ts * 1000).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" })} บอร์ดจริงรันบน Wokwi (ตัวจำลอง ESP32) เป็นช่วง ๆ`
      : "ยังไม่มีข้อมูลจากบอร์ด บอร์ดจริงรันบน Wokwi (ตัวจำลอง ESP32) เป็นช่วง ๆ ลองเปิดอุปกรณ์จำลองในเบราว์เซอร์แทนได้";
  }

  const canControl = live || !!state.sim;
  const alert = canControl ? alertText(s) : "";
  $("alertbar").hidden = !alert;
  $("alertText").textContent = alert;
  $("reset").hidden = !s || s.fault === "none" || s.fault === "sensor";
  $("silence").hidden = !s?.alarm || s.silenced;

  const sensorBad = s?.fault === "sensor";
  $("v-level").textContent = s && !sensorBad ? Math.round(s.level) : "–";
  $("v-litres").textContent = s && !sensorBad ? s.litres.toLocaleString("th-TH") : "–";
  $("v-tank").textContent = Number(cfg.tankLitres || 1000).toLocaleString("th-TH");
  $("v-used").textContent = s?.usedToday != null ? s.usedToday.toLocaleString("th-TH") : "–";
  $("v-refills").textContent = s?.refillsToday ?? "–";
  $("v-dist").textContent = s?.distance != null && !sensorBad ? s.distance.toFixed(1) : "–";
  const pumpLine = $("pumpLine");
  pumpLine.textContent = !s ? "ปั๊ม –" : s.fault !== "none" ? "ปั๊มหยุด (ข้อผิดพลาด)" : s.pump ? "💧 กำลังเติมน้ำ" : `ปั๊มปิด · เติมเมื่อต่ำกว่า ${cfg.start}%`;
  pumpLine.className = "pumpline" + (s?.fault !== "none" && s ? " bad" : s?.pump ? " on" : "");
  drawTank($("tank"), s && !sensorBad ? s.level : null, cfg, {
    water: color("--water"), water2: color("--water2"), empty: "#f2f7fc", wall: "#5a7a99", mark: color("--muted"), alarm: color("--red"),
  }, !!s?.pump);

  const manual = (s?.mode || cfg.mode) === "manual";
  document.querySelector(".control").classList.toggle("disabled", !canControl);
  document.querySelectorAll(".seg button").forEach((b) => {
    b.classList.toggle("on", b.dataset.mode === (manual ? "manual" : "auto"));
    b.disabled = !canControl;
  });
  const pumpBtn = $("pump");
  pumpBtn.classList.toggle("on", !!s?.pump);
  pumpBtn.classList.toggle("fault", !!s && s.fault !== "none");
  pumpBtn.disabled = !canControl || !manual;
  pumpBtn.title = manual ? "" : "สลับเป็นโหมดสั่งเองก่อน";
  $("pumpState").textContent = s ? (s.fault !== "none" ? "หยุดเพราะข้อผิดพลาด" : s.pump ? "กำลังเติมน้ำ" : "ปิด") : "–";
  $("modeHint").textContent = manual
    ? `โหมดสั่งเอง: กดเปิด/ปิดได้เลย (ปั๊มยังหยุดเองที่ ${cfg.stop}% และเมื่อน้ำไม่ขึ้น)`
    : "โหมดอัตโนมัติ: บอร์ดตัดสินใจเองจากระดับน้ำและค่าเกณฑ์";
  const start = Number($("start").value), stop = Number($("stop").value), alarm = Number($("alarm").value);
  $("startOut").textContent = start;
  $("stopOut").textContent = stop;
  $("alarmOut").textContent = alarm;
  const valid = settingsValid(start, stop, alarm);
  $("cfgHint").textContent = valid ? "" : "ค่าเตือนต้องต่ำกว่าค่าเริ่มเติม และหยุดเติมต้องสูงกว่าเริ่มเติมอย่างน้อย 15%";
  $("saveCfg").disabled = !canControl || !state.cfgDirty || !valid;
  $("notify").hidden = !("Notification" in window) || Notification.permission !== "default";

  $("m-rssi").textContent = s?.rssi != null ? `${s.rssi} dBm` : "–";
  $("m-uptime").textContent = s?.uptime != null ? formatUptime(s.uptime) : "–";
  $("m-fw").textContent = s?.fw ? (s.fw === "sim" ? "จำลองในเบราว์เซอร์" : `v${s.fw}`) : "–";
  $("valve").checked = !!s?.valveClosed;

  $("log").innerHTML = state.log.length
    ? state.log.slice(0, 8).map((l) => `<li><time>${l.time}</time><span>${l.text}</span></li>`).join("")
    : '<li class="empty">ยังไม่มีเหตุการณ์</li>';

  drawHistory($("chart"), state.points, {
    start: Number(cfg.start), stop: Number(cfg.stop), alarm: Number(cfg.alarm),
    colors: { level: color("--water2"), pump: "#16a34a", grid: color("--line"), text: color("--muted"), mark: color("--muted"), alarm: color("--red") },
  });
  renderAgo();
}

function renderAgo() {
  const sec = Math.round((Date.now() - dataTime()) / 1000);
  $("ago").textContent = state.lastAt && sec >= 0 && sec < 60 ? `อัปเดต ${sec} วินาทีที่แล้ว` : "";
}

function formatUptime(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? `${h} ชม. ${m} นาที` : m ? `${m} นาที ${sec % 60} วินาที` : `${sec} วินาที`;
}

function addLog(text) {
  state.log.unshift({ time: new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" }), text });
  state.log.length = Math.min(state.log.length, 30);
}

// ---------- controls ----------

document.querySelector(".seg").addEventListener("click", (e) => {
  const mode = e.target.closest("button")?.dataset.mode;
  if (!mode) return;
  send({ mode });
  addLog(mode === "auto" ? "ส่งคำสั่ง: โหมดอัตโนมัติ" : "ส่งคำสั่ง: โหมดสั่งเอง");
  render();
});
$("pump").addEventListener("click", () => {
  const next = !state.last?.pump;
  send({ pump: next });
  addLog(`ส่งคำสั่ง: ปั๊ม ${next ? "เปิด" : "ปิด"}`);
  render();
});
for (const id of ["start", "stop", "alarm"]) {
  $(id).addEventListener("input", () => { state.cfgDirty = true; render(); });
}
$("saveCfg").addEventListener("click", () => {
  const cmd = { start: Number($("start").value), stop: Number($("stop").value), alarm: Number($("alarm").value) };
  send(cmd);
  state.cfgDirty = false;
  addLog(`ส่งคำสั่ง: เติมเมื่อ < ${cmd.start}% หยุดที่ ${cmd.stop}% เตือน < ${cmd.alarm}%`);
  render();
});
$("silence").addEventListener("click", () => { send({ silence: true }); addLog("ส่งคำสั่ง: ปิดเสียงเตือน"); });
$("reset").addEventListener("click", () => { send({ reset: true }); addLog("ส่งคำสั่ง: ล้างข้อผิดพลาด"); });
$("valve").addEventListener("change", (e) => {
  send({ valveClosed: e.target.checked });
  addLog(e.target.checked ? "จำลอง: ปิดวาล์วน้ำเข้า" : "จำลอง: เปิดวาล์วน้ำเข้า");
});
$("notify").addEventListener("click", async () => {
  const p = await Notification.requestPermission();
  addLog(p === "granted" ? "เปิดแจ้งเตือนบนอุปกรณ์นี้แล้ว" : "ไม่ได้อนุญาตการแจ้งเตือน");
  render();
});
$("startSim").addEventListener("click", () => {
  const id = "sim-" + Math.random().toString(36).slice(2, 6);
  state.sim = new Simulator(bus, `watertank-th/${id}`);
  watch(id, true);
  state.sim.start();
  addLog("เปิดอุปกรณ์จำลองในเบราว์เซอร์");
  render();
});
$("stopSim").addEventListener("click", stopSim);
window.addEventListener("pagehide", () => state.sim?.stop());

function stopSim() {
  state.sim?.stop();
  state.sim = null;
  watch(REAL_DEVICE);
  addLog("กลับไปดูบอร์ดจริง");
}

setInterval(() => { renderAgo(); if (!isLive() && state.status === "online" && !state.sim) render(); }, 1000);
new ResizeObserver(() => render()).observe($("chart"));
if (params.has("debug")) window.watertank = { state, client };
// Start watching now, not on "connect": mqtt.js queues the subscription until it
// connects, and if the public broker is down the offline banner (with the
// simulator button) still appears after a few seconds.
if (params.get("sim") === "1") $("startSim").click();
else watch(state.device);
