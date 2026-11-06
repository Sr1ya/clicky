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
  layout: null,
  stepNumber: 0,
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
  session.layout.add(mark, session.stepNumber);
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

const shadeHex = (hex, k) => {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex));
  if (!match) return hex;
  const n = parseInt(match[1], 16);
  const c = (v) => Math.round(v * (1 - k)).toString(16).padStart(2, "0");
  return `#${c(n >> 16)}${c((n >> 8) & 255)}${c(n & 255)}`;
};
// A filled shape with no outline colour of its own gets a thin edge in a deeper shade of its fill.
function outlined(options, inkFallback) {
  const o = options || {};
  const own = o.color || o.tone;
  const style = styled(o, inkFallback);
  if (style.fill && !own) {
    style.color = shadeHex(style.fill, 0.32);
    if (!o.size) style.size = 1.6;
  }
  return style;
}

// A paper window around its writing area, and the tones that follow the user's cursor colour.
const WINDOW_HEADER = 28, WINDOW_PAD = 24;
const BOARDS = new Set(["dots", "grid", "plain"]);
const PAPER_TONES = { "#3380FF": "#EFF2F6", "#FF4C4C": "#F9EFEA", "#D4A017": "#FAF5EA", "#26C281": "#EFF4EB" };
const PAPER_FILLS = { butter: "#FFE27A", mint: "#BFEFCF", peach: "#FFD0BC", lilac: "#D9D1FB", sky: "#CFE6FF" };
const GEL_MIDS = { "#3380FF": "#A2C7FF", "#FF4C4C": "#FFB8B0", "#D4A017": "#FFDF8A", "#26C281": "#C9F0CF" };
const textWidth = (words, size, style) => String(words).length * (size || 20) * (style === "title" ? 0.56 : 0.47);
function openWindow(x, y, w, h, o) {
  o = o || {};
  const X = Math.max(2, x - WINDOW_PAD), Y = Math.max(2, y - WINDOW_PAD - WINDOW_HEADER);
  const Wd = x + w + WINDOW_PAD - X, Hd = y + h + WINDOW_PAD - Y;
  session.papers.push({ x: X, y: Y, w: Wd, h: Hd });
  const title = o.title == null ? "" : String(o.title).replace(/\s+/g, " ").trim().slice(0, 60);
  const board = BOARDS.has(o.board) ? o.board : o.grid === false ? "plain" : "grid";
  push({ do: "window", at: [X, Y], w: Wd, h: Hd, header: WINDOW_HEADER, pad: WINDOW_PAD, inner: [x, y, w, h], title, board, role: "paper", color: o.color ? tone(o.color) : undefined });
}
function niceTicks(lo, hi) {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const rough = span / 5, power = 10 ** Math.floor(Math.log10(rough));
  const unit = [1, 2, 2.5, 5, 10].find((k) => k * power >= rough) * power;
  const out = [];
  for (let v = Math.ceil(lo / unit) * unit; v <= hi + unit * 1e-6; v += unit) out.push(+v.toFixed(10));
  return out;
}

