// Clicky's lesson sandbox. Claude answers with a small JavaScript program:
//
//   step(1); say("A V8 has 8 cylinders."); const f = figure(40, 120, 640, 480, {title: "V8"});
//   const block = f.box({size: [2, 1, 4], mat: "iron"}); f.label(block, "Block");
//
// The program arrives over the network a few characters at a time. This worker
// cuts it into top-level statements, runs each one once as soon as it is whole,
// and sends the page "marks": plain data saying what to draw. Each mark belongs
// to the say() line it is drawn under, so the page can pace it to the voice.
//
// The program is model-written, so it runs here and nowhere else: no DOM, no
// network (the page's CSP covers workers and the APIs are removed below), and
// nothing it posts can do more than draw. The page kills the worker if it stops
// answering, so an endless loop can't take the overlay down with it.

// ---------------------------------------------------------------- lock the door
const post = self.postMessage.bind(self);
const listen = self.addEventListener.bind(self);
const onMessage = (handler) => listen("message", handler);
for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "Worker", "SharedWorker",
  "BroadcastChannel", "indexedDB", "caches", "navigator", "location", "postMessage", "addEventListener",
  "removeEventListener", "close", "RTCPeerConnection", "WebTransport"]) {
  try {
    for (let scope = self; scope && scope !== Object.prototype; scope = Object.getPrototypeOf(scope)) {
      if (Object.prototype.hasOwnProperty.call(scope, name)) {
        Object.defineProperty(scope, name, { value: undefined, configurable: false, writable: false });
      }
    }
  } catch (_) { /* a host object that refuses is covered by the CSP */ }
}

