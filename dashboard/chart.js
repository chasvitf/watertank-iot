// Minimal SVG drawings with no dependencies: the tank picture and the 1-hour chart.

const NS = "http://www.w3.org/2000/svg";

function el(name, attrs, parent) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.appendChild(node);
  return node;
}

/** Tank (viewBox 160 x 220) filled to `level` %, with the start / stop / alarm marks. */
export function drawTank(svg, level, cfg, colors, pumpOn) {
  svg.replaceChildren();
  const x = 22, y = 18, w = 116, h = 186;           // inside of the tank
  const yAt = (pct) => y + h - (pct / 100) * h;
  const defs = el("defs", {}, svg);
  const clip = el("clipPath", { id: "tankClip" }, defs);
  el("rect", { x, y, width: w, height: h, rx: 14 }, clip);
  const grad = el("linearGradient", { id: "water", x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  el("stop", { offset: "0", "stop-color": colors.water }, grad);
  el("stop", { offset: "1", "stop-color": colors.water2 }, grad);

  el("rect", { x, y, width: w, height: h, rx: 14, fill: colors.empty }, svg);
  if (level != null) {
    const top = yAt(level);
    const g = el("g", { "clip-path": "url(#tankClip)" }, svg);
    // a gentle wave on the surface
    const wave = `M${x - 20},${top} q 18,-5 36,0 t 36,0 t 36,0 t 36,0 t 36,0 V${y + h + 5} H${x - 20} Z`;
    el("path", { d: wave, fill: "url(#water)", class: pumpOn ? "wave on" : "wave" }, g);
  }
  // threshold marks on the right wall
  for (const [pct, label, color] of [[cfg.stop, "หยุด", colors.mark], [cfg.start, "เริ่ม", colors.mark], [cfg.alarm, "เตือน", colors.alarm]]) {
    const yy = yAt(pct);
    el("line", { x1: x + w - 16, x2: x + w + 6, y1: yy, y2: yy, stroke: color, "stroke-width": 2 }, svg);
    el("text", { x: x + w + 9, y: yy + 4, fill: color, "font-size": 11, "font-family": "IBM Plex Sans Thai" }, svg).textContent = label;
  }
  el("rect", { x, y, width: w, height: h, rx: 14, fill: "none", stroke: colors.wall, "stroke-width": 4 }, svg);
  // lid with the sensor
  el("rect", { x: x + w / 2 - 14, y: 4, width: 28, height: 12, rx: 3, fill: colors.wall }, svg);
  el("circle", { cx: x + w / 2 - 6, cy: 10, r: 3.2, fill: "#fff" }, svg);
  el("circle", { cx: x + w / 2 + 6, cy: 10, r: 3.2, fill: "#fff" }, svg);
}

/**
 * points: [{ts (ms), level, pump (0-100)}], sorted by ts.
 * opts: {start, stop, alarm, colors: {level, pump, grid, text, mark, alarm}}
 */
export function drawHistory(svg, points, opts) {
  const W = svg.clientWidth || 600, H = svg.clientHeight || 230;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.replaceChildren();
  const pad = { l: 40, r: 14, t: 12, b: 26 };
  const c = opts.colors;
  if (points.length < 2) {
    el("text", { x: W / 2, y: H / 2, "text-anchor": "middle", fill: c.text, "font-size": 13 }, svg).textContent = "รอข้อมูล…";
    return;
  }
  const t0 = points[0].ts, t1 = points[points.length - 1].ts;
  const x = (ts) => pad.l + ((ts - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / 100) * (H - pad.t - pad.b);

  for (let i = 0; i <= 4; i++) {
    const v = 100 - i * 25;
    el("line", { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), stroke: c.grid, "stroke-width": 1 }, svg);
    el("text", { x: pad.l - 6, y: y(v) + 4, "text-anchor": "end", fill: c.text, "font-size": 11 }, svg).textContent = `${v}%`;
  }
  const span = t1 - t0;
  const step = span > 50 * 60000 ? 15 * 60000 : span > 20 * 60000 ? 10 * 60000 : 5 * 60000;
  for (let ts = Math.ceil(t0 / step) * step; ts <= t1; ts += step) {
    const label = new Date(ts).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
    el("text", { x: x(ts), y: H - 8, "text-anchor": "middle", fill: c.text, "font-size": 11 }, svg).textContent = label;
  }

  // pump run time as bars along the bottom; each bar spans until the next point
  points.forEach((p, i) => {
    if (!p.pump) return;
    const next = points[i + 1];
    const w = Math.min(40, Math.max(1.5, next ? x(next.ts) - x(p.ts) : 3));
    const h = (p.pump / 100) * 22;
    el("rect", { x: x(p.ts), y: H - pad.b - h, width: w, height: h, fill: c.pump, opacity: 0.5 }, svg);
  });

  for (const [v, color] of [[opts.stop, c.mark], [opts.start, c.mark], [opts.alarm, c.alarm]]) {
    el("line", { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), stroke: color, "stroke-dasharray": "4 4", opacity: 0.8 }, svg);
  }

  const pts = points.filter((p) => p.level != null);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.ts).toFixed(1)},${y(p.level).toFixed(1)}`).join("");
  const area = `${line}L${x(pts[pts.length - 1].ts).toFixed(1)},${y(0)}L${x(pts[0].ts).toFixed(1)},${y(0)}Z`;
  el("path", { d: area, fill: c.level, opacity: 0.12 }, svg);
  el("path", { d: line, fill: "none", stroke: c.level, "stroke-width": 2.4, "stroke-linejoin": "round" }, svg);
}