// Boxes that carry words and land partly over another such box move to the nearest free spot,
// and what was drawn in them comes along. One shape inside another, or just touching, stays.
function newLayout() {
  const containers = [], words = [], strokes = [], areas = [];
  let moved = null;
  const shapeOf = (m) => {
    if (m.under) return null;
    if (m.do === "rect" && Array.isArray(m.at) && finite(m.w) && finite(m.h)) {
      let [x, y] = m.at, w = m.w, h = m.h;
      if (w < 0) { x += w; w = -w; }
      if (h < 0) { y += h; h = -h; }
      return { kind: "box", b: [x, y, x + w, y + h], area: w * h, inside: (px, py) => px >= x && px <= x + w && py >= y && py <= y + h };
    }
    if ((m.do === "circle" || m.do === "ellipse") && Array.isArray(m.at)) {
      const [cx, cy] = m.at, rx = +(m.r || m.rx), ry = +(m.r || m.ry);
      if (!(rx > 0 && ry > 0)) return null;
      return { kind: "round", b: [cx - rx, cy - ry, cx + rx, cy + ry], area: Math.PI * rx * ry, inside: (px, py) => ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1 };
    }
    if (m.do === "window" && Array.isArray(m.at)) {
      const [x, y] = m.at, w = m.w, h = m.h;
      return { kind: "poly", b: [x, y, x + w, y + h], area: w * h, inside: (px, py) => px >= x && px <= x + w && py >= y && py <= y + h };
    }
    return null;
  };
  const isContainer = (m, s) => s && s.b[2] - s.b[0] >= 36 && s.b[3] - s.b[1] >= 22 && s.area < 0.4 * session.W * session.H && (m.outline !== false || (m.fill && (m.fillAlpha == null || m.fillAlpha >= 0.5)));
  const inter = (a, b, dx = 0, dy = 0) => {
    const x0 = Math.max(a.b[0] + dx, b.b[0]), y0 = Math.max(a.b[1] + dy, b.b[1]), x1 = Math.min(a.b[2] + dx, b.b[2]), y1 = Math.min(a.b[3] + dy, b.b[3]);
    if (x1 <= x0 || y1 <= y0) return 0;
    const N = 14;
    let hit = 0;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const px = x0 + ((i + 0.5) * (x1 - x0)) / N, py = y0 + ((j + 0.5) * (y1 - y0)) / N;
      if (a.inside(px - dx, py - dy) && b.inside(px, py)) hit++;
    }
    return (hit / (N * N)) * (x1 - x0) * (y1 - y0);
  };
  const clash = (a, b, dx = 0, dy = 0) => {
    const overlap = inter(a, b, dx, dy);
    if (!overlap) return false;
    const small = Math.min(a.area, b.area), big = Math.max(a.area, b.area);
    if (overlap >= 0.8 * a.area || overlap >= 0.8 * b.area) return false;
    if (overlap < 0.1 * small) return false;
    return a.kind === b.kind && a.kind !== "poly" && small / big >= 0.2;
  };
  const within = (p, b, pad) => p[0] >= b[0] - pad && p[0] <= b[2] + pad && p[1] >= b[1] - pad && p[1] <= b[3] + pad;
  const pointsOf = (m) => {
    if (Array.isArray(m.pts)) return m.pts.filter(Array.isArray);
    if (!Array.isArray(m.at)) return [];
    if (m.do === "rect" || m.do === "highlight" || m.do === "image" || m.do === "window") return [m.at, [m.at[0] + (+m.w || 0), m.at[1] + (+m.h || 0)]];
    if (m.do === "circle" || m.do === "ellipse") { const rx = +(m.r || m.rx) || 0, ry = +(m.r || m.ry) || 0; return [[m.at[0] - rx, m.at[1] - ry], [m.at[0] + rx, m.at[1] + ry]]; }
    return [m.at];
  };
  const shift = (m, dx, dy, near) => {
    const move = (p) => (!near || near(p) ? [p[0] + dx, p[1] + dy] : p);
    if (Array.isArray(m.at)) m.at = move(m.at);
    if (Array.isArray(m.pts)) m.pts = m.pts.map((p) => (Array.isArray(p) ? move(p) : p));
  };
  return {
    reset() { containers.length = words.length = strokes.length = areas.length = 0; moved = null; },
    add(m, step) {
      if (m.do === "edit" || /3d$/.test(m.do || "") || m.role === "button") return;
      if (moved) {
        if (step !== moved.step) moved = null;
        else {
          const s = shapeOf(m), P = pointsOf(m);
          if (isContainer(m, s) && !(within([s.b[0], s.b[1]], moved.from, 3) && within([s.b[2], s.b[3]], moved.from, 3))) moved = null;
          else if (P.length && (m.do === "line" || m.do === "arrow")) shift(m, moved.d[0], moved.d[1], (p) => within(p, moved.from, 12));
          else if (P.length && P.every((p) => within(p, moved.from, 3))) shift(m, moved.d[0], moved.d[1]);
        }
      }
      if ((m.do === "line" || m.do === "arrow") && Array.isArray(m.pts)) { for (const p of m.pts) if (Array.isArray(p)) strokes.push(p); }
      else if (m.do === "dot" && Array.isArray(m.at)) strokes.push(m.at);
      if (m.do === "text" && Array.isArray(m.at) && m.text != null) {
        const size = m.size || 20, wide = m.fit ? Math.min(m.fit[0], textWidth(m.text, size, m.style)) : textWidth(m.text, size, m.style);
        const x = m.at[0] - (m.anchor === "middle" ? wide / 2 : m.anchor === "end" ? wide : 0);
        const box = [x, m.at[1] - size * 0.8, x + wide, m.at[1] + size * 0.25];
        words.push(box);
        const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
        for (let k = containers.length - 1; k >= 0; k--) if (containers[k].inside(cx, cy)) { containers[k].labelled = true; break; }
        return;
      }
      const s = shapeOf(m);
      if (!isContainer(m, s)) return;
      s.labelled = false;
      const hit = containers.find((other) => other.labelled && clash(s, other));
      if (hit) {
        const box = (dx, dy) => [s.b[0] + dx, s.b[1] + dy, s.b[2] + dx, s.b[3] + dy];
        const free = (dx, dy) => s.b[0] + dx >= 6 && s.b[1] + dy >= 6 && s.b[2] + dx <= session.W - 6 && s.b[3] + dy <= session.H - 6
          && !containers.some((o) => (o.labelled && clash(s, o, dx, dy)) || (inter(s, o, dx, dy) > 0.12 * s.area && inter(s, o, dx, dy) < 0.8 * o.area))
          && !strokes.some((p) => within(p, box(dx, dy), 4))
          && !words.some((t) => Math.min(t[2], s.b[2] + dx) > Math.max(t[0], s.b[0] + dx) && Math.min(t[3], s.b[3] + dy) > Math.max(t[1], s.b[1] + dy));
        const limit = 0.22 * Math.min(session.W, session.H), candidates = [];
        for (let r = 8; r <= limit; r += 8) for (const [ux, uy] of [[0, 1], [1, 0], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) candidates.push([ux * r, uy * r]);
        candidates.push([hit.b[2] + 10 - s.b[0], 0], [hit.b[0] - 10 - s.b[2], 0], [0, hit.b[3] + 10 - s.b[1]], [0, hit.b[1] - 10 - s.b[3]]);
        const best = candidates.filter((d) => Math.hypot(...d) <= limit * 1.1).sort((p, q) => Math.hypot(...p) - Math.hypot(...q)).find(([dx, dy]) => free(dx, dy));
        if (best) {
          const from = s.b.slice();
          shift(m, best[0], best[1]);
          s.b = box(best[0], best[1]);
          const inside = s.inside;
          s.inside = (px, py) => inside(px - best[0], py - best[1]);
          moved = { from, d: best, step };
        }
      }
      containers.push(s);
    },
  };
}

