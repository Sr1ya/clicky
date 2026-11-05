// Clicky's real-time graphics renderer.
//
// Rust drives this page through window.clicky.handle(command):
//   {type:"show",  id, visual, scale_x, scale_y}  build the (empty) card
//   {type:"step",  id, index}                     draw everything up to step `index`
//   {type:"clear", id|null}                       fade out (null = whatever is showing)
//
// `visual` is the JSON Claude wrote (see the system prompt in pointing.rs).
// Card elements use the card's own coordinate space (card.w x card.h units).
// Elements with "on":"screen" use screenshot pixels; scale_x/scale_y map those
// onto this page's CSS pixels (the page covers exactly one monitor).
(() => {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const COLORS = {
    ink: "#1f2430",
    blue: "#3b6fe0",
    red: "#e03e3e",
    green: "#2f9e44",
    orange: "#f08c00",
    yellow: "#e6b400",
    purple: "#7048e8",
    teal: "#0c8599",
    pink: "#d6336c",
    gray: "#868e96",
  };
  const FILLS = {
    ink: "#e9ecef",
    blue: "#dbe7ff",
    red: "#ffe0e0",
    green: "#d8f5dd",
    orange: "#ffe8cc",
    yellow: "#fff3bf",
    purple: "#e5dbff",
    teal: "#d3f4f6",
    pink: "#ffdeeb",
    gray: "#f1f3f5",
  };
  const NOTE_YELLOW = "#ffec99";
  const HIGHLIGHT = "rgba(255, 212, 59, 0.38)";

  let current = null;

  // ------------------------------------------------------------ helpers

  const num = (value, fallback) => (Number.isFinite(Number(value)) && value !== null && value !== "" ? Number(value) : fallback);
  const isCssColor = (value) => typeof value === "string" && /^#[0-9a-f]{3,8}$/i.test(value);
  const strokeColor = (name) => COLORS[name] || (isCssColor(name) ? name : COLORS.ink);
  const fillColor = (fill, strokeName) => {
    if (fill === true || fill === "solid" || fill === "hachure") return FILLS[strokeName] || FILLS.gray;
    if (FILLS[fill]) return FILLS[fill];
    if (isCssColor(fill)) return fill;
    return FILLS.gray;
  };
  const point = (value) => (Array.isArray(value) && value.length >= 2 ? [num(value[0], 0), num(value[1], 0)] : null);

  function svgElement(tag, attributes = {}) {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    return element;
  }

  function htmlElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  }

  /** Greedy word wrap; Caveat averages ~0.45em per character. */
  function wrapText(text, maxWidth, fontSize) {
    const maxCharacters = Math.max(6, Math.floor(maxWidth / (fontSize * 0.45)));
    const lines = [];
    for (const paragraph of String(text).split("\n")) {
      let line = "";
      for (const word of paragraph.split(/\s+/)) {
        if (!word) continue;
        if (line && (line + " " + word).length > maxCharacters) {
          lines.push(line);
          line = word;
        } else {
          line = line ? line + " " + word : word;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  /** Multi-line hand-written text centred vertically on y. */
  function handText(x, y, text, { size = 22, color = "ink", anchor = "middle", weight = 500, maxWidth = 0 } = {}) {
    const lines = maxWidth > 0 ? wrapText(text, maxWidth, size) : String(text).split("\n");
    const lineHeight = size * 1.08;
    const element = svgElement("text", {
      class: "hand",
      x,
      y,
      "font-size": size,
      "font-weight": weight,
      "text-anchor": anchor,
      fill: strokeColor(color),
    });
    lines.forEach((line, index) => {
      const span = svgElement("tspan", {
        x,
        dy: index === 0 ? -((lines.length - 1) * lineHeight) / 2 : lineHeight,
        "dominant-baseline": "central",
      });
      span.textContent = line;
      element.appendChild(span);
    });
    return element;
  }

  /** Small explanatory text in a clean sans face, under a handwritten label. */
  function subText(x, y, text, size, maxWidth, anchor = "middle") {
    const lines = wrapText(text, maxWidth * 0.8, size);
    const element = svgElement("text", { class: "sub", x, y, "font-size": size, "text-anchor": anchor, fill: "#5c6370" });
    lines.forEach((line, index) => {
      const span = svgElement("tspan", { x, dy: index === 0 ? 0 : size * 1.25, "dominant-baseline": "central" });
      span.textContent = line;
      element.appendChild(span);
    });
    return element;
  }

  /** Bar, line or pie chart from data [[label, value], ...]. */
  function drawChart(rc, layer, element, options, size, add) {
    const [x, y] = layer.p(num(element.x, 0), num(element.y, 0));
    const w = layer.s(num(element.w, 300));
    const h = layer.s(num(element.h, 200));
    const data = (element.data || []).filter(Array.isArray).map(([label, value, color]) => ({ label: String(label), value: num(value, 0), color }));
    if (!data.length) return;
    const labelSize = size * 0.72;
    const thin = { ...options, strokeWidth: Math.max(1.2, options.strokeWidth * 0.7), roughness: 0.6, fill: undefined };
    const palette = ["blue", "orange", "green", "purple", "teal", "pink", "red", "yellow"];
    const unit = element.unit ? String(element.unit) : "";
    const format = (value) => `${Number.isInteger(value) ? value : value.toFixed(1)}${unit}`;

    if (element.kind === "pie") {
      const total = data.reduce((sum, item) => sum + Math.max(0, item.value), 0) || 1;
      const radius = Math.min(w, h) / 2 - labelSize;
      const cx = x + w / 2;
      const cy = y + h / 2;
      let start = -Math.PI / 2;
      data.forEach((item, index) => {
        const sweep = (Math.max(0, item.value) / total) * Math.PI * 2;
        const colorName = item.color || palette[index % palette.length];
        add(rc.arc(cx, cy, radius * 2, radius * 2, start, start + sweep, true, { ...options, stroke: strokeColor(colorName), fill: fillColor(true, colorName), fillStyle: "solid" }));
        const middle = start + sweep / 2;
        add(handText(cx + Math.cos(middle) * radius * 0.62, cy + Math.sin(middle) * radius * 0.62, `${item.label}\n${format(item.value)}`, { size: labelSize, color: colorName }));
        start += sweep;
      });
      return;
    }

    const axisBottom = y + h - labelSize * 1.6;
    const axisLeft = x + labelSize * 0.6;
    const plotHeight = axisBottom - y - labelSize * 1.4;
    const max = num(element.max, Math.max(...data.map((item) => item.value), 0)) || 1;
    add(rc.linearPath([[axisLeft, y], [axisLeft, axisBottom], [x + w, axisBottom]], thin));
    const slot = (x + w - axisLeft) / data.length;
    const points = [];
    data.forEach((item, index) => {
      const centerX = axisLeft + slot * (index + 0.5);
      const top = axisBottom - (Math.max(0, item.value) / max) * plotHeight;
      const colorName = item.color || element.color || "blue";
      if (element.kind === "line") {
        points.push([centerX, top]);
      } else {
        const barWidth = slot * 0.58;
        add(rc.rectangle(centerX - barWidth / 2, top, barWidth, axisBottom - top, { ...options, stroke: strokeColor(colorName), fill: fillColor(true, colorName), fillStyle: "solid" }));
      }
      add(handText(centerX, top - labelSize * 0.7, format(item.value), { size: labelSize, color: colorName, weight: 700 }));
      add(handText(centerX, axisBottom + labelSize * 0.8, item.label, { size: labelSize, color: "ink", maxWidth: slot + 10 }));
    });
    if (points.length >= 2) add(rc.curve(points, { ...options, fill: undefined }));
    for (const [px, py] of points) add(rc.circle(px, py, 9, { ...options, fill: options.stroke, fillStyle: "solid" }));
  }

  /** A ruled table: rows of strings, first row bold on a tint when header !== false. */
  function drawTable(rc, layer, element, options, size, add) {
    const rows = (element.rows || []).filter(Array.isArray);
    if (!rows.length) return;
    const [x, y] = layer.p(num(element.x, 0), num(element.y, 0));
    const w = layer.s(num(element.w, 360));
    const columns = Math.max(...rows.map((row) => row.length));
    const rowHeight = layer.s(num(element.rowH, size * 1.7));
    const cellSize = num(element.size, size * 0.8);
    const h = rowHeight * rows.length;
    const columnWidth = w / columns;
    const thin = { ...options, strokeWidth: Math.max(1.1, options.strokeWidth * 0.6), roughness: 0.5, fill: undefined };
    const hasHeader = element.header !== false;
    if (hasHeader) add(rc.rectangle(x, y, w, rowHeight, { ...thin, stroke: "none", fill: fillColor(true, element.color || "blue"), fillStyle: "solid" }));
    add(rc.rectangle(x, y, w, h, { ...options, fill: undefined }));
    for (let row = 1; row < rows.length; row++) add(rc.line(x, y + row * rowHeight, x + w, y + row * rowHeight, thin));
    for (let column = 1; column < columns; column++) add(rc.line(x + column * columnWidth, y, x + column * columnWidth, y + h, thin));
    rows.forEach((row, rowIndex) => {
      row.forEach((cell, columnIndex) => {
        add(handText(x + columnWidth * (columnIndex + 0.5), y + rowHeight * (rowIndex + 0.5), String(cell), {
          size: cellSize,
          color: hasHeader && rowIndex === 0 ? strokeColor(element.color || "blue") : "ink",
          weight: hasHeader && rowIndex === 0 ? 700 : 500,
          maxWidth: columnWidth - 8,
        }));
      });
    });
  }

  // ------------------------------------------------------------ icons

  /**
   * Hand-drawn pictograms, drawn in a unit box (-0.5..0.5) scaled to `size`
   * and centred on cx,cy. Returns the rough nodes; unknown names fall back to
   * a circle with the name's first letter.
   */
  function drawIcon(rc, name, cx, cy, size, options) {
    const s = size;
    const X = (u) => cx + u * s;
    const Y = (v) => cy + v * s;
    const o = { ...options, roughness: Math.min(num(options.roughness, 1), 0.85), fill: undefined };
    const solid = { ...o, fill: options.stroke, fillStyle: "solid" };
    const tint = options.fill ? { ...o, fill: options.fill, fillStyle: "solid" } : o;
    const out = [];
    const map = (points) => points.map(([u, v]) => [X(u), Y(v)]);
    const rect = (x, y, w, h, opt = o) => out.push(rc.rectangle(X(x), Y(y), w * s, h * s, opt));
    const circ = (x, y, d, opt = o) => out.push(rc.circle(X(x), Y(y), d * s, opt));
    const ell = (x, y, w, h, opt = o) => out.push(rc.ellipse(X(x), Y(y), w * s, h * s, opt));
    const line = (points, opt = o) => out.push(rc.linearPath(map(points), opt));
    const poly = (points, opt = o) => out.push(rc.polygon(map(points), opt));
    const curve = (points, opt = o) => out.push(rc.curve(map(points), opt));
    const arc = (x, y, w, h, start, stop, opt = o) => out.push(rc.arc(X(x), Y(y), w * s, h * s, start, stop, false, opt));
    const dot = (x, y, d = 0.08) => circ(x, y, d, solid);
    const PI = Math.PI;
    switch (String(name || "").toLowerCase()) {
      case "person":
      case "user":
        circ(0, -0.24, 0.34, tint);
        arc(0, 0.44, 0.76, 0.74, PI, 2 * PI);
        line([[-0.38, 0.44], [0.38, 0.44]]);
        break;
      case "people":
      case "team":
        circ(-0.18, -0.2, 0.26, tint);
        arc(-0.18, 0.4, 0.56, 0.6, PI, 2 * PI);
        circ(0.2, -0.26, 0.26, tint);
        arc(0.2, 0.34, 0.56, 0.6, PI, 2 * PI);
        break;
      case "server":
        for (const y of [-0.45, -0.14, 0.17]) {
          rect(-0.36, y, 0.72, 0.27, tint);
          dot(0.22, y + 0.135, 0.07);
          line([[-0.24, y + 0.135], [0.04, y + 0.135]]);
        }
        break;
      case "database":
      case "db":
        ell(0, -0.32, 0.7, 0.22, tint);
        line([[-0.35, -0.32], [-0.35, 0.32]]);
        line([[0.35, -0.32], [0.35, 0.32]]);
        arc(0, 0, 0.7, 0.22, 0, PI);
        arc(0, 0.32, 0.7, 0.22, 0, PI);
        break;
      case "cloud": {
        const d = `M ${X(-0.36)} ${Y(0.2)} A ${0.16 * s} ${0.16 * s} 0 0 1 ${X(-0.28)} ${Y(-0.1)} A ${0.22 * s} ${0.22 * s} 0 0 1 ${X(0.1)} ${Y(-0.22)} A ${0.19 * s} ${0.19 * s} 0 0 1 ${X(0.38)} ${Y(0.02)} A ${0.1 * s} ${0.1 * s} 0 0 1 ${X(0.34)} ${Y(0.2)} Z`;
        out.push(rc.path(d, tint));
        break;
      }
      case "document":
      case "file":
        poly([[-0.3, -0.45], [0.14, -0.45], [0.3, -0.29], [0.3, 0.45], [-0.3, 0.45]], tint);
        line([[0.14, -0.45], [0.14, -0.29], [0.3, -0.29]]);
        for (const y of [-0.12, 0.06, 0.24]) line([[-0.18, y], [0.18, y]]);
        break;
      case "folder":
        poly([[-0.44, -0.3], [-0.12, -0.3], [-0.02, -0.19], [0.44, -0.19], [0.44, 0.34], [-0.44, 0.34]], tint);
        break;
      case "lock":
        arc(0, -0.08, 0.42, 0.62, PI, 2 * PI);
        line([[-0.21, -0.08], [-0.21, 0]]);
        line([[0.21, -0.08], [0.21, 0]]);
        rect(-0.32, 0, 0.64, 0.44, tint);
        dot(0, 0.2, 0.1);
        break;
      case "key":
        circ(-0.24, 0, 0.32, tint);
        line([[-0.08, 0], [0.44, 0]]);
        line([[0.3, 0], [0.3, 0.14]]);
        line([[0.4, 0], [0.4, 0.11]]);
        break;
      case "gear":
      case "settings": {
        const teeth = 8;
        const points = [];
        for (let index = 0; index < teeth * 2; index++) {
          const angle = (index / (teeth * 2)) * 2 * PI;
          const radius = index % 2 === 0 ? 0.46 : 0.34;
          points.push([Math.cos(angle - 0.12) * radius, Math.sin(angle - 0.12) * radius], [Math.cos(angle + 0.12) * radius, Math.sin(angle + 0.12) * radius]);
        }
        poly(points, tint);
        circ(0, 0, 0.28);
        break;
      }
      case "globe":
      case "internet":
      case "web":
        circ(0, 0, 0.88, tint);
        ell(0, 0, 0.38, 0.88);
        line([[-0.44, 0], [0.44, 0]]);
        line([[-0.37, -0.22], [0.37, -0.22]]);
        line([[-0.37, 0.22], [0.37, 0.22]]);
        break;
      case "phone":
      case "mobile":
        rect(-0.22, -0.46, 0.44, 0.92, tint);
        line([[-0.06, 0.36], [0.06, 0.36]]);
        break;
      case "laptop":
        rect(-0.32, -0.34, 0.64, 0.44, tint);
        poly([[-0.42, 0.12], [0.42, 0.12], [0.5, 0.26], [-0.5, 0.26]]);
        break;
      case "monitor":
      case "screen":
      case "computer":
        rect(-0.44, -0.38, 0.88, 0.56, tint);
        line([[0, 0.18], [0, 0.34]]);
        line([[-0.2, 0.36], [0.2, 0.36]]);
        break;
      case "battery":
        rect(-0.44, -0.2, 0.8, 0.4);
        rect(0.36, -0.08, 0.08, 0.16, solid);
        rect(-0.38, -0.14, 0.42, 0.28, solid);
        break;
      case "bolt":
      case "lightning":
      case "power":
      case "energy":
        poly([[0.08, -0.48], [-0.26, 0.06], [-0.02, 0.06], [-0.1, 0.48], [0.26, -0.08], [0.03, -0.08]], tint);
        break;
      case "clock":
      case "time":
        circ(0, 0, 0.88, tint);
        line([[0, -0.28], [0, 0], [0.2, 0.12]]);
        break;
      case "mail":
      case "email":
      case "message":
        rect(-0.44, -0.3, 0.88, 0.6, tint);
        line([[-0.44, -0.3], [0, 0.06], [0.44, -0.3]]);
        break;
      case "chip":
      case "cpu":
        for (const t of [-0.16, 0, 0.16]) {
          line([[t, -0.28], [t, -0.42]]);
          line([[t, 0.28], [t, 0.42]]);
          line([[-0.28, t], [-0.42, t]]);
          line([[0.28, t], [0.42, t]]);
        }
        rect(-0.28, -0.28, 0.56, 0.56, tint);
        rect(-0.12, -0.12, 0.24, 0.24);
        break;
      case "wifi":
      case "signal":
      case "wireless":
        for (const r of [0.3, 0.6, 0.9]) arc(0, 0.32, r, r, 1.25 * PI, 1.75 * PI);
        dot(0, 0.32, 0.1);
        break;
      case "search":
      case "magnifier":
        circ(-0.08, -0.08, 0.56, tint);
        line([[0.12, 0.12], [0.42, 0.42]], { ...o, strokeWidth: o.strokeWidth * 1.6 });
        break;
      case "check":
      case "yes":
        line([[-0.36, 0], [-0.1, 0.28], [0.38, -0.32]], { ...o, strokeWidth: o.strokeWidth * 1.5 });
        break;
      case "cross":
      case "x":
      case "no":
        line([[-0.3, -0.3], [0.3, 0.3]], { ...o, strokeWidth: o.strokeWidth * 1.5 });
        line([[0.3, -0.3], [-0.3, 0.3]], { ...o, strokeWidth: o.strokeWidth * 1.5 });
        break;
      case "warning":
      case "alert":
        poly([[0, -0.46], [0.46, 0.38], [-0.46, 0.38]], tint);
        line([[0, -0.14], [0, 0.12]]);
        dot(0, 0.25, 0.08);
        break;
      case "heart":
        curve([[0, 0.4], [-0.3, 0.12], [-0.42, -0.14], [-0.3, -0.36], [-0.1, -0.34], [0, -0.18], [0.1, -0.34], [0.3, -0.36], [0.42, -0.14], [0.3, 0.12], [0, 0.4]], tint);
        break;
      case "star": {
        const points = [];
        for (let index = 0; index < 10; index++) {
          const angle = -PI / 2 + (index * PI) / 5;
          const radius = index % 2 === 0 ? 0.48 : 0.2;
          points.push([Math.cos(angle) * radius, Math.sin(angle) * radius + 0.04]);
        }
        poly(points, tint);
        break;
      }
      case "idea":
      case "bulb":
      case "lightbulb":
        circ(0, -0.12, 0.54, tint);
        rect(-0.12, 0.16, 0.24, 0.18);
        line([[-0.08, 0.42], [0.08, 0.42]]);
        for (const [a, b] of [[-0.46, -0.12], [0.46, -0.12], [-0.36, -0.44], [0.36, -0.44]]) line([[a * 0.82, b * 0.9], [a, b]]);
        break;
      case "money":
      case "coin":
      case "cost":
        circ(0, 0, 0.84, tint);
        circ(0, 0, 0.6);
        line([[0.1, -0.14], [-0.08, -0.14], [-0.1, 0], [0.1, 0], [0.08, 0.14], [-0.1, 0.14]]);
        line([[0, -0.22], [0, 0.22]]);
        break;
      case "chart":
      case "graph":
      case "analytics":
        line([[-0.42, -0.44], [-0.42, 0.4], [0.44, 0.4]]);
        rect(-0.3, 0.06, 0.16, 0.34, tint);
        rect(-0.06, -0.14, 0.16, 0.54, tint);
        rect(0.18, -0.34, 0.16, 0.74, tint);
        break;
      case "code":
        line([[-0.14, -0.26], [-0.42, 0], [-0.14, 0.26]]);
        line([[0.14, -0.26], [0.42, 0], [0.14, 0.26]]);
        line([[0.08, -0.34], [-0.08, 0.34]]);
        break;
      case "terminal":
      case "console":
        rect(-0.46, -0.36, 0.92, 0.72, tint);
        line([[-0.3, -0.12], [-0.14, 0], [-0.3, 0.12]]);
        line([[-0.06, 0.14], [0.18, 0.14]]);
        break;
      case "fire":
      case "flame":
      case "heat":
        curve([[0, 0.44], [-0.3, 0.3], [-0.32, 0], [-0.12, -0.2], [-0.04, -0.46], [0.16, -0.22], [0.32, 0.02], [0.3, 0.3], [0, 0.44]], tint);
        break;
      case "water":
      case "drop":
      case "liquid":
        curve([[0, -0.46], [0.18, -0.18], [0.3, 0.1], [0.2, 0.36], [0, 0.44], [-0.2, 0.36], [-0.3, 0.1], [-0.18, -0.18], [0, -0.46]], tint);
        break;
      case "sun":
      case "light":
        circ(0, 0, 0.46, tint);
        for (let index = 0; index < 8; index++) {
          const angle = (index * PI) / 4;
          line([[Math.cos(angle) * 0.32, Math.sin(angle) * 0.32], [Math.cos(angle) * 0.47, Math.sin(angle) * 0.47]]);
        }
        break;
      case "leaf":
      case "plant":
        curve([[-0.36, 0.36], [-0.3, -0.1], [0.04, -0.38], [0.42, -0.42], [0.34, 0.0], [0.06, 0.3], [-0.36, 0.36]], tint);
        line([[-0.36, 0.36], [0.2, -0.2]]);
        break;
      case "eye":
      case "view":
        curve([[-0.46, 0], [-0.2, -0.24], [0.2, -0.24], [0.46, 0]]);
        curve([[-0.46, 0], [-0.2, 0.24], [0.2, 0.24], [0.46, 0]]);
        circ(0, 0, 0.3, tint);
        dot(0, 0, 0.1);
        break;
      case "home":
      case "house":
        poly([[-0.46, -0.02], [0, -0.44], [0.46, -0.02]], tint);
        rect(-0.34, -0.02, 0.68, 0.44);
        rect(-0.08, 0.16, 0.16, 0.26);
        break;
      case "cart":
      case "shop":
        line([[-0.46, -0.32], [-0.32, -0.32], [-0.2, 0.18], [0.32, 0.18], [0.42, -0.18], [-0.27, -0.18]]);
        circ(-0.14, 0.34, 0.14);
        circ(0.26, 0.34, 0.14);
        break;
      case "brain":
      case "ai":
      case "mind":
        curve([[0, -0.38], [-0.22, -0.4], [-0.4, -0.22], [-0.42, 0.06], [-0.3, 0.3], [-0.06, 0.38], [0, 0.3]], tint);
        curve([[0, -0.38], [0.22, -0.4], [0.4, -0.22], [0.42, 0.06], [0.3, 0.3], [0.06, 0.38], [0, 0.3]], tint);
        line([[0, -0.38], [0, 0.3]]);
        curve([[-0.3, -0.06], [-0.16, 0.0], [-0.12, 0.16]]);
        curve([[0.3, -0.06], [0.16, 0.0], [0.12, 0.16]]);
        break;
      case "atom": {
        for (const angle of [0, 60, -60]) {
          const group = svgElement("g", { transform: `rotate(${angle} ${cx} ${cy})` });
          group.appendChild(rc.ellipse(cx, cy, 0.95 * s, 0.34 * s, o));
          out.push(group);
        }
        dot(0, 0, 0.14);
        break;
      }
      case "lock-open":
      case "unlock":
        arc(0.2, -0.1, 0.42, 0.6, PI, 2 * PI);
        rect(-0.32, 0, 0.64, 0.44, tint);
        dot(0, 0.2, 0.1);
        break;
      case "api":
      case "plug":
        rect(-0.2, -0.1, 0.4, 0.3, tint);
        line([[-0.1, -0.1], [-0.1, -0.36]]);
        line([[0.1, -0.1], [0.1, -0.36]]);
        curve([[0, 0.2], [0, 0.34], [0.18, 0.44]]);
        break;
      case "rocket":
      case "launch":
        curve([[0, -0.48], [0.16, -0.24], [0.16, 0.2], [-0.16, 0.2], [-0.16, -0.24], [0, -0.48]], tint);
        poly([[-0.16, 0.06], [-0.32, 0.3], [-0.16, 0.24]]);
        poly([[0.16, 0.06], [0.32, 0.3], [0.16, 0.24]]);
        circ(0, -0.12, 0.14);
        line([[0, 0.26], [0, 0.44]], { ...o, stroke: COLORS.orange });
        break;
      default: {
        circ(0, 0, 0.84, tint);
        const letter = handText(cx, cy, String(name || "?").charAt(0).toUpperCase(), { size: s * 0.5, color: options.stroke, weight: 700 });
        out.push(letter);
      }
    }
    return out;
  }

  // ------------------------------------------------------------ card

  function buildCard(state) {
    const visual = state.visual;
    const spec = visual.card || {};
    const width = num(spec.w, 760);
    const height = num(spec.h, 480);
    const chrome = (visual.title ? 44 : 0) + (visual.subtitle ? 18 : 0) + 34;
    const scale = Math.min((innerWidth * 0.44) / width, (innerHeight * 0.74 - chrome) / height, 1.15);

    const card = htmlElement("div", "card");
    card.title = "click to close";
    card.addEventListener("click", requestDismiss);
    card.appendChild(closeButton());
    if (visual.subtitle) card.appendChild(htmlElement("div", "card-caption", visual.subtitle));
    if (visual.title) card.appendChild(htmlElement("div", "card-title", visual.title));
    const svg = svgElement("svg", {
      width: Math.round(width * scale),
      height: Math.round(height * scale),
      viewBox: `0 0 ${width} ${height}`,
    });
    card.appendChild(svg);
    card.style.width = `${Math.round(width * scale) + 36}px`;
    card.style.visibility = "hidden";
    document.body.appendChild(card);

    // offsetWidth/Height ignore the entrance transform, so placement is exact.
    const [left, top] = placeCard(spec.place, card.offsetWidth, card.offsetHeight, state);
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
    card.style.visibility = "";
    state.card = card;
    state.cardSvg = svg;
    state.cardSize = { width, height, scale };
    reportInteractiveArea();
  }

  /** Grows the card when Claude drew past its edges, keeping it on screen. */
  function fitCardToContent(state) {
    const { card, cardSvg: svg, cardSize } = state;
    if (!card) return;
    const box = svg.getBBox();
    const padding = 14;
    const minX = Math.min(cardSize.minX || 0, box.x - padding);
    const minY = Math.min(cardSize.minY || 0, box.y - padding);
    const width = Math.max(cardSize.width + (cardSize.minX || 0) - minX, box.x + box.width + padding - minX);
    const height = Math.max(cardSize.height + (cardSize.minY || 0) - minY, box.y + box.height + padding - minY);
    if (width === cardSize.width && height === cardSize.height && minX === (cardSize.minX || 0) && minY === (cardSize.minY || 0)) return;
    cardSize.minX = minX;
    cardSize.minY = minY;
    // Shrink the scale if needed so the grown card still fits the monitor.
    const scale = Math.min(cardSize.scale, (innerWidth * 0.5) / width, (innerHeight * 0.88 - 100) / height);
    Object.assign(cardSize, { width, height, scale });
    svg.setAttribute("viewBox", `${minX} ${minY} ${width} ${height}`);
    svg.setAttribute("width", Math.round(width * scale));
    svg.setAttribute("height", Math.round(height * scale));
    card.style.width = `${Math.round(width * scale) + 36}px`;
    const left = Math.min(card.offsetLeft, innerWidth - card.offsetWidth - 20);
    const top = Math.min(card.offsetTop, innerHeight - card.offsetHeight - 20);
    card.style.left = `${Math.max(20, left)}px`;
    card.style.top = `${Math.max(20, top)}px`;
    reportInteractiveArea();
  }

  function placeCard(place, cardWidth, cardHeight, state) {
    const margin = 40;
    let x;
    let y;
    const anchor = point(place);
    if (anchor) {
      x = anchor[0] * state.scaleX;
      y = anchor[1] * state.scaleY;
    } else {
      const centredX = (innerWidth - cardWidth) / 2;
      const centredY = (innerHeight - cardHeight) / 2;
      switch (place) {
        case "left":
          [x, y] = [margin, centredY];
          break;
        case "center":
          [x, y] = [centredX, centredY];
          break;
        case "top":
          [x, y] = [centredX, margin];
          break;
        case "bottom":
          [x, y] = [centredX, innerHeight - cardHeight - margin];
          break;
        case "top-left":
          [x, y] = [margin, margin];
          break;
        case "top-right":
          [x, y] = [innerWidth - cardWidth - margin, margin];
          break;
        case "bottom-left":
          [x, y] = [margin, innerHeight - cardHeight - margin];
          break;
        case "bottom-right":
          [x, y] = [innerWidth - cardWidth - margin, innerHeight - cardHeight - margin];
          break;
        default:
          [x, y] = [innerWidth - cardWidth - margin, centredY];
      }
    }
    const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));
    return [clamp(x, margin / 2, innerWidth - cardWidth - margin / 2), clamp(y, margin / 2, innerHeight - cardHeight - margin / 2)];
  }

  // ------------------------------------------------------------ elements

  /** Coordinate mapping for one layer: card units or screenshot pixels. */
  // ------------------------------------------------------------ isometric
  // Grid coordinates [gx, gy, gz]: gx runs down-right, gy down-left, gz up.
  // One grid unit is "unit" card units; "origin" is where [0,0,0] lands.
  const COS30 = Math.cos(Math.PI / 6);
  function isoSpace(state, element) {
    const shared = state.visual.iso || {};
    const origin = point(element.origin) || point(shared.origin) || [num(state.visual.card?.w, 760) / 2, num(state.visual.card?.h, 480) * 0.3];
    const unit = num(element.unit, num(shared.unit, 40));
    const project = (gx, gy, gz = 0) => [origin[0] + (gx - gy) * unit * COS30, origin[1] + (gx + gy) * unit * 0.5 - gz * unit];
    return { origin, unit, project, rough: num(element.roughness, num(shared.roughness, 0.7)) };
  }
  const iso3 = (value, fallback = [0, 0, 0]) =>
    Array.isArray(value) ? [num(value[0], fallback[0]), num(value[1], fallback[1]), num(value[2], fallback[2])] : [...fallback];

  /** Mixes a hex colour toward another ("#fff" lightens, "#000" darkens). */
  function mixColor(hex, target, t) {
    const parse = (value) => {
      let v = String(value).replace("#", "");
      if (v.length === 3) v = v.split("").map((c) => c + c).join("");
      return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) || 0);
    };
    const a = parse(hex);
    const b = parse(target);
    return `#${a.map((c, i) => Math.round(c + (b[i] - c) * t).toString(16).padStart(2, "0")).join("")}`;
  }

  /** Top, left and right face tones for an isometric solid: lit from the top-left. */
  function isoTones(element, colorName) {
    const base = isCssColor(element.fill) ? element.fill : strokeColor(colorName);
    const light = element.tone === "dark" ? 0.25 : element.tone === "vivid" ? 0.35 : 0.62;
    return {
      top: mixColor(base, "#ffffff", light + 0.18),
      left: mixColor(base, "#ffffff", light - 0.08),
      right: mixColor(base, "#ffffff", Math.max(0, light - 0.32)),
      edge: mixColor(base, "#000000", 0.35),
    };
  }

  /** Text lying on an isometric face ("top", "left", "right") or upright ("above"). */
  function isoFaceText(cx, cy, text, face, { size, color, maxWidth, weight = 700 }) {
    const node = handText(0, 0, text, { size, color, maxWidth, weight });
    const matrix = { top: [COS30, 0.5, -COS30, 0.5], left: [COS30, 0.5, 0, 1], right: [COS30, -0.5, 0, 1] }[face];
    const wrapper = svgElement("g", { transform: matrix ? `matrix(${matrix.join(" ")} ${cx} ${cy})` : `translate(${cx} ${cy})` });
    wrapper.appendChild(node);
    return wrapper;
  }

  /** The <g> that keeps isometric solids in painter's order under the annotations. */
  function isoLayerOf(state, svg) {
    state.isoLayers = state.isoLayers || new Map();
    let layer = state.isoLayers.get(svg);
    if (!layer || !layer.isConnected) {
      layer = svgElement("g", { class: "iso-layer" });
      svg.insertBefore(layer, svg.firstChild);
      state.isoLayers.set(svg, layer);
    }
    return layer;
  }

  function drawIso(state, element, layer, rc, options, size, add, addLabel) {
    const space = isoSpace(state, element);
    const P = (gx, gy, gz) => layer.p(...space.project(gx, gy, gz));
    const colorName = element.color || "blue";
    const tones = isoTones(element, colorName);
    const solid = (fill) => ({ ...options, stroke: tones.edge, strokeWidth: num(element.width, 1.6), roughness: space.rough, bowing: 0.6, fill, fillStyle: "solid" });
    const labelColor = element.textColor || "ink";
    switch (element.type) {
      case "isogrid": {
        // A diamond floor with grid lines: the stage everything stands on.
        const [gx, gy] = iso3(element.at);
        const cols = Math.max(1, Math.round(num(element.cols, 8)));
        const rows = Math.max(1, Math.round(num(element.rows, cols)));
        const floor = [P(gx, gy, 0), P(gx + cols, gy, 0), P(gx + cols, gy + rows, 0), P(gx, gy + rows, 0)];
        const floorColor = element.color ? isoTones(element, element.color).top : "#f3f5f8";
        add(rc.polygon(floor, { ...options, stroke: "#aab2bd", strokeWidth: 1.4, roughness: space.rough * 0.6, fill: floorColor, fillStyle: "solid" }));
        if (element.lines !== false) {
          const thin = { ...options, stroke: "#c9cfd8", strokeWidth: 0.9, roughness: 0.3, fill: undefined };
          for (let c = 1; c < cols; c++) add(rc.line(...P(gx + c, gy, 0), ...P(gx + c, gy + rows, 0), thin));
          for (let r = 1; r < rows; r++) add(rc.line(...P(gx, gy + r, 0), ...P(gx + cols, gy + r, 0), thin));
        }
        if (element.thickness) {
          // A slab edge so the floor reads as a tile, not a sticker.
          const t = num(element.thickness, 0.3);
          add(rc.polygon([P(gx, gy + rows, 0), P(gx + cols, gy + rows, 0), P(gx + cols, gy + rows, -t), P(gx, gy + rows, -t)], solid(mixColor(floorColor, "#000000", 0.08))));
          add(rc.polygon([P(gx + cols, gy, 0), P(gx + cols, gy + rows, 0), P(gx + cols, gy + rows, -t), P(gx + cols, gy, -t)], solid(mixColor(floorColor, "#000000", 0.18))));
        }
        return -1e6 + gx + gy;
      }
      case "isotile": {
        // A flat coloured patch on the floor: a zone, road, room or region.
        const [gx, gy, gz] = iso3(element.at);
        const [sx, sy] = iso3(element.size, [2, 2, 0]);
        add(rc.polygon([P(gx, gy, gz), P(gx + sx, gy, gz), P(gx + sx, gy + sy, gz), P(gx, gy + sy, gz)], { ...solid(element.fill === false ? undefined : tones.top), strokeLineDash: element.dashed ? [8, 6] : undefined }));
        if (element.label) addLabel(isoFaceText(...P(gx + sx / 2, gy + sy / 2, gz), element.label, "top", { size: size * 0.9, color: element.textColor || colorName, maxWidth: Math.min(sx, sy) * space.unit * 1.1 }));
        return -1e5 + gx + gy + gz;
      }
      case "isobox": {
        // A solid block: servers, buildings, layers of a stack, rooms, chips.
        const [gx, gy, gz] = iso3(element.at);
        const [sx, sy, sz] = iso3(element.size, [1, 1, 1]);
        const x2 = gx + sx;
        const y2 = gy + sy;
        const z2 = gz + sz;
        add(rc.polygon([P(gx, y2, gz), P(x2, y2, gz), P(x2, y2, z2), P(gx, y2, z2)], solid(tones.left)));
        add(rc.polygon([P(x2, gy, gz), P(x2, y2, gz), P(x2, y2, z2), P(x2, gy, z2)], solid(tones.right)));
        add(rc.polygon([P(gx, gy, z2), P(x2, gy, z2), P(x2, y2, z2), P(gx, y2, z2)], solid(tones.top)));
        if (element.stripes) {
          // Horizontal bands on the front faces (server bays, floors of a building).
          const bands = Math.max(1, Math.round(num(element.stripes, 3)));
          const thin = { ...options, stroke: tones.edge, strokeWidth: 1, roughness: 0.4, fill: undefined };
          for (let b = 1; b <= bands; b++) {
            const z = gz + (sz * b) / (bands + 1);
            add(rc.line(...P(gx + sx * 0.08, y2, z), ...P(x2 - sx * 0.04, y2, z), thin));
            add(rc.line(...P(x2, y2 - sy * 0.04, z), ...P(x2, gy + sy * 0.08, z), thin));
          }
        }
        if (element.windows) {
          // Small lit squares on the right face: a building, a rack of leds.
          const dots = Math.max(1, Math.round(num(element.windows, 3)));
          const rowsOf = Math.max(1, Math.round(sz / Math.max(0.35, sy / dots) * 0.7));
          for (let r = 0; r < rowsOf; r++) for (let d = 0; d < dots; d++) {
            const yy = gy + (sy * (d + 0.3)) / dots;
            const zz = gz + (sz * (r + 0.3)) / rowsOf;
            const w = (sy / dots) * 0.4;
            const h = (sz / rowsOf) * 0.4;
            add(rc.polygon([P(x2, yy, zz), P(x2, yy + w, zz), P(x2, yy + w, zz + h), P(x2, yy, zz + h)], { ...solid(element.windowColor ? strokeColor(element.windowColor) : "#ffe8a3"), strokeWidth: 0.8, roughness: 0.3 }));
          }
        }
        if (element.icon) {
          // An icon standing on the top face.
          const [ix, iy] = P(gx + sx / 2, gy + sy / 2, z2);
          const iconSize = Math.min(sx, sy) * space.unit * 0.9;
          const icons = drawIcon(rc, element.icon, ix, iy - iconSize * 0.35, iconSize, { ...options, stroke: tones.edge, fill: undefined });
          icons.forEach(add);
        }
        const face = element.labelOn || (element.icon || element.stripes || element.windows || element.sub ? "above" : sz > Math.max(sx, sy) * 1.2 ? "left" : "top");
        if (element.label) {
          const at = {
            top: [gx + sx / 2, gy + sy / 2, z2],
            left: [gx + sx / 2, y2, gz + sz / 2],
            right: [x2, gy + sy / 2, gz + sz / 2],
            above: [gx + sx / 2, gy + sy / 2, z2],
          }[face] || [gx + sx / 2, gy + sy / 2, z2];
          let [lx, ly] = P(...at);
          if (face === "above") ly -= (element.icon ? Math.min(sx, sy) * space.unit * 1.05 : size * 0.9) + (element.sub ? size * 0.75 : 0);
          const span = (face === "right" ? sy : sx) * space.unit * 0.95;
          const labelSize = num(element.size, size * 0.85);
          addLabel(isoFaceText(lx, ly, element.label, face, { size: labelSize, color: labelColor, maxWidth: face === "above" ? span + 140 : span }));
          if (element.sub) {
            const subNode = subText(0, labelSize * 0.95, element.sub, labelSize * 0.62, face === "above" ? span + 160 : span * 1.2);
            const holder = isoFaceText(lx, ly, "", face, { size: labelSize, color: labelColor, maxWidth: span });
            holder.appendChild(subNode);
            addLabel(holder);
          }
        }
        // Painter's order: things nearer the viewer (bigger gx+gy, higher) draw later.
        return gx + sx / 2 + gy + sy / 2 + (gz + sz / 2) * 0.5;
      }
      case "isocylinder": {
        // Tanks, databases, pillars, coins, chimneys: a circle on the floor of radius r.
        const [gx, gy, gz] = iso3(element.at);
        const r = num(element.r, 0.5);
        const h = num(element.h, 1);
        const [cx, cyBase] = P(gx, gy, gz);
        const [, cyTop] = P(gx, gy, gz + h);
        const scale = layer.s(space.unit);
        const rx = r * scale * COS30 * Math.SQRT2;
        const ry = r * scale * 0.5 * Math.SQRT2;
        const side = `M ${cx - rx} ${cyTop} L ${cx - rx} ${cyBase} A ${rx} ${ry} 0 0 0 ${cx + rx} ${cyBase} L ${cx + rx} ${cyTop} Z`;
        add(rc.path(side, solid(tones.left)));
        // Darker right half of the side for the iso lighting.
        add(rc.path(`M ${cx} ${cyTop + ry} L ${cx} ${cyBase + ry} A ${rx} ${ry} 0 0 0 ${cx + rx} ${cyBase} L ${cx + rx} ${cyTop} A ${rx} ${ry} 0 0 1 ${cx} ${cyTop + ry} Z`, { ...solid(tones.right), stroke: "none" }));
        if (element.bands) {
          const bands = Math.max(1, Math.round(num(element.bands, 2)));
          for (let b = 1; b <= bands; b++) {
            const y = cyBase + ((cyTop - cyBase) * b) / (bands + 1);
            add(rc.path(`M ${cx - rx} ${y} A ${rx} ${ry} 0 0 0 ${cx + rx} ${y}`, { ...options, stroke: tones.edge, strokeWidth: 1.2, roughness: 0.4, fill: undefined }));
          }
        }
        add(rc.ellipse(cx, cyTop, rx * 2, ry * 2, solid(tones.top)));
        if (element.label) {
          const above = element.labelOn === "above" || !element.labelOn;
          const ly = above ? cyTop - ry - size * (element.sub ? 1.45 : 0.75) : cyTop;
          addLabel(isoFaceText(cx, ly, element.label, above ? "above" : "top", { size: num(element.size, size * 0.85), color: labelColor, maxWidth: rx * 2 + (above ? 120 : 0) }));
          if (element.sub && above) addLabel(subText(cx, ly + size * 0.78, element.sub, size * 0.55, rx * 2 + 140));
        }
        return gx + gy + (gz + h / 2) * 0.5;
      }
      case "isoarrow":
      case "isopath": {
        // A route across the iso floor (data hops, people walking, pipes); last point gets a head.
        const points = (element.points || [element.from, element.to]).filter(Array.isArray).map((p) => P(...iso3(p)));
        if (points.length < 2) return null;
        const stroke = strokeColor(element.color || "ink");
        const lineOptions = { ...options, stroke, strokeWidth: num(element.width, 2.6), roughness: space.rough, fill: undefined };
        add(rc.linearPath(points, lineOptions));
        if (element.type === "isoarrow" || element.head) {
          const [tipX, tipY] = points[points.length - 1];
          const [fromX, fromY] = points[points.length - 2];
          const angle = Math.atan2(tipY - fromY, tipX - fromX);
          const headLength = 14;
          const spread = Math.PI * 0.83;
          add(rc.linearPath([[tipX + headLength * Math.cos(angle + spread), tipY + headLength * Math.sin(angle + spread)], [tipX, tipY], [tipX + headLength * Math.cos(angle - spread), tipY + headLength * Math.sin(angle - spread)]], { ...lineOptions, roughness: 0.5 }));
        }
        if (element.flow) {
          const d = `M ${points.map((p) => p.join(" ")).join(" L ")}`;
          let length = 0;
          for (let i = 1; i < points.length; i++) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
          const duration = Math.max(1.2, length / 140);
          const dots = Math.max(2, Math.min(6, Math.round(length / 90)));
          for (let index = 0; index < dots; index++) {
            const dot = svgElement("circle", { r: 4.5, fill: stroke, opacity: 0.9, class: "flow-dot" });
            dot.appendChild(svgElement("animateMotion", { dur: `${duration}s`, repeatCount: "indefinite", path: d, begin: `${(index * duration) / dots}s` }));
            add(dot);
          }
        }
        if (element.label) {
          const mid = points[Math.floor((points.length - 1) / 2)];
          const next = points[Math.floor((points.length - 1) / 2) + 1];
          addLabel(handText((mid[0] + next[0]) / 2, (mid[1] + next[1]) / 2 - size * 0.8, element.label, { size: size * 0.85, color: element.color || "ink", maxWidth: 200 }));
        }
        return null; // routes sit above the solids
      }
      default:
        return null;
    }
  }

  function layerFor(state, element) {
    if (element.on === "screen") {
      const { scaleX, scaleY } = state;
      return {
        svg: state.screenSvg,
        p: (x, y) => [x * scaleX, y * scaleY],
        s: (value) => value * (scaleX + scaleY) / 2,
        strokeWidth: 3,
        fontSize: 26,
      };
    }
    return {
      svg: state.cardSvg,
      p: (x, y) => [x, y],
      s: (value) => value,
      strokeWidth: 2.2,
      fontSize: 22,
    };
  }

  function drawElement(state, element, seed) {
    const layer = layerFor(state, element);
    if (!layer.svg) return null;
    if (Array.isArray(element.iso) && !String(element.type || "").startsWith("iso")) {
      // Any flat element (text, icon, badge, note, callout) can be placed by grid point.
      const [x, y] = isoSpace(state, element).project(...iso3(element.iso));
      element = { ...element, x, y };
    }
    const rc = rough.svg(layer.svg);
    const colorName = element.color || "ink";
    const stroke = strokeColor(colorName);
    const options = {
      stroke,
      strokeWidth: num(element.width, layer.strokeWidth),
      roughness: 1.25,
      bowing: 1.1,
      seed,
    };
    if (element.fill) {
      options.fill = fillColor(element.fill, colorName);
      options.fillStyle = element.fill === "hachure" ? "hachure" : "solid";
      options.hachureGap = 7;
      options.fillWeight = 1.3;
    }
    if (element.dashed) options.strokeLineDash = [9, 7];
    const size = num(element.size, layer.fontSize);
    const group = svgElement("g");
    const add = (node) => node && group.appendChild(node);
    const addAll = (nodes) => nodes.forEach(add);

    if (/^iso(grid|tile|box|cylinder|arrow|path)$/.test(element.type)) {
      // Labels go on a layer above every solid and route, haloed against the paper.
      const labelGroup = svgElement("g", { class: "iso-label" });
      const depth = drawIso(state, element, layer, rc, options, size, add, (node) => node && labelGroup.appendChild(node));
      if (!group.childNodes.length) return null;
      if (labelGroup.childNodes.length) {
        state.isoLabelLayers = state.isoLabelLayers || new Map();
        let top = state.isoLabelLayers.get(layer.svg);
        if (!top || !top.isConnected) {
          top = svgElement("g", { class: "iso-labels" });
          state.isoLabelLayers.set(layer.svg, top);
        }
        layer.svg.appendChild(top); // keep it last, above later drawing too
        top.appendChild(labelGroup);
        group.linked = labelGroup;
      }
      if (depth === null || depth === undefined) {
        layer.svg.appendChild(group);
      } else {
        // Insert in painter's order among the other solids.
        group.dataset.isoDepth = depth;
        const isoLayer = isoLayerOf(state, layer.svg);
        const after = [...isoLayer.children].find((other) => Number(other.dataset.isoDepth) > depth);
        isoLayer.insertBefore(group, after || null);
      }
      return group;
    }

    switch (element.type) {
      case "box": {
        const [x, y] = layer.p(num(element.x, 0), num(element.y, 0));
        const w = layer.s(num(element.w, 120));
        const h = layer.s(num(element.h, 60));
        if (element.rounded !== false && layer.svg === state.cardSvg) {
          const r = Math.min(14, w / 4, h / 4);
          add(rc.path(`M ${x + r} ${y} H ${x + w - r} Q ${x + w} ${y} ${x + w} ${y + r} V ${y + h - r} Q ${x + w} ${y + h} ${x + w - r} ${y + h} H ${x + r} Q ${x} ${y + h} ${x} ${y + h - r} V ${y + r} Q ${x} ${y} ${x + r} ${y} Z`, options));
        } else {
          add(rc.rectangle(x, y, w, h, options));
        }
        // Optional icon on the left, then a label with an optional smaller sub-line.
        let textX = x + w / 2;
        let textWidth = w - 12;
        if (element.icon) {
          const iconSize = Math.min(h * 0.62, 44, w * 0.35);
          addAll(drawIcon(rc, element.icon, x + 10 + iconSize / 2, y + h / 2, iconSize, { ...options, fill: undefined }));
          textX = x + 18 + iconSize + (w - 18 - iconSize) / 2;
          textWidth = w - 24 - iconSize;
        }
        if (element.label && element.sub) {
          // Centre the label plus its wrapped sub-lines as one block, shrinking
          // the text (down to 60%) until it fits inside the box.
          let fit = 1;
          let labelLines;
          let subLines;
          let block;
          let size = num(element.size, layer.fontSize);
          let subSize = size * 0.68;
          for (; fit >= 0.6; fit -= 0.05) {
            size = num(element.size, layer.fontSize) * fit;
            subSize = size * 0.68;
            labelLines = wrapText(element.label, textWidth, size).length;
            subLines = wrapText(element.sub, textWidth * 0.8, subSize).length;
            block = labelLines * size * 1.08 + 4 + subLines * subSize * 1.25;
            if (block <= h - 8) break;
          }
          const top = y + h / 2 - block / 2;
          add(handText(textX, top + (labelLines * size * 1.08) / 2, element.label, { size, color: element.textColor || "ink", maxWidth: textWidth, weight: 700 }));
          add(subText(textX, top + labelLines * size * 1.08 + 4 + subSize * 0.62, element.sub, subSize, textWidth));
        } else if (element.label) {
          let labelSize = size;
          while (labelSize > size * 0.6 && wrapText(element.label, textWidth, labelSize).length * labelSize * 1.08 > h - 6) labelSize *= 0.92;
          add(handText(textX, y + h / 2, element.label, { size: labelSize, color: element.textColor || "ink", maxWidth: textWidth }));
        }
        break;
      }
      case "icon": {
        const [x, y] = layer.p(num(element.x, 0), num(element.y, 0));
        const iconSize = layer.s(num(element.r, 0) ? num(element.r, 0) * 2 : num(element.size, 48));
        const iconOptions = { ...options };
        if (element.fill) iconOptions.fill = fillColor(element.fill, colorName);
        addAll(drawIcon(rc, element.name || element.icon, x, y, iconSize, iconOptions));
        if (element.label) add(handText(x, y + iconSize / 2 + layer.fontSize * 0.75, element.label, { size: layer.fontSize * 0.9, color: element.textColor || "ink", maxWidth: iconSize + 110 }));
        if (element.sub) add(subText(x, y + iconSize / 2 + layer.fontSize * 1.65, element.sub, layer.fontSize * 0.62, iconSize + 120));
        break;
      }
      case "callout": {
        // A thin leader from a dot on the target to a short note.
        const target = layer.p(num(element.x, 0), num(element.y, 0));
        const textPoint = element.tx !== undefined ? layer.p(num(element.tx, 0), num(element.ty, 0)) : [target[0] + 90, target[1] - 50];
        const anchor = textPoint[0] >= target[0] ? "start" : "end";
        const thin = { ...options, strokeWidth: Math.max(1.2, options.strokeWidth * 0.6), roughness: 0.5, fill: undefined };
        add(rc.line(target[0], target[1], textPoint[0] + (anchor === "start" ? -4 : 4), textPoint[1], thin));
        add(rc.circle(target[0], target[1], 8, { ...thin, fill: stroke, fillStyle: "solid" }));
        const calloutSize = num(element.size, layer.fontSize * 0.86);
        const maxWidth = layer.s(num(element.w, 200));
        add(handText(textPoint[0] + (anchor === "start" ? 4 : -4), textPoint[1], element.text ?? element.label ?? "", { size: calloutSize, color: colorName, anchor, maxWidth, weight: 600 }));
        if (element.sub) {
          const lines = wrapText(element.text ?? element.label ?? "", maxWidth, calloutSize).length;
          add(subText(textPoint[0] + (anchor === "start" ? 4 : -4), textPoint[1] + calloutSize * (0.5 + lines * 0.54) + 6, element.sub, calloutSize * 0.66, maxWidth, anchor));
        }
        break;
      }
      case "badge": {
        // Numbered step marker: a solid coloured disc with a white number.
        const [x, y] = layer.p(num(element.x, 0), num(element.y, 0));
        const r = layer.s(num(element.r, 15));
        add(rc.circle(x, y, r * 2, { ...options, fill: stroke, fillStyle: "solid", roughness: 0.7 }));
        const label = handText(x, y + 1, String(element.n ?? element.text ?? element.label ?? ""), { size: r * 1.25, color: "#ffffff", weight: 700 });
        add(label);
        break;
      }
      case "frame": {
        // A dashed region that groups related elements, with a tab label.
        const [x, y] = layer.p(num(element.x, 0), num(element.y, 0));
        const w = layer.s(num(element.w, 200));
        const h = layer.s(num(element.h, 140));
        const frameOptions = { ...options, strokeWidth: Math.max(1.4, options.strokeWidth * 0.75), strokeLineDash: [10, 8], roughness: 0.8 };
        if (element.fill) {
          frameOptions.fill = fillColor(element.fill, colorName);
          frameOptions.fillStyle = "solid";
        }
        add(rc.rectangle(x, y, w, h, frameOptions));
        if (element.label) {
          const tabSize = num(element.size, layer.fontSize * 0.78);
          add(handText(x + 10, y + tabSize * 0.7, element.label, { size: tabSize, color: colorName, anchor: "start", weight: 700 }));
        }
        break;
      }
      case "brace": {
        // Curly brace beside the span from→to, bulging toward "side" (+1/-1).
        const from = point(element.from);
        const to = point(element.to);
        if (!from || !to) return null;
        const [x1, y1] = layer.p(...from);
        const [x2, y2] = layer.p(...to);
        const length = Math.hypot(x2 - x1, y2 - y1) || 1;
        const side = num(element.side, 1) >= 0 ? 1 : -1;
        const nx = (-(y2 - y1) / length) * side;
        const ny = ((x2 - x1) / length) * side;
        const depth = Math.min(18, length * 0.12);
        const at = (t, d) => [x1 + (x2 - x1) * t + nx * d, y1 + (y2 - y1) * t + ny * d];
        add(rc.curve([at(0, 0), at(0.06, depth * 0.55), at(0.25, depth * 0.55), at(0.44, depth * 0.6), at(0.5, depth)], { ...options, fill: undefined }));
        add(rc.curve([at(0.5, depth), at(0.56, depth * 0.6), at(0.75, depth * 0.55), at(0.94, depth * 0.55), at(1, 0)], { ...options, fill: undefined }));
        if (element.label) {
          const [lx, ly] = at(0.5, depth + size * 0.4);
          const anchor = Math.abs(nx) > Math.abs(ny) ? (nx > 0 ? "start" : "end") : "middle";
          add(handText(lx, ly + (anchor === "middle" ? ny * size * 0.5 : 0), element.label, { size: size * 0.9, color: colorName, anchor, maxWidth: 220 }));
        }
        break;
      }
      case "chart":
        drawChart(rc, layer, element, options, size, add);
        break;
      case "table":
        drawTable(rc, layer, element, options, size, add);
        break;
      case "code": {
        // A dark code panel with monospace lines; "mark" lists 1-based lines to highlight.
        const [x, y] = layer.p(num(element.x, 0), num(element.y, 0));
        const w = layer.s(num(element.w, 300));
        const codeSize = num(element.size, layer.fontSize * 0.62);
        const lines = String(element.text ?? element.code ?? "").split("\n");
        const lineHeight = codeSize * 1.45;
        const h = element.h ? layer.s(num(element.h, 0)) : lines.length * lineHeight + 22;
        add(svgElement("rect", { x, y, width: w, height: h, rx: 10, fill: "#1e222b" }));
        const marked = new Set((element.mark || []).map(Number));
        lines.forEach((line, index) => {
          const lineY = y + 11 + index * lineHeight;
          if (marked.has(index + 1)) add(svgElement("rect", { x: x + 4, y: lineY, width: w - 8, height: lineHeight, rx: 4, fill: "rgba(255, 212, 59, 0.22)" }));
          const text = svgElement("text", { x: x + 14, y: lineY + lineHeight / 2, "font-size": codeSize, class: "mono", fill: marked.has(index + 1) ? "#ffe8a3" : "#d7dce5", "dominant-baseline": "central" });
          text.textContent = line;
          add(text);
        });
        break;
      }
      case "mark": {
        const [x, y] = layer.p(num(element.x, 0), num(element.y, 0));
        const markColor = element.color || (element.kind === "cross" ? "red" : "green");
        addAll(drawIcon(rc, element.kind === "cross" ? "cross" : "check", x, y, layer.s(num(element.size, 30)), { ...options, stroke: strokeColor(markColor) }));
        break;
      }
      case "circle":
      case "ellipse":
      case "ring": {
        let cx;
        let cy;
        let w;
        let h;
        if (element.r !== undefined) {
          [cx, cy] = layer.p(num(element.x, 0), num(element.y, 0));
          w = h = layer.s(num(element.r, 30)) * 2;
        } else {
          // A rectangle to circle around: pad it so the ring sits outside the target.
          const [x, y] = layer.p(num(element.x, 0), num(element.y, 0));
          const rw = layer.s(num(element.w, 80));
          const rh = layer.s(num(element.h, 40));
          [cx, cy, w, h] = [x + rw / 2, y + rh / 2, rw * 1.22 + 14, rh * 1.35 + 14];
        }
        if (element.type === "ring") options.strokeWidth = num(element.width, layer.strokeWidth + 0.5);
        add(rc.ellipse(cx, cy, w, h, options));
        if (element.icon) {
          addAll(drawIcon(rc, element.icon, cx, element.label && element.labelInside !== false && element.fill ? cy - h * 0.14 : cy, Math.min(w, h) * 0.5, { ...options, fill: undefined }));
          if (element.label && element.fill) element.labelInside = false;
        }
        if (element.label) {
          const inside = element.labelInside ?? (element.fill && element.type !== "ring");
          add(handText(cx, inside ? cy : cy + h / 2 + size * 0.75, element.label, { size, color: inside ? "ink" : colorName, maxWidth: inside ? w - 8 : w + 80 }));
        }
        break;
      }
      case "arrow": {
        const from = point(element.from);
        const to = point(element.to);
        if (!from || !to) return null;
        const [x1, y1] = layer.p(...from);
        const [x2, y2] = layer.p(...to);
        const bend = num(element.bend, 0);
        const dx = x2 - x1;
        const dy = y2 - y1;
        const length = Math.hypot(dx, dy) || 1;
        const midX = (x1 + x2) / 2 - dy * bend * 0.5;
        const midY = (y1 + y2) / 2 + dx * bend * 0.5;
        add(bend ? rc.curve([[x1, y1], [midX, midY], [x2, y2]], options) : rc.line(x1, y1, x2, y2, options));
        const headLength = Math.min(16 * (options.strokeWidth / 2.2), length * 0.35);
        const head = (tipX, tipY, fromX, fromY) => {
          const angle = Math.atan2(tipY - fromY, tipX - fromX);
          const spread = Math.PI * 0.83;
          return rc.linearPath(
            [
              [tipX + headLength * Math.cos(angle + spread), tipY + headLength * Math.sin(angle + spread)],
              [tipX, tipY],
              [tipX + headLength * Math.cos(angle - spread), tipY + headLength * Math.sin(angle - spread)],
            ],
            { ...options, roughness: 0.7, fill: undefined },
          );
        };
        add(head(x2, y2, bend ? midX : x1, bend ? midY : y1));
        if (element.both) add(head(x1, y1, bend ? midX : x2, bend ? midY : y2));
        if (element.flow) {
          // Dots travelling along the arrow show data, current or material moving.
          // The quadratic control point that passes through (midX, midY) at t=0.5.
          const controlX = 2 * midX - (x1 + x2) / 2;
          const controlY = 2 * midY - (y1 + y2) / 2;
          const d = bend ? `M ${x1} ${y1} Q ${controlX} ${controlY} ${x2} ${y2}` : `M ${x1} ${y1} L ${x2} ${y2}`;
          const duration = Math.max(1.1, length / 150);
          const dots = Math.max(2, Math.min(5, Math.round(length / 90)));
          for (let index = 0; index < dots; index++) {
            const dot = svgElement("circle", { r: Math.max(3.5, options.strokeWidth * 1.7), fill: stroke, opacity: 0.85, class: "flow-dot" });
            const motion = svgElement("animateMotion", { dur: `${duration}s`, repeatCount: "indefinite", path: d, begin: `${(index * duration) / dots}s` });
            dot.appendChild(motion);
            add(dot);
          }
        }
        if (element.label) {
          // Beside mostly-vertical arrows, above mostly-horizontal ones.
          const labelSize = size * 0.9;
          if (Math.abs(dy) > Math.abs(dx)) {
            add(handText(midX + labelSize * 0.55, midY, element.label, { size: labelSize, color: colorName, anchor: "start", maxWidth: 200 }));
          } else {
            add(handText(midX, midY - labelSize * 0.85, element.label, { size: labelSize, color: colorName, maxWidth: Math.max(120, Math.abs(dx)) }));
          }
        }
        break;
      }
      case "line": {
        const points = (element.points || []).map(point).filter(Boolean).map((p) => layer.p(...p));
        if (points.length < 2) return null;
        add(element.smooth ? rc.curve(points, options) : rc.linearPath(points, options));
        break;
      }
      case "polygon": {
        const points = (element.points || []).map(point).filter(Boolean).map((p) => layer.p(...p));
        if (points.length < 3) return null;
        add(rc.polygon(points, options));
        if (element.label) {
          const cx = points.reduce((sum, p) => sum + p[0], 0) / points.length;
          const cy = points.reduce((sum, p) => sum + p[1], 0) / points.length;
          add(handText(cx, cy, element.label, { size, color: "ink" }));
        }
        break;
      }
      case "text": {
        const [x, y] = layer.p(num(element.x, 0), num(element.y, 0));
        const anchor = { left: "start", right: "end" }[element.align] || "middle";
        const maxWidth = element.maxWidth ? layer.s(num(element.maxWidth, 0)) : 0;
        add(handText(x, y, element.text ?? element.label ?? "", { size, color: colorName, anchor, weight: element.bold ? 700 : 500, maxWidth }));
        break;
      }
      case "note": {
        const [x, y] = layer.p(num(element.x, 0), num(element.y, 0));
        const w = layer.s(num(element.w, 170));
        const lines = wrapText(element.text ?? element.label ?? "", w - 24, size);
        const h = element.h ? layer.s(num(element.h, 0)) : lines.length * size * 1.08 + 28;
        add(rc.rectangle(x, y, w, h, { ...options, stroke: "#d9b300", strokeWidth: 1.4, roughness: 0.6, fill: NOTE_YELLOW, fillStyle: "solid" }));
        add(handText(x + w / 2, y + h / 2, lines.join("\n"), { size, color: "ink" }));
        group.setAttribute("transform", `rotate(${num(element.tilt, -2.5)} ${x + w / 2} ${y + h / 2})`);
        break;
      }
      case "highlight": {
        const [x, y] = layer.p(num(element.x, 0), num(element.y, 0));
        const w = layer.s(num(element.w, 120));
        const h = layer.s(num(element.h, 24));
        add(rc.rectangle(x - 3, y - 2, w + 6, h + 4, { ...options, stroke: "none", fill: element.fill ? fillColor(element.fill, colorName) : HIGHLIGHT, fillStyle: "solid", roughness: 1.6 }));
        break;
      }
      case "underline": {
        const [x, y] = layer.p(num(element.x, 0), num(element.y, 0));
        const w = layer.s(num(element.w, 120));
        add(rc.curve([[x, y], [x + w * 0.5, y + 2], [x + w, y - 1]], { ...options, roughness: 1.6 }));
        break;
      }
      default:
        console.warn("unknown visual element", element);
        return null;
    }
    layer.svg.appendChild(group);
    return group;
  }

  /** Draws strokes on like a pen, fades fills and text in. Returns the next delay. */
  function animateIn(group, delay) {
    let longest = 0;
    for (const path of group.querySelectorAll("path")) {
      const strokeAttribute = path.getAttribute("stroke");
      if (!strokeAttribute || strokeAttribute === "none") {
        path.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 380, delay: delay + 200, fill: "both" });
        continue;
      }
      const length = path.getTotalLength();
      if (!length) continue;
      const duration = Math.min(850, 220 + length * 0.8);
      path.style.strokeDasharray = `${length} ${length}`;
      path.animate([{ strokeDashoffset: length }, { strokeDashoffset: 0 }], {
        duration,
        delay,
        easing: "cubic-bezier(.3,.7,.3,1)",
        fill: "both",
      });
      longest = Math.max(longest, duration);
    }
    for (const text of group.querySelectorAll("text")) {
      text.animate([{ opacity: 0, transform: "translateY(5px)" }, { opacity: 1, transform: "none" }], {
        duration: 380,
        delay: delay + longest * 0.4,
        fill: "both",
      });
    }
    for (const shape of group.querySelectorAll(":scope > rect, :scope > circle")) {
      shape.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 380, delay: delay + 120, fill: "both" });
    }
    return delay + Math.max(160, longest * 0.45);
  }

  function revealStep(state, index) {
    const step = (state.visual.steps || [])[index];
    if (!step) return;
    const draw = step.draw || [];
    state.scene?.revealStep(draw.filter((element) => element.on === "3d"));
    // Streamed replies reveal the card only once something is drawn on it.
    if (!state.card && draw.some((element) => element.on !== "screen" && element.on !== "3d")) buildCard(state);
    // "focus": earlier drawing fades back so this step's elements stand out.
    // "clear": a new scene — earlier card drawing fades away (screen marks stay).
    if (step.clear && state.cardSvg) {
      for (const group of state.groups) {
        if (!state.cardSvg.contains(group)) continue;
        group.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: "forwards" }).onfinish = () => group.remove();
      }
      state.groups = state.groups.filter((group) => !state.cardSvg.contains(group));
      state.byId.clear();
    }
    // The next step without focus brings everything back.
    for (const group of state.groups) group.classList.toggle("dimmed", Boolean(step.focus));
    let delay = 0;
    for (const element of draw.filter((element) => element.on !== "3d")) {
      try {
        const group = drawElement(state, element, state.nextSeed++);
        if (group) state.groups.push(group);
        if (group?.linked) state.groups.push(group.linked);
        // Reusing an id replaces the earlier element (a pointer or label that moves).
        if (group && element.id) {
          const previous = state.byId.get(element.id);
          if (previous) {
            for (const old of [previous, previous.linked].filter(Boolean)) {
              old.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 350, fill: "forwards" }).onfinish = () => old.remove();
            }
            state.groups = state.groups.filter((other) => other !== previous && other !== previous.linked);
          }
          state.byId.set(element.id, group);
        }
        if (group) delay = animateIn(group, delay);
        if (group?.linked) animateIn(group.linked, delay);
      } catch (error) {
        console.error("couldn't draw", element, error);
      }
    }
  }

  // ------------------------------------------------------------ commands

  function show({ id, visual, scale_x, scale_y }) {
    dismiss(null);
    // Streamed visuals arrive without steps; each "step" command adds one.
    if (!Array.isArray(visual.steps)) visual.steps = [];
    const steps = visual.steps;
    const screenSvg = svgElement("svg", { class: "screen-layer" });
    document.body.appendChild(screenSvg);
    const state = {
      id,
      visual,
      scaleX: num(scale_x, 1),
      scaleY: num(scale_y, 1),
      screenSvg,
      card: null,
      cardSvg: null,
      revealed: 0,
      nextSeed: 7,
      groups: [],
      byId: new Map(),
    };
    const hasCardElements = steps.some((step) => (step.draw || []).some((element) => element.on !== "screen" && element.on !== "3d"));
    if (visual.scene3d && window.ClickyScene) {
      const spec = { title: visual.title, ...visual.scene3d };
      state.scene = window.ClickyScene.create(spec, {
        place: (place, width, height) => placeCard(place, width, height, state),
        setInteractive: () => reportInteractiveArea(),
        closeButton,
      });
      // A diagram card alongside a model goes on the other side by default.
      if (state.scene) {
        visual.card = visual.card || {};
        if (!visual.card.place) visual.card.place = visual.scene3d.place === "left" ? "right" : "left";
      }
    }
    if ((visual.card && !state.scene) || hasCardElements || (visual.title && !state.scene)) buildCard(state);
    current = state;
    reportInteractiveArea();
  }

  function step({ id, index, step: streamedStep }) {
    if (!current || current.id !== id) return;
    if (streamedStep) current.visual.steps[index] = streamedStep;
    while (current.revealed <= index && current.revealed < (current.visual.steps || []).length) {
      revealStep(current, current.revealed);
      current.revealed += 1;
    }
    fitCardToContent(current);
  }

  function dismiss(id) {
    if (!current || (id !== null && id !== undefined && current.id !== id)) return;
    const { card, screenSvg, scene } = current;
    current = null;
    card?.classList.add("leaving");
    scene?.element.classList.add("leaving");
    screenSvg.classList.add("leaving");
    reportInteractiveArea();
    setTimeout(() => {
      card?.remove();
      screenSvg.remove();
      scene?.dispose();
    }, 420);
  }

  /** Tells Rust which parts of this click-through surface take the mouse:
   *  the card (click to close) and the 3D stage (drag to rotate). */
  function reportInteractiveArea() {
    const rects = [];
    if (current) {
      for (const element of [current.card, current.scene?.element]) {
        // offset* ignore the entrance animation's scale, unlike getBoundingClientRect.
        if (element) rects.push([element.offsetLeft, element.offsetTop, element.offsetWidth, element.offsetHeight]);
      }
    }
    // Lesson stages and buttons take the mouse too.
    rects.push(...(window.clickyLesson?.rects() || []));
    window.webkit?.messageHandlers?.clicky?.postMessage(JSON.stringify({ type: "input", rects }));
  }

  function closeButton() {
    const button = htmlElement("button", "close-button", "×");
    button.title = "close";
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      requestDismiss();
    });
    return button;
  }

  /** Asks Rust to stop speaking and clear (it sends "clear" back). */
  function requestDismiss() {
    const handler = window.webkit?.messageHandlers?.clicky;
    if (handler) handler.postMessage(JSON.stringify({ type: "dismiss" }));
    else dismiss(null);
  }

  window.clicky = {
    handle(command) {
      try {
        if (command.type === "show") show(command);
        else if (command.type === "step") step(command);
        else if (command.type === "clear_card") dismiss(null);
        else if (command.type === "clear") {
          dismiss(command.id);
          if (command.id === null) window.clickyLesson?.clear();
        }
      } catch (error) {
        console.error("visual command failed", command, error);
      }
    },
    setHidden(hidden) {
      document.body.classList.toggle("hidden-for-capture", hidden);
    },
    reportInteractiveArea,
  };
})();
