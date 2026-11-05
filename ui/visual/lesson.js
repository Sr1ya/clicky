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
  const PEN_POINTS_PER_SECOND = 600;
  const PEN_MIN_SECONDS = 0.14;
  const PEN_MAX_SECONDS = 0.7;
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
  const penSeconds = (length) => clamp(length / PEN_POINTS_PER_SECOND, PEN_MIN_SECONDS, PEN_MAX_SECONDS);

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

  // A line a hand drew: wobbled along its normal, thicker in the middle than at its ends.
  function handStroke(rawPoints, options) {
    const { size = 3, taper = 1, wobble = 1, seed = 1 } = options;
    const points = resample(rawPoints);
    const n = points.length;
    let total = 0;
    const along = [0];
    for (let i = 1; i < n; i++) { total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]); along.push(total); }
    const amplitude = Math.min(2.2, total * 0.012) * wobble;
    const center = [], left = [], right = [];
    for (let i = 0; i < n; i++) {
      const before = points[Math.max(0, i - 1)], after = points[Math.min(n - 1, i + 1)];
      let tx = after[0] - before[0], ty = after[1] - before[1];
      const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const shift = smoothNoise(along[i] * 0.014 + seed * 7.3) * amplitude * Math.min(1, along[i] / 18, (total - along[i]) / 18);
      const px = points[i][0] - ty * shift, py = points[i][1] + tx * shift;
      center.push([px, py]);
      let half = size / 2;
      if (taper) {
        const entry = Math.min(1, along[i] / 16), exit = Math.min(1, (total - along[i]) / 22);
        half *= (0.45 + 0.55 * entry) * (0.35 + 0.65 * exit) * (1 + 0.14 * smoothNoise(along[i] * 0.03 + seed));
      }
      left.push([px - ty * half, py + tx * half]);
      right.push([px + ty * half, py - tx * half]);
    }
    const fmt = (p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
    return {
      center: `M${center.map(fmt).join("L")}`,
      outline: `M${left.map(fmt).join("L")}L${right.reverse().map(fmt).join("L")}Z`,
      length: total,
    };
  }

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

  function drawStroke(group, mark, rawPoints, seconds, options = {}) {
    const color = mark.color || PAPER_INK;
    const size = mark.size || 3;
    const seed = parseInt(mark.id.slice(1), 10) + 1;
    const taper = mark.taper === 0 ? 0 : 1;
    const stroke = handStroke(rawPoints, { size, taper, wobble: mark.wobble ?? (mark.glow ? 0.5 : 1), seed });
    const dashed = mark.dash || options.dash;

    const paint = svg("g");
    const onPaper = rawPoints.length && inPaper(rawPoints[0][0], rawPoints[0][1]);
    if (mark.glow) {
      paint.appendChild(svg("path", { d: stroke.center, fill: "none", stroke: color, "stroke-opacity": 0.22, "stroke-width": size * 3.2, "stroke-linecap": "round", "stroke-linejoin": "round" }));
    } else if (!onPaper) {
      paint.appendChild(svg("path", { d: stroke.center, fill: "none", stroke: haloColor(color), "stroke-width": size + 2.6, "stroke-linecap": "round", "stroke-linejoin": "round" }));
    }
    if (dashed) {
      paint.appendChild(svg("path", { d: stroke.center, fill: "none", stroke: color, "stroke-width": size, "stroke-dasharray": `${size * 3.2} ${size * 2.6}`, "stroke-linecap": "round" }));
    } else if (taper) {
      paint.appendChild(svg("path", { d: stroke.outline, fill: color, stroke: color, "stroke-width": 0.4 }));
    } else {
      paint.appendChild(svg("path", { d: stroke.center, fill: "none", stroke: color, "stroke-width": size, "stroke-linecap": "round", "stroke-linejoin": "round" }));
    }
    group.appendChild(paint);
    revealByStroke(paint, stroke.center, stroke.length, size * 4 + 8, seconds);
    return stroke;
  }

  function fillIn(group, element, seconds) {
    group.insertBefore(element, group.firstChild);
    const target = +(element.getAttribute("fill-opacity") ?? 1);
    tween(Math.max(0.15, seconds * 0.8), (t) => element.setAttribute("fill-opacity", target * t), easeOutCubic);
  }

  function shapeFill(mark, d) {
    return svg("path", { d, fill: mark.fill, "fill-opacity": mark.fillAlpha ?? 0.35 });
  }

  function popIn(group, cx, cy, seconds) {
    tween(seconds, (t) => {
      const s = Math.max(0.01, easeOutBack(t));
      group.setAttribute("transform", `translate(${cx} ${cy}) scale(${s}) translate(${-cx} ${-cy})`);
      group.setAttribute("opacity", clamp(t * 2.5, 0, 1));
    });
  }

  function fontFamily(mark) {
    return mark.font === "serif" ? "Georgia, 'Noto Serif', serif" : "Hand, sans-serif";
  }

  function wrapLines(mark) {
    const size = mark.size || 20;
    const hard = String(mark.text).split("\n");
    if (!mark.fit || !mark.fit[0]) return hard;
    const context = lesson.measure;
    context.font = `${mark.weight >= 600 ? "700 " : ""}${size}px ${fontFamily(mark)}`;
    const out = [];
    for (const paragraph of hard) {
      let line = "";
      for (const word of paragraph.split(/\s+/)) {
        const attempt = line ? `${line} ${word}` : word;
        if (line && context.measureText(attempt).width > mark.fit[0]) { out.push(line); line = word; } else line = attempt;
      }
      out.push(line);
    }
    return out;
  }

  function drawText(group, mark, seconds) {
    const size = mark.size || 20;
    const lines = wrapLines(mark);
    const leading = size * 1.22;
    const [x, y] = mark.at;
    const color = mark.color || PAPER_INK;
    const onPaper = inPaper(x, y);
    const text = svg("text", {
      x, y, fill: color, "font-size": size, "font-family": fontFamily(mark), "text-anchor": mark.anchor || "start",
      "font-weight": mark.weight >= 600 ? 700 : 400,
      stroke: onPaper ? undefined : haloColor(color), "stroke-width": onPaper ? undefined : Math.max(2.4, size * 0.13), "paint-order": onPaper ? undefined : "stroke", "stroke-linejoin": "round",
    });
    lines.forEach((line, index) => {
      const span = svg("tspan", { x, dy: index ? leading : 0 });
      span.textContent = line;
      text.appendChild(span);
    });
    group.appendChild(text);
    // Handwriting wipes on left to right; words on several lines wipe as one.
    const bounds = text.getBBox();
    const id = `lesson-clip-${++lesson.maskCount}`;
    const clip = svg("clipPath", { id });
    const rect = svg("rect", { x: bounds.x - 6, y: bounds.y - 6, width: 0, height: bounds.height + 12 });
    clip.appendChild(rect);
    lesson.defs.appendChild(clip);
    text.setAttribute("clip-path", `url(#${id})`);
    tween(seconds, (t) => {
      rect.setAttribute("width", (bounds.width + 12) * t);
      if (t >= 1) { text.removeAttribute("clip-path"); clip.remove(); }
    });
  }

  function drawPill(group, mark) {
    const [x, y] = mark.at;
    const words = String(mark.text);
    const size = 16;
    lesson.measure.font = `${size}px Hand, sans-serif`;
    const width = lesson.measure.measureText(words).width + 22;
    const height = 27;
    const left = mark.anchor === "middle" ? x - width / 2 : x;
    const color = mark.color || lesson.ink;
    group.appendChild(svg("rect", { x: left + 1, y: y + 2, width, height, rx: height / 2, fill: "#10131a", "fill-opacity": 0.2 }));
    group.appendChild(svg("rect", { x: left, y, width, height, rx: height / 2, fill: color, stroke: "#10131a", "stroke-opacity": 0.28 }));
    group.appendChild(svg("rect", { x: left, y, width, height, rx: height / 2, fill: "#fff", "fill-opacity": 0.72 }));
    group.appendChild(svg("rect", { x: left + 8, y: y + 2.5, width: width - 16, height: 8, rx: 4, fill: "#fff", "fill-opacity": 0.6 }));
    const text = svg("text", { x: left + width / 2, y: y + height / 2 + size * 0.33, "text-anchor": "middle", "font-size": size, "font-family": "Hand, sans-serif", fill: "#15171C" });
    text.textContent = words;
    group.appendChild(text);
    popIn(group, left + width / 2, y + height / 2, 0.26);
    window.ClickySound?.play("pill-pop");
  }

  function drawBadge(group, mark) {
    const [x, y] = mark.at;
    const r = 14;
    group.appendChild(svg("circle", { cx: x, cy: y, r: r + 2.5, fill: mark.color || lesson.ink, "fill-opacity": 0.25 }));
    group.appendChild(svg("circle", { cx: x, cy: y, r, fill: mark.color || lesson.ink }));
    const text = svg("text", { x, y: y + 6, "text-anchor": "middle", "font-size": 18, "font-family": "Hand, sans-serif", fill: "#fff", "font-weight": 700 });
    text.textContent = mark.text;
    group.appendChild(text);
    popIn(group, x, y, 0.26);
    window.ClickySound?.play("pill-pop");
  }

  function drawWindow(mark) {
    const { scale } = lesson;
    const element = document.createElement("div");
    element.className = "lesson-window popping";
    Object.assign(element.style, {
      left: `${mark.at[0] * scale.x}px`, top: `${mark.at[1] * scale.y}px`, width: `${mark.w * scale.x}px`, height: `${mark.h * scale.y}px`,
    });
    if (mark.color) element.style.background = mark.color;
    const bar = document.createElement("div");
    bar.className = "lesson-window-bar";
    bar.style.height = `${34 * scale.y}px`;
    bar.style.fontSize = `${15 * scale.y}px`;
    bar.innerHTML = '<span class="lesson-dot"></span><span class="lesson-dot"></span><span class="lesson-dot"></span>';
    const title = document.createElement("span");
    title.className = "lesson-window-title";
    title.textContent = mark.title || "";
    bar.appendChild(title);
    element.appendChild(bar);
    lesson.windowLayer.appendChild(element);
    lesson.papers.push({ x: mark.at[0], y: mark.at[1], w: mark.w, h: mark.h, id: mark.id });
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
    button.style.fontSize = `${17 * scale.y}px`;
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
    });
    lesson.stages.set(mark.stage, stage);
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
      case "text": case "pill": case "badge": case "highlight": case "image": case "spotlight": {
        const group = svg("g", { "data-id": mark.id });
        lesson.inkSvg.appendChild(group);
        record.group = group;
        record.element = paintInk(group, mark, seconds);
        break;
      }
      case "window": record.element = drawWindow(mark); break;
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

  function paintInk(group, mark, seconds) {
    switch (mark.do) {
      case "line": {
        const points = mark.smooth ? catmullRom(mark.pts) : mark.pts;
        drawStroke(group, mark, bentPoints(points, mark.bend), seconds);
        return null;
      }
      case "arrow": {
        const points = bentPoints(mark.smooth ? catmullRom(mark.pts) : mark.pts, mark.bend);
        drawStroke(group, mark, points, seconds * 0.82);
        // The head is two quick flicks after the shaft lands.
        const end = points[points.length - 1];
        let back = points[points.length - 2];
        for (let i = points.length - 2; i >= 0; i--) { back = points[i]; if (Math.hypot(end[0] - back[0], end[1] - back[1]) > 10) break; }
        const angle = Math.atan2(end[1] - back[1], end[0] - back[0]);
        const size = mark.size || 3;
        const headLength = clamp(size * 4.2, 11, 22);
        const head = svg("g");
        for (const spread of [-0.5, 0.5]) {
          const tip = [end[0] - Math.cos(angle + spread) * headLength, end[1] - Math.sin(angle + spread) * headLength];
          const d = handStroke([tip, end], { size, taper: 0, wobble: 0, seed: 1 });
          head.appendChild(svg("path", { d: d.center, stroke: mark.color || PAPER_INK, "stroke-width": size, "stroke-linecap": "round", fill: "none" }));
        }
        group.appendChild(head);
        head.setAttribute("opacity", 0);
        tween(seconds, (t) => head.setAttribute("opacity", t >= 0.82 ? 1 : 0));
        window.ClickySound?.play("pen-flick");
        return null;
      }
      case "circle": case "ellipse": {
        const rx = mark.r || mark.rx, ry = mark.r || mark.ry;
        const [cx, cy] = mark.at;
        const seed = parseInt(mark.id.slice(1), 10);
        const points = [];
        // A hand's circle overshoots its start a little.
        for (let i = 0; i <= 44; i++) {
          const a = -Math.PI / 2 + (i / 40) * Math.PI * 2;
          const swell = 1 + smoothNoise(i * 0.22 + seed) * 0.018;
          points.push([cx + Math.cos(a) * rx * swell, cy + Math.sin(a) * ry * swell]);
        }
        if (mark.fill) fillIn(group, svg("ellipse", { cx, cy, rx, ry, fill: mark.fill, "fill-opacity": mark.fillAlpha ?? 0.35 }), seconds);
        if (mark.outline !== false) drawStroke(group, mark, points, seconds);
        return null;
      }
      case "rect": {
        const [x, y] = mark.at;
        const w = mark.w, h = mark.h;
        const points = roundedRectPoints(x, y, w, h, mark.r);
        const d = `M${points.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("L")}Z`;
        if (mark.fill) {
          const fill = shapeFill(mark, d);
          fillIn(group, fill, seconds);
          if (mark.shadow) {
            group.insertBefore(svg("path", { d, transform: "translate(3 6)", fill: "#10131a", "fill-opacity": 0.24 }), fill);
            lesson.papers.push({ x, y, w, h, id: mark.id });
          }
        }
        if (mark.outline !== false) drawStroke(group, mark, points, seconds);
        return null;
      }
      case "poly": {
        const closed = mark.smooth ? catmullRom(mark.pts, true) : mark.pts.concat([mark.pts[0]]);
        if (mark.fill) fillIn(group, shapeFill(mark, `M${closed.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("L")}Z`), seconds);
        if (mark.outline !== false) drawStroke(group, mark, closed, seconds);
        return null;
      }
      case "path": {
        const path = svg("path", { d: mark.d, fill: mark.fill || "none", "fill-opacity": mark.fillAlpha ?? 0.35, stroke: mark.color, "stroke-width": mark.size || 3, "stroke-linecap": "round", "stroke-linejoin": "round" });
        group.appendChild(path);
        const length = path.getTotalLength();
        revealByStroke(path, mark.d, length, (mark.size || 3) * 4 + 8, seconds);
        return null;
      }
      case "dot": {
        group.appendChild(svg("circle", { cx: mark.at[0], cy: mark.at[1], r: mark.r, fill: mark.color }));
        popIn(group, mark.at[0], mark.at[1], 0.2);
        return null;
      }
      case "text": drawText(group, mark, seconds); return null;
      case "pill": drawPill(group, mark); return null;
      case "badge": drawBadge(group, mark); return null;
      case "highlight": {
        const rect = svg("rect", { x: mark.at[0], y: mark.at[1], width: 0, height: mark.h, rx: 3, fill: mark.color, "fill-opacity": 0.42, style: "mix-blend-mode:multiply" });
        group.appendChild(rect);
        tween(seconds, (t) => rect.setAttribute("width", mark.w * t), easeInOut);
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
      lesson.labelSvg.replaceChildren();
      lesson.buttonLayer.replaceChildren();
    }
    lesson.closeButton = null;
    lesson.papers = [];
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
    lesson.inkSvg.setAttribute("viewBox", `0 0 ${command.width} ${command.height}`);
    // The watchdog ended the last program, so its variables are gone. What it drew
    // can't be built on, so the new turn starts on a clean canvas.
    if (lesson.workerDead) wipe();
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
      case "lesson_line":
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
