// Clicky's lesson player. Rust streams a program's code in; the sandboxed worker
// turns it into marks and say() lines. This file holds each mark back until its
// line is being spoken, spreads the line's marks across the line's real spoken
// time, and paints them: pen strokes, handwriting, paper, buttons, 3D stages.
//
// The rule that makes it feel like a person at a whiteboard: nothing appears
// before the words about it are heard, and a line's drawing ends with the line.
(() => {
  "use strict";

  // ---- pacing
  const WORDS_PER_SECOND = 2.6;
  const LINE_LEAD_SECONDS = 0.08;  // the voice starts just before the pen
  const LINE_TAIL_SECONDS = 0.12;  // and the pen lifts just before the voice stops
  const FASTEST_PACE = 0.35;       // strokes may run this much faster to fit a line
  const RUSH_PACE = 0.2;           // or this fast when a line starts late or is overfull
  const SLOWEST_PACE = 2;          // and this much slower when a line has room
  const MAX_GAP_STRETCH = 4;       // spare time beyond this is a rest at the line's end
  const OPEN_LINE_PACE_LIMIT = 1.3;// a line still being written may get more strokes
  const VOICE_WAIT_SECONDS = 15;   // draw anyway if the voice never arrives
  // ---- the pen
  const PEN_POINTS_PER_SECOND = 1400;
  const PEN_BASE_SECONDS = 0.25;
  const PEN_MIN_SECONDS = 0.3;
  const PEN_MAX_SECONDS = 1.4;
  const DEFAULT_PEN_SIZE = 2.8;
  const TEXT_LINE_HEIGHT = 1.3;
  const MIN_TEXT_SIZE = 13;
  // Larger fills skip the watercolour edge: costly while a stroke animates.
  const WASH_MAX_AREA = 60000;
  const WINDOW_HEADER = 28, WINDOW_RADIUS = 10;
  const PILL_TEXT = 12, BADGE_TEXT = 13;
  const UI_FONT = "system-ui, Inter, 'Noto Sans', sans-serif";
  // A little of the user's cursor colour in the paper and the pills.
  const PAPER_TONES = {
    "#3380FF": "#EFF2F6", "#FF4C4C": "#F9EFEA", "#D4A017": "#FAF5EA", "#26C281": "#EFF4EB",
  };
  const GEL_TONES = {
    "#3380FF": { top: "#EDF4FF", mid: "#A2C7FF", low: "#A2D2F7", rim: "#221898" },
    "#FF4C4C": { top: "#FFF1EF", mid: "#FFB8B0", low: "#FFC8C0", rim: "#7A1E1E" },
    "#D4A017": { top: "#FFF8E2", mid: "#FFDF8A", low: "#FFE9A8", rim: "#6E4E00" },
    "#26C281": { top: "#EFFBF2", mid: "#C9F0CF", low: "#B4E8C5", rim: "#17603F" },
  };
  const WINDOW_TINTS = { "#D4A017": ["#FEEA3D", 0.12], "#3380FF": ["#0F7FFF", 0.08], "#FF4C4C": ["#FF5A4C", 0.08], "#26C281": ["#26C281", 0.1] };
  const SAMPLE_SPACING = 6;
  const WATCHDOG_SECONDS = 3;
  const PAPER_INK = "#30333A";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const now = () => performance.now() / 1000;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const easeOutCubic = (t) => 1 - (1 - t) ** 3;
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  const easeOutBack = (t) => { const c = 1.5; return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2; };
  const toRust = (message) => window.webkit?.messageHandlers?.clicky?.postMessage(JSON.stringify(message));

  function svg(tag, attributes) {
    const element = document.createElementNS(SVG_NS, tag);
    for (const key of Object.keys(attributes || {})) {
      if (attributes[key] !== undefined && attributes[key] !== null) element.setAttribute(key, attributes[key]);
    }
    return element;
  }

  // ---------------------------------------------------------------- how long each mark takes at pace 1
  function polylineLength(points) {
    let total = 0;
    for (let i = 1; i < (points || []).length; i++) total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    return total;
  }
  const penSeconds = (length) => clamp(PEN_BASE_SECONDS + length / PEN_POINTS_PER_SECOND, PEN_MIN_SECONDS, PEN_MAX_SECONDS);

  function naturalTiming(mark) {
    const timing = naturalTimingAlone(mark);
    return mark.together ? { dur: timing.dur, adv: 0 } : timing;
  }
  function naturalTimingAlone(mark) {
    let dur = 0.3;
    switch (mark.do) {
      case "line": dur = mark.dash ? Math.min(0.9, 0.2 + polylineLength(mark.pts) / 900) : penSeconds(polylineLength(mark.pts)); break;
      case "arrow": { const d = penSeconds(polylineLength(mark.pts)); return { dur: d + 0.16, adv: d + 0.1 }; }
      case "circle": case "ellipse": dur = penSeconds(Math.PI * ((mark.r || mark.rx || 10) + (mark.r || mark.ry || 10))); break;
      case "rect": dur = mark.outline === false ? 0.3 : penSeconds(2 * (Math.abs(mark.w) + Math.abs(mark.h))); break;
      case "poly": dur = penSeconds(polylineLength((mark.pts || []).concat(mark.pts && mark.pts.length ? [mark.pts[0]] : []))); break;
      case "path": dur = 0.5; break;
      case "dot": return { dur: 0.25, adv: 0.06 };
      case "act": return { dur: 0, adv: 0 };
      case "molecule": return { dur: 0.6, adv: 0.4 };
      case "highlight": dur = 0.35; break;
      case "text": { const n = String(mark.text).length; return { dur: 0.4 + n * 0.015, adv: (0.35 + n * 0.012) * 0.7 }; }
      case "pill": case "badge": return { dur: 0.28, adv: 0.16 };
      case "image": return { dur: 0.5, adv: 0.3 };
      case "window": return { dur: 0.45, adv: 0.3 };
      case "button": return { dur: 0.25, adv: 0.12 };
      case "stage3d": return { dur: 0.35, adv: 0.12 };
      // A part's copies arrive with it, so a fan of 40 blades costs one beat, not 40.
      case "part3d": return { dur: 0.65, adv: mark.kind === "group" ? 0 : 0.12 };
      case "label3d": { const n = String(mark.text).length; return { dur: 0.4 + n * 0.015, adv: (0.35 + n * 0.012) * 0.7 }; }
      case "motion3d": case "camera3d": case "tick3d": case "sound": return { dur: 0, adv: 0 };
      case "edit": {
        if (mark.op === "clear") return { dur: 0.3, adv: 0.3 };
        if (mark.op === "erase") { const span = Math.min(0.9, 0.3 + (mark.ids || []).length * 0.01); return { dur: span, adv: span * 0.6 }; }
        return { dur: 0.35, adv: 0.25 };
      }
      default:
    }
    return { dur, adv: dur };
  }

  // ---------------------------------------------------------------- the pacer
  class Pacer {
    constructor() {
      this.lines = [];
      this.queue = [];
      this.dirty = false;
      this.programDone = false;
      this.cursor = 0; // when the pen is free again
    }
    addLine(k, text) {
      this.lines[k] = { k, words: String(text).trim().split(/\s+/).length, start: null, end: null, arrived: now() };
      this.dirty = true;
    }
    add(mark) {
      const timing = naturalTiming(mark);
      this.queue.push({ mark, line: mark.line ?? -1, dur: timing.dur, adv: timing.adv, at: null, pace: 1 });
      this.dirty = true;
    }
    lineEvent(k, event, duration) {
      const line = this.lines[k];
      if (!line) return;
      if (event === "start") {
        line.start = now();
        if (duration > 0) line.expectedEnd = line.start + duration;
      } else {
        if (line.start === null) line.start = now();
        line.end = now();
      }
      this.dirty = true;
    }
    lineTimes(line) {
      const start = line.start;
      const end = line.end ?? line.expectedEnd ?? start + line.words / WORDS_PER_SECOND;
      return [start, Math.max(end, start + 0.2)];
    }
    isOpen(k) {
      return !this.programDone && !this.lines[k + 1];
    }
    plan(time) {
      this.dirty = false;
      let cursor = Math.max(time, this.cursor);
      let i = 0;
      while (i < this.queue.length) {
        const k = this.queue[i].line;
        let j = i;
        while (j < this.queue.length && this.queue[j].line === k) j++;
        const group = this.queue.slice(i, j);
        if (k < 0) {
          for (const item of group) { item.at = cursor; item.pace = 1; item.gap = item.adv; cursor += item.adv; }
          i = j;
          continue;
        }
        const line = this.lines[k];
        if (!line) break;
        if (line.start === null && time - line.arrived > VOICE_WAIT_SECONDS) line.start = time;
        if (line.start === null) break;
        const [start, end] = this.lineTimes(line);
        const workStart = Math.max(cursor, start + LINE_LEAD_SECONDS);
        const available = end - LINE_TAIL_SECONDS - workStart;
        const gaps = group.reduce((sum, item, index) => sum + (index < group.length - 1 ? item.adv : 0), 0);
        const lastDur = group[group.length - 1].dur;
        let factor = available <= 0.05 ? 0 : available / (gaps + lastDur || 0.1);
        if (this.isOpen(k)) factor = Math.min(factor, OPEN_LINE_PACE_LIMIT);
        let pace, spread;
        if (factor < FASTEST_PACE) {
          pace = spread = Math.max(RUSH_PACE, factor);
        } else {
          pace = Math.min(factor, SLOWEST_PACE);
          spread = Math.min(factor, MAX_GAP_STRETCH);
        }
        let t = workStart;
        for (const item of group) { item.at = t; item.pace = pace; item.gap = item.adv * spread; t += item.gap; }
        cursor = t;
        i = j;
      }
      for (; i < this.queue.length; i++) this.queue[i].at = null;
    }
    due(time) {
      if (this.dirty) this.plan(time);
      const ready = [];
      while (this.queue.length && this.queue[0].at !== null && this.queue[0].at <= time + 0.004) {
        const item = this.queue.shift();
        this.cursor = item.at + item.gap;
        ready.push(item);
      }
      // A waiting head line can time out without any event arriving.
      if (this.queue.length && this.queue[0].at === null) this.dirty = true;
      return ready;
    }
    dropWaiting() {
      const dropped = this.queue.filter((item) => item.mark.do !== "edit").map((item) => item.mark.id);
      this.queue = [];
      this.lines = this.lines.map((line) => ({ ...line, start: line.start ?? now(), end: line.end ?? now() }));
      return dropped;
    }
  }

  // ---------------------------------------------------------------- a seeded hand
  const hashNoise = (x) => { const s = Math.sin(x * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
  function smoothNoise(x) {
    const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
    return (hashNoise(i) * (1 - u) + hashNoise(i + 1) * u) * 2 - 1;
  }

  function catmullRom(points, closed) {
    if (points.length < 3) return points.slice();
    const out = [];
    const count = closed ? points.length : points.length - 1;
    const at = (i) => (closed ? points[((i % points.length) + points.length) % points.length] : points[clamp(i, 0, points.length - 1)]);
    for (let i = 0; i < count; i++) {
      const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
      const steps = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / SAMPLE_SPACING));
      for (let s = 0; s < steps; s++) {
        const t = s / steps, t2 = t * t, t3 = t2 * t;
        out.push([0, 1].map((c) => 0.5 * (2 * p1[c] + (p2[c] - p0[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (3 * p1[c] - p0[c] - 3 * p2[c] + p3[c]) * t3)));
      }
    }
    out.push(closed ? points[0].slice() : points[points.length - 1].slice());
    return out;
  }

  function resample(points) {
    const out = [points[0].slice()];
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1], [bx, by] = points[i];
      const length = Math.hypot(bx - ax, by - ay);
      const steps = Math.max(1, Math.round(length / SAMPLE_SPACING));
      for (let s = 1; s <= steps; s++) out.push([ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps]);
    }
    return out;
  }

  function roundedRectPoints(x, y, w, h, r) {
    r = clamp(r || 0, 0, Math.min(w, h) / 2);
    if (r < 0.5) return [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
    const points = [];
    const corner = (cx, cy, from) => { for (let i = 0; i <= 6; i++) { const a = from + (i / 6) * (Math.PI / 2); points.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } };
    corner(x + w - r, y + r, -Math.PI / 2);
    corner(x + w - r, y + h - r, 0);
    corner(x + r, y + h - r, Math.PI / 2);
    corner(x + r, y + r, Math.PI);
    points.push(points[0].slice());
    return points;
  }

  // ---- the pen. Seeded, so the same drawing always wobbles the same way.
  const seeded = (seed) => {
    let state = 0;
    for (const c of String(seed)) state = (state * 31 + c.charCodeAt(0)) >>> 0;
    return () => ((state = (state * 1664525 + 1013904223) >>> 0) / 4294967296);
  };
  const gap = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const lengthOf = (points) => points.reduce((total, p, i) => (i ? total + gap(points[i - 1], p) : 0), 0);
  const pathOf = (points) => `M${points.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("L")}`;
  function finer(points, step = 6) {
    const out = [points[0]];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i], n = Math.max(1, Math.ceil(gap(a, b) / step));
      for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
    }
    return out;
  }
  // Smooth through its points. A straight line stays straight: the hand shows in its width.
  function smoothLine(points, closed) {
    if (points.length < 2) return points.slice();
    if (points.length === 2 && !closed) return finer(points, 12);
    const P = closed ? [points[points.length - 1], ...points, points[0], points[1]] : [points[0], ...points, points[points.length - 1]];
    const out = [];
    for (let i = 1; i < P.length - 2; i++) {
      const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
      const n = clamp(Math.ceil(gap(p1, p2) / 4), 2, 30);
      for (let k = 0; k < n; k++) {
        const t = k / n, t2 = t * t, t3 = t2 * t;
        out.push([0, 1].map((c) => 0.5 * (2 * p1[c] + (p2[c] - p0[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (3 * p1[c] - p0[c] - 3 * p2[c] + p3[c]) * t3)));
      }
    }
    out.push(closed ? points[0] : points[points.length - 1]);
    return out;
  }
  // Straight edges drawn by hand each bow a little.
  function handEdges(points, closed, random, amount = 1, style, jitter = 0) {
    const unit = lesson.scale.x > 0 ? lesson.scale.x : 1;
    const corners = jitter ? points.map((p) => [p[0] + ((random() * 2 - 1) * jitter) / unit, p[1] + ((random() * 2 - 1) * jitter) / unit]) : points;
    const route = closed ? [...corners, corners[0]] : corners;
    const out = [route[0]];
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1], b = route[i], length = gap(a, b), n = Math.max(2, Math.ceil(length / 5));
      const inPoints = length * unit;
      const penBow = inPoints < 24 ? inPoints * 0.03 : clamp(inPoints * 0.03, 2, 7);
      const bow = style === "pen"
        ? ((random() < 0.5 ? -1 : 1) * penBow * (0.6 + 0.4 * random()) * amount) / unit
        : (random() - 0.5) * Math.min(3.2, length * 0.03) * amount;
      const nx = -(b[1] - a[1]) / (length || 1), ny = (b[0] - a[0]) / (length || 1);
      for (let k = 1; k <= n; k++) {
        const t = k / n, push = Math.sin(Math.PI * t) * bow;
        out.push([a[0] + (b[0] - a[0]) * t + nx * push, a[1] + (b[1] - a[1]) * t + ny * push]);
      }
    }
    return out;
  }
  function handEllipse(cx, cy, rx, ry, turn, random, wobble = 1, overshoot = true) {
    const n = Math.max(28, Math.round((rx + ry) / 2.2));
    const start = random() * Math.PI * 2, span = Math.PI * 2 * (overshoot ? 1.06 : 1);
    const p1 = random() * 6, p2 = random() * 6;
    const out = [];
    for (let i = 0; i <= n; i++) {
      const a = start + (span * i) / n;
      const k = 1 + wobble * (0.018 * Math.sin(a * 2 + p1) + 0.012 * Math.sin(a * 3 + p2)) + (overshoot ? (0.02 * wobble * i) / n : 0);
      const x = Math.cos(a) * rx * k, y = Math.sin(a) * ry * k;
      out.push([cx + x * Math.cos(turn) - y * Math.sin(turn), cy + x * Math.sin(turn) + y * Math.cos(turn)]);
    }
    return out;
  }
  // A felt pen's outline: a light taper into and out of the stroke, and a slight swell along it.
  function feltOutline(points, size, taper = 1) {
    const n = points.length;
    if (n < 2) return null;
    const along = [0];
    for (let i = 1; i < n; i++) along.push(along[i - 1] + gap(points[i - 1], points[i]));
    const total = along[n - 1] || 1, ramp = Math.min(total * 0.3, size * 5) * taper || 1e-6;
    const left = [], right = [];
    for (let i = 0; i < n; i++) {
      const a = points[Math.max(0, i - 1)], b = points[Math.min(n - 1, i + 1)], d = gap(a, b) || 1;
      const nx = -(b[1] - a[1]) / d, ny = (b[0] - a[0]) / d, u = along[i];
      const press = Math.min(1, 0.35 + (0.65 * Math.min(u, total - u)) / ramp);
      const half = (size / 2) * press * (0.94 + 0.06 * Math.sin(u / 7));
      left.push([points[i][0] + nx * half, points[i][1] + ny * half]);
      right.push([points[i][0] - nx * half, points[i][1] - ny * half]);
    }
    return `${pathOf(left)}L${pathOf(right.reverse()).slice(1)}Z`;
  }
  function dashPieces(points, on, off) {
    const fine = finer(points, 2), out = [];
    let run = 0, current = [fine[0]], drawing = true;
    for (let i = 1; i < fine.length; i++) {
      run += gap(fine[i - 1], fine[i]);
      if (drawing) {
        current.push(fine[i]);
        if (run >= on) { out.push(current); drawing = false; run = 0; }
      } else if (run >= off) { drawing = true; run = 0; current = [fine[i]]; }
    }
    if (drawing && current.length > 1) out.push(current);
    return out;
  }
  const shadeHex = (hex, k) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    const c = (v) => Math.round(v * (1 - k)).toString(16).padStart(2, "0");
    return `#${c(n >> 16)}${c((n >> 8) & 255)}${c(n & 255)}`;
  };
  const mixHex = (hex, other, t) => {
    const channels = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const a = channels(hex), b = channels(other);
    return `#${a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
  };
  const paperTone = () => PAPER_TONES[lesson.ink] || mixHex("#FAF5EA", lesson.ink, 0.05);
  const gelTone = () => GEL_TONES[lesson.ink] || { top: mixHex(lesson.ink, "#FFFFFF", 0.9), mid: mixHex(lesson.ink, "#FFFFFF", 0.55), low: mixHex(lesson.ink, "#FFFFFF", 0.5), rim: mixHex(lesson.ink, "#000000", 0.55) };

  function bentPoints(points, bend) {
    if (!bend || points.length !== 2) return points;
    const [a, b] = points;
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const control = [mx - dy * bend, my + dx * bend];
    const out = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16, u = 1 - t;
      out.push([u * u * a[0] + 2 * u * t * control[0] + t * t * b[0], u * u * a[1] + 2 * u * t * control[1] + t * t * b[1]]);
    }
    return out;
  }

  // ---------------------------------------------------------------- the lesson
  const lesson = {
    active: false,
    worker: null,
    pacer: new Pacer(),
    width: 1280, height: 720, scale: { x: 1, y: 1 },
    ink: "#3380FF",
    root: null, windowLayer: null, stageLayer: null, inkSvg: null, labelSvg: null, buttonLayer: null, closeButton: null,
    painted: new Map(),
    stages: new Map(),
    papers: [],
    cards: [],
    dim: null,
    pinning: null,
    captions: false,
    recording: false,
    canSaveVideo: false,
    lineTexts: {},
    captionBar: null,
    captionTimer: 0,
    ignoreScreenUntil: 0,
    fills: [],
    fillOrder: 0,
    placedWords: [],
    inkBoxes: [],
    buttons: [],
    tweens: [],
    animationFrame: 0,
    measure: null,
    awaitingFrame: false,
    lastHeardFromWorker: 0,
    expectingWorker: false,
    ticksRunning: false,
    programDoneSent: true,
    workerDead: false,
    defs: null,
    maskCount: 0,
  };

  function tween(seconds, apply, ease) {
    if (seconds <= 0) { apply(1); return; }
    apply(0);
    lesson.tweens.push({ start: now(), seconds, apply, ease: ease || ((t) => t) });
  }

  // A fill's soft watercolour edge, and the blurred glow of a mark on the real screen.
  function installFilters(defs) {
    const wash = svg("filter", { id: "lesson-wash", x: "-10%", y: "-10%", width: "120%", height: "120%" });
    wash.appendChild(svg("feTurbulence", { type: "fractalNoise", baseFrequency: 0.035, numOctaves: 2, seed: 3 }));
    wash.appendChild(svg("feDisplacementMap", { in: "SourceGraphic", scale: 3.5 }));
    const glow = svg("filter", { id: "lesson-glow", x: "-50%", y: "-50%", width: "200%", height: "200%", filterUnits: "objectBoundingBox" });
    glow.appendChild(svg("feGaussianBlur", { stdDeviation: 6 }));
    defs.append(wash, glow);
  }

  function ensureLayers() {
    if (lesson.root) return;
    const root = document.createElement("div");
    root.className = "lesson-layer";
    const windowLayer = document.createElement("div");
    windowLayer.className = "lesson-layer";
    const stageLayer = document.createElement("div");
    stageLayer.className = "lesson-layer";
    const inkSvg = svg("svg", { class: "lesson-ink", preserveAspectRatio: "none" });
    const defs = svg("defs");
    installFilters(defs);
    inkSvg.appendChild(defs);
    const labelSvg = svg("svg", { class: "lesson-ink" });
    const buttonLayer = document.createElement("div");
    buttonLayer.className = "lesson-layer";
    root.append(windowLayer, stageLayer, inkSvg, labelSvg, buttonLayer);
    document.body.appendChild(root);
    Object.assign(lesson, { root, windowLayer, stageLayer, inkSvg, labelSvg, buttonLayer, defs });
    lesson.measure = document.createElement("canvas").getContext("2d");
  }

  // ---------------------------------------------------------------- input region
  function reportInput() {
    window.clicky?.reportInteractiveArea?.();
  }
  function inputRects() {
    const rects = [];
    for (const stage of lesson.stages.values()) rects.push(stage.rect());
    for (const button of lesson.buttons) rects.push([button.offsetLeft, button.offsetTop, button.offsetWidth, button.offsetHeight]);
    for (const card of lesson.cards) {
      const r = card.element.getBoundingClientRect();
      rects.push([r.left, r.top, r.width, r.height]);
    }
    if (lesson.saveButton) rects.push([lesson.saveButton.offsetLeft, lesson.saveButton.offsetTop, lesson.saveButton.offsetWidth, lesson.saveButton.offsetHeight]);
    if (lesson.cards.some((card) => card.isFull)) rects.push([0, 0, window.innerWidth, window.innerHeight]);
    for (const item of document.getElementById("lesson-pinned")?.children || []) {
      if (item.classList.contains("open")) {
        const r = item.getBoundingClientRect();
        rects.push([r.left, r.top, r.width, r.height]);
      } else {
        const scale = Math.min(150 / item.lessonW, 110 / item.lessonH, 1);
        rects.push([window.innerWidth - 30, item.offsetTop, 30, item.lessonH * scale]);
      }
    }
    if (lesson.closeButton) {
      const close = lesson.closeButton;
      rects.push([close.offsetLeft, close.offsetTop, close.offsetWidth, close.offsetHeight]);
    }
    return rects;
  }

  function placeCloseButton() {
    let right = 0, top = Infinity;
    const consider = (x, y, w) => { right = Math.max(right, x + w); top = Math.min(top, y); };
    for (const paper of lesson.papers) consider(paper.x * lesson.scale.x, paper.y * lesson.scale.y, paper.w * lesson.scale.x);
    for (const stage of lesson.stages.values()) { const [x, y, w] = stage.rect(); consider(x, y, w); }
    if (!lesson.closeButton) {
      const close = document.createElement("button");
      close.className = "lesson-close";
      close.textContent = "×";
      close.title = "clear";
      close.addEventListener("click", () => toRust({ type: "dismiss" }));
      lesson.buttonLayer.appendChild(close);
      lesson.closeButton = close;
    }
    if (top === Infinity) { right = window.innerWidth - 14; top = 44; }
    lesson.closeButton.style.left = `${clamp(right - 13, 8, window.innerWidth - 34)}px`;
    lesson.closeButton.style.top = `${clamp(top - 13, 8, window.innerHeight - 34)}px`;
    lesson.closeButton.style.display = lesson.recording ? "none" : "";
    if (lesson.canSaveVideo && !lesson.recording && !lesson.saveButton) {
      const save = document.createElement("button");
      save.className = "lesson-close lesson-save";
      save.textContent = "⤓";
      save.title = "save this lesson as a video";
      save.addEventListener("click", () => toRust({ type: "save_video" }));
      lesson.buttonLayer.appendChild(save);
      lesson.saveButton = save;
    }
    if (lesson.saveButton) {
      lesson.saveButton.style.left = `${clamp(right - 45, 8, window.innerWidth - 34)}px`;
      lesson.saveButton.style.top = lesson.closeButton.style.top;
    }
    reportInput();
  }

  // ---------------------------------------------------------------- painting
  const inPaper = (x, y) => lesson.papers.some((p) => x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h);
  const isLight = (color) => {
    const hex = /^#([0-9a-f]{6})$/i.exec(color || "");
    if (!hex) return false;
    const n = parseInt(hex[1], 16);
    return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 150;
  };
  const haloColor = (color) => (isLight(color) ? "rgba(10,12,16,0.6)" : "rgba(255,255,255,0.72)");

  function revealByStroke(target, centerPath, length, width, seconds) {
    const id = `lesson-mask-${++lesson.maskCount}`;
    const mask = svg("mask", { id, maskUnits: "userSpaceOnUse", x: -50, y: -50, width: lesson.width + 100, height: lesson.height + 100 });
    const reveal = svg("path", { d: centerPath, fill: "none", stroke: "#fff", "stroke-width": width, "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-dasharray": length + 2 });
    mask.appendChild(reveal);
    lesson.defs.appendChild(mask);
    target.setAttribute("mask", `url(#${id})`);
    tween(seconds, (t) => {
      reveal.setAttribute("stroke-dashoffset", (length + 2) * (1 - t));
      if (t >= 1) { target.removeAttribute("mask"); mask.remove(); }
    }, easeInOut);
  }

  // White or near-black ink over the real screen wears a thin contrasting halo; a coloured
  // screen mark wears a soft blurred glow of its own colour instead.
  const INK_HALOS = {
    "#FFFFFF": [["#080E1E", 0.16, 7], ["#080E1E", 0.45, 3]],
    "#15171C": [["#FFFFFF", 0.35, 7], ["#FFFFFF", 0.85, 3]],
  };
  function drawStroke(group, mark, centre, seconds, options = {}) {
    const color = mark.color || PAPER_INK;
    const size = mark.size || DEFAULT_PEN_SIZE;
    const taper = options.taper ?? (mark.taper == null ? 1 : mark.taper);
    const paint = svg("g");
    const opacity = mark.alpha != null ? mark.alpha : 1;
    const shape = (points, width, fill, fillOpacity) => (taper === 0
      ? svg("path", { d: pathOf(points), fill: "none", stroke: fill, "stroke-width": width, "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-opacity": fillOpacity })
      : svg("path", { d: feltOutline(points, width, taper), fill, "fill-opacity": fillOpacity }));
    const dashed = mark.dash || options.dash;
    const on = typeof dashed === "number" ? dashed : Math.max(8, size * 3);
    const pieces = dashed ? dashPieces(centre, on, mark.dashGap || on * 0.75) : [centre];
    const halo = !inPaper(centre[0][0], centre[0][1]) && INK_HALOS[String(color).toUpperCase()];
    if (mark.glow && !halo) {
      paint.appendChild(svg("path", { d: pathOf(centre), fill: "none", stroke: color, "stroke-opacity": 0.65, "stroke-width": size, "stroke-linecap": "round", "stroke-linejoin": "round", filter: "url(#lesson-glow)" }));
    }
    for (const [haloColor, haloOpacity, haloWidth] of halo || []) {
      for (const piece of pieces) paint.appendChild(svg("path", { d: pathOf(piece), fill: "none", stroke: haloColor, "stroke-opacity": haloOpacity, "stroke-width": haloWidth + size, "stroke-linecap": "round", "stroke-linejoin": "round" }));
    }
    for (const piece of pieces) {
      const drawn = shape(piece, size, color, opacity);
      if (drawn.getAttribute("d")) paint.appendChild(drawn);
    }
    group.appendChild(paint);
    revealByStroke(paint, pathOf(centre), lengthOf(centre), size * 2 + 4 + (mark.glow ? 30 : 0), seconds);
    return centre;
  }

  // A fill fades in a moment after its outline starts, with a soft uneven watercolour edge.
  function fillIn(group, mark, d, area, seconds) {
    const washed = mark.wash !== false && area <= WASH_MAX_AREA;
    const alpha = mark.fillAlpha != null ? mark.fillAlpha : 1;
    const element = svg("path", { d, fill: mark.fill, "fill-opacity": 0, filter: washed ? "url(#lesson-wash)" : undefined });
    group.insertBefore(element, group.firstChild);
    const hold = mark.outline === false ? 0 : 0.18;
    tween(0.35 + hold, (t) => element.setAttribute("fill-opacity", alpha * clamp((t * (0.35 + hold) - hold) / 0.35, 0, 1)), easeOutCubic);
    if ((mark.role !== "paper" && alpha >= 0.08) || (mark.role === "paper" && alpha >= 0.99)) lesson.fills.push({ mark, order: ++lesson.fillOrder });
    return element;
  }
  function boxOfMark(mark) {
    if (mark.do === "rect") return [mark.at[0], mark.at[1], mark.at[0] + mark.w, mark.at[1] + mark.h];
    if (mark.do === "circle" || mark.do === "ellipse") {
      const rx = mark.r || mark.rx, ry = mark.r || mark.ry;
      return [mark.at[0] - rx, mark.at[1] - ry, mark.at[0] + rx, mark.at[1] + ry];
    }
    if (mark.pts) {
      const xs = mark.pts.map((p) => p[0]), ys = mark.pts.map((p) => p[1]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }
    return null;
  }

  function popIn(group, cx, cy, seconds) {
    tween(seconds, (t) => {
      const s = Math.max(0.01, easeOutBack(t));
      group.setAttribute("transform", `translate(${cx} ${cy}) scale(${s}) translate(${-cx} ${-cy})`);
      group.setAttribute("opacity", clamp(t * 2.5, 0, 1));
    });
  }

  function fontFamily(mark) {
    if (mark.font === "serif") return "Georgia, 'Noto Serif', serif";
    return mark.style === "ui" ? UI_FONT : "Hand, sans-serif";
  }
  const textWeight = (mark) => (mark.style === "title" ? 600 : mark.weight || 400);

  function wrapLines(mark, size) {
    const hard = String(mark.text).split("\n");
    const widest = mark.wrap || (mark.fit && mark.fit[0]);
    if (!widest || hard.length > 1) return hard;
    const context = lesson.measure;
    context.font = `${textWeight(mark)} ${size}px ${fontFamily(mark)}`;
    const out = [];
    let line = "";
    for (const word of hard[0].split(" ")) {
      const attempt = line ? `${line} ${word}` : word;
      if (line && context.measureText(attempt).width > widest) { out.push(line); line = word; } else line = attempt;
    }
    out.push(line);
    return out;
  }
  // Words on a card keep clear of what's under them with a halo in the card's own colour.
  function knockoutFor(mark) {
    if (mark.under || mark.knockout === false || mark.role === "cheer") return null;
    const [x, y] = mark.at;
    const card = [...lesson.papers].reverse().find((paper) => paper.bg && x >= paper.x && x <= paper.x + paper.w && y >= paper.y && y <= paper.y + paper.h);
    if (!card) return null;
    let color = card.bg;
    for (const { mark: filled } of lesson.fills) {
      const b = boxOfMark(filled);
      if (!b || x < b[0] || x > b[2] || y < b[1] || y > b[3] || !/^#[0-9a-f]{6}$/i.test(String(filled.fill))) continue;
      const alpha = filled.fillAlpha != null ? filled.fillAlpha : 1;
      color = alpha >= 0.99 ? filled.fill : mixHex(color, filled.fill, alpha);
    }
    return color;
  }
  // A short label steps off another label or a shape it landed on; a shape around it is its home.
  function placeLabel(text, group, mark) {
    if (mark.place === false || mark.under || text.querySelector("tspan")) { lesson.placedWords.push(text); return; }
    const b = text.getBBox();
    if (!b.width) return;
    const boxOf = (element) => { try { const r = element.getBBox(); const n = element.lessonNudge || [0, 0]; return { x: r.x + n[0], y: r.y + n[1], w: r.width, h: r.height }; } catch (_) { return null; } };
    const others = lesson.placedWords.filter((other) => other.isConnected).map(boxOf).filter(Boolean);
    const shapes = lesson.inkBoxes.filter((entry) => entry.element.isConnected).map((entry) => entry.box);
    const hitsWords = (dx, dy) => others.some((o) => Math.min(b.x + dx + b.width, o.x + o.w) - Math.max(b.x + dx, o.x) > 3
      && Math.min(b.y + dy + b.height * 0.8, o.y + o.h * 0.8) - Math.max(b.y + dy + b.height * 0.2, o.y + o.h * 0.2) > 1);
    const cover = (dx, dy) => {
      const x0 = b.x + dx + b.width * 0.1, y0 = b.y + dy + b.height * 0.25, x1 = b.x + dx + b.width * 0.9, y1 = b.y + dy + b.height * 0.75;
      let area = 0;
      for (const o of shapes) {
        if (o.x <= x0 + 2 && o.y <= y0 + 2 && o.x + o.w >= x1 - 2 && o.y + o.h >= y1 - 2) continue;
        const ix = Math.min(x1, o.x - 4 + o.w + 8) - Math.max(x0, o.x - 4), iy = Math.min(y1, o.y - 4 + o.h + 8) - Math.max(y0, o.y - 4);
        if (ix > 2 && iy > 2) area += ix * iy;
      }
      return area / Math.max(1, (x1 - x0) * (y1 - y0));
    };
    const hits = (dx, dy) => hitsWords(dx, dy) || cover(dx, dy) > 0.2;
    const inside = (dx, dy) => b.x + dx >= 4 && b.y + dy >= 4 && b.x + dx + b.width <= lesson.width - 4 && b.y + dy + b.height <= lesson.height - 4;
    let best = [0, 0];
    if (!inside(0, 0)) best = [clamp(0, 4 - b.x, lesson.width - 4 - b.x - b.width), clamp(0, 4 - b.y, lesson.height - 4 - b.y - b.height)];
    if (hits(best[0], best[1])) {
      const step = Math.max(10, b.height * 0.9), candidates = [];
      for (let k = 1; k <= 5; k++) {
        for (const [ux, uy] of [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]]) candidates.push([best[0] + ux * k * (b.width * 0.35 + 6), best[1] + uy * k * step]);
      }
      candidates.sort((p, q) => Math.hypot(p[0] - best[0], (p[1] - best[1]) * 1.6) - Math.hypot(q[0] - best[0], (q[1] - best[1]) * 1.6));
      const free = candidates.find(([dx, dy]) => inside(dx, dy) && !hits(dx, dy));
      if (free) best = free;
    }
    if (best[0] || best[1]) {
      text.lessonNudge = best;
      text.setAttribute("transform", `translate(${best[0].toFixed(1)} ${best[1].toFixed(1)}) ${text.getAttribute("transform") || ""}`);
    }
    lesson.placedWords.push(text);
  }

  function drawText(group, mark, seconds) {
    const style = mark.style || "hand";
    let size = mark.size || (style === "title" ? 24 : style === "body" ? 17 : style === "caps" ? 14 : 20);
    size = Math.max(size, style === "ui" ? 8 / (lesson.scale.x || 1) : MIN_TEXT_SIZE);
    if (style === "caps") mark = Object.assign({}, mark, { text: String(mark.text).toUpperCase().split("").join("\u200A"), weight: mark.weight || 600 });
    const leading = mark.lineHeight > 0.8 ? mark.lineHeight : TEXT_LINE_HEIGHT;
    const lines = wrapLines(mark, size);
    const [x, y] = mark.at;
    const color = mark.color || PAPER_INK;
    const onPaper = inPaper(x, y);
    const knockout = onPaper ? knockoutFor(mark) : null;
    const haloWidth = Math.max(5, size * 0.45);
    const lift = lines.length > 1 && (mark.fit || mark.wrap) && !mark.top && (mark.baseline || "auto") === "auto" ? ((lines.length - 1) * size * leading) / 2 : 0;
    const text = svg("text", {
      x, y: y - lift, fill: color, "font-size": size, "font-family": fontFamily(mark), "text-anchor": mark.anchor || "start",
      "font-weight": textWeight(mark),
      transform: mark.rot ? `rotate(${mark.rot} ${x} ${y})` : undefined,
      stroke: onPaper ? undefined : haloColor(color), "stroke-width": onPaper ? undefined : Math.max(2.4, size * 0.13), "paint-order": onPaper ? undefined : "stroke", "stroke-linejoin": "round",
    });
    lines.forEach((line, index) => {
      const span = svg("tspan", lines.length > 1 ? { x, dy: index ? size * leading : 0 } : {});
      span.textContent = line;
      text.appendChild(span);
    });
    group.appendChild(text);
    if (mark.fit) {
      let fitted = size, box = text.getBBox();
      while ((box.width > mark.fit[0] || box.height > mark.fit[1]) && fitted > Math.min(8, MIN_TEXT_SIZE)) {
        fitted *= 0.92;
        text.setAttribute("font-size", fitted.toFixed(1));
        text.querySelectorAll("tspan").forEach((tspan, k) => { if (k) tspan.setAttribute("dy", fitted * leading); });
        box = text.getBBox();
      }
    }
    if (lines.length === 1 && text.firstChild) { text.firstChild.removeAttribute("x"); }
    placeLabel(text, group, mark);
    // The handwriting has one weight, so bold is drawn with a thin stroke of the words' own colour.
    let halo = null;
    if (knockout) {
      halo = text.cloneNode(true);
      halo.setAttribute("fill", knockout);
      halo.setAttribute("stroke", knockout);
      halo.setAttribute("stroke-width", haloWidth);
      group.insertBefore(halo, text);
    }
    if (textWeight(mark) >= 600 && onPaper) {
      text.setAttribute("stroke", color);
      text.setAttribute("stroke-width", size * 0.035);
    }
    // Handwriting wipes on left to right; words on several lines wipe as one.
    const bounds = text.getBBox();
    const id = `lesson-clip-${++lesson.maskCount}`;
    const clip = svg("clipPath", { id });
    const rect = svg("rect", { x: bounds.x - 6, y: bounds.y - 6, width: 0, height: bounds.height + 12 });
    clip.appendChild(rect);
    lesson.defs.appendChild(clip);
    text.setAttribute("clip-path", `url(#${id})`);
    if (halo) halo.setAttribute("clip-path", `url(#${id})`);
    tween(seconds, (t) => {
      rect.setAttribute("width", (bounds.width + 12) * t);
      if (t >= 1) { text.removeAttribute("clip-path"); if (halo) halo.removeAttribute("clip-path"); clip.remove(); }
    });
  }

  // A pill in the user's cursor colour: a soft shadow, a dark rim, a low and a lighter band, a gloss.
  function capsulePath(x, y, w, h) {
    const r = h / 2;
    return `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
  }
  function capsuleTopPath(x, y, w, h, fraction) {
    const r = h / 2, cutY = y + h * clamp(fraction, 0.02, 1);
    const cut = Math.asin(clamp((cutY - y - r) / r, -1, 1));
    const points = [];
    for (let k = 0; k <= 10; k++) { const a = -Math.PI / 2 + ((cut + Math.PI / 2) * k) / 10; points.push([x + w - r + r * Math.cos(a), y + r + r * Math.sin(a)]); }
    for (let k = 0; k <= 10; k++) { const a = Math.PI - cut + ((cut + Math.PI / 2) * k) / 10; points.push([x + r + r * Math.cos(a), y + r + r * Math.sin(a)]); }
    return `${pathOf(points)}Z`;
  }
  function drawGel(group, x, y, w, h) {
    const unit = lesson.scale.x || 1;
    const tones = gelTone(), edge = 1 / unit, shine = Math.max(1.5 / unit, h * 0.09);
    const layer = (d, fill, alpha) => group.appendChild(svg("path", { d, fill, "fill-opacity": alpha }));
    layer(capsulePath(x, y + 1 / unit, w, h), "#1C1E24", 0.1);
    layer(capsulePath(x - edge, y - edge, w + 2 * edge, h + 2 * edge), tones.rim, 1);
    layer(capsulePath(x, y, w, h), tones.low, 1);
    layer(capsuleTopPath(x, y, w, h, 0.78), tones.mid, 1);
    layer(capsuleTopPath(x, y, w, h, 0.42), tones.top, 0.75);
    layer(capsuleTopPath(x + shine, y + shine * 0.6, w - 2 * shine, h - 2 * shine, 0.5), "#FFFFFF", 0.6);
  }
  function drawPill(group, mark) {
    const [x, y] = mark.at;
    const words = String(mark.text);
    const size = PILL_TEXT / (lesson.scale.x || 1);
    const width = Math.round(words.length * size * 0.58 + size * 1.9), height = Math.round(size * 1.9);
    const left = mark.anchor === "middle" ? x - width / 2 : x;
    drawGel(group, left, y, width, height);
    const text = svg("text", { x: left + width / 2, y: y + height * 0.68, "text-anchor": "middle", "font-size": size, "font-family": UI_FONT, "font-weight": 600, fill: "#15171C" });
    text.textContent = words;
    group.appendChild(text);
    popIn(group, left + width / 2, y + height / 2, 0.26);
    window.ClickySound?.play("pill-pop");
  }

  function drawBadge(group, mark) {
    const [x, y] = mark.at;
    const size = BADGE_TEXT / (lesson.scale.x || 1);
    const height = Math.round(size * 1.9), width = Math.max(height, Math.round(String(mark.text).length * size * 0.58 + size * 1.1));
    drawGel(group, x - width / 2, y - height / 2, width, height);
    const text = svg("text", { x, y: y + height * 0.18, "text-anchor": "middle", "font-size": size, "font-family": UI_FONT, "font-weight": 600, fill: "#15171C" });
    text.textContent = mark.text;
    group.appendChild(text);
    popIn(group, x, y, 0.26);
    window.ClickySound?.play("pill-pop");
  }

  // A window: a board in the paper's tone, a title bar with a wash of the cursor colour, and
  // close and full-screen buttons that only show while the pointer is on the card.
  function decorateWindow(element, bar, board) {
    const tint = WINDOW_TINTS[lesson.ink] || [lesson.ink, 0.09];
    const unit = lesson.scale.y;
    element.style.setProperty("--board", paperTone());
    element.style.setProperty("--tint", `${tint[0]}${Math.round(tint[1] * 255).toString(16).padStart(2, "0")}`);
    element.style.setProperty("--radius", `${WINDOW_RADIUS * unit}px`);
    if (board === "grid" || board === "dots") element.dataset.board = board;
    element.style.setProperty("--grid", `${24 * unit}px`);
    element.style.setProperty("--dots", `${16 * unit}px`);
    element.style.setProperty("--dot", `${1.1 * unit}px`);
    bar.style.fontSize = `${13 * unit}px`;
  }
  // ---- cards: a window and everything drawn on it move, grow, pin and close as one.
  function addCard({ element, bar, box, stage, paperId }) {
    const card = { element, bar, box, ownStage: stage || null, stages: stage ? [stage] : [], paperId, holders: new Set(), dx: 0, dy: 0, zoom: null };
    if (!stage) {
      // A figure standing on this paper belongs to it.
      for (const other of lesson.stages.values()) if (!lesson.cards.some((c) => c.ownStage === other) && cardHolds(card, other)) card.stages.push(other);
    }
    const buttons = document.createElement("div");
    buttons.className = "lesson-window-buttons";
    for (const [kind, title, act] of [["close", "close", () => closeCard(card)], ["pin", "pin to the side", () => pinCard(card)], ["full", "full screen", () => toggleFullScreen(card)]]) {
      const button = document.createElement("button");
      button.className = `lesson-window-button ${kind}`;
      button.title = title;
      button.addEventListener("pointerdown", (event) => event.stopPropagation());
      button.addEventListener("click", (event) => { event.stopPropagation(); act(); });
      buttons.appendChild(button);
    }
    bar.appendChild(buttons);
    let drag = null;
    bar.style.cursor = "grab";
    bar.addEventListener("pointerdown", (event) => {
      if (card.zoom) return;
      event.stopPropagation();
      bar.setPointerCapture(event.pointerId);
      const rect = element.getBoundingClientRect();
      drag = {
        x: event.clientX, y: event.clientY, dx: card.dx, dy: card.dy,
        buttons: lesson.buttons.filter((b) => {
          const cx = b.offsetLeft + b.offsetWidth / 2, cy = b.offsetTop + b.offsetHeight / 2;
          return cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom + 40;
        }).map((b) => ({ b, left: b.offsetLeft, top: b.offsetTop })),
      };
    });
    bar.addEventListener("pointermove", (event) => {
      if (!drag) return;
      event.stopPropagation();
      const moveX = event.clientX - drag.x, moveY = event.clientY - drag.y;
      card.dx = drag.dx + moveX / lesson.scale.x;
      card.dy = drag.dy + moveY / lesson.scale.y;
      for (const { b, left, top } of drag.buttons) { b.style.left = `${left + moveX}px`; b.style.top = `${top + moveY}px`; }
      applyCard(card);
    });
    const endDrag = (event) => {
      if (!drag) return;
      event.stopPropagation();
      drag = null;
      placeCloseButton();
    };
    bar.addEventListener("pointerup", endDrag);
    bar.addEventListener("pointercancel", endDrag);
    lesson.cards.push(card);
    return card;
  }
  const cardHolds = (card, stage) => {
    const { scale } = lesson;
    const [x, y, w, h] = stage.rect();
    const cx = (x + w / 2) / scale.x - card.dx, cy = (y + h / 2) / scale.y - card.dy;
    return cx >= card.box.x && cx <= card.box.x + card.box.w && cy >= card.box.y && cy <= card.box.y + card.box.h;
  };
  // A mark belongs to the top card it was drawn on.
  function joinCard(record) {
    if (!record.holder || !lesson.cards.length) return;
    let bounds;
    try { bounds = record.holder.getBBox(); } catch (_) { return; }
    if (!bounds.width && !bounds.height) return;
    const cx = bounds.x + bounds.width / 2, cy = bounds.y + bounds.height / 2;
    for (let i = lesson.cards.length - 1; i >= 0; i--) {
      const card = lesson.cards[i];
      if (cx >= card.box.x && cx <= card.box.x + card.box.w && cy >= card.box.y && cy <= card.box.y + card.box.h) {
        card.holders.add(record.holder);
        record.card = card;
        applyCard(card, record.holder);
        return;
      }
    }
  }
  function applyCard(card, onlyHolder) {
    const { x: sx, y: sy } = lesson.scale;
    const k = card.zoom ? card.zoom.k : 1, tx = card.zoom ? card.zoom.tx : 0, ty = card.zoom ? card.zoom.ty : 0;
    const moved = card.dx || card.dy || card.zoom;
    const transform = moved ? `translate(${tx} ${ty}) scale(${k}) translate(${card.dx} ${card.dy})` : null;
    const place = (holder) => { if (transform) holder.setAttribute("transform", transform); else holder.removeAttribute("transform"); };
    if (onlyHolder) { place(onlyHolder); return; }
    card.holders.forEach(place);
    if (!card.ownStage) {
      const ex = card.box.x * sx, ey = card.box.y * sy;
      card.element.style.transformOrigin = "0 0";
      card.element.style.transform = moved ? `translate(${k * (ex + card.dx * sx) + tx * sx - ex}px, ${k * (ey + card.dy * sy) + ty * sy - ey}px) scale(${k})` : "";
    }
    for (const stage of card.stages) stage.setCardTransform(card.dx * sx, card.dy * sy, k, tx * sx, ty * sy);
  }
  // The other things on screen step back while one card is shown big.
  function isolate(card, on) {
    const faded = on ? "0" : "";
    for (const other of lesson.cards) {
      if (other === card) continue;
      other.element.style.opacity = faded;
      other.holders.forEach((holder) => { holder.style.opacity = faded; });
      other.stages.forEach((stage) => stage.setHidden(on));
    }
    for (const stage of lesson.stages.values()) if (!card.stages.includes(stage) && !lesson.cards.some((c) => c.stages.includes(stage))) stage.setHidden(on);
    for (const record of lesson.painted.values()) if (record.holder && !record.card) record.holder.style.opacity = faded;
    for (const button of lesson.buttons) button.style.opacity = faded;
    if (!lesson.dim) {
      lesson.dim = document.createElement("div");
      lesson.dim.className = "lesson-dim";
      // Clicking anywhere off the big card puts it back.
      lesson.dim.addEventListener("click", () => { const big = lesson.cards.find((c) => c.isFull); if (big) toggleFullScreen(big); });
      lesson.windowLayer.prepend(lesson.dim);
    }
    lesson.dim.classList.toggle("shown", on);
  }
  function toggleFullScreen(card) {
    const { x: sx, y: sy } = lesson.scale;
    const from = card.zoom || { k: 1, tx: 0, ty: 0 };
    let to;
    if (card.zoom && card.zoom.k > 1.001 && card.isFull) {
      to = { k: 1, tx: 0, ty: 0 };
      card.isFull = false;
      isolate(card, false);
    } else {
      const left = 64 / sx, top = 72 / sy, bottom = 64 / sy;
      const roomW = lesson.width - 2 * left, roomH = lesson.height - top - bottom;
      const k = Math.min(roomW / card.box.w, roomH / card.box.h, 3);
      if (!(k > 0)) return;
      const cx = card.box.x + card.dx + card.box.w / 2, cy = card.box.y + card.dy + card.box.h / 2;
      to = { k, tx: left + roomW / 2 - k * cx, ty: top + roomH / 2 - k * cy };
      card.isFull = true;
      isolate(card, true);
    }
    for (const stage of card.stages) stage.setSharpness(to.k);
    tween(0.35, (t) => {
      card.zoom = { k: from.k + (to.k - from.k) * t, tx: from.tx + (to.tx - from.tx) * t, ty: from.ty + (to.ty - from.ty) * t };
      if (t >= 1 && to.k === 1) card.zoom = null;
      applyCard(card);
      if (t >= 1) reportInput();
    }, easeOutCubic);
  }
  function removeCard(card) {
    lesson.cards = lesson.cards.filter((other) => other !== card);
    card.holders.forEach((holder) => holder.remove());
    for (const stage of card.stages) {
      for (const [id, entry] of lesson.stages) if (entry === stage) { stage.dispose(); lesson.stages.delete(id); }
    }
    if (!card.ownStage) card.element.remove();
    if (card.paperId !== undefined) lesson.papers = lesson.papers.filter((paper) => paper.id !== card.paperId);
    if (card.isFull) isolate(card, false);
    placeCloseButton();
  }
  function closeCard(card) {
    card.element.style.transition = "opacity 180ms";
    card.element.style.opacity = "0";
    card.holders.forEach((holder) => { holder.style.transition = "opacity 180ms"; holder.style.opacity = "0"; });
    setTimeout(() => {
      removeCard(card);
      const anythingLeft = lesson.cards.length || [...lesson.painted.values()].some((record) => record.holder && record.holder.isConnected && !record.card && record.mark.role !== "button");
      if (!anythingLeft) toRust({ type: "dismiss" });
    }, 190);
  }
  // Pinned: a picture of the card rests at the screen's edge, and slides out under the pointer.
  function pinCard(card) {
    if (lesson.pinning) return;
    lesson.pinning = card;
    card.element.classList.add("lesson-being-pinned");
    setTimeout(() => {
      const rect = card.element.getBoundingClientRect();
      toRust({ type: "pin", x: rect.left, y: rect.top, w: rect.width, h: rect.height });
    }, 60);
  }
  function pinnedLayer() {
    let layer = document.getElementById("lesson-pinned");
    if (!layer) {
      layer = document.createElement("div");
      layer.id = "lesson-pinned";
      document.body.appendChild(layer);
    }
    return layer;
  }
  function layOutPinned() {
    const items = [...pinnedLayer().children];
    let top = 56;
    for (const item of items) {
      const scale = Math.min(150 / item.lessonW, 110 / item.lessonH, 1);
      const tuckedH = item.lessonH * scale;
      const grow = Math.min(1, 400 / item.lessonW, (window.innerHeight * 0.7) / item.lessonH);
      item.style.top = `${top}px`;
      item.style.setProperty("--tucked", scale);
      item.style.setProperty("--tuck-shift", `${item.lessonW * scale - 30}px`);
      item.style.setProperty("--grown", grow);
      top += tuckedH + 10;
    }
    reportInput();
  }
  function closePinned(except) {
    for (const item of pinnedLayer().children) if (item !== except) item.classList.remove("open");
  }
  function addPinned(data, width, height) {
    const layer = pinnedLayer();
    const item = document.createElement("div");
    item.className = "lesson-pinned-card";
    item.lessonW = width;
    item.lessonH = height;
    const picture = document.createElement("img");
    picture.src = data;
    picture.style.width = `${width}px`;
    picture.style.height = `${height}px`;
    const close = document.createElement("button");
    close.className = "lesson-window-button close";
    close.title = "unpin";
    close.addEventListener("click", () => { item.remove(); layOutPinned(); });
    item.append(picture, close);
    // Only the open card reserves its full size from the desktop, so a lost "pointer left"
    // can't leave a big dead area over the user's apps.
    item.addEventListener("pointerenter", () => { closePinned(item); item.classList.add("open"); setTimeout(reportInput, 240); });
    item.addEventListener("pointerleave", () => { item.classList.remove("open"); setTimeout(reportInput, 240); });
    layer.prepend(item);
    while (layer.children.length > 8) layer.lastChild.remove();
    layOutPinned();
    window.ClickySound?.play("paper-place");
  }
  // The screen moved on: what pointed at it no longer means anything, while cards and notes stay.
  function screenChanged(reason) {
    if (now() < lesson.ignoreScreenUntil || !lesson.pacer.lines.some((line) => line && line.start !== null)) return;
    for (const record of lesson.painted.values()) {
      const { mark, holder } = record;
      if (!holder || record.card || record.faded) continue;
      if (!(mark.glow || mark.role === "point" || mark.role === "ring" || mark.role === "frame" || mark.do === "pill" || mark.do === "badge")) continue;
      record.faded = true;
      holder.style.transition = "opacity 350ms";
      holder.style.opacity = "0";
      setTimeout(() => holder.remove(), 380);
    }
    console.info(`the screen changed (${reason}): pointing marks cleared`);
  }
  // Captions of what's being said, each word lighting up as it's reached.
  function showCaption(k, duration) {
    if (!lesson.captions) return;
    const words = String(lesson.lineTexts[k] || "").trim().split(/\s+/).filter(Boolean);
    if (!words.length) return;
    if (!lesson.captionBar) {
      lesson.captionBar = document.createElement("div");
      lesson.captionBar.className = "lesson-caption";
      document.body.appendChild(lesson.captionBar);
    }
    const bar = lesson.captionBar;
    clearTimeout(lesson.captionTimer);
    bar.replaceChildren();
    const total = words.reduce((sum, word) => sum + word.length + 1, 0);
    let spoken = 0;
    for (const word of words) {
      const span = document.createElement("span");
      span.textContent = `${word} `;
      span.style.transitionDelay = `${(duration * spoken) / total}s`;
      bar.appendChild(span);
      spoken += word.length + 1;
    }
    bar.classList.add("shown");
    void bar.offsetWidth;
    bar.classList.add("speaking");
    requestAnimationFrame(() => { for (const span of bar.children) span.classList.add("said"); });
    bar.classList.remove("speaking");
    lesson.captionTimer = setTimeout(() => bar.classList.remove("shown"), (duration + 1.2) * 1000);
  }

  function drawWindow(mark) {
    const { scale } = lesson;
    const element = document.createElement("div");
    element.className = "lesson-window popping";
    Object.assign(element.style, {
      left: `${mark.at[0] * scale.x}px`, top: `${mark.at[1] * scale.y}px`, width: `${mark.w * scale.x}px`, height: `${mark.h * scale.y}px`,
    });
    const bar = document.createElement("div");
    bar.className = "lesson-window-bar";
    bar.style.height = `${(mark.header || WINDOW_HEADER) * scale.y}px`;
    const title = document.createElement("span");
    title.className = "lesson-window-title";
    title.textContent = mark.title || "";
    bar.appendChild(title);
    element.appendChild(bar);
    decorateWindow(element, bar, mark.board);
    if (mark.bg) element.style.setProperty("--board", mark.bg);
    lesson.windowLayer.appendChild(element);
    lesson.papers.push({ x: mark.at[0], y: mark.at[1], w: mark.w, h: mark.h, id: mark.id, bg: mark.bg || paperTone() });
    addCard({ element, bar, box: { x: mark.at[0], y: mark.at[1], w: mark.w, h: mark.h }, paperId: mark.id });
    window.ClickySound?.play("paper-place");
    placeCloseButton();
    return element;
  }

  function drawImage(group, mark) {
    const [x, y] = mark.at;
    const border = 9, strip = mark.caption ? 38 : 16;
    const cx = x + mark.w / 2, cy = y + mark.h / 2;
    const frame = svg("g", { transform: `rotate(${mark.tilt || 0} ${cx} ${cy})` });
    frame.appendChild(svg("rect", { x: x - border + 2, y: y - border + 4, width: mark.w + border * 2, height: mark.h + border + strip, rx: 2, fill: "#10131a", "fill-opacity": 0.28 }));
    frame.appendChild(svg("rect", { x: x - border, y: y - border, width: mark.w + border * 2, height: mark.h + border + strip, rx: 2, fill: "#FBF9F4" }));
    frame.appendChild(svg("rect", { x, y, width: mark.w, height: mark.h, fill: "#D9D6CE" }));
    const image = svg("image", { x, y, width: mark.w, height: mark.h, preserveAspectRatio: "xMidYMid slice", opacity: 0 });
    frame.appendChild(image);
    if (mark.caption) {
      const caption = svg("text", { x: cx, y: y + mark.h + 26, "text-anchor": "middle", "font-size": 20, "font-family": "Hand, sans-serif", fill: PAPER_INK });
      caption.textContent = mark.caption;
      frame.appendChild(caption);
    }
    group.appendChild(frame);
    popIn(group, cx, cy, 0.4);
    lesson.papers.push({ x: x - border, y: y - border, w: mark.w + 2 * border, h: mark.h + border + strip, id: mark.id });
    if (mark.query) toRust({ type: "photo", id: mark.id, query: mark.query });
    return image;
  }

  function drawButton(mark) {
    const { scale, ink } = lesson;
    const button = document.createElement("button");
    button.className = "lesson-button";
    button.textContent = mark.text;
    button.style.setProperty("--ink", ink);
    button.style.fontSize = `${13 * scale.y}px`;
    const tones = gelTone();
    for (const [name, value] of Object.entries(tones)) button.style.setProperty(`--gel-${name}`, value);
    button.addEventListener("click", () => {
      const action = mark.action || {};
      if (action.ask) toRust({ type: "ask", text: action.ask });
      else if (action.open) toRust({ type: "open", url: action.open });
      else if (action.copy) toRust({ type: "copy", text: action.copy });
    });
    lesson.buttonLayer.appendChild(button);
    let left = mark.at[0] * scale.x;
    let top = mark.at[1] * scale.y;
    const width = button.offsetWidth, height = button.offsetHeight;
    left = clamp(left, 6, window.innerWidth - width - 6);
    top = clamp(top, 6, window.innerHeight - height - 6);
    // A button written on top of a card or figure moves just below it, or tucks
    // inside its bottom edge when there's no room below. Never half across the edge.
    const obstacles = [...lesson.stages.values()].map((stage) => stage.rect())
      .concat(lesson.papers.map((paper) => [paper.x * scale.x, paper.y * scale.y, paper.w * scale.x, paper.h * scale.y]));
    for (const [x, y, w, h] of obstacles) {
      const across = left < x + w && x < left + width;
      if (!across || top + height <= y || top >= y + h) continue;
      const below = y + h + 10;
      top = below + height < window.innerHeight - 6 ? below : y + h - height - 12;
    }
    // Two buttons never sit on each other: the later one steps to the side.
    for (const other of lesson.buttons) {
      const hits = left < other.offsetLeft + other.offsetWidth + 8 && other.offsetLeft < left + width + 8 && top < other.offsetTop + other.offsetHeight && other.offsetTop < top + height;
      if (hits) {
        const right = other.offsetLeft + other.offsetWidth + 10;
        if (right + width < window.innerWidth - 6) left = right;
        else top = other.offsetTop - height - 8;
      }
    }
    button.style.left = `${left}px`;
    button.style.top = `${top}px`;
    lesson.buttons.push(button);
    window.ClickySound?.play("button-appear");
    reportInput();
    return button;
  }

  function stageFor(id) { return lesson.stages.get(id); }

  function createStage(mark) {
    const stage = window.ClickyStage.create(mark, {
      scale: lesson.scale,
      stageLayer: lesson.stageLayer,
      labelLayer: lesson.labelSvg,
      svgElement: svg,
      warn: (message) => console.warn(message),
      ask: (text) => toRust({ type: "ask", text }),
      decorateWindow,
      paperTone,
    });
    lesson.stages.set(mark.stage, stage);
    if (mark.card) {
      const [x, y, w, h] = stage.rect();
      addCard({ element: stage.element, bar: stage.element.querySelector(".lesson-window-bar"), box: { x: x / lesson.scale.x, y: y / lesson.scale.y, w: w / lesson.scale.x, h: h / lesson.scale.y }, stage });
    } else {
      for (const card of lesson.cards) if (!card.ownStage && cardHolds(card, stage)) { card.stages.push(stage); applyCard(card); break; }
    }
    placeCloseButton();
    reportInput();
    return stage;
  }

  function paint(item) {
    const { mark } = item;
    const seconds = item.dur * item.pace;
    if (mark.snd) window.ClickySound?.play(mark.snd);
    const record = { mark, group: null, element: null };
    switch (mark.do) {
      case "line": case "arrow": case "circle": case "ellipse": case "rect": case "poly": case "path": case "dot":
      case "text": case "pill": case "badge": case "highlight": case "image": case "spotlight": case "molecule": {
        const group = svg("g", { "data-id": mark.id });
        // The holder carries the card's drag and zoom, so the mark's own animations stay separate.
        const holder = svg("g");
        holder.appendChild(group);
        lesson.inkSvg.appendChild(holder);
        record.group = group;
        record.holder = holder;
        record.element = paintInk(group, mark, seconds);
        joinCard(record);
        break;
      }
      case "window": record.element = drawWindow(mark); break;
      case "act":
        lesson.ignoreScreenUntil = now() + 2;
        if (mark.kind === "type") toRust({ type: "type_text", x: mark.at[0], y: mark.at[1], text: mark.text });
        else if (mark.kind === "handoff") toRust({ type: "handoff", task: mark.task, label: mark.label });
        break;
      case "button": record.element = drawButton(mark); break;
      case "stage3d": createStage(mark); window.ClickySound?.play("paper-place"); break;
      case "part3d": {
        const stage = stageFor(mark.stage);
        if (stage) { stage.addPart(mark, Math.max(0.4, item.pace)); window.ClickySound?.play("build-3d"); }
        break;
      }
      case "label3d": stageFor(mark.stage)?.addLabel(mark); break;
      case "motion3d": stageFor(mark.stage)?.motion(mark, now()); break;
      case "camera3d": stageFor(mark.stage)?.camera(mark); break;
      case "tick3d":
        lesson.worker?.postMessage({ type: "tickStart", tickId: mark.tickId, now: now() });
        lesson.ticksRunning = true;
        stageFor(mark.stage)?.ticksRunning(true);
        break;
      case "sound": window.ClickySound?.play(mark.name); break;
      case "edit": applyEdit(mark, seconds); break;
      default:
    }
    lesson.painted.set(mark.id, record);
    if (mark.flies) {
      const at = mark.at || [0, 0];
      const center = mark.do === "rect" ? [at[0] + mark.w / 2, at[1] + mark.h / 2] : at;
      toRust({ type: "point", x: center[0], y: center[1], label: "" });
    }
  }

  // A chemical structure, drawn in the handwriting with rounded bonds.
  function drawMolecule(group, mark) {
    const [x, y] = mark.at;
    const holder = svg("g", { transform: `translate(${x} ${y})`, opacity: 0 });
    group.appendChild(holder);
    const picture = svg("svg", { width: mark.w, height: mark.h, viewBox: `0 0 ${mark.w} ${mark.h}`, overflow: "visible" });
    holder.appendChild(picture);
    const library = window.SmilesDrawer;
    if (!library) { console.warn("molecule: SmilesDrawer isn't loaded"); return; }
    try {
      const drawer = new library.SvgDrawer({ width: mark.w, height: mark.h, bondThickness: 1.6, bondLength: mark.bond || 22, shortBondLength: 0.82, fontSizeLarge: 9, fontSizeSmall: 6, padding: 4, compactDrawing: false, terminalCarbons: false });
      library.parse(mark.smiles, (tree) => drawer.draw(tree, picture, "light", null, false), (error) => toRust({ type: "warn", message: `molecule: ${error && error.message}` }));
      picture.querySelectorAll("line").forEach((line) => { line.setAttribute("stroke-linecap", "round"); line.setAttribute("stroke-width", "1.8"); });
      const bounds = picture.getBBox();
      if (bounds.width > 0) {
        const k = Math.min(mark.w / (bounds.width + 10), mark.h / (bounds.height + 10), 1.9);
        const viewW = mark.w / k, viewH = mark.h / k;
        picture.setAttribute("viewBox", `${bounds.x + bounds.width / 2 - viewW / 2} ${bounds.y + bounds.height / 2 - viewH / 2} ${viewW} ${viewH}`);
      }
      picture.querySelectorAll("text").forEach((words) => { words.setAttribute("font-family", "Hand, sans-serif"); words.setAttribute("font-weight", "600"); });
    } catch (error) { toRust({ type: "warn", message: `molecule failed: ${error.message}` }); }
    tween(0.6, (t) => holder.setAttribute("opacity", t), easeOutCubic);
  }

  function noteShape(group, mark) {
    if (mark.role === "paper" || mark.role === "tie") return;
    try {
      const r = group.getBBox();
      if (r.width || r.height) lesson.inkBoxes.push({ element: group, box: { x: r.x, y: r.y, w: r.width, h: r.height } });
    } catch (_) { /* not rendered yet */ }
  }
  function paintInk(group, mark, seconds) {
    const random = seeded(`${mark.id}`);
    const size = mark.size || DEFAULT_PEN_SIZE;
    switch (mark.do) {
      case "line": {
        const centre = mark.smooth === false
          ? handEdges(mark.pts, false, random, mark.wobble == null ? 0.6 : mark.wobble, mark.bow, mark.jitter)
          : mark.bow === "pen" ? smoothLine(handEdges(mark.pts, false, random, mark.wobble == null ? 1 : mark.wobble, "pen", mark.jitter)) : smoothLine(mark.pts);
        drawStroke(group, mark, centre, seconds, { taper: mark.dash && mark.taper !== 0 ? 0.3 : undefined });
        noteShape(group, mark);
        return null;
      }
      case "arrow": {
        let centre = mark.smooth === false ? handEdges(mark.pts, false, random, mark.wobble == null ? 0.6 : mark.wobble) : smoothLine(mark.pts);
        if (mark.bend) {
          const a = mark.pts[0], b = mark.pts[mark.pts.length - 1], length = gap(a, b) || 1;
          let k = mark.bend === true ? 0.15 : Number(mark.bend) || 0;
          if (Math.abs(k) > 1) k /= length;
          k = clamp(k, -0.6, 0.6);
          centre = smoothLine([a, [(a[0] + b[0]) / 2 - (b[1] - a[1]) * k, (a[1] + b[1]) / 2 + (b[0] - a[0]) * k], b]);
        }
        const shaftSeconds = seconds * 0.8;
        drawStroke(group, mark, centre, shaftSeconds);
        // The head is one quick flick after the shaft lands.
        const end = centre[centre.length - 1], back = centre[Math.max(0, centre.length - 6)];
        const angle = Math.atan2(end[1] - back[1], end[0] - back[0]);
        const length = mark.head || Math.max(9, size * 3), open = mark.headAngle || 0.5;
        const barbs = [[end[0] - length * Math.cos(angle - open), end[1] - length * Math.sin(angle - open)], end, [end[0] - length * Math.cos(angle + open), end[1] - length * Math.sin(angle + open)]];
        const head = svg("g", { opacity: 0 });
        group.appendChild(head);
        tween(seconds, (t) => {
          if (t >= 0.8 && !head.childNodes.length) {
            head.setAttribute("opacity", 1);
            drawStroke(head, mark, barbs, Math.max(0.08, seconds * 0.2), { taper: mark.taper === 0 ? 0 : 0.4 });
            window.ClickySound?.play("pen-flick");
          }
        });
        if (mark.label) {
          const middle = centre[Math.floor(centre.length / 2)];
          const words = svg("text", { x: middle[0] + (mark.labelDx || 0), y: middle[1] - 8 + (mark.labelDy || 0), "text-anchor": "middle", fill: mark.color || PAPER_INK, "font-family": "Hand, sans-serif", "font-size": mark.labelSize || 15 });
          words.textContent = mark.label;
          group.appendChild(words);
        }
        noteShape(group, mark);
        return null;
      }
      case "circle": case "ellipse": {
        const rx = mark.r || mark.rx, ry = mark.r || mark.ry;
        const [cx, cy] = mark.at;
        const turn = (mark.rot || 0) * (Math.abs(mark.rot || 0) > 6.3 ? Math.PI / 180 : 1);
        if (mark.fill) fillIn(group, mark, `${pathOf(handEllipse(cx, cy, rx, ry, turn, seeded(`f${mark.id}`), 0.5, false))}Z`, 4 * rx * ry, seconds);
        if (mark.outline !== false) drawStroke(group, mark, handEllipse(cx, cy, rx, ry, turn, random, mark.wobble == null ? 1 : mark.wobble, true), seconds);
        noteShape(group, mark);
        return null;
      }
      case "rect": {
        const [x, y] = mark.at;
        const w = mark.w, h = mark.h;
        const rounded = clamp(mark.r || 0, 0, Math.min(Math.abs(w), Math.abs(h)) / 2);
        const corners = rounded ? roundedRectPoints(x, y, w, h, rounded).slice(0, -1) : [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
        if (mark.fill) {
          const fill = fillIn(group, mark, `${pathOf(corners)}Z`, Math.abs(w * h), seconds);
          if (mark.shadow) {
            group.insertBefore(svg("path", { d: `${pathOf(corners)}Z`, transform: "translate(3 6)", fill: "#10131a", "fill-opacity": 0.24 }), fill);
            lesson.papers.push({ x, y, w, h, id: mark.id });
          }
        }
        // A sharp box is closed by hand: the pen runs a little past where it started.
        const route = rounded ? handEdges(corners, true, random, 1) : handEdges(corners.concat([[x, y], [x + Math.min(6, Math.abs(w) * 0.06), y + 1]]), false, random, 1);
        if (mark.outline !== false) drawStroke(group, mark, route, seconds);
        noteShape(group, mark);
        return null;
      }
      case "poly": {
        const closed = mark.close !== false;
        const b = boxOfMark(mark);
        if (mark.fill) fillIn(group, mark, `${pathOf(mark.smooth ? smoothLine(mark.pts, true) : mark.pts)}Z`, (b[2] - b[0]) * (b[3] - b[1]), seconds);
        if (mark.outline !== false) {
          drawStroke(group, mark, mark.smooth ? smoothLine(mark.pts, closed) : handEdges(mark.pts, closed, random, mark.wobble == null ? 0.7 : mark.wobble, mark.bow, mark.jitter), seconds);
        }
        noteShape(group, mark);
        return null;
      }
      case "path": {
        const path = svg("path", { d: mark.d, fill: mark.fill || "none", "fill-opacity": mark.fillAlpha ?? 1, stroke: mark.outline === false ? "none" : mark.color, "stroke-width": size, "stroke-linecap": "round", "stroke-linejoin": "round" });
        group.appendChild(path);
        const length = path.getTotalLength();
        revealByStroke(path, mark.d, length, size * 2 + 4, seconds);
        noteShape(group, mark);
        return null;
      }
      case "dot": {
        group.appendChild(svg("circle", { cx: mark.at[0], cy: mark.at[1], r: mark.r || 3, fill: mark.color, "fill-opacity": mark.fillAlpha ?? 1 }));
        popIn(group, mark.at[0], mark.at[1], 0.25);
        return null;
      }
      case "text": drawText(group, mark, seconds); return null;
      case "molecule": drawMolecule(group, mark); return null;
      case "pill": drawPill(group, mark); return null;
      case "badge": drawBadge(group, mark); return null;
      case "highlight": {
        const [x, y] = mark.at, w = mark.w, h = mark.h;
        const band = svg("path", {
          d: `M${x} ${y + 2} Q${x + w / 2} ${y - 1} ${x + w} ${y + 1} L${x + w - 1} ${y + h} Q${x + w / 2} ${y + h + 2} ${x + 1} ${y + h - 1} Z`,
          fill: mark.color, "fill-opacity": 0.72, style: "mix-blend-mode:multiply",
        });
        group.appendChild(band);
        tween(0.35, (t) => band.setAttribute("transform", `translate(${x} 0) scale(${Math.max(0.001, t)} 1) translate(${-x} 0)`), easeOutCubic);
        window.ClickySound?.play("highlighter");
        return null;
      }
      case "image": return drawImage(group, mark);
      case "spotlight": {
        const [x, y] = mark.at;
        const veil = svg("path", {
          d: `M0 0H${lesson.width}V${lesson.height}H0Z M${x} ${y}V${y + mark.h}H${x + mark.w}V${y}Z`,
          fill: "#0A0C10", "fill-opacity": 0, "fill-rule": "evenodd",
        });
        group.appendChild(veil);
        tween(0.4, (t) => veil.setAttribute("fill-opacity", 0.45 * t), easeOutCubic);
        return null;
      }
      default: return null;
    }
  }

  // ---------------------------------------------------------------- edits on what's already there
  function eachTarget(ids, visit) {
    for (const id of ids || []) {
      const record = lesson.painted.get(id);
      if (record) visit(record, id);
    }
  }

  function removeRecord(record) {
    const { mark } = record;
    if (mark.do === "part3d") { stageFor(mark.stage)?.erasePart(mark.partId); return; }
    if (mark.do === "label3d") { stageFor(mark.stage)?.eraseLabel(mark.labelId); return; }
    if (mark.do === "stage3d") {
      stageFor(mark.stage)?.dispose();
      lesson.stages.delete(mark.stage);
      placeCloseButton();
      return;
    }
    if (mark.do === "button") {
      record.element?.remove();
      lesson.buttons = lesson.buttons.filter((button) => button !== record.element);
      reportInput();
      return;
    }
    if (mark.do === "window") {
      record.element?.remove();
      lesson.papers = lesson.papers.filter((paper) => paper.id !== mark.id);
      placeCloseButton();
      return;
    }
    record.group?.remove();
    lesson.papers = lesson.papers.filter((paper) => paper.id !== mark.id);
  }

  function applyEdit(mark, seconds) {
    switch (mark.op) {
      case "erase": {
        window.ClickySound?.play("eraser");
        const fade = Math.max(0.2, seconds);
        eachTarget(mark.ids, (record) => {
          const target = record.group;
          if (target) {
            tween(fade, (t) => {
              target.setAttribute("opacity", 1 - t);
              if (t >= 1) removeRecord(record);
            }, easeOutCubic);
          } else {
            removeRecord(record);
          }
        });
        break;
      }
      case "recolor": case "restyle":
        eachTarget(mark.ids, (record) => {
          if (record.mark.do === "part3d") { stageFor(record.mark.stage)?.recolorPart(record.mark.partId, mark.color); return; }
          record.group?.querySelectorAll("[fill]:not([fill='none'])").forEach((node) => node.setAttribute("fill", mark.color));
          record.group?.querySelectorAll("[stroke]:not([stroke='none'])").forEach((node) => node.setAttribute("stroke", mark.color));
        });
        break;
      case "highlight":
        window.ClickySound?.play("highlighter");
        eachTarget(mark.ids, (record) => {
          if (record.mark.do === "part3d") { stageFor(record.mark.stage)?.highlightPart(record.mark.partId, mark.color); return; }
          if (!record.group) return;
          const box = record.group.getBBox();
          const band = svg("rect", { x: box.x - 4, y: box.y - 2, width: 0, height: box.height + 4, rx: 3, fill: mark.color, "fill-opacity": 0.42, style: "mix-blend-mode:multiply" });
          record.group.insertBefore(band, record.group.firstChild);
          tween(0.35, (t) => band.setAttribute("width", (box.width + 8) * t), easeInOut);
        });
        break;
      case "move":
        window.ClickySound?.play("slide");
        eachTarget(mark.ids, (record) => {
          if (!record.group) return;
          tween(0.45, (t) => record.group.setAttribute("transform", `translate(${(mark.dx || 0) * t} ${(mark.dy || 0) * t})`), easeInOut);
        });
        break;
      case "scale":
        eachTarget(mark.ids, (record) => {
          if (!record.group) return;
          const box = record.group.getBBox();
          const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
          tween(0.45, (t) => { const s = 1 + ((mark.factor || 1) - 1) * t; record.group.setAttribute("transform", `translate(${cx} ${cy}) scale(${s}) translate(${-cx} ${-cy})`); }, easeInOut);
        });
        break;
      case "clear":
        window.ClickySound?.play("page-clear");
        wipe();
        break;
      default:
    }
  }

  // Everything on the card goes; the program keeps its variables.
  function wipe() {
    lesson.worker?.postMessage({ type: "tickStop" });
    lesson.ticksRunning = false;
    for (const stage of lesson.stages.values()) stage.dispose();
    lesson.stages.clear();
    if (lesson.root) {
      lesson.windowLayer.replaceChildren();
      lesson.inkSvg.replaceChildren(lesson.defs);
      lesson.defs.replaceChildren();
      installFilters(lesson.defs);
      lesson.labelSvg.replaceChildren();
      lesson.buttonLayer.replaceChildren();
    }
    lesson.closeButton = null;
    lesson.papers = [];
    lesson.cards = [];
    lesson.dim = null;
    lesson.pinning = null;
    lesson.lineTexts = {};
    lesson.canSaveVideo = false;
    lesson.saveButton?.remove();
    lesson.saveButton = null;
    lesson.fills = [];
    lesson.fillOrder = 0;
    lesson.placedWords = [];
    lesson.inkBoxes = [];
    lesson.buttons = [];
    lesson.painted.clear();
    lesson.tweens = [];
    reportInput();
  }

  // ---------------------------------------------------------------- the sandbox
  function startWorker() {
    if (lesson.worker) lesson.worker.terminate();
    const source = document.getElementById("lesson-worker-source").textContent;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = ({ data }) => workerMessage(data);
    worker.onerror = (event) => { console.warn("lesson worker error", event.message); };
    lesson.worker = worker;
    lesson.workerDead = false;
    lesson.lastHeardFromWorker = now();
    lesson.awaitingFrame = false;
    lesson.ticksRunning = false;
  }

  function workerMessage(data) {
    lesson.lastHeardFromWorker = now();
    switch (data.type) {
      case "events":
        for (const event of data.events) {
          if (event.kind === "say") {
            lesson.pacer.addLine(event.k, event.text);
            lesson.lineTexts[event.k] = event.text;
            toRust({ type: "say", k: event.k, text: event.text });
          } else if (event.kind === "mark") {
            lesson.pacer.add(event.mark);
          } else if (event.kind === "warn") {
            console.warn(event.message);
            toRust({ type: "warn", message: event.message });
          }
        }
        break;
      case "done":
        lesson.expectingWorker = false;
        lesson.pacer.programDone = true;
        lesson.pacer.dirty = true;
        toRust({ type: "done", state: data.state });
        lesson.canSaveVideo = true;
        placeCloseButton();
        break;
      case "alive":
        lesson.expectingWorker = false;
        break;
      case "poses":
        lesson.awaitingFrame = false;
        for (const stage of lesson.stages.values()) {
          stage.poses(data.poses);
          stage.readout(data.readouts[stage.mark.stage]);
        }
        break;
      default:
    }
  }

  function checkWorker(time) {
    if (!lesson.worker || lesson.workerDead) return;
    if (!lesson.expectingWorker && !lesson.awaitingFrame) return;
    if (time - lesson.lastHeardFromWorker < WATCHDOG_SECONDS) return;
    // An endless loop in the program. The drawing stays; the program can't run on.
    lesson.worker.terminate();
    lesson.worker = null;
    lesson.workerDead = true;
    lesson.expectingWorker = false;
    lesson.awaitingFrame = false;
    lesson.ticksRunning = false;
    lesson.pacer.programDone = true;
    lesson.pacer.dirty = true;
    toRust({ type: "warn", message: "the drawing program stopped responding" });
    toRust({ type: "done", state: "", lost: true });
  }

  // ---------------------------------------------------------------- the frame
  function frame() {
    lesson.animationFrame = 0;
    const time = now();
    for (const item of lesson.pacer.due(time)) {
      try { paint(item); } catch (error) { console.warn("paint failed", item.mark, error); }
    }
    const tweens = lesson.tweens;
    lesson.tweens = [];
    for (const animation of tweens) {
      const t = clamp((time - animation.start) / animation.seconds, 0, 1);
      try { animation.apply(animation.ease(t)); } catch (error) { continue; }
      if (t < 1) lesson.tweens.push(animation);
    }
    for (const stage of lesson.stages.values()) {
      try { stage.update(time); } catch (error) { console.warn("stage failed", error); }
    }
    if (lesson.ticksRunning && lesson.worker && !lesson.awaitingFrame) {
      lesson.awaitingFrame = true;
      lesson.lastHeardFromWorker = Math.max(lesson.lastHeardFromWorker, time - 0.001);
      lesson.worker.postMessage({ type: "frame", now: time });
    }
    checkWorker(time);
    const busy = lesson.stages.size > 0 || lesson.tweens.length > 0 || lesson.pacer.queue.length > 0 || lesson.expectingWorker;
    if (busy) schedule();
  }
  function schedule() {
    if (!lesson.animationFrame) lesson.animationFrame = requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- commands from Rust
  function begin(command) {
    ensureLayers();
    lesson.width = command.width;
    lesson.height = command.height;
    lesson.scale = { x: command.scale_x, y: command.scale_y };
    if (command.ink) lesson.ink = command.ink;
    lesson.captions = !!command.captions;
    lesson.recording = !!command.recording;
    lesson.inkSvg.setAttribute("viewBox", `0 0 ${command.width} ${command.height}`);
    // The watchdog ended the last program, so its variables are gone. What it drew
    // can't be built on, so the new turn starts on a clean canvas.
    if (lesson.workerDead) wipe();
    // A new question is being answered, so what's on screen stops turning and faces front.
    for (const stage of lesson.stages.values()) stage.holdStill();
    if (!lesson.worker) startWorker();
    if (lesson.pacer.queue.length) dropUndrawn();
    lesson.pacer.programDone = false;
    lesson.pacer.dirty = true;
    window.ClickySound?.setEnabled(command.sounds !== false);
    lesson.active = true;
    lesson.expectingWorker = true;
    lesson.lastHeardFromWorker = now();
    lesson.worker.postMessage({ type: "begin", width: command.width, height: command.height, tiles: command.tiles, ink: command.ink });
    schedule();
  }

  function dropUndrawn() {
    const dropped = lesson.pacer.dropWaiting();
    if (dropped.length) lesson.worker?.postMessage({ type: "dropped", ids: dropped });
  }

  function handle(command) {
    switch (command.type) {
      case "lesson_begin": begin(command); break;
      case "lesson_code":
        lesson.expectingWorker = true;
        lesson.worker?.postMessage({ type: "code", text: command.text });
        schedule();
        break;
      case "lesson_end":
        lesson.expectingWorker = true;
        lesson.worker?.postMessage({ type: "end" });
        schedule();
        break;
      case "lesson_pinned": {
        const card = lesson.pinning;
        lesson.pinning = null;
        if (card) card.element.classList.remove("lesson-being-pinned");
        if (command.data) {
          addPinned(command.data, command.width, command.height);
          if (card) removeCard(card);
        }
        break;
      }
      case "lesson_screen_changed": screenChanged(command.reason); break;
      case "lesson_line":
        if (command.event === "start") showCaption(command.k, command.duration);
        lesson.pacer.lineEvent(command.k, command.event, command.duration);
        schedule();
        break;
      case "lesson_interrupt":
        dropUndrawn();
        lesson.pacer.programDone = true;
        break;
      case "lesson_photo": {
        const record = lesson.painted.get(command.id);
        if (record?.element) {
          record.element.setAttribute("href", command.data);
          tween(0.3, (t) => record.element.setAttribute("opacity", t), easeOutCubic);
          schedule();
        }
        break;
      }
      default:
    }
  }

  window.clickyLesson = {
    handle(command) {
      try { handle(command); } catch (error) { console.error("lesson command failed", command, error); }
    },
    clear() {
      if (!lesson.root) return;
      dropUndrawn();
      wipe();
      // A cleared drawing's program ends too: the next question starts a fresh scope.
      lesson.worker?.terminate();
      lesson.worker = null;
      lesson.active = false;
    },
    rects: inputRects,
  };
})();