// ---------------------------------------------------------------- statement scanner
// Finds where top-level statements end in a stream of code. It only looks at
// structure (strings, comments, brackets), so it needs no parser. A wrong cut is
// repaired later: a piece that doesn't compile waits for the next one.
const CONTINUES_AFTER_BLOCK = /^(?:else\b|catch\b|finally\b|while\b|in\b|of\b|instanceof\b|[.,)?:+\-*/%=([<>&|^])/;
const CONTINUES_NEXT_LINE = /^[.,)?:+\-*/%=[<>&|^]/;
const OPEN_ENDED = /[=+\-*/%,&|?:(<[{.!~^>]$|\b(?:return|typeof|new|in|of|else|do|case|const|let|var)$/;
const REGEX_MAY_FOLLOW = /(?:^|[(,=:[!&|?{};+\-*%<>~^\n]|\b(?:return|typeof|case|in|of|do|else))\s*$/;

class StatementScanner {
  constructor() {
    this.code = "";
    this.position = 0;
    this.start = 0;
    this.depth = 0;
    this.mode = "code";
    this.quote = "";
    this.templates = [];
  }

  feed(text) {
    this.code += text;
    return this.scan(false);
  }

  finish() {
    const statements = this.scan(true);
    const rest = this.code.slice(this.start).trim();
    if (rest) statements.push(rest);
    this.start = this.code.length;
    return statements;
  }

  // The next significant text after `from`, or null when the stream hasn't got there yet.
  lookahead(from, finished) {
    const tail = this.code.slice(from).replace(/^(?:\s+|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)+/, "");
    if (tail === "" || /^\/[/*]/.test(tail)) return finished ? "" : null;
    // A short word might still grow into `else`; wait for a little more of it.
    if (!finished && /^[a-z]{1,8}$/.test(tail)) return null;
    return tail;
  }

  emit(end, statements) {
    const statement = this.code.slice(this.start, end);
    this.start = end;
    if (statement.replace(/\s|;/g, "")) statements.push(statement);
  }

  scan(finished) {
    const statements = [];
    const { code } = this;
    let i = this.position;
    for (; i < code.length; i++) {
      const ch = code[i];
      switch (this.mode) {
        case "line-comment":
          if (ch === "\n") this.mode = "code";
          continue;
        case "block-comment":
          if (ch === "/" && code[i - 1] === "*") this.mode = "code";
          continue;
        case "string":
          if (ch === "\\") i++;
          else if (ch === this.quote || ch === "\n") this.mode = "code";
          continue;
        case "template":
          if (ch === "\\") i++;
          else if (ch === "`") this.mode = "code";
          else if (ch === "$" && code[i + 1] === "{") {
            this.templates.push(this.depth);
            this.depth++;
            this.mode = "code";
            i++;
          }
          continue;
        case "regex":
          if (ch === "\\") i++;
          else if (ch === "[") this.mode = "regex-class";
          else if (ch === "/" || ch === "\n") this.mode = "code";
          continue;
        case "regex-class":
          if (ch === "\\") i++;
          else if (ch === "]") this.mode = "regex";
          continue;
        default:
      }
      if (ch === '"' || ch === "'") { this.mode = "string"; this.quote = ch; continue; }
      if (ch === "`") { this.mode = "template"; continue; }
      if (ch === "/") {
        if (code[i + 1] === undefined && !finished) break;
        if (code[i + 1] === "/") { this.mode = "line-comment"; i++; continue; }
        if (code[i + 1] === "*") { this.mode = "block-comment"; i++; continue; }
        if (REGEX_MAY_FOLLOW.test(code.slice(Math.max(this.start, i - 12), i))) this.mode = "regex";
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") { this.depth++; continue; }
      if (ch === ")" || ch === "]") { this.depth = Math.max(0, this.depth - 1); continue; }
      if (ch === "}") {
        const depthAfter = Math.max(0, this.depth - 1);
        if (this.templates.length && this.templates[this.templates.length - 1] === depthAfter) {
          this.depth = depthAfter;
          this.templates.pop();
          this.mode = "template";
          continue;
        }
        if (depthAfter === 0) {
          const next = this.lookahead(i + 1, finished);
          if (next === null) break; // Retried from this same character once more arrives.
          this.depth = 0;
          if (!CONTINUES_AFTER_BLOCK.test(next) && !next.startsWith(";")) this.emit(i + 1, statements);
          continue;
        }
        this.depth = depthAfter;
        continue;
      }
      if (this.depth !== 0) continue;
      if (ch === ";") {
        // `if (a) b(); else c();` is one statement.
        if (/^\s*if\b/.test(code.slice(this.start, i))) {
          const next = this.lookahead(i + 1, finished);
          if (next === null) break;
          if (/^else\b/.test(next)) continue;
        }
        this.emit(i + 1, statements);
        continue;
      }
      if (ch === "\n") {
        const before = code.slice(this.start, i).trimEnd();
        if (!before || OPEN_ENDED.test(before)) continue;
        const next = this.lookahead(i + 1, finished);
        if (next === null) break;
        if (next !== "" && !CONTINUES_NEXT_LINE.test(next) && !/^(?:else|catch|finally)\b/.test(next)) this.emit(i + 1, statements);
      }
    }
    this.position = i;
    return statements;
  }
}

// Top-level const/let become var so names outlive their statement (and the turn:
// a follow-up question keeps building on `f`).
function hoistDeclarations(statement) {
  const leading = /^(?:\s+|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/.exec(statement)[0];
  const body = statement.slice(leading.length);
  if (/^(?:const|let)\s/.test(body)) return leading + "var " + body.replace(/^(?:const|let)\s+/, "");
  const classDeclaration = /^class\s+([A-Za-z_$][\w$]*)/.exec(body);
  if (classDeclaration) return `${leading}var ${classDeclaration[1]} = ${body}`;
  return statement;
}

function declaredName(statement) {
  const match = /^(?:\s+|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(statement);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------- session state
const MAX_MARKS = 12000;
const session = {
  W: 1280, H: 720,
  tiles: null,
  ink: "#3380FF",
  marks: [],
  statements: [],        // {text, first, last} per top-level statement that drew something
  outbox: [],
  line: -1,              // the say() line now being written
  stepHasLine: false,
  waiting: [],           // marks of this step that came before its first say()
  ticks: new Map(),
  running: new Map(),    // tick id -> start time
  poses: {},
  readouts: {},
  inTick: false,
  namedNext: null,
  byName: new Map(),
  papers: [],
  figures: [],
  pills: [],
  turn: 0,
  stages: 0,
};

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const vec3 = (value, fallback) => (Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every(finite)
  ? [value[0], value[1], value[2]] : fallback);
const warn = (message) => session.outbox.push({ kind: "warn", message: String(message).slice(0, 300) });

function flushWaiting(line) {
  for (const mark of session.waiting) {
    mark.line = line;
    session.outbox.push({ kind: "mark", mark });
  }
  session.waiting = [];
}

function push(mark, options) {
  if (session.marks.length >= MAX_MARKS) throw new Error(`too many marks (the limit is ${MAX_MARKS})`);
  if (options && typeof options === "object") Object.assign(mark, options);
  mark.id = `m${session.marks.length}`;
  if (session.namedNext && !mark.name) { mark.name = session.namedNext; session.namedNext = null; }
  if (mark.name) session.byName.set(mark.name, mark.id);
  session.marks.push(mark);
  if (session.stepHasLine) {
    mark.line = session.line;
    session.outbox.push({ kind: "mark", mark });
  } else {
    session.waiting.push(mark);
  }
  return mark;
}

// ---------------------------------------------------------------- what's under a spot of the screen
function tileAt(x, y) {
  const tiles = session.tiles;
  if (!tiles) return null;
  const column = Math.max(0, Math.min(tiles.columns - 1, Math.floor(x / tiles.size)));
  const row = Math.max(0, Math.min(tiles.rows - 1, Math.floor(y / tiles.size)));
  const index = row * tiles.columns + column;
  return { luminance: tiles.luminance[index], busy: tiles.busy[index] };
}

// Words or controls in 8% of a box's tiles or more means it's busy. A few words
// show through a calm area, and an average would miss them.
function boxIsBusy(x, y, w, h) {
  const tiles = session.tiles;
  if (!tiles) return true;
  let busy = 0, total = 0;
  for (let ty = y + tiles.size / 2; ty < y + h; ty += tiles.size) {
    for (let tx = x + tiles.size / 2; tx < x + w; tx += tiles.size) {
      total++;
      if (tileAt(tx, ty).busy) busy++;
    }
  }
  return total > 0 && busy / total >= 0.08;
}

const PAPER_INK = "#30333A";
const inPaper = (x, y) => session.papers.some((p) => !p.erased && x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h);
function inkAt(x, y) {
  if (inPaper(x, y)) return PAPER_INK;
  const tile = tileAt(x, y);
  if (!tile) return "#FFFFFF";
  return tile.luminance > 150 ? "#15171C" : "#FFFFFF";
}

// ---------------------------------------------------------------- the drawing language
const TONES = {
  ink: PAPER_INK, white: "#FFFFFF", grey: "#7E838D", gray: "#7E838D", black: "#15171C", butter: "#FFD84D", yellow: "#FFD84D",
  sun: "#FFB930", orange: "#FF9A3C", peach: "#FFB59A", coral: "#F2706B", red: "#E5484D", pink: "#F59AB5", lilac: "#A897F5",
  purple: "#6E5BD8", violet: "#6E5BD8", sky: "#5AA8F5", blue: "#1F5FCC", mint: "#7ED6A0", green: "#3E9E5C", leaf: "#3E9E5C",
  brown: "#A0673D", tan: "#D9A877", cream: "#FFF3D6",
};
// In 3D the same names mean what a real object of that colour looks like; bright
// tones read as toys under studio light.
const REAL_TONES = {
  ink: "#2C2E33", white: "#E8E6E1", grey: "#8B8E93", gray: "#8B8E93", black: "#1E2023", butter: "#E0C477", yellow: "#D6A83C",
  sun: "#D6A83C", orange: "#C9692E", peach: "#D8A287", coral: "#C1604F", red: "#A8352D", pink: "#C7848F", lilac: "#9E92C0",
  purple: "#5D4D90", violet: "#5D4D90", sky: "#8AAFCC", blue: "#2F5689", mint: "#94BCA2", green: "#53794A", leaf: "#53794A",
  brown: "#6D4A2F", tan: "#B9946F", cream: "#E4D9C2",
};
// Secondary words: grey on paper, but grey doesn't read over an arbitrary screen.
const quietInk = (x, y) => (inPaper(x, y) ? TONES.grey : inkAt(x, y));
const tone = (name, fallback) => TONES[name] || name || fallback;
const realTone = (name, fallback) => REAL_TONES[name] || name || fallback;

function styled(options, inkFallback) {
  const o = Object.assign({}, options);
  if (o.tone && !o.color) o.color = o.tone;
  o.color = tone(o.color, inkFallback);
  if (o.fill) o.fill = o.fill === true ? o.color : tone(o.fill);
  return o;
}

const firstPoint = (pts) => (Array.isArray(pts) && Array.isArray(pts[0]) ? pts[0] : [0, 0]);

const api = {
  W: 0, H: 0, PI: Math.PI, TAU: Math.PI * 2,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, abs: Math.abs, min: Math.min, max: Math.max, sqrt: Math.sqrt, round: Math.round,
  floor: Math.floor, ceil: Math.ceil, trunc: Math.trunc, sign: Math.sign, pow: Math.pow, exp: Math.exp, log: Math.log,
  log2: Math.log2, log10: Math.log10, hypot: Math.hypot, atan2: Math.atan2, atan: Math.atan, asin: Math.asin, acos: Math.acos,
  range: (n) => Array.from({ length: n }, (_, i) => i),
  lerp: (a, b, t) => a + (b - a) * t,
  polar: (cx, cy, r, a) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r],
  mid: (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
  along: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
  dist: (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]),

  step() {
    // A step with no line of its own joins the line before it.
    if (session.waiting.length) flushWaiting(session.line);
    session.stepHasLine = false;
  },
  say(text) {
    const line = String(text == null ? "" : text).trim().slice(0, 600);
    if (!line) return;
    session.line += 1;
    session.outbox.push({ kind: "say", k: session.line, text: line });
    flushWaiting(session.line);
    session.stepHasLine = true;
  },
  seen() {}, noted() {}, plan() {}, lessonTitle() {}, waitForUser() {}, task() {}, onScreen() {},

  // ---- pen strokes
  line: (pts, o) => push({ do: "line", pts }, styled(o, inkAt(...firstPoint(pts)))),
  curve: (pts, o) => push({ do: "line", pts, smooth: true }, styled(o, inkAt(...firstPoint(pts)))),
  arrow: (pts, o) => push({ do: "arrow", pts }, styled(o, inkAt(...firstPoint(pts)))),
  circle: (x, y, r, o) => push({ do: "circle", at: [x, y], r }, styled(o, inkAt(x, y))),
  ellipse: (x, y, rx, ry, o) => push({ do: "ellipse", at: [x, y], rx, ry }, styled(o, inkAt(x, y))),
  rect: (x, y, w, h, o) => push({ do: "rect", at: [x, y], w, h }, styled(o, inkAt(x, y))),
  poly: (pts, o) => push({ do: "poly", pts }, styled(o, inkAt(...firstPoint(pts)))),
  path: (d, o) => push({ do: "path", d: String(d) }, styled(o, PAPER_INK)),
  dot: (x, y, r, o) => push({ do: "dot", at: [x, y], r: finite(r) ? r : 4 }, styled(o, inkAt(x, y))),
  text: (x, y, words, o) => push({ do: "text", at: [x, y], text: String(words == null ? "" : words) }, styled(o, inkAt(x, y))),
  write: (x, y, words, o) => api.text(x, y, words, o),
  highlight(a, b, c, d, o) {
    if (typeof a === "string" || isTarget(a)) return edit("highlight", a, { color: tone(b, TONES.butter) });
    return push({ do: "highlight", at: [a, b], w: c, h: d }, styled(o, TONES.butter));
  },

  // ---- naming and marking real things on the screen
  label(x, y, words, o) { return placePill(x, y, words, o); },
  tag: (x, y, words) => placePill(x, y, words),
  point(x, y, name) {
    const mark = push({ do: "circle", at: [x, y], r: 16, role: "point", flies: true }, { color: session.ink, size: 3.5, glow: true, taper: 0 });
    if (name) pillBeside([x - 16, y - 16, 32, 32], name);
    return mark;
  },
  target(x, y, w, h, name) {
    let mark;
    if (h === undefined || typeof h === "string") {
      const r = typeof w === "number" ? w : 18;
      mark = api.ring(x - r, y - r, 2 * r, 2 * r, typeof w === "string" ? w : h);
    } else {
      mark = api.ring(x, y, w, h, name);
    }
    mark.flies = true;
    return mark;
  },
  hover: (x, y, w, h, name) => api.target(x, y, w, h, name),
  ring(x, y, w, h, name, o) {
    const corner = o && finite(o.r) ? o.r : (h < 44 || w < 44 ? Math.min(w, h) / 2 + 4 : 14);
    const mark = push({ do: "rect", at: [x - 4, y - 4], w: w + 8, h: h + 8, r: corner, role: "ring" }, { color: session.ink, size: 3.5, glow: true, taper: 0 });
    if (name) pillBeside([x - 4, y - 4, w + 8, h + 8], name);
    return mark;
  },
  frame(x, y, w, h, name, o) {
    const corner = o && finite(o.r) ? o.r : 10;
    const mark = push({ do: "rect", at: [x, y], w, h, r: corner, role: "frame", dash: true }, { color: session.ink, size: 2.5, fill: session.ink, fillAlpha: 0.09 });
    if (name) pillBeside([x, y, w, h], name);
    return mark;
  },
  ink: (pts, o) => push({ do: (o && o.arrow) ? "arrow" : "line", pts, smooth: true }, Object.assign({ color: session.ink, size: 3.5, glow: true, taper: 0 }, o && o.color ? { color: tone(o.color) } : {}, o && o.bend ? { bend: o.bend } : {})),
  num(x, y, n, o) { return push({ do: "badge", at: [x, y], text: String(n) }, Object.assign({ color: session.ink }, o)); },
  underline: (x, y, w, o) => push({ do: "line", pts: [[x, y + 4], [x + w, y + 4]] }, Object.assign({ color: session.ink, size: 3 }, o && styled(o, session.ink))),
  strike: (x, y, w, o) => push({ do: "line", pts: [[x, y], [x + w, y]] }, styled(o, TONES.red)),
  connect(a, b, o) {
    o = o || {};
    const mark = push({ do: "arrow", pts: [a, b], bend: finite(o.bend) ? o.bend : 0.2 }, { color: o.color ? tone(o.color) : session.ink, size: 3 });
    if (o.label) pillBeside([(a[0] + b[0]) / 2 - 6, (a[1] + b[1]) / 2 - 6, 12, 12], o.label);
    return mark;
  },
  trace(pts, o) {
    o = o || {};
    const mark = push({ do: "poly", pts, smooth: !o.straight }, { color: session.ink, size: 3, glow: true, fill: o.fill ? session.ink : undefined, fillAlpha: 0.1 });
    if (o.label) { const p = firstPoint(pts); pillBeside([p[0] - 6, p[1] - 6, 12, 12], o.label); }
    return mark;
  },
  check: (x, y, o) => push({ do: "line", pts: [[x, y], [x + 7, y + 8], [x + 21, y - 12]] }, styled(o, TONES.leaf)),
  cross(x, y, o) {
    const style = Object.assign(styled(o, TONES.red), { together: true });
    push({ do: "line", pts: [[x - 8, y - 8], [x + 8, y + 8]] }, style);
    return push({ do: "line", pts: [[x + 8, y - 8], [x - 8, y + 8]] }, styled(o, TONES.red));
  },
  scroll(x, y, direction, name) {
    const s = direction === "up" ? -1 : 1;
    for (const offset of [0, 14]) push({ do: "line", pts: [[x - 12, y + offset - 6 * s], [x, y + offset + 6 * s], [x + 12, y + offset - 6 * s]] }, { color: session.ink, size: 3.5, glow: true, taper: 0 });
    if (name) pillBeside([x - 14, y - 10, 28, 34], name);
  },
  cheer: (x, y, face) => placePill(x, y, face || "(^_^)v"),
  spotlight: (x, y, w, h, o) => push({ do: "spotlight", at: [x, y], w, h }, o),

  // ---- paper
  paper(x, y, w, h, o) {
    o = o || {};
    const box = stepAsideFromFigures(x, y, w, h);
    x = box[0]; y = box[1];
    session.papers.push({ x, y, w, h });
    const bar = 34, pad = 24;
    push({ do: "window", at: [x, y], w, h, title: o.title ? String(o.title) : "", role: "paper", color: o.color ? tone(o.color) : undefined });
    let cursor = y + bar + 8;
    if (o.heading) { cursor += 30; push({ do: "text", at: [x + pad, cursor], text: String(o.heading), size: 30, weight: 700, color: PAPER_INK, fit: [w - 2 * pad, 80], role: "heading" }); }
    if (o.subtitle) { cursor += 25; push({ do: "text", at: [x + pad, cursor], text: String(o.subtitle), size: 18, color: TONES.grey, fit: [w - 2 * pad, 60], role: "subtitle" }); }
    return { x: x + pad, y: cursor + 18, w: w - 2 * pad, h: y + h - cursor - 18 - pad, box: [x, y, w, h], kind: "paper" };
  },
  sticky(x, y, words, color, o) {
    o = o || {};
    const fills = { butter: "#FFE27A", mint: "#BFEFCF", peach: "#FFD0BC", lilac: "#D9D1FB", sky: "#CFE6FF", white: "#FAF5EA" };
    const w = finite(o.w) ? o.w : 220;
    const h = finite(o.h) ? o.h : Math.max(90, 46 + Math.ceil(String(words).length / (w / 11)) * 26);
    session.papers.push({ x, y, w, h });
    push({ do: "rect", at: [x, y], w, h, r: 4, outline: false, fill: fills[color] || fills.butter, fillAlpha: 1, shadow: true, role: "paper", snd: "sticky-press", together: true });
    return push({ do: "text", at: [x + 16, y + 34], text: String(words), size: 21, color: PAPER_INK, fit: [w - 32, h - 40] });
  },
  receipt(x, y, title, items, o) {
    o = o || {};
    const rows = (items || []).map((item) => (Array.isArray(item) ? item : [item, ""]));
    const w = finite(o.w) ? o.w : 300;
    const h = 92 + rows.length * 28;
    session.papers.push({ x, y, w, h });
    push({ do: "rect", at: [x, y], w, h, r: 3, outline: false, fill: "#FAF5EA", fillAlpha: 1, shadow: true, role: "paper", snd: "paper-place" });
    push({ do: "text", at: [x + w / 2, y + 38], text: String(title), size: 24, weight: 700, anchor: "middle", color: PAPER_INK });
    push({ do: "line", pts: [[x + 16, y + 54], [x + w - 16, y + 54]], dash: true, size: 1.5, color: TONES.grey });
    rows.forEach((row, index) => {
      const rowY = y + 82 + index * 28;
      push({ do: "text", at: [x + 18, rowY], text: String(row[0]), size: 19, color: PAPER_INK, together: true });
      push({ do: "text", at: [x + w - 18, rowY], text: String(row[1]), size: 19, anchor: "end", color: PAPER_INK });
    });
    return { x, y, w, h, box: [x, y, w, h], kind: "paper" };
  },
  clipping(x, y, w, title, body, source) {
    const lines = Math.ceil(String(body || "").length / (w / 9));
    const h = 92 + lines * 24 + (source ? 28 : 0);
    session.papers.push({ x, y, w, h });
    push({ do: "rect", at: [x, y], w, h, r: 2, outline: false, fill: "#F3EEE4", fillAlpha: 1, shadow: true, role: "paper", snd: "paper-place" });
    push({ do: "text", at: [x + 18, y + 40], text: String(title), size: 28, weight: 700, color: PAPER_INK, fit: [w - 36, 76], font: "serif" });
    push({ do: "text", at: [x + 18, y + 72], text: String(body || ""), size: 18, color: PAPER_INK, fit: [w - 36, lines * 26], font: "serif" });
    if (source) push({ do: "text", at: [x + 18, y + h - 16], text: String(source), size: 15, color: TONES.grey });
    return { x, y, w, h, box: [x, y, w, h], kind: "paper" };
  },
  legend(x, y, items) {
    (items || []).forEach((item, index) => {
      const [color, words] = Array.isArray(item) ? item : [item.color, item.text];
      push({ do: "rect", at: [x, y + index * 28 - 13], w: 18, h: 18, r: 4, fill: tone(color), fillAlpha: 1, outline: false, together: true });
      push({ do: "text", at: [x + 28, y + index * 28], text: String(words), size: 19, color: inkAt(x + 28, y) });
    });
  },
  table(x, y, rows, o) {
    o = o || {};
    const widths = o.widths || [];
    const rowHeight = finite(o.rowHeight) ? o.rowHeight : 30;
    (rows || []).forEach((row, rowIndex) => {
      let cellX = x;
      (row || []).forEach((cell, cellIndex) => {
        const header = rowIndex === 0 && o.header !== false;
        push({ do: "text", at: [cellX, y + rowIndex * rowHeight], text: String(cell), size: finite(o.size) ? o.size : 19, weight: header ? 700 : 400, color: tone(o.color, inkAt(x, y)), together: cellIndex < row.length - 1 });
        cellX += finite(widths[cellIndex]) ? widths[cellIndex] : 160;
      });
      if (rowIndex === 0 && o.header !== false) {
        const total = widths.length ? widths.reduce((a, b) => a + b, 0) : 160 * row.length;
        push({ do: "line", pts: [[x, y + 9], [x + total - 16, y + 9]], size: 1.5, color: TONES.grey });
      }
    });
  },

  // ---- real pictures, credits, buttons
  photo(x, y, w, h, query, caption, o) {
    o = o || {};
    const tilt = finite(o.tilt) ? o.tilt : ((session.marks.length % 2 ? 1 : -1) * 2.2);
    const mark = push({ do: "image", at: [x, y], w, h, query: String(query || "").slice(0, 80), caption: caption ? String(caption) : "", tilt, snd: "photo-drop" });
    return { x, y, w, h, box: [x, y, w, h], id: mark.id, kind: "photo" };
  },
  image: (x, y, w, h, o) => api.photo(x, y, w, h, o && o.query, o && o.caption, o),
  tie(from, to, o) {
    const box = Array.isArray(to) ? to : to && to.box;
    if (!Array.isArray(box)) return null;
    const center = [box[0] + box[2] / 2, box[1] + box[3] / 2];
    const dx = center[0] - from[0], dy = center[1] - from[1];
    const reach = Math.min(Math.abs(dx) > 1 ? (box[2] / 2 + 8) / Math.abs(dx) : 1, Math.abs(dy) > 1 ? (box[3] / 2 + 8) / Math.abs(dy) : 1, 1);
    return push({ do: "arrow", pts: [from, [center[0] - dx * reach, center[1] - dy * reach]], bend: o && finite(o.bend) ? o.bend : 0.15 }, { color: inkAt(from[0], from[1]), size: 2.5 });
  },
  source: (x, y, domain, words, o) => push({ do: "text", at: [x, y], text: words ? `${domain} · ${words}` : String(domain), size: (o && o.size) || 15, color: quietInk(x, y) }),
  sources(x, y, list, o) {
    o = o || {};
    const names = [...new Set((list || []).map((item) => (Array.isArray(item) ? (item[1] || item[0]) : item)))];
    return push({ do: "text", at: [x, y], text: `Sources: ${names.join(" · ")}`, size: o.size || 15, color: quietInk(x, y), fit: o.maxWidth ? [o.maxWidth, 60] : undefined });
  },
  button(x, y, words, action) {
    if (typeof x === "object" && x !== null) {
      const box = Array.isArray(x) ? x : x.box;
      action = words; words = y;
      x = box[0] + box[2] / 2 - 90; y = box[1] + box[3] - 24;
    }
    action = action && typeof action === "object" ? action : {};
    const allowed = {};
    if (typeof action.ask === "string") allowed.ask = action.ask.slice(0, 500);
    if (typeof action.open === "string" && /^https?:\/\//i.test(action.open)) allowed.open = action.open.slice(0, 2000);
    if (typeof action.copy === "string") allowed.copy = action.copy.slice(0, 20000);
    return push({ do: "button", at: [x, y], text: String(words == null ? "" : words).slice(0, 60), action: allowed });
  },
  copyText: (words) => { warn(`copyText ignored; offer a button instead: ${String(words).slice(0, 40)}`); },
  typeText: () => warn("typeText isn't available on this desktop; offer a {copy} button instead."),
  openPage: (url) => warn(`openPage ignored; offer an {open} button instead: ${String(url).slice(0, 60)}`),
  handOff: () => warn("handOff isn't available on this desktop."),

  // ---- charts in data units
  graph(x, y, w, h, o) {
    o = o || {};
    const xRange = o.x || [0, 10], yRange = o.y || [0, 10];
    const left = x + 44, bottom = y + h - 34, plotW = w - 56, plotH = h - 50;
    const toPx = (dx, dy) => [left + ((dx - xRange[0]) / (xRange[1] - xRange[0])) * plotW, bottom - ((dy - yRange[0]) / (yRange[1] - yRange[0])) * plotH];
    const ink = tone(o.color, inkAt(x, y));
    if (o.title) push({ do: "text", at: [x, y + 2], text: String(o.title), size: 22, weight: 700, color: ink });
    push({ do: "arrow", pts: [[left, bottom], [left, bottom - plotH - 6]], size: 2.5, color: ink, together: true });
    push({ do: "arrow", pts: [[left, bottom], [left + plotW + 6, bottom]], size: 2.5, color: ink });
    if (o.xlabel) push({ do: "text", at: [left + plotW / 2, bottom + 28], text: String(o.xlabel), size: 17, anchor: "middle", color: quietInk(x, y) });
    if (o.ylabel) push({ do: "text", at: [x + 4, bottom - plotH - 12], text: String(o.ylabel), size: 17, color: quietInk(x, y) });
    const ticks = (range, count) => Array.from({ length: count + 1 }, (_, i) => range[0] + ((range[1] - range[0]) * i) / count);
    if (o.ticks !== false) {
      for (const value of ticks(xRange, 4)) { const [px] = toPx(value, yRange[0]); push({ do: "text", at: [px, bottom + 16], text: shortNumber(value), size: 13, anchor: "middle", color: quietInk(x, y), together: true }); }
      for (const value of ticks(yRange, 4)) { const [, py] = toPx(xRange[0], value); push({ do: "text", at: [left - 6, py + 4], text: shortNumber(value), size: 13, anchor: "end", color: quietInk(x, y), together: true }); }
    }
    return {
      at: toPx,
      curve(source, style) {
        style = style || {};
        const points = typeof source === "function"
          ? Array.from({ length: 49 }, (_, i) => { const dx = xRange[0] + ((xRange[1] - xRange[0]) * i) / 48; return toPx(dx, source(dx)); })
          : (source || []).map((p) => toPx(p[0], p[1]));
        const mark = push({ do: "line", pts: points, smooth: typeof source === "function" || style.smooth === true }, { color: tone(style.color, TONES.blue), size: style.size || 3, dash: style.dash });
        if (style.label) { const end = points[points.length - 1]; push({ do: "text", at: [end[0] + 6, end[1]], text: String(style.label), size: 18, color: mark.color }); }
        return mark;
      },
      point(dx, dy, style) {
        style = style || {};
        const [px, py] = toPx(dx, dy);
        const mark = push({ do: "dot", at: [px, py], r: style.r || 5, color: tone(style.color, TONES.red) });
        if (style.label) push({ do: "text", at: [px + 10, py - 8], text: String(style.label), size: 18, color: ink });
        return mark;
      },
    };
  },
  bars(x, y, w, h, rows, o) {
    o = o || {};
    const data = (rows || []).map((row) => (Array.isArray(row) ? row : [row.label, row.value]));
    const top = Math.max(...data.map((row) => +row[1] || 0), 1e-9);
    const slot = w / Math.max(1, data.length);
    const bottom = y + h - 26;
    const ink = inkAt(x, y);
    push({ do: "line", pts: [[x, bottom], [x + w, bottom]], size: 2.5, color: ink });
    data.forEach((row, index) => {
      const barH = ((+row[1] || 0) / top) * (h - 56);
      const barX = x + index * slot + slot * 0.18, barW = slot * 0.64;
      push({ do: "rect", at: [barX, bottom - barH], w: barW, h: barH, fill: tone(row[2] || o.color, TONES.sky), fillAlpha: 0.85, color: ink, size: 2 });
      push({ do: "text", at: [barX + barW / 2, bottom - barH - 8], text: shortNumber(+row[1]) + (o.unit || ""), size: 17, anchor: "middle", color: ink, together: true });
      push({ do: "text", at: [barX + barW / 2, bottom + 20], text: String(row[0]), size: 16, anchor: "middle", color: quietInk(x, y) });
    });
  },
  timeline(x, y, w, marks, o) {
    o = o || {};
    const list = marks || [];
    const ink = inkAt(x, y);
    const at = (value, index) => {
      if (o.from !== undefined && finite(+value)) return x + ((+value - o.from) / (o.to - o.from)) * w;
      return x + (list.length > 1 ? (index / (list.length - 1)) * w : w / 2);
    };
    push({ do: "arrow", pts: [[x - 10, y], [x + w + 22, y]], size: 2.5, color: ink });
    list.forEach((item, index) => {
      const [when, words] = Array.isArray(item) ? item : [item.at, item.text];
      const px = at(when, index), above = index % 2 === 0;
      push({ do: "dot", at: [px, y], r: 6, color: TONES.coral, together: true });
      push({ do: "text", at: [px, y + (above ? -34 : 30)], text: String(when), size: 19, weight: 700, anchor: "middle", color: ink, together: true });
      push({ do: "text", at: [px, y + (above ? -12 : 52)], text: String(words), size: 17, anchor: "middle", color: quietInk(x, y) });
    });
  },

  // ---- changing what's already there. Ids are m3, m3-m9, p2 (a whole statement), a name or a handle.
  erase: (target) => edit("erase", target),
  recolor: (target, color) => edit("recolor", target, { color: tone(color) }),
  restyle: (target, style) => edit("restyle", target, styled(style)),
  moveMark: (target, dx, dy) => edit("move", target, { dx, dy }),
  scaleMark: (target, factor) => edit("scale", target, { factor }),
  undo: () => edit("undo", null),
  clear() {
    for (const paper of session.papers) paper.erased = true;
    for (const mark of session.marks) mark.erased = true;
    session.figures.length = 0;
    session.pills.length = 0;
    return push({ do: "edit", op: "clear" });
  },
  startOver: () => api.clear(),
  sfx: (name) => push({ do: "sound", name: String(name) }),
  figure: (x, y, w, h, o) => makeFigure(x, y, w, h, o),
  scene3d(x, y, w, h, build, o) {
    const figure = makeFigure(x, y, w, h, o);
    if (figure && typeof build === "function") build(figure);
    return figure;
  },
};

function shortNumber(value) {
  if (!finite(value)) return String(value);
  const size = Math.abs(value);
  if (size >= 1e6) return `${+(value / 1e6).toFixed(1)}M`;
  if (size >= 1e4) return `${+(value / 1e3).toFixed(1)}k`;
  return String(+value.toFixed(2));
}

// ---- pills
function pillBox(x, y, words) { return [x, y, String(words).length * 7.6 + 24, 28]; }
const overlaps = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
function placePill(x, y, words, o) {
  const box = pillBox(x, y, words);
  session.pills.push(box);
  return push({ do: "pill", at: [x, y], text: String(words).slice(0, 60) }, Object.assign({ color: session.ink }, o));
}
// Beside the mark it names on the calmest free spot, never on another pill.
function pillBeside(box, words) {
  const size = pillBox(0, 0, words);
  const candidates = [
    [box[0] + box[2] / 2 - size[2] / 2, box[1] - size[3] - 8],
    [box[0] + box[2] / 2 - size[2] / 2, box[1] + box[3] + 8],
    [box[0] + box[2] + 8, box[1] + box[3] / 2 - size[3] / 2],
    [box[0] - size[2] - 8, box[1] + box[3] / 2 - size[3] / 2],
  ];
  const fits = ([x, y]) => x >= 4 && y >= 4 && x + size[2] <= session.W - 4 && y + size[3] <= session.H - 4;
  const clear = ([x, y]) => !session.pills.some((pill) => overlaps(pill, [x, y, size[2], size[3]]));
  const score = (spot) => (fits(spot) ? 0 : 100) + (clear(spot) ? 0 : 50)
    + (tileAt(spot[0] + size[2] / 2, spot[1] + size[3] / 2)?.busy ? 10 : 0);
  const best = candidates.map((spot, order) => ({ spot, rank: score(spot) + order })).sort((a, b) => a.rank - b.rank)[0].spot;
  return placePill(best[0], best[1], words);
}

function stepAsideFromFigures(x, y, w, h) {
  for (const figure of session.figures) {
    if (!overlaps([x, y, w, h], figure) || figure.onPaper) continue;
    const right = figure[0] + figure[2] + 12;
    const left = figure[0] - w - 12;
    if (right + w <= session.W) x = right;
    else if (left >= 0) x = left;
  }
  return [Math.max(4, Math.min(session.W - w - 4, x)), Math.max(4, Math.min(session.H - h - 4, y))];
}

// ---- edits
const isTarget = (value) => value && typeof value === "object" && (typeof value.id === "string" || Array.isArray(value));
function resolveIds(target) {
  const ids = new Set();
  const addRange = (from, to) => { for (let n = from; n <= to && n < session.marks.length; n++) ids.add(`m${n}`); };
  const visit = (value) => {
    if (value == null) return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (typeof value === "object") { if (typeof value.id === "string") visit(value.id); return; }
    for (const token of String(value).split(",").map((piece) => piece.trim()).filter(Boolean)) {
      let match;
      if ((match = /^m(\d+)-m?(\d+)$/.exec(token))) addRange(+match[1], +match[2]);
      else if ((match = /^m(\d+)$/.exec(token))) addRange(+match[1], +match[1]);
      else if ((match = /^p(\d+)$/.exec(token))) {
        const statement = session.statements[+match[1] - 1];
        if (statement) addRange(statement.first, statement.last);
      } else if (session.byName.has(token)) ids.add(session.byName.get(token));
      else if (/^st\d+p?\d*/.test(token)) ids.add(token);
    }
  };
  visit(target);
  return [...ids];
}
function edit(op, target, fields) {
  const ids = target === null ? [] : resolveIds(target);
  if (op === "erase") {
    for (const id of ids) {
      const mark = session.marks[+id.slice(1)];
      if (mark) mark.erased = true;
      if (mark && mark.do === "window") {
        const paper = session.papers.find((p) => p.x === mark.at[0] && p.y === mark.at[1]);
        if (paper) paper.erased = true;
      }
    }
  }
  return push(Object.assign({ do: "edit", op, ids }, fields));
}

// ---------------------------------------------------------------- 3D figures
const PLACE_KEYS = new Set(["at", "pos", "rot", "rotate", "scale", "parent", "name", "mat", "from", "to", "mirror", "copies", "around", "cut",
  "color", "roughness", "metalness", "opacity", "glow", "emissive", "double"]);
const PART_KINDS = ["box", "cyl", "cylinder", "cone", "tube", "lathe", "sphere", "torus", "capsule", "pipe", "spring", "gear", "extrude", "blob", "poly"];
const MATERIAL_KINDS = new Set(["steel", "alu", "aluminum", "aluminium", "titanium", "chrome", "brass", "copper", "gold", "iron", "black", "rubber", "glass",
  "water", "wood", "ceramic", "paper", "gloss", "paint", "plastic", "soft", "matte", "metal", "glow"]);
const AXIS_WORDS = { x: [1, 0, 0], "+x": [1, 0, 0], "-x": [-1, 0, 0], y: [0, 1, 0], "+y": [0, 1, 0], "-y": [0, -1, 0], z: [0, 0, 1], "+z": [0, 0, 1], "-z": [0, 0, -1] };
const axisOf = (value, fallback) => {
  if (typeof value === "string") return AXIS_WORDS[value.trim().toLowerCase()] || fallback;
  return vec3(value, fallback);
};
const degrees = (radians) => (radians * 180) / Math.PI;

function makeFigure(x, y, w, h, options) {
  const o = options || {};
  if (![x, y, w, h].every(finite) || w < 24 || h < 24) { warn("figure() needs x, y, width and height in pixels"); return null; }
  const stage = `st${++session.stages}`;
  const onPaper = session.papers.some((p) => !p.erased && x + w / 2 >= p.x && x + w / 2 <= p.x + p.w && y + h / 2 >= p.y && y + h / 2 <= p.y + p.h);
  const cardWanted = o.card !== undefined ? !!o.card : boxIsBusy(x, y, w, h);
  const card = !onPaper && cardWanted;
  const box = [x, y, w, h];
  box.onPaper = onPaper;
  session.figures.push(box);
  if (card) session.papers.push({ x, y, w, h });
  // A figure sitting still doesn't feel 3D, so it always turns at least slowly.
  const spin = Math.min(2, Math.max(0.5, finite(o.spin) ? o.spin : 0.7));
  push({
    do: "stage3d", stage, at: [x, y], w, h, card, onPaper,
    title: o.title ? String(o.title).slice(0, 80) : "",
    camera: { tilt: finite(o.tilt) ? Math.max(-80, Math.min(80, o.tilt)) : 15, turn: finite(o.turn) ? o.turn : 0, zoom: finite(o.zoom) ? o.zoom : 1, fov: finite(o.fov) ? o.fov : 35, spin },
    ink: card ? PAPER_INK : inkAt(x + w / 2, y + 12),
  });
  let partCount = 0, labelCount = 0, tickCount = 0, currentParent = null;

  const motion = (id, kind, fields) => push({ do: "motion3d", stage, target: id, kind, ...fields });
  const poseOf = (id) => session.poses[id] || (session.poses[id] = {});

  const makeHandle = (mark) => {
    const id = mark.partId;
    const planned = {};
    const setPose = (key, value, inBeat) => {
      if (session.inTick) poseOf(id)[key] = value;
      else { planned[key] = value; inBeat(); }
    };
    const current = (key) => { const pose = session.poses[id]; return pose && pose[key] !== undefined ? pose[key] : planned[key]; };
    const handle = {
      id: mark.id, partId: id, kind: "part", name: mark.name || null,
      spin(op) { op = op || {}; motion(id, "spin", { axis: axisOf(op.axis, [0, 1, 0]), period: finite(op.period) ? op.period : 6 }); return this; },
      bob(op) { op = op || {}; motion(id, "bob", { axis: axisOf(op.axis, [0, 1, 0]), amount: finite(op.amount) ? op.amount : 0.1, period: finite(op.period) ? op.period : 3 }); return this; },
      orbit(op) { op = op || {}; motion(id, "orbit", { axis: axisOf(op.axis, [0, 1, 0]), center: vec3(op.center, [0, 0, 0]), period: finite(op.period) ? op.period : 8 }); return this; },
      path(points, op) {
        op = op || {};
        const clean = (points || []).map((p) => vec3(p, null)).filter(Boolean);
        if (clean.length >= 2) motion(id, "path", { points: clean, closed: !op.once && op.closed !== false, once: !!op.once, period: finite(op.period) ? op.period : 6 });
        return this;
      },
      pulse(op) { op = op || {}; motion(id, "pulse", { amount: finite(op.amount) ? Math.max(-0.5, Math.min(0.5, op.amount)) : 0.08, period: finite(op.period) ? op.period : 1 }); return this; },
    };
    Object.defineProperties(handle, {
      pos: { enumerable: true, get: () => (current("pos") || mark.pos || [0, 0, 0]).slice(),
        set: (v) => { const p = vec3(v, null); if (p) setPose("pos", p, () => motion(id, "tween", { to: p, secs: 0.35 })); } },
      rot: { enumerable: true, get: () => (current("rot") || mark.rot || [0, 0, 0]).slice(),
        set: (v) => { const r = vec3(v, null); if (r) setPose("rot", r, () => motion(id, "tween", { rot: r, secs: 0.35 })); } },
      scale: { enumerable: true, get: () => { const s = current("scale"); return s !== undefined ? s : (mark.scale !== undefined ? mark.scale : 1); },
        set: (v) => { if (finite(v) || vec3(v, null)) setPose("scale", v, () => motion(id, "set", { scale: v })); } },
      show: { enumerable: true, get: () => current("show") !== false,
        set: (v) => setPose("show", !!v, () => motion(id, "set", { show: !!v })) },
      glow: { enumerable: true, get: () => current("glow") || 0,
        set: (v) => { if (finite(+v)) { const g = Math.max(0, Math.min(1, +v)); setPose("glow", g, () => motion(id, "set", { glow: g })); } } },
      color: { enumerable: true, get: () => current("color") || mark.material.color || null,
        set: (v) => { if (typeof v === "string" && v) { const c = realTone(v); setPose("color", c, () => motion(id, "set", { color: c })); } } },
    });
    return handle;
  };

  const part = (kind, params) => {
    const p = Object.assign({}, params);
    const partId = `${stage}p${++partCount}`;
    const material = {};
    for (const key of ["roughness", "metalness", "opacity", "double"]) if (p[key] !== undefined) material[key] = p[key];
    if (p.color) material.color = realTone(p.color);
    if (finite(p.glow)) material.glow = p.glow;
    if (p.emissive) material.emissive = tone(p.emissive);
    if (typeof p.mat === "string" && p.mat.trim()) {
      const [word, tint] = p.mat.trim().toLowerCase().split(":").map((piece) => piece.trim());
      const known = MATERIAL_KINDS.has(word);
      material.kind = known ? word : "gloss";
      const color = tint || (known ? null : word);
      if (color) material.color = word === "glow" ? tone(color) : realTone(color);
    }
    const shape = {};
    for (const key of Object.keys(p)) if (!PLACE_KEYS.has(key)) shape[key] = p[key];
    let pos = vec3(p.at, null) || vec3(p.pos, [0, 0, 0]);
    let rot = vec3(p.rot, null) || vec3(p.rotate, [0, 0, 0]);
    // cyl({from, to}) stands between two points.
    const from = vec3(p.from, null), to = vec3(p.to, null);
    if (from && to && ["cyl", "capsule", "cone", "tube"].includes(kind)) {
      const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]], length = Math.hypot(...d);
      if (length > 1e-6) { pos = from.map((c, i) => (c + to[i]) / 2); shape.h = length; shape.axis = d.map((c) => c / length); }
    }
    const parent = (p.parent && p.parent.partId) || currentParent;
    const scale = vec3(p.scale, null) || (finite(p.scale) ? p.scale : undefined);
    const mark = push({
      do: "part3d", stage, partId, kind, shape, pos, rot, scale, material, parent,
      name: typeof p.name === "string" && p.name.trim() ? p.name.trim().slice(0, 40) : undefined,
      copies: p.copies && typeof p.copies === "object" ? { count: Math.max(1, Math.min(200, +p.copies.count || 1)), step: vec3(p.copies.step, [0, 0, 0]), turn: p.copies.turn } : undefined,
      around: p.around && typeof p.around === "object" ? { count: Math.max(1, Math.min(200, +p.around.count || 1)), axis: axisOf(p.around.axis, [0, 1, 0]), center: vec3(p.around.center, [0, 0, 0]), arc: finite(p.around.arc) ? p.around.arc : 360 } : undefined,
      mirror: typeof p.mirror === "string" ? [p.mirror] : (Array.isArray(p.mirror) ? p.mirror.filter((m) => typeof m === "string") : undefined),
      cut: p.cut === true || typeof p.cut === "string" ? p.cut : (p.cut && typeof p.cut === "object" ? { axis: axisOf(p.cut.axis, [0, 0, 1]), at: finite(p.cut.at) ? p.cut.at : 0 } : undefined),
    });
    return makeHandle(mark);
  };

  const figure = { id: stage, kind: "figure", box };
  for (const kind of PART_KINDS) figure[kind] = (op) => part(kind === "cylinder" ? "cyl" : kind, op);
  figure.arrow = (a, b) => (Array.isArray(a) ? part("arrow", Object.assign({}, b, { points: a })) : part("arrow", a || {}));
  figure.surface = (fn, op) => {
    op = op || {};
    const segments = Math.max(4, Math.min(160, op.segments || 80)), rows = Math.max(2, Math.min(80, op.rows || 24));
    const u = op.u || [0, 1], v = op.v || [0, 1], grid = [];
    try {
      for (let j = 0; j <= rows; j++) {
        const row = [];
        for (let i = 0; i <= segments; i++) row.push(vec3(fn(u[0] + ((u[1] - u[0]) * i) / segments, v[0] + ((v[1] - v[0]) * j) / rows), [0, 0, 0]).map((n) => +n.toFixed(4)));
        grid.push(row);
      }
    } catch (error) { warn(`surface() failed: ${error.message}`); return null; }
    const rest = Object.assign({}, op); delete rest.segments; delete rest.rows; delete rest.u; delete rest.v;
    return part("surface", Object.assign(rest, { grid }));
  };
  figure.group = (a, b) => {
    const fn = typeof a === "function" ? a : null;
    const group = part("group", Object.assign({}, fn ? b : a));
    if (fn) { const saved = currentParent; currentParent = group.partId; try { fn(figure); } finally { currentParent = saved; } }
    return group;
  };
  figure.build = (fn, op) => {
    if (typeof fn !== "function") return figure;
    const saved = currentParent;
    if (op && op.parent && op.parent.partId) currentParent = op.parent.partId;
    try { fn(figure); } finally { currentParent = saved; }
    return figure;
  };
  figure.label = (point, words, op) => {
    op = op || {};
    const text = String(words == null ? "" : words).trim();
    if (!text) return null;
    return push({
      do: "label3d", stage, labelId: `${stage}l${++labelCount}`,
      point: point && point.partId ? null : vec3(point, [0, 0, 0]),
      follow: point && point.partId ? point.partId : null,
      text: text.slice(0, 60), side: op.side === "left" || op.side === "right" ? op.side : null,
      size: finite(op.size) ? Math.max(15, Math.min(28, op.size)) : 19,
    });
  };
  // tick((t, dt) => { piston.pos = [...] }) runs every frame once its beat has drawn.
  figure.tick = (fn) => {
    if (typeof fn !== "function") { warn("tick() needs a function"); return null; }
    const tickId = `${stage}t${++tickCount}`;
    session.ticks.set(tickId, fn);
    return push({ do: "tick3d", stage, tickId });
  };
  figure.readout = (values) => {
    if (!values || typeof values !== "object") return figure;
    const readout = session.readouts[stage] || (session.readouts[stage] = {});
    for (const key of Object.keys(values).slice(0, 6)) {
      const value = values[key];
      if (value == null) delete readout[key]; else readout[String(key).slice(0, 24)] = String(value).slice(0, 32);
    }
    return figure;
  };
  figure.move = (target, op) => {
    op = op || {};
    if (!target || !target.partId) { warn("move() needs a part"); return null; }
    const to = vec3(op.to, null), rot = vec3(op.rot, null);
    if (!to && !rot) return null;
    motion(target.partId, "tween", { to, rot, secs: finite(op.secs) ? Math.max(0.05, op.secs) : 0.8 });
    return target;
  };
  figure.view = figure.camera = (op) => {
    op = op || {};
    push({
      do: "camera3d", stage,
      tilt: finite(op.tilt) ? Math.max(-80, Math.min(80, op.tilt)) : undefined,
      turn: finite(op.turn) ? Math.max(-180, Math.min(180, op.turn)) : undefined,
      zoom: finite(op.zoom) ? Math.max(0.5, Math.min(3, op.zoom)) : undefined,
      spin: finite(op.spin) ? Math.min(2, Math.max(0, op.spin)) : undefined,
      target: vec3(op.target, undefined),
    });
    return figure;
  };
  figure.part = (id) => {
    const match = /^(?:st\d+)?p?(\d+)$/.exec(String(id == null ? "" : id).trim());
    if (!match) return null;
    const partId = `${stage}p${match[1]}`;
    const mark = session.marks.find((m) => m.partId === partId);
    return mark ? makeHandle(mark) : null;
  };
  return figure;
}

// ---------------------------------------------------------------- running statements
// A generator keeps one live function activation, so `var`s made by eval persist
// between statements and tick closures see them. `with` puts the drawing calls in scope.
function* programScope(__api) {
  with (__api) {
    let __next = yield;
    for (;;) {
      let __result = { ok: true };
      try {
        eval(__next);
      } catch (error) {
        __result = { ok: false, error };
      }
      __next = yield __result;
    }
  }
}

// A program may name its own variable after a drawing call (`const label = ...`).
// That shadows the call for the program, while the pieces above keep the real one.
const shadows = Object.create(null);
const scope = programScope(new Proxy(Object.create(null), {
  has: (_, key) => typeof key === "string" && (key in shadows || Object.prototype.hasOwnProperty.call(api, key)),
  get: (_, key) => {
    if (typeof key !== "string") return undefined;
    return key in shadows ? shadows[key] : api[key];
  },
  set: (_, key, value) => { shadows[key] = value; return true; },
}));
scope.next();

let heldBack = "";
let heldBackCount = 0;
const MAX_HELD_STATEMENTS = 12;

function compiles(code) {
  try { new Function(code); return true; } catch (error) { return !(error instanceof SyntaxError); }
}

function runStatement(raw, finished) {
  const statement = heldBack + raw;
  const hoisted = hoistDeclarations(statement);
  // A statement that was cut too early doesn't compile; join it to what follows.
  if (!compiles(hoisted)) {
    if (!finished && heldBackCount < MAX_HELD_STATEMENTS) {
      heldBack = statement;
      heldBackCount++;
      return;
    }
    heldBack = "";
    heldBackCount = 0;
    warn(`syntax error in: ${statement.trim().slice(0, 120)}`);
    return;
  }
  heldBack = "";
  heldBackCount = 0;
  session.namedNext = declaredName(statement);
  const first = session.marks.length;
  const { value } = scope.next(hoisted);
  session.namedNext = null;
  if (value && !value.ok) warn(`${value.error && value.error.message}: ${statement.trim().slice(0, 120)}`);
  if (session.marks.length > first) {
    session.statements.push({ text: statement.trim(), first, last: session.marks.length - 1 });
  }
}

function sendOutbox() {
  if (session.outbox.length) {
    post({ type: "events", events: session.outbox });
    session.outbox = [];
  }
}

// A compact list of what's on the card, for the next turn's model.
function describeState() {
  const lines = [];
  session.statements.forEach((statement, index) => {
    let alive = false;
    for (let m = statement.first; m <= statement.last && !alive; m++) alive = !session.marks[m].erased;
    if (!alive) return;
    const summary = statement.text.replace(/\s+/g, " ").slice(0, 90);
    lines.push(`p${index + 1} (m${statement.first}-m${statement.last}): ${summary}`);
  });
  return lines.slice(-90).join("\n");
}

let scanner = new StatementScanner();

onMessage(({ data }) => {
  switch (data.type) {
    case "begin":
      session.W = data.width;
      session.H = data.height;
      api.W = data.width;
      api.H = data.height;
      session.tiles = data.tiles || null;
      if (data.ink) session.ink = data.ink;
      scanner = new StatementScanner();
      session.turn += 1;
      session.stepHasLine = false;
      break;
    case "code":
      for (const statement of scanner.feed(data.text)) runStatement(statement, false);
      sendOutbox();
      post({ type: "alive" });
      break;
    case "end":
      for (const statement of scanner.finish()) runStatement(statement, true);
      if (heldBack) runStatement("", true);
      flushWaiting(session.line);
      session.stepHasLine = session.line >= 0;
      sendOutbox();
      post({ type: "done", state: describeState(), marks: session.marks.length });
      break;
    case "tickStart":
      if (session.ticks.has(data.tickId)) session.running.set(data.tickId, data.now);
      break;
    case "tickStop":
      session.running.clear();
      session.ticks.clear();
      break;
    case "frame": {
      session.poses = {};
      session.inTick = true;
      let last = session.lastFrame || data.now;
      const dt = Math.min(0.1, Math.max(0, data.now - last));
      session.lastFrame = data.now;
      for (const [tickId, start] of session.running) {
        try {
          session.ticks.get(tickId)(data.now - start, dt);
        } catch (error) {
          warn(`tick stopped: ${error.message}`);
          session.running.delete(tickId);
        }
      }
      session.inTick = false;
      sendOutbox();
      post({ type: "poses", poses: session.poses, readouts: session.readouts });
      break;
    }
    case "dropped":
      for (const id of data.ids) { const mark = session.marks[+id.slice(1)]; if (mark) mark.erased = true; }
      break;
    case "ping":
      post({ type: "alive" });
      break;
    default:
  }
});
post({ type: "ready" });