session.layout = newLayout();

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
    session.stepNumber += 1;
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
  circle: (x, y, r, o) => push({ do: "circle", at: [x, y], r }, outlined(o, inkAt(x, y))),
  ellipse: (x, y, rx, ry, o) => push({ do: "ellipse", at: [x, y], rx, ry }, outlined(o, inkAt(x, y))),
  rect: (x, y, w, h, o) => push({ do: "rect", at: [x, y], w, h }, outlined(o, inkAt(x, y))),
  poly: (pts, o) => push({ do: "poly", pts }, outlined(o, inkAt(...firstPoint(pts)))),
  path: (d, o) => push({ do: "path", d: String(d) }, styled(o, PAPER_INK)),
  dot: (x, y, r, o) => push({ do: "dot", at: [x, y], r: finite(r) ? r : 3 }, styled(o, inkAt(x, y))),
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
  underline: (x, y, w, o) => push({ do: "line", pts: [[x, y + 3], [x + w, y + 3]] }, Object.assign({ color: session.ink, size: 3, taper: 0, glow: true, smooth: false, wobble: 0.3 }, o && styled(o, session.ink))),
  strike: (x, y, w) => push({ do: "line", pts: [[x - 2, y], [x + w + 2, y]] }, { color: session.ink, size: 3, taper: 0, glow: true, smooth: false }),
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
  check(x, y, size) {
    const s = finite(size) ? size : 12;
    return push({ do: "line", pts: [[x - s * 0.6, y], [x - s * 0.15, y + s * 0.5], [x + s * 0.7, y - s * 0.6]] }, { color: session.ink, size: 3.5, taper: 0, glow: true, smooth: false, role: "check" });
  },
  cross(x, y, size) {
    const s = finite(size) ? size : 10;
    const pen = { color: session.ink, size: 3.5, taper: 0, glow: true, role: "cross" };
    push({ do: "line", pts: [[x - s / 2, y - s / 2], [x + s / 2, y + s / 2]] }, Object.assign({ together: true }, pen));
    return push({ do: "line", pts: [[x + s / 2, y - s / 2], [x - s / 2, y + s / 2]] }, pen);
  },
  scroll(x, y, direction, name) {
    const s = direction === "up" ? -1 : 1;
    for (const offset of [0, 14]) push({ do: "line", pts: [[x - 12, y + offset - 6 * s], [x, y + offset + 6 * s], [x + 12, y + offset - 6 * s]] }, { color: session.ink, size: 3.5, glow: true, taper: 0 });
    if (name) pillBeside([x - 14, y - 10, 28, 34], name);
  },
  cheer: (x, y, face) => placePill(x, y, face || "(^_^)v"),
  spotlight: (x, y, w, h, o) => push({ do: "spotlight", at: [x, y], w, h }, o),

  // ---- paper
  // paper's x, y, w, h is the writing area; the window stands around it.
  paper(x, y, w, h, o) {
    o = o || {};
    const box = stepAsideFromFigures(x, y, w, h);
    x = box[0]; y = box[1];
    const clean = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());
    const heading = clean(o.heading), subtitle = clean(o.subtitle);
    const title = clean(o.title) || (heading.split(" ").length <= 5 ? heading : "");
    openWindow(x, y, w, h, { title, board: o.board, grid: o.grid, color: o.color });
    let top = y;
    if (heading) {
      push({ do: "text", at: [x, y + 20], text: heading, style: "title", size: 26, color: PAPER_INK, place: false, fit: [w, 34] });
      top = y + 20 + 26 * 0.3;
    }
    if (subtitle) {
      const baseline = heading ? y + 50 : y + 14;
      push({ do: "text", at: [x, baseline], text: subtitle, size: 18, color: TONES.grey, place: false, fit: [w, 24] });
      top = baseline + 18 * 0.3;
    }
    if (top > y) top += 32;
    return { x, y: top, w, h: Math.max(40, y + h - top), box: [x, y, w, h], kind: "paper" };
  },
  // A sticky lies a touch askew, with a soft shadow, a curled corner and a strip of tape.
  sticky(x, y, words, color, o) {
    o = o || {};
    const size = o.size || 170, turn = (o.tilt ?? -2) * (Math.PI / 180);
    const box = stepAsideFromFigures(x, y, size, size);
    x = box[0]; y = box[1];
    const middle = [x + size / 2, y + size / 2];
    const tilted = (points) => points.map(([px, py]) => {
      const dx = px - middle[0], dy = py - middle[1];
      return [middle[0] + dx * Math.cos(turn) - dy * Math.sin(turn), middle[1] + dx * Math.sin(turn) + dy * Math.cos(turn)];
    });
    const sheet = [[x, y], [x + size, y], [x + size, y + size - 24], [x + size - 24, y + size], [x, y + size]];
    const flat = { outline: false, wash: false, role: "paper" };
    session.papers.push({ x, y, w: size, h: size });
    push({ do: "poly", pts: tilted(sheet.map((p) => [p[0], p[1] + 3])), fill: TONES.ink, fillAlpha: 0.07, together: true, ...flat });
    push({ do: "poly", pts: tilted(sheet.map((p) => [p[0], p[1] + 1])), fill: TONES.ink, fillAlpha: 0.08, together: true, ...flat });
    push({ do: "poly", pts: tilted(sheet), fill: PAPER_FILLS[color] || tone(color, PAPER_FILLS.butter), fillAlpha: 1, snd: "paper-place", ...flat });
    push({ do: "poly", pts: tilted([[x + size - 24, y + size], [x + size, y + size - 24], [x + size - 20, y + size - 20]]), fill: TONES.ink, fillAlpha: 0.12, together: true, ...flat });
    const tapeW = size * 0.4, tapeH = 20, tapeX = x + size * 0.5 - tapeW / 2, tapeY = y + 1 - tapeH / 2;
    const leftEnd = [], rightEnd = [];
    for (let i = 0; i <= 4; i++) leftEnd.push([tapeX + (i % 2 ? 2.5 : 0), tapeY + (i * tapeH) / 4]);
    for (let i = 0; i <= 4; i++) rightEnd.push([tapeX + tapeW - (i % 2 ? 0 : 2.5), tapeY + tapeH - (i * tapeH) / 4]);
    push({ do: "poly", pts: tilted([...leftEnd.reverse(), ...rightEnd.reverse()]), fill: GEL_MIDS[session.ink] || session.ink, fillAlpha: 0.8, snd: "tape", ...flat });
    return push({ do: "text", at: [x + 16, y + 40], text: String(words), style: "hand", size: o.textSize || 22, color: PAPER_INK, fit: [size - 32, size - 50], rot: o.tilt ?? -2, baseline: "alphabetic" });
  },
  // A short list in a window, its title on top of the board.
  receipt(x, y, title, items, o) {
    o = o || {};
    const rows = (items || []).map((item) => (Array.isArray(item) ? item.filter((cell) => cell !== "").join("  ") : String(item)));
    const w = finite(o.w) ? o.w : 240, rowHeight = 30, h = 48 + rows.length * rowHeight;
    const box = stepAsideFromFigures(x, y, w, h);
    x = box[0]; y = box[1];
    openWindow(x, y, w, h, { board: o.board || "plain", title: o.title });
    push({ do: "text", at: [x, y + 24], text: String(title), style: "title", size: 20, color: PAPER_INK, fit: [w, 28] });
    rows.forEach((row, index) => push({ do: "text", at: [x, y + 54 + index * rowHeight], text: `${index + 1}. ${row}`, style: "hand", size: 19, color: PAPER_INK, fit: [w, rowHeight] }));
    return { x, y, w, h, box: [x, y, w, h], kind: "paper" };
  },
  // A fact in a window, its source in the title bar.
  clipping(x, y, w, title, body, source, o) {
    o = o || {};
    const h = finite(o.h) ? o.h : 130;
    const box = stepAsideFromFigures(x, y, w, h);
    x = box[0]; y = box[1];
    openWindow(x, y, w, h, { board: o.board || "plain", title: source || o.title });
    push({ do: "text", at: [x, y + 24], text: String(title), style: "title", size: 20, color: PAPER_INK, fit: [w, 28] });
    push({ do: "text", at: [x, y + 52], text: String(body || ""), style: "body", size: 17, color: TONES.grey, fit: [w, h - 56], baseline: "alphabetic" });
    return { x, y, w, h, box: [x, y, w, h], kind: "paper" };
  },
  // A row of colour keys, each a small dot and its words in grey. y is the words' baseline.
  legend(x, y, items, o) {
    o = o || {};
    const size = o.size || 15, r = Math.max(3, Math.round(size * 0.3)), space = Math.round(size * 0.45), apart = Math.round(size * 1.3);
    let cx = x;
    for (const entry of items || []) {
      const [color, words] = Array.isArray(entry) ? entry : [entry && (entry.tone || entry.color), entry && (entry.label || entry.text)];
      if (!words) continue;
      push({ do: "dot", at: [cx + r, y - size * 0.3], r, color: tone(color, TONES.grey), role: "key", together: true });
      push({ do: "text", at: [cx + 2 * r + space, y], text: String(words), size, color: TONES.grey, place: false });
      cx += 2 * r + space + String(words).length * size * 0.42 + apart;
    }
    return Math.max(0, cx - apart - x);
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
  graph(gx, gy, gw, gh, o) {
    o = o || {};
    const xr = Array.isArray(o.x) ? o.x : [0, 10], yr = Array.isArray(o.y) ? o.y : [0, 10];
    const X = (v) => gx + ((v - xr[0]) / (xr[1] - xr[0] || 1)) * gw, Y = (v) => gy + gh - ((v - yr[0]) / (yr[1] - yr[0] || 1)) * gh;
    const at = (a, b) => (Array.isArray(a) ? [X(a[0]), Y(a[1])] : [X(a), Y(b)]);
    const ink = tone(o.tone || o.color, inkAt(gx, gy));
    const quiet = quietInk(gx, gy);
    const axisY = yr[0] < 0 && yr[1] > 0 ? Y(0) : gy + gh, axisX = xr[0] < 0 && xr[1] > 0 ? X(0) : gx;
    const short = (v) => shortNumber(v);
    const ticksOf = (list, lo, hi) => (Array.isArray(list) ? list : list === true || o.ticks ? niceTicks(lo, hi) : []).map((t) => (Array.isArray(t) ? [t[0], String(t[1])] : [t, short(t)]));
    const xt = ticksOf(o.xTicks, xr[0], xr[1]), yt = ticksOf(o.yTicks, yr[0], yr[1]);
    if (o.title) push({ do: "text", at: [gx, gy - 34], text: String(o.title), style: "title", size: 22, color: ink });
    if (o.grid) {
      for (const [v] of xt) push({ do: "line", pts: [[X(v), gy], [X(v), gy + gh]], color: TONES.grey, size: 1.4, alpha: 0.4, smooth: false, together: true });
      for (const [v] of yt) push({ do: "line", pts: [[gx, Y(v)], [gx + gw, Y(v)]], color: TONES.grey, size: 1.4, alpha: 0.4, smooth: false, together: true });
    }
    push({ do: "arrow", pts: [[Math.min(gx, axisX) - 6, axisY], [gx + gw + 12, axisY]], color: ink, size: 1.8, head: 8 });
    push({ do: "arrow", pts: [[axisX, Math.max(gy + gh, axisY) + 6], [axisX, gy - 12]], color: ink, size: 1.8, head: 8 });
    for (const [v, words] of xt) {
      if (v === 0 && axisX === X(0)) continue;
      push({ do: "line", pts: [[X(v), axisY - 4], [X(v), axisY + 4]], color: ink, size: 1.6, smooth: false, together: true });
      push({ do: "text", at: [X(v), axisY + 22], text: words, anchor: "middle", size: 14, color: quiet });
    }
    for (const [v, words] of yt) {
      if (v === 0 && axisY === Y(0)) continue;
      push({ do: "line", pts: [[axisX - 4, Y(v)], [axisX + 4, Y(v)]], color: ink, size: 1.6, smooth: false, together: true });
      push({ do: "text", at: [axisX - 9, Y(v) + 5], text: words, anchor: "end", size: 14, color: quiet });
    }
    const xLabel = o.xLabel || o.xlabel, yLabel = o.yLabel || o.ylabel;
    if (xLabel) push({ do: "text", at: [gx + gw + 12, axisY + (xt.length ? 48 : 30)], text: String(xLabel), anchor: "end", size: o.labelSize || 18, color: ink });
    if (yLabel) push({ do: "text", at: [axisX - 4, gy - 24], text: String(yLabel), size: o.labelSize || 18, color: ink });
    const inRange = ([u, v]) => u >= xr[0] - 1e-9 && u <= xr[1] + 1e-9 && v >= Math.min(yr[0], yr[1]) - 1e-9 && v <= Math.max(yr[0], yr[1]) + 1e-9;
    const leaving = (a, b) => {
      let lo = 0, hi = 1;
      for (let k = 0; k < 24; k++) { const m = (lo + hi) / 2; if (inRange([a[0] + (b[0] - a[0]) * m, a[1] + (b[1] - a[1]) * m])) lo = m; else hi = m; }
      return [a[0] + (b[0] - a[0]) * lo, a[1] + (b[1] - a[1]) * lo];
    };
    const series = (data, style, straight) => {
      data = data.filter((p) => finite(p[0]) && finite(p[1]));
      const pieces = [];
      let current = [];
      data.forEach((p, k) => {
        if (inRange(p)) { if (!current.length && k && !inRange(data[k - 1])) current.push(leaving(p, data[k - 1])); current.push(p); }
        else if (current.length) { current.push(leaving(data[k - 1], p)); pieces.push(current); current = []; }
      });
      if (current.length) pieces.push(current);
      const color = tone(style.tone || style.color, TONES.blue), size = style.size || 4;
      for (const piece of pieces) if (piece.length >= 2) push({ do: "line", pts: piece.map((p) => at(p)), color, size, smooth: straight ? false : undefined, dash: style.dash });
      if (!pieces.length) warn("graph: a line lies completely outside the graph ranges");
      const last = pieces.length ? pieces[pieces.length - 1] : data, first = pieces.length ? pieces[0] : data;
      const end = at(last[last.length - 1] || [0, 0]), start = at(first[0] || [0, 0]);
      if (style.label) {
        const wide = textWidth(style.label, 18), atStart = style.labelAt === "start", p = atStart ? start : end;
        let lx = p[0] + (atStart ? -8 : 8), ly = p[1] + 6, anchor = atStart ? "end" : "start";
        if (!atStart && lx + wide > session.W - 8) { lx = p[0] - 4; ly = p[1] - 14; anchor = "end"; }
        if (atStart && lx - wide < 8) { lx = p[0] + 4; ly = p[1] - 14; anchor = "start"; }
        if (p[1] <= axisY && ly > axisY - 12) ly = p[1] - 12;
        push({ do: "text", at: [lx, Math.max(22, Math.min(session.H - 8, ly))], text: String(style.label), anchor, size: style.labelSize || 18, color: tone(style.labelTone, color) });
      }
      return { data, color, size, straight, start, end, pts: data.map((p) => at(p)) };
    };
    const g = { box: { x: gx, y: gy, w: gw, h: gh }, origin: [axisX, axisY], x: X, y: Y, at };
    g.plot = (f, style) => {
      style = style || {};
      if (typeof f === "function") {
        const a = style.from != null ? style.from : xr[0], b = style.to != null ? style.to : xr[1], n = style.samples || 64, data = [];
        for (let k = 0; k <= n; k++) { const u = a + ((b - a) * k) / n; let v; try { v = f(u); } catch (_) { v = NaN; } if (Number.isFinite(v)) data.push([u, v]); }
        return series(data, style, false);
      }
      if (Array.isArray(f)) return series(f, style, style.smooth === true ? false : style.straight != null ? !!style.straight : f.length <= 8);
      warn("graph: plot() needs a function or a list of [x, y] points");
      return null;
    };
    g.curve = g.plot;
    g.line = (p1, p2, style) => g.plot([p1, p2], Object.assign({ straight: true }, style));
    g.shift = (line, dx, dy, style) => {
      style = style || {};
      if (!line || !line.data) { warn("graph: shift() needs a line made by plot() or line()"); return null; }
      return series(line.data.map(([u, v]) => [u + (dx || 0), v + (dy || 0)]), Object.assign({ size: line.size, color: line.color }, style), line.straight);
    };
    g.cross = (a, b) => {
      if (!a || !b || !a.data || !b.data) { warn("graph: cross() needs two lines"); return null; }
      for (let i = 1; i < a.data.length; i++) for (let j = 1; j < b.data.length; j++) {
        const p = a.data[i - 1], p2 = a.data[i], q = b.data[j - 1], q2 = b.data[j];
        const r = [p2[0] - p[0], p2[1] - p[1]], s2 = [q2[0] - q[0], q2[1] - q[1]], den = r[0] * s2[1] - r[1] * s2[0];
        if (Math.abs(den) < 1e-12) continue;
        const t = ((q[0] - p[0]) * s2[1] - (q[1] - p[1]) * s2[0]) / den, u = ((q[0] - p[0]) * r[1] - (q[1] - p[1]) * r[0]) / den;
        if (t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) return [p[0] + r[0] * t, p[1] + r[1] * t];
      }
      warn("graph: these two lines do not cross inside the graph");
      return null;
    };
    g.point = (a, b, style) => {
      if (Array.isArray(a)) { style = b; b = a[1]; a = a[0]; }
      style = style || {};
      if (!finite(a) || !finite(b)) { warn("graph: point() got no point"); return null; }
      const [cx, cy] = at(a, b);
      const color = tone(style.tone || style.color, ink);
      if (style.guides) {
        push({ do: "line", pts: [[cx, cy], [cx, axisY]], color: TONES.grey, size: 2.4, dash: true, smooth: false, together: true });
        push({ do: "line", pts: [[cx, cy], [axisX, cy]], color: TONES.grey, size: 2.4, dash: true, smooth: false, together: true });
      }
      push({ do: "dot", at: [cx, cy], r: style.r || 6.5, color });
      if (style.xTick) push({ do: "text", at: [cx, axisY + 24], text: String(style.xTick), anchor: "middle", size: 16, color });
      if (style.yTick) push({ do: "text", at: [axisX - 10, cy + 5], text: String(style.yTick), anchor: "end", size: 16, color });
      if (style.label) push({ do: "text", at: [cx + 12, cy - 12], text: String(style.label), size: style.labelSize || 17, color });
      const p = [cx, cy];
      p.data = [a, b];
      return p;
    };
    return g;
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
  // Dated marks along an arrow, words under them (or alternating), spread apart when too close.
  timeline(tx, ty, tw, events, o) {
    o = o || {};
    const list = (Array.isArray(events) ? events : []).map((e, i) => (Array.isArray(e)
      ? { date: e[0], label: e[1] == null ? "" : String(e[1]), show: e[2] }
      : e && typeof e === "object" ? { date: e.date != null ? e.date : e.at != null ? e.at : i, label: String(e.label || e.text || ""), show: e.show } : { date: e, label: "" }));
    const n = list.length, ink = tone(o.tone, inkAt(tx, ty)), quiet = quietInk(tx, ty);
    push({ do: "arrow", pts: [[tx, ty], [tx + tw, ty]], color: ink, size: 2, head: 9 });
    if (!n) { warn("timeline: no events"); return { marks: [], at: () => [tx, ty] }; }
    const numeric = list.every((e) => finite(e.date));
    const inset = o.inset != null ? o.inset : Math.min(60, tw / (2 * n)), span = tw - 2 * inset - 12;
    const lo = numeric ? (o.from != null ? o.from : Math.min(...list.map((e) => e.date))) : 0;
    const hi = numeric ? (o.to != null ? o.to : Math.max(...list.map((e) => e.date))) : n - 1;
    const place = (d) => tx + inset + (n === 1 && !(o.from != null && o.to != null) ? span / 2 : ((d - lo) / (hi - lo || 1)) * span);
    const xs = list.map((e, i) => (numeric && !o.even ? place(e.date) : tx + inset + (n === 1 ? span / 2 : (i * span) / (n - 1))));
    const alternate = o.slots === "alternate";
    const minGap = Math.min(o.minGap || (alternate ? 70 : 96), span / Math.max(1, n - 1));
    const order = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
    for (let k = 1; k < n; k++) xs[order[k]] = Math.max(xs[order[k]], xs[order[k - 1]] + minGap);
    for (let k = n - 1; k >= 0; k--) xs[order[k]] = Math.min(xs[order[k]], k === n - 1 ? tx + inset + span : xs[order[k + 1]] - minGap);
    const room = (i) => {
      const sorted = order.map((k) => xs[k]), k = sorted.indexOf(xs[i]);
      const nearest = Math.min(k > 0 ? xs[i] - sorted[k - 1] : 1e9, k < n - 1 ? sorted[k + 1] - xs[i] : 1e9);
      return nearest > 1e8 ? tw / 2 : nearest;
    };
    const marks = list.map((e, i) => {
      const x = xs[i], below = o.slots === "below" ? false : alternate ? i % 2 === 0 : true;
      push({ do: "line", pts: [[x, ty - 9], [x, ty + 9]], color: ink, size: 3, smooth: false, together: true });
      push({ do: "dot", at: [x, ty], r: 5.5, color: tone(o.dotTone, TONES.coral), together: true });
      const shown = e.show != null ? String(e.show) : numeric ? shortNumber(e.date) : String(e.date);
      const wide = Math.min(190, (alternate ? 1.85 : 0.96) * room(i));
      const labelSize = o.labelSize || 17, dateSize = o.dateSize || 18;
      const two = e.label && textWidth(e.label, labelSize) > wide - 6;
      push({ do: "text", at: [x, below ? ty + 30 : ty - 18], text: shown, anchor: "middle", size: dateSize, color: tone(o.dateTone, ink), together: !!e.label });
      if (e.label) push({ do: "text", at: [x, below ? ty + (two ? 64 : 56) : ty - (two ? 54 : 44)], text: e.label, anchor: "middle", size: labelSize, fit: [wide - 6, 44], color: ink === quiet ? ink : ink });
      return { date: e.date, label: e.label, x, y: ty, at: [x, ty] };
    });
    return { marks, at: (d) => { const k = list.findIndex((e) => e.date === d); return k >= 0 ? [xs[k], ty] : [tx, ty]; } };
  },

  // ---- changing what's already there. Ids are m3, m3-m9, p2 (a whole statement), a name or a handle.
  erase: (target) => edit("erase", target),
  recolor: (target, color) => edit("recolor", target, { color: tone(color) }),
  restyle: (target, style) => edit("restyle", target, styled(style)),
  moveMark: (target, dx, dy) => edit("move", target, { dx, dy }),
  scaleMark: (target, factor) => edit("scale", target, { factor }),
  undo: () => edit("undo", null),
  clear() {
    session.layout.reset();
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
const MAJOR_PIPE_RADIUS = 0.08;
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

  // cut: true takes away the half facing the viewer. That half is on the +z side unless the
  // figure starts turned to another side.
  const startsFacingZ = ((Math.round((-20 + (finite(o.turn) ? o.turn : 0)) / 90) % 4) + 4) % 4 === 0;
  let hasFacingCut = false;
  // Pipes in a cutaway follow the cut, so none is left hanging in front of the opening: one
  // crossing the slice is sliced, a big vessel entirely in front settles onto the slice, and
  // a thin one on the removed front goes with the wall it ran on.
  const followTheCut = (p, shape, pos) => {
    if (p.cut !== undefined || p.parent || currentParent || !hasFacingCut || !startsFacingZ || !Array.isArray(shape.points)) return;
    p.cut = true;
    const r = finite(shape.r) ? shape.r : 0.1;
    const depths = shape.points.filter((point) => Array.isArray(point) && finite(point[2])).map((point) => point[2] + pos[2]);
    if (!depths.length || Math.min(...depths) - r < 0 || r < MAJOR_PIPE_RADIUS) return;
    const middle = (Math.min(...depths) + Math.max(...depths)) / 2;
    shape.points = shape.points.map((point) => (Array.isArray(point) ? [point[0], point[1], point[2] - middle] : point));
  };

  const part = (kind, params) => {
    const p = Object.assign({}, params);
    const partId = `${stage}p${++partCount}`;
    if (p.cut === true) hasFacingCut = true;
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
    if (kind === "pipe") followTheCut(p, shape, pos);
    // Given only by points, a pipe or arrow stands at their middle, so it grows in place and its
    // label, picking and framing find it where it is rather than at the figure's origin.
    if ((kind === "pipe" || kind === "arrow") && !vec3(p.at, null) && !vec3(p.pos, null) && Array.isArray(shape.points)) {
      const points = shape.points.map((point) => vec3(point, null)).filter(Boolean);
      if (points.length >= 2) {
        const middle = [0, 1, 2].map((k) => points.reduce((sum, point) => sum + point[k], 0) / points.length);
        shape.points = points.map((point) => point.map((value, k) => value - middle[k]));
        pos = middle;
      }
    }
    const parent = (p.parent && p.parent.partId) || currentParent;
    const scale = vec3(p.scale, null) || (finite(p.scale) ? p.scale : undefined);
    const mark = push({
      do: "part3d", stage, partId, kind, shape, pos, rot, scale, material, parent,
      name: typeof p.name === "string" && p.name.trim() ? p.name.trim().slice(0, 40) : session.namedNext || undefined,
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
