// Clicky's 3D stage: one figure() of a lesson. The sandbox sends a part at a time
// as plain data (shape recipe, place, material); each part grows in on its beat
// under a fixed studio rig while the model turns on a turntable. lesson.js owns
// the timing and calls into this file. Drag turns the figure, the wheel zooms.
(() => {
  "use strict";

  const THREE = window.THREE;
  const ADDONS = window.THREE_ADDONS || {};
  const DEG = Math.PI / 180;
  // spin 1 turns the figure at this many degrees a second.
  const SPIN_DEGREES_PER_UNIT = 15;
  const RESUME_SPIN_AFTER_DRAG_SECONDS = 4;
  const GROW_SECONDS = 0.65;
  const LABEL_GAP = 26;
  const FRAMING_INTERVAL_FRAMES = 12;
  const FRAME_BREATHING_ROOM = 1.06;
  const LABEL_MARGIN_PX = 105;
  const QUALITY_CHECK_SECONDS = 2.5;
  const SLOW_FRAME_MS = 26;
  const QUALITY_STEP_MUST_SAVE = 0.85;
  const QUALITY_LEVELS = [
    { pixelRatio: 1.5, shadowEvery: 1 },
    { pixelRatio: 1, shadowEvery: 1 },
    { pixelRatio: 1, shadowEvery: 6 },
    { pixelRatio: 0.75, shadowEvery: 6 },
  ];

  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const easeOutCubic = (t) => 1 - (1 - t) ** 3;
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  const easeOutBack = (t) => { const c = 1.4; return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2; };
  const num = (value, fallback) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
  const vectorOf = (value, fallback) => (Array.isArray(value) && value.length >= 3 ? new THREE.Vector3(value[0], value[1], value[2]) : fallback);
  const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
  function axisVector(axis) {
    if (typeof axis === "string") {
      const match = /^\s*([+-]?)\s*([xyz])\s*$/i.exec(axis);
      if (!match) return null;
      return AXES[match[2].toLowerCase()].clone().multiplyScalar(match[1] === "-" ? -1 : 1);
    }
    const vector = vectorOf(axis, null);
    return vector && vector.lengthSq() > 1e-12 ? vector.normalize() : null;
  }

  // ---------------------------------------------------------------- materials
  // Kinds of real stuff, not shader settings: the model says "steel".
  const MATERIALS = {
    steel: { color: "#B8BCC2", metalness: 1, roughness: 0.32 },
    alu: { color: "#C9CCD0", metalness: 1, roughness: 0.42 },
    aluminum: { color: "#C9CCD0", metalness: 1, roughness: 0.42 },
    aluminium: { color: "#C9CCD0", metalness: 1, roughness: 0.42 },
    titanium: { color: "#8F9196", metalness: 0.92, roughness: 0.38 },
    chrome: { color: "#E8EAED", metalness: 1, roughness: 0.06 },
    brass: { color: "#B8914A", metalness: 1, roughness: 0.3 },
    copper: { color: "#B4673D", metalness: 1, roughness: 0.32 },
    gold: { color: "#D4A93E", metalness: 1, roughness: 0.22 },
    iron: { color: "#55585D", metalness: 0.75, roughness: 0.62 },
    metal: { color: "#A8ACB2", metalness: 1, roughness: 0.3 },
    black: { color: "#1E2023", metalness: 0.1, roughness: 0.45 },
    rubber: { color: "#232427", metalness: 0, roughness: 0.88 },
    glass: { color: "#D8E6EE", metalness: 0, roughness: 0.06, opacity: 0.28, clearcoat: 1, clearcoatRoughness: 0.05 },
    water: { color: "#4E8FB5", metalness: 0, roughness: 0.1, opacity: 0.55, clearcoat: 1, clearcoatRoughness: 0.08 },
    wood: { color: "#8A5E3A", metalness: 0, roughness: 0.62 },
    ceramic: { color: "#E9E5DC", metalness: 0, roughness: 0.25, clearcoat: 0.6, clearcoatRoughness: 0.2 },
    paper: { color: "#EFEBE0", metalness: 0, roughness: 0.95 },
    gloss: { color: "#8A8D92", metalness: 0, roughness: 0.2, clearcoat: 0.8, clearcoatRoughness: 0.12 },
    paint: { color: "#8A8D92", metalness: 0, roughness: 0.38, clearcoat: 0.5, clearcoatRoughness: 0.2 },
    plastic: { color: "#8A8D92", metalness: 0, roughness: 0.45 },
    soft: { color: "#B5766A", metalness: 0, roughness: 0.55, sheen: 0.6, sheenRoughness: 0.5, sheenColorMix: true, clearcoat: 0.25, clearcoatRoughness: 0.45 },
    matte: { color: "#8A8D92", metalness: 0, roughness: 0.85 },
    glow: { color: "#FFB930", metalness: 0, roughness: 0.6, glow: 1 },
  };

  function buildMaterial(spec, doubleSided) {
    const preset = MATERIALS[spec.kind] || MATERIALS.paint;
    const color = new THREE.Color(spec.color || preset.color);
    const opacity = num(spec.opacity, preset.opacity ?? 1);
    const material = new THREE.MeshPhysicalMaterial({
      color,
      metalness: num(spec.metalness, preset.metalness),
      roughness: num(spec.roughness, preset.roughness),
      transparent: opacity < 1,
      opacity,
      depthWrite: opacity >= 0.6,
      side: doubleSided || spec.double ? THREE.DoubleSide : THREE.FrontSide,
      clearcoat: preset.clearcoat || 0,
      clearcoatRoughness: preset.clearcoatRoughness || 0,
    });
    if (preset.sheen) {
      material.sheen = preset.sheen;
      material.sheenRoughness = preset.sheenRoughness;
      material.sheenColor = color.clone().lerp(new THREE.Color("#FFFFFF"), 0.5);
    }
    const glow = num(spec.glow, preset.glow || 0);
    if (spec.emissive) material.emissive.set(spec.emissive);
    else if (glow) material.emissive.copy(color);
    material.emissiveIntensity = glow || (spec.emissive ? 1 : 0);
    material.userData.glowable = true;
    return material;
  }

  // Cut parts show their inside: faces seen from behind are painted as a hatched cut surface.
  function makeHatched(material) {
    material.side = THREE.DoubleSide;
    material.clipShadows = true;
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <dithering_fragment>",
        `#include <dithering_fragment>
        if (!gl_FrontFacing) {
          float hatch = mod(gl_FragCoord.x + gl_FragCoord.y, 11.0);
          vec3 face = pow(mix(diffuseColor.rgb, vec3(1.0), 0.22), vec3(1.0 / 2.2));
          gl_FragColor.rgb = face * (hatch < 1.8 ? 0.68 : 1.0);
        }`,
      );
    };
    material.customProgramCacheKey = () => "clicky-hatched";
    return material;
  }

  // ---------------------------------------------------------------- geometry helpers
  const merge = (geometries) => {
    const clean = geometries.map((geometry) => {
      const flat = geometry.index ? geometry : geometry;
      for (const name of Object.keys(flat.attributes)) if (!["position", "normal", "uv"].includes(name)) flat.deleteAttribute(name);
      return flat;
    });
    return ADDONS.mergeGeometries(clean, false) || clean[0];
  };

  function flipGeometry(geometry) {
    const index = geometry.index;
    if (index) {
      for (let i = 0; i + 2 < index.count; i += 3) {
        const a = index.getX(i + 1);
        index.setX(i + 1, index.getX(i + 2));
        index.setX(i + 2, a);
      }
    }
    const normal = geometry.attributes.normal;
    for (let i = 0; i < normal.count; i++) normal.setXYZ(i, -normal.getX(i), -normal.getY(i), -normal.getZ(i));
    return geometry;
  }

  // A closed or open sheet given a wall: the surface, plus a copy pushed in along
  // its normals and facing the other way. A closed part goes hollow.
  function solidify(geometry, thickness) {
    const inner = geometry.clone();
    const position = inner.attributes.position;
    const normal = inner.attributes.normal;
    for (let i = 0; i < position.count; i++) {
      position.setXYZ(i, position.getX(i) - normal.getX(i) * thickness, position.getY(i) - normal.getY(i) * thickness, position.getZ(i) - normal.getZ(i) * thickness);
    }
    return merge([geometry, flipGeometry(inner)]);
  }

  function turnTo(geometry, axis, natural) {
    const to = axisVector(axis);
    if (!to) return geometry;
    const from = AXES[natural || "y"];
    if (to.distanceToSquared(from) < 1e-9) return geometry;
    return geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(from, to));
  }

  function roundedProfile(r, rTop, h, bevel) {
    const b = Math.min(bevel, Math.max(0.001, Math.min(r, rTop || r, h / 2)) * 0.95);
    const points = [new THREE.Vector2(0, -h / 2)];
    const arc = (cx, cy, from, to) => {
      for (let i = 0; i <= 5; i++) {
        const a = from + ((to - from) * i) / 5;
        points.push(new THREE.Vector2(Math.max(0, cx + Math.cos(a) * b), cy + Math.sin(a) * b));
      }
    };
    arc(r - b, -h / 2 + b, -Math.PI / 2, 0);
    if (rTop > 0) arc(Math.max(0, rTop - b), h / 2 - b, 0, Math.PI / 2);
    points.push(new THREE.Vector2(0, h / 2));
    return points;
  }

  function hollowCylinder(outer, inner, height, segments) {
    const outerWall = new THREE.CylinderGeometry(outer, outer, height, segments, 1, true);
    const innerWall = flipGeometry(new THREE.CylinderGeometry(inner, inner, height, segments, 1, true));
    const top = new THREE.RingGeometry(inner, outer, segments, 1).rotateX(-Math.PI / 2).translate(0, height / 2, 0);
    const bottom = new THREE.RingGeometry(inner, outer, segments, 1).rotateX(Math.PI / 2).translate(0, -height / 2, 0);
    return merge([outerWall, innerWall, top, bottom]);
  }

  function arrowGeometry(shape) {
    const points = (shape.points || []).map((p) => vectorOf(p, null)).filter(Boolean);
    if (points.length < 2) return null;
    const r = num(shape.r, 0.04);
    const headLength = num(shape.head, r * 6);
    const headRadius = num(shape.headR, r * 2.6);
    const curve = points.length > 2 ? new THREE.CatmullRomCurve3(points) : new THREE.LineCurve3(points[0], points[1]);
    const length = curve.getLength();
    const shaftEnd = Math.max(0.05, 1 - headLength / Math.max(length, 1e-3));
    const shaftPoints = Array.from({ length: 25 }, (_, i) => curve.getPointAt((shaftEnd * i) / 24));
    const shaft = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(shaftPoints), Math.max(16, points.length * 12), r, 12, false);
    const tip = curve.getPointAt(1);
    const base = curve.getPointAt(shaftEnd);
    const cone = new THREE.ConeGeometry(headRadius, headLength, 20);
    cone.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(AXES.y, tip.clone().sub(base).normalize()));
    cone.translate((tip.x + base.x) / 2, (tip.y + base.y) / 2, (tip.z + base.z) / 2);
    return merge([shaft, cone]);
  }

  function gearGeometry(shape) {
    const r = num(shape.r, 0.5);
    const teeth = Math.max(4, Math.min(120, Math.round(num(shape.teeth, 16))));
    const depth = num(shape.h, num(shape.depth, 0.15));
    const toothDepth = num(shape.tooth, r * 0.16);
    const root = r - toothDepth;
    const outline = new THREE.Shape();
    for (let i = 0; i < teeth; i++) {
      const a = (i / teeth) * Math.PI * 2;
      const pitch = (Math.PI * 2) / teeth;
      const corner = (radius, fraction) => [Math.cos(a + pitch * fraction) * radius, Math.sin(a + pitch * fraction) * radius];
      const start = corner(root, 0);
      if (i === 0) outline.moveTo(start[0], start[1]);
      else outline.lineTo(start[0], start[1]);
      outline.lineTo(...corner(root, 0.2));
      outline.lineTo(...corner(r, 0.32));
      outline.lineTo(...corner(r, 0.58));
      outline.lineTo(...corner(root, 0.7));
    }
    outline.closePath();
    const hole = num(shape.hole, 0);
    if (hole > 0) {
      const path = new THREE.Path();
      path.absarc(0, 0, hole, 0, Math.PI * 2, true);
      outline.holes.push(path);
    }
    return new THREE.ExtrudeGeometry(outline, { depth, bevelEnabled: true, bevelSize: depth * 0.06, bevelThickness: depth * 0.06, bevelSegments: 2, curveSegments: 16 }).translate(0, 0, -depth / 2);
  }

  // SVG path data (absolute and relative M L H V C Q Z) as shapes. SVG's y runs down.
  function shapesFromPath(d, unit) {
    const path = new THREE.ShapePath();
    const tokens = String(d).match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/g) || [];
    let i = 0, x = 0, y = 0, command = "";
    const next = () => parseFloat(tokens[i++]) * unit;
    const isNumber = () => i < tokens.length && !/^[a-zA-Z]$/.test(tokens[i]);
    while (i < tokens.length) {
      if (!isNumber()) command = tokens[i++];
      const relative = command === command.toLowerCase();
      const ox = relative ? x : 0, oy = relative ? y : 0;
      switch (command.toUpperCase()) {
        case "M": x = ox + next(); y = oy + next(); path.moveTo(x, -y); command = relative ? "l" : "L"; break;
        case "L": x = ox + next(); y = oy + next(); path.lineTo(x, -y); break;
        case "H": x = ox + next(); path.lineTo(x, -y); break;
        case "V": y = oy + next(); path.lineTo(x, -y); break;
        case "C": { const a = ox + next(), b = oy + next(), c = ox + next(), e = oy + next(); x = ox + next(); y = oy + next(); path.bezierCurveTo(a, -b, c, -e, x, -y); break; }
        case "Q": { const a = ox + next(), b = oy + next(); x = ox + next(); y = oy + next(); path.quadraticCurveTo(a, -b, x, -y); break; }
        case "Z": path.currentPath && path.currentPath.closePath(); if (!isNumber()) command = ""; break;
        default: i++;
      }
      if (!command && i < tokens.length && isNumber()) i++;
    }
    return path.toShapes(false);
  }

  function extrudeGeometry(shape) {
    const depth = num(shape.depth, num(shape.h, 0.2));
    const bevel = num(shape.bevel, depth * 0.08);
    const options = { depth, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2, curveSegments: 16 };
    let shapes = null;
    if (typeof shape.d === "string") shapes = shapesFromPath(shape.d, num(shape.unit, 0.01));
    else if (Array.isArray(shape.points) && shape.points.length >= 3) shapes = [new THREE.Shape(shape.points.map((p) => new THREE.Vector2(p[0], p[1])))];
    else if (Array.isArray(shape.shape) && shape.shape.length >= 3) shapes = [new THREE.Shape(shape.shape.map((p) => new THREE.Vector2(p[0], p[1])))];
    if (!shapes || !shapes.length) return null;
    const geometry = new THREE.ExtrudeGeometry(shapes, options);
    geometry.translate(0, 0, -depth / 2);
    if (shape.center !== false) {
      geometry.computeBoundingBox();
      const center = geometry.boundingBox.getCenter(new THREE.Vector3());
      geometry.translate(-center.x, -center.y, 0);
    }
    return geometry;
  }

  function latheGeometry(shape) {
    const profile = (shape.profile || []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (profile.length < 2) return null;
    let points = profile.map((p) => new THREE.Vector2(Math.max(0, p[0]), p[1]));
    if (points[0].y > points[points.length - 1].y) points.reverse();
    if (points[0].x > 1e-4) points.unshift(new THREE.Vector2(0, points[0].y));
    if (points[points.length - 1].x > 1e-4) points.push(new THREE.Vector2(0, points[points.length - 1].y));
    const geometry = new THREE.LatheGeometry(points, 56);
    return ADDONS.toCreasedNormals ? ADDONS.toCreasedNormals(geometry.toNonIndexed(), 0.7) : geometry;
  }

  function surfaceGeometry(shape) {
    const grid = shape.grid;
    if (!Array.isArray(grid) || grid.length < 2) return null;
    const rows = grid.length, columns = grid[0].length;
    const positions = new Float32Array(rows * columns * 3);
    const indices = [];
    grid.forEach((row, j) => row.forEach((p, i) => positions.set(p, (j * columns + i) * 3)));
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < columns - 1; i++) {
        const a = j * columns + i, b = a + 1, c = a + columns, d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }

  async function blobGeometry(shape) {
    if (!window.ClickySculpt) return null;
    const blobs = [];
    for (const ball of shape.balls || []) if (Array.isArray(ball) && ball.length >= 4) blobs.push({ type: "sphere", at: ball.slice(0, 3), r: ball[3] });
    for (const stick of shape.sticks || []) {
      if (Array.isArray(stick) && stick.length >= 7) blobs.push({ type: "cone", from: stick.slice(0, 3), to: stick.slice(3, 6), r: stick[6], r2: num(stick[7], stick[6]) });
    }
    if (!blobs.length) return null;
    const group = await window.ClickySculpt.sculpt({
      blobs, smooth: num(shape.blend, 0.25), color: "#FFFFFF", resolution: clamp(num(shape.resolution, 72), 32, 110),
      detail: shape.detail,
    });
    let geometry = null;
    group && group.traverse((node) => { if (node.isMesh && !geometry) geometry = node.geometry; });
    return geometry;
  }

  // ---- the shapes. Most stand along y; a gear's axle and an extrusion's depth run along z.
  const NATURAL_AXIS = { gear: "z", extrude: "z" };
  const ROUND_KINDS = new Set(["cyl", "cone", "tube", "lathe", "capsule", "spring", "torus"]);
  function buildShape(kind, shape) {
    switch (kind) {
      case "box": {
        const size = Array.isArray(shape.size) ? shape.size : [num(shape.w, 1), num(shape.h, 1), num(shape.d, 1)];
        const bevel = num(shape.bevel, num(shape.radius, 0));
        if (bevel > 0 && ADDONS.RoundedBoxGeometry) {
          return new ADDONS.RoundedBoxGeometry(size[0], size[1], size[2], 3, Math.min(bevel, Math.min(size[0], size[1], size[2]) * 0.49));
        }
        return new THREE.BoxGeometry(size[0], size[1], size[2]);
      }
      case "cyl": {
        const r = num(shape.r, 0.5), top = num(shape.rTop, num(shape.r2, r)), h = num(shape.h, 1);
        const bevel = num(shape.bevel, 0);
        if (bevel > 0) return new THREE.LatheGeometry(roundedProfile(r, top, h, bevel), 48);
        return new THREE.CylinderGeometry(top, r, h, 48);
      }
      case "cone": return new THREE.CylinderGeometry(num(shape.top, num(shape.rTop, 0)), num(shape.r, 0.5), num(shape.h, 1), 40);
      case "tube": {
        const outer = num(shape.r, 0.5);
        return hollowCylinder(outer, Math.min(num(shape.inner, outer * 0.8), outer * 0.995), num(shape.h, 1), 48);
      }
      case "lathe": return latheGeometry(shape);
      case "sphere": {
        const r = num(shape.r, 0.5);
        return new THREE.SphereGeometry(r, 48, 32, 0, Math.PI * 2, 0, shape.dome ? Math.PI / 2 : Math.PI);
      }
      case "torus": return new THREE.TorusGeometry(num(shape.r, 0.5), num(shape.tube, num(shape.r2, 0.12)), 20, 72).rotateX(Math.PI / 2);
      case "capsule": return new THREE.CapsuleGeometry(num(shape.r, 0.25), num(shape.h, 1), 12, 32);
      case "pipe": {
        const points = (shape.points || []).map((p) => vectorOf(p, null)).filter(Boolean);
        if (points.length < 2) return null;
        const curve = points.length > 2 ? new THREE.CatmullRomCurve3(points, !!shape.closed) : new THREE.LineCurve3(points[0], points[1]);
        const r = num(shape.r, 0.08);
        const tube = new THREE.TubeGeometry(curve, clamp(points.length * 14, 24, 240), r, 18, !!shape.closed);
        if (shape.closed || shape.caps === false) return tube;
        const capStart = new THREE.SphereGeometry(r, 18, 12).translate(points[0].x, points[0].y, points[0].z);
        const last = points[points.length - 1];
        const capEnd = new THREE.SphereGeometry(r, 18, 12).translate(last.x, last.y, last.z);
        return merge([tube, capStart, capEnd]);
      }
      case "arrow": return arrowGeometry(shape);
      case "spring": {
        const r = num(shape.r, 0.3), h = num(shape.h, 1), turns = clamp(num(shape.turns, 6), 1, 60);
        const curve = new (class extends THREE.Curve {
          getPoint(t, target = new THREE.Vector3()) {
            const a = t * turns * Math.PI * 2;
            return target.set(Math.cos(a) * r, (t - 0.5) * h, Math.sin(a) * r);
          }
        })();
        return new THREE.TubeGeometry(curve, Math.round(turns * 28), num(shape.wire, r * 0.12), 10, false);
      }
      case "gear": return gearGeometry(shape);
      case "extrude": return extrudeGeometry(shape);
      case "poly": {
        const r = num(shape.r, 0.5), faces = num(shape.faces, 20);
        const geometry = faces === 4 ? new THREE.TetrahedronGeometry(r)
          : faces === 6 ? new THREE.BoxGeometry(r * 1.2, r * 1.2, r * 1.2)
          : faces === 8 ? new THREE.OctahedronGeometry(r)
          : faces === 12 ? new THREE.DodecahedronGeometry(r)
          : new THREE.IcosahedronGeometry(r);
        return geometry;
      }
      case "surface": return surfaceGeometry(shape);
      default: return null;
    }
  }

  // ---------------------------------------------------------------- the studio
  // A bright room with softboxes, baked once into an environment map. Metal looks
  // like metal because it has something to reflect.
  function bakeStudio(renderer) {
    const room = new THREE.Scene();
    const sky = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      vertexShader: "varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: `varying vec3 vDir;
        void main() {
          float up = normalize(vDir).y;
          vec3 ceiling = vec3(0.96, 0.97, 1.0), wall = vec3(0.84, 0.86, 0.90), ground = vec3(0.55, 0.53, 0.52);
          vec3 c = up >= 0.0 ? mix(wall, ceiling, smoothstep(0.0, 0.85, up)) : mix(wall, ground, smoothstep(0.0, 0.3, -up));
          gl_FragColor = vec4(c * 0.42, 1.0);
        }`,
    });
    room.add(new THREE.Mesh(new THREE.SphereGeometry(40, 32, 16), sky));
    const softboxes = [
      { to: [-0.55, 0.62, 0.56], size: [18, 13], tint: [1, 0.97, 0.92], power: 6 },
      { to: [0.85, 0.22, 0.3], size: [4, 24], tint: [1, 1, 1], power: 3 },
      { to: [0, 1, 0.001], size: [22, 16], tint: [1, 1, 1], power: 2.2 },
      { to: [0.35, 0.45, -0.85], size: [16, 6], tint: [0.8, 0.88, 1], power: 2.4 },
    ];
    for (const box of softboxes) {
      const panel = new THREE.Mesh(
        new THREE.PlaneGeometry(box.size[0], box.size[1]),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(box.tint[0] * box.power, box.tint[1] * box.power, box.tint[2] * box.power), side: THREE.DoubleSide, toneMapped: false }),
      );
      panel.position.set(box.to[0], box.to[1], box.to[2]).normalize().multiplyScalar(22);
      panel.lookAt(0, 0, 0);
      room.add(panel);
    }
    const generator = new THREE.PMREMGenerator(renderer);
    const target = generator.fromScene(room, 0.012);
    generator.dispose();
    return target.texture;
  }

  // ---------------------------------------------------------------- a stage
  function create(mark, host) {
    const scale = host.scale;
    const box = { x: mark.at[0] * scale.x, y: mark.at[1] * scale.y, w: mark.w * scale.x, h: mark.h * scale.y };
    const titleInset = mark.card || (!mark.onPaper && mark.title) ? 34 * scale.y : 0;

    const element = document.createElement("div");
    element.className = `lesson-stage${mark.card ? " lesson-window" : ""}`;
    Object.assign(element.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
    if (mark.card || mark.title) {
      const bar = document.createElement("div");
      bar.className = mark.card ? "lesson-window-bar" : "lesson-stage-title";
      bar.style.height = `${titleInset}px`;
      bar.style.fontSize = `${15 * scale.y}px`;
      if (mark.card) bar.innerHTML = '<span class="lesson-dot"></span><span class="lesson-dot"></span><span class="lesson-dot"></span>';
      const title = document.createElement("span");
      title.className = "lesson-window-title";
      title.textContent = mark.title || "";
      bar.appendChild(title);
      element.appendChild(bar);
    }
    const canvas = document.createElement("canvas");
    canvas.className = "lesson-stage-canvas";
    canvas.style.top = `${titleInset}px`;
    element.appendChild(canvas);
    const readout = document.createElement("div");
    readout.className = "lesson-readout";
    readout.style.top = `${titleInset + 8}px`;
    element.appendChild(readout);
    host.stageLayer.appendChild(element);

    const widthPx = Math.max(1, Math.round(box.w));
    const heightPx = Math.max(1, Math.round(box.h - titleInset));
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY_LEVELS[0].pixelRatio));
    renderer.setSize(widthPx, heightPx, false);
    canvas.style.width = `${widthPx}px`;
    canvas.style.height = `${heightPx}px`;
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.localClippingEnabled = true;

    const scene = new THREE.Scene();
    scene.environment = bakeStudio(renderer);
    scene.environmentIntensity = 0.62;

    const key = new THREE.DirectionalLight(0xfff6ea, 2.2);
    key.position.set(-0.55, 0.62, 0.56).multiplyScalar(12);
    key.castShadow = true;
    key.shadow.mapSize.set(1536, 1536);
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 5;
    scene.add(key);
    scene.add(key.target);
    const rim = new THREE.DirectionalLight(0xcfe0ff, 0.9);
    rim.position.set(0.35, 0.45, -0.85).multiplyScalar(12);
    scene.add(rim);

    const floor = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.ShadowMaterial({ opacity: 0.24 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.visible = false;
    scene.add(floor);

    const camera = new THREE.PerspectiveCamera(mark.camera.fov, widthPx / heightPx, 0.01, 2000);
    const root = new THREE.Group();
    scene.add(root);

    // ---- what the stage is doing
    const parts = new Map();
    const labels = [];
    const motions = [];
    const shapeCache = new Map();
    const view = {
      tilt: mark.camera.tilt, turn: mark.camera.turn, zoom: mark.camera.zoom, spin: mark.camera.spin,
      tiltShown: mark.camera.tilt, turnShown: mark.camera.turn, zoomShown: mark.camera.zoom,
      spinAngle: 0, dragTurn: 0, dragTilt: 0, target: null,
      center: new THREE.Vector3(), radius: 1, centerShown: new THREE.Vector3(), radiusShown: 0,
      spanAcross: 1, spanUp: 1, acrossShown: 1, upShown: 1,
    };
    let frames = 0, disposed = false, pausedUntil = 0, lastTime = performance.now() / 1000;
    let lastFrameReport = lastTime, renderMilliseconds = 0, renderedFrames = 0, qualityLevel = 0;
    let frameMsBeforeStep = null, qualityIsSettled = false;

    // ---- framing: the drawn parts sit in the middle of the rectangle
    const scratchBox = new THREE.Box3();
    const scratchMatrix = new THREE.Matrix4();
    const rootInverse = new THREE.Matrix4();
    function measureFraming() {
      root.updateWorldMatrix(true, true);
      rootInverse.copy(root.matrixWorld).invert();
      const total = new THREE.Box3();
      root.traverseVisible((node) => {
        if (!node.isMesh || !node.geometry || node.userData.ignoreFraming) return;
        if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
        scratchMatrix.multiplyMatrices(rootInverse, node.matrixWorld);
        scratchBox.copy(node.geometry.boundingBox).applyMatrix4(scratchMatrix);
        if (Number.isFinite(scratchBox.min.x)) total.union(scratchBox);
      });
      if (total.isEmpty()) return;
      const sphere = total.getBoundingSphere(new THREE.Sphere());
      view.center.copy(sphere.center);
      view.radius = Math.max(sphere.radius, 1e-3);
      const size = total.getSize(new THREE.Vector3());
      // The widest it gets as it turns on the turntable, and how tall it stands.
      view.spanAcross = Math.max(Math.hypot(size.x, size.z) / 2, 1e-3);
      view.spanUp = Math.max(size.y / 2, 1e-3);
      view.floorY = total.min.y;
    }

    function updateCamera(dt) {
      const blend = 1 - Math.exp(-dt * 3.2);
      if (view.radiusShown === 0) {
        view.radiusShown = view.radius;
        view.acrossShown = view.spanAcross;
        view.upShown = view.spanUp;
        view.centerShown.copy(view.center);
      }
      view.radiusShown += (view.radius - view.radiusShown) * blend;
      view.acrossShown += (view.spanAcross - view.acrossShown) * blend;
      view.upShown += (view.spanUp - view.upShown) * blend;
      view.centerShown.lerp(view.target || view.center, blend);
      view.tiltShown += (view.tilt - view.tiltShown) * blend;
      view.turnShown += (view.turn - view.turnShown) * blend;
      view.zoomShown += (view.zoom - view.zoomShown) * blend;

      root.rotation.y = (view.turnShown + view.spinAngle + view.dragTurn) * DEG;
      const tilt = clamp(view.tiltShown + view.dragTilt, -80, 80) * DEG;
      const aspect = camera.aspect;
      const tanVertical = Math.tan((camera.fov * DEG) / 2);
      // Labels sit in the side margins, so the object fits in what's between them.
      const labelMargin = labels.length ? clamp(LABEL_MARGIN_PX * scale.x * 2 / widthPx, 0, 0.5) : 0;
      const usableAcross = Math.max(0.35, 1 - labelMargin);
      const tilted = Math.abs(Math.sin(clamp(view.tiltShown + view.dragTilt, -80, 80) * DEG));
      const shownUp = view.upShown * Math.sqrt(1 - tilted * tilted) + view.acrossShown * tilted;
      const fitVertical = shownUp / tanVertical;
      const fitAcross = view.acrossShown / (tanVertical * aspect * usableAcross);
      // Nearby parts look bigger under perspective, hence the extra depth of half the object.
      const distance = ((Math.max(fitVertical, fitAcross) + view.acrossShown * 0.45) * FRAME_BREATHING_ROOM) / view.zoomShown;
      const centerWorld = view.centerShown.clone().applyAxisAngle(AXES.y, root.rotation.y);
      camera.position.set(centerWorld.x, centerWorld.y + Math.sin(tilt) * distance, centerWorld.z + Math.cos(tilt) * distance);
      camera.near = Math.max(0.01, distance - view.radiusShown * 4);
      camera.far = distance + view.radiusShown * 6 + 1;
      camera.lookAt(centerWorld);
      camera.updateProjectionMatrix();

      const reach = view.radiusShown * 1.6;
      key.position.set(-0.55, 0.62, 0.56).multiplyScalar(reach * 4).add(centerWorld);
      key.target.position.copy(centerWorld);
      const shadow = key.shadow.camera;
      shadow.left = shadow.bottom = -reach;
      shadow.right = shadow.top = reach;
      shadow.near = reach * 0.5;
      shadow.far = reach * 8;
      shadow.updateProjectionMatrix();

      if (view.floorY !== undefined) {
        floor.visible = tilt > -2 * DEG;
        floor.position.set(centerWorld.x, view.floorY - view.radiusShown * 0.02, centerWorld.z);
        floor.scale.setScalar(view.radiusShown * 4);
      }
      updateClipping(centerWorld);
    }

    // ---- cutaways
    const cuts = [];
    function updateClipping(centerWorld) {
      for (const cut of cuts) {
        if (cut.facing) {
          cut.plane.normal.set(0, 0, -1);
          cut.plane.constant = centerWorld.z;
        } else {
          cut.plane.normal.copy(cut.axis).negate().applyAxisAngle(AXES.y, root.rotation.y);
          cut.plane.constant = cut.at;
        }
      }
    }
    function planeFor(cut) {
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
      if (cut === true) cuts.push({ plane, facing: true });
      else if (typeof cut === "string") cuts.push({ plane, axis: axisVector(cut) || AXES.z.clone(), at: 0 });
      else cuts.push({ plane, axis: vectorOf(cut.axis, AXES.z.clone()).normalize(), at: num(cut.at, 0) });
      return plane;
    }

    // ---- parts
    function resolveAxisAndRotation(mark) {
      const axis = mark.shape.axis;
      if (axis === undefined || !ROUND_KINDS.has(mark.kind)) return axis;
      // Models often turn a round part twice: axis "x" and a rot that lays it down the
      // same way. Then it would come out upright. If rot alone already does it, drop axis.
      const to = axisVector(axis);
      if (!to || !mark.rot.some((angle) => angle !== 0)) return axis;
      const natural = AXES[NATURAL_AXIS[mark.kind] || "y"].clone();
      natural.applyEuler(new THREE.Euler(mark.rot[0] * DEG, mark.rot[1] * DEG, mark.rot[2] * DEG));
      return Math.abs(natural.dot(to)) > 0.999 ? undefined : axis;
    }

    // A part turned by right angles stretches along the figure's own x, y, z, so a
    // fuselage laid down with rot [90,0,0] and flattened by scale [1,0.7,1] flattens
    // the way the model meant. Any other turn keeps scale in the part's own axes.
    function localScale(scaleValue, rotation) {
      if (scaleValue === undefined) return new THREE.Vector3(1, 1, 1);
      if (typeof scaleValue === "number") return new THREE.Vector3(scaleValue, scaleValue, scaleValue);
      const vector = new THREE.Vector3(scaleValue[0], scaleValue[1], scaleValue[2]);
      const rightAngles = rotation.every((angle) => Math.abs(angle / 90 - Math.round(angle / 90)) < 1e-3);
      if (!rightAngles || !rotation.some((angle) => angle !== 0)) return vector;
      const matrix = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rotation[0] * DEG, rotation[1] * DEG, rotation[2] * DEG));
      const e = matrix.elements;
      const result = new THREE.Vector3(1, 1, 1);
      for (let local = 0; local < 3; local++) {
        const column = [Math.abs(e[local * 4]), Math.abs(e[local * 4 + 1]), Math.abs(e[local * 4 + 2])];
        const world = column.indexOf(Math.max(...column));
        result.setComponent(local, vector.getComponent(world));
      }
      return result;
    }

    function geometryFor(mark, axis) {
      const key_ = JSON.stringify([mark.kind, mark.shape, axis]);
      if (shapeCache.has(key_)) return shapeCache.get(key_);
      const finish = (geometry) => {
        if (!geometry) return null;
        if (axis !== undefined) turnTo(geometry, axis, NATURAL_AXIS[mark.kind]);
        if (mark.shape.thick > 0 && geometry.attributes.normal) geometry = solidify(geometry, mark.shape.thick);
        return geometry;
      };
      const built = mark.kind === "blob" ? blobGeometry(mark.shape).then(finish) : Promise.resolve(finish(buildShape(mark.kind, mark.shape)));
      shapeCache.set(key_, built);
      return built;
    }

    function placeNode(node, base) {
      node.position.copy(base.pos);
      node.quaternion.copy(base.quat);
      node.scale.copy(base.scale);
    }

    // Copies, rings of copies and mirror images share the shape and move with the part's parent.
    function instancesOf(mark, basePos, baseQuat) {
      let list = [{ pos: basePos.clone(), quat: baseQuat.clone() }];
      if (mark.copies) {
        const out = [];
        for (const item of list) {
          for (let i = 0; i < mark.copies.count; i++) {
            const pos = item.pos.clone().add(new THREE.Vector3(...mark.copies.step).multiplyScalar(i));
            let quat = item.quat.clone();
            const turn = mark.copies.turn;
            if (typeof turn === "number") quat = new THREE.Quaternion().setFromAxisAngle(AXES.y, turn * i * DEG).multiply(quat);
            else if (Array.isArray(turn)) quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(turn[0] * i * DEG, turn[1] * i * DEG, turn[2] * i * DEG)).multiply(quat);
            out.push({ pos, quat });
          }
        }
        list = out;
      }
      if (mark.around) {
        const axis = new THREE.Vector3(...mark.around.axis).normalize();
        const center = new THREE.Vector3(...mark.around.center);
        const full = Math.abs(mark.around.arc) >= 360;
        const out = [];
        for (const item of list) {
          for (let i = 0; i < mark.around.count; i++) {
            const angle = (mark.around.arc * DEG * i) / (full ? mark.around.count : Math.max(1, mark.around.count - 1));
            const turn = new THREE.Quaternion().setFromAxisAngle(axis, angle);
            out.push({ pos: item.pos.clone().sub(center).applyQuaternion(turn).add(center), quat: turn.clone().multiply(item.quat) });
          }
        }
        list = out;
      }
      return list;
    }

    function addPart(mark, pace) {
      const parent = mark.parent && parts.has(mark.parent) ? parts.get(mark.parent).node : root;
      const basePos = new THREE.Vector3(...mark.pos);
      const baseQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(mark.rot[0] * DEG, mark.rot[1] * DEG, mark.rot[2] * DEG));
      const baseScale = localScale(mark.scale, mark.rot);
      const instances = instancesOf(mark, basePos, baseQuat);
      const mirrors = [[1, 1, 1]];
      for (const word of mark.mirror || []) {
        const axis = word.trim().toLowerCase().replace(/^[+-]/, "");
        const index = "xyz".indexOf(axis);
        if (index < 0) continue;
        const count = mirrors.length;
        for (let i = 0; i < count; i++) { const flipped = mirrors[i].slice(); flipped[index] = -flipped[index]; mirrors.push(flipped); }
      }

      const nodes = [];
      const holders = [];
      for (const mirror of mirrors) {
        const holder = mirror.every((sign) => sign === 1) ? parent : (() => {
          const wrapper = new THREE.Group();
          wrapper.scale.set(mirror[0], mirror[1], mirror[2]);
          parent.add(wrapper);
          holders.push(wrapper);
          return wrapper;
        })();
        for (const instance of instances) {
          const node = new THREE.Group();
          placeNode(node, { pos: instance.pos, quat: instance.quat, scale: baseScale });
          holder.add(node);
          nodes.push(node);
        }
      }
      const entry = {
        id: mark.partId, mark, node: nodes[0], nodes, holders, material: null, meshes: [],
        base: { pos: basePos.clone(), quat: baseQuat.clone(), scale: baseScale.clone() }, pose: {}, motions: [], born: performance.now() / 1000, pace: pace || 1,
      };
      parts.set(mark.partId, entry);
      if (mark.kind === "group") return entry;

      const axis = resolveAxisAndRotation(mark);
      const doubleSided = ["lathe", "surface"].includes(mark.kind) || mark.shape.dome || mark.shape.thick > 0;
      const material = buildMaterial(mark.material, doubleSided);
      if (mark.cut) {
        makeHatched(material);
        material.clippingPlanes = [planeFor(mark.cut)];
      }
      if (mark.kind === "poly") material.flatShading = true;
      entry.material = material;

      Promise.resolve(geometryFor(mark, axis)).then((geometry) => {
        if (disposed || !geometry) return;
        entry.born = performance.now() / 1000;
        // A sculpted blob bakes its occlusion into vertex colours; the material carries the tint.
        material.vertexColors = !!geometry.attributes.color;
        for (const node of nodes) {
          const mesh = new THREE.Mesh(geometry, material);
          mesh.castShadow = (material.opacity >= 0.6) && !(material.emissiveIntensity > 0.5);
          mesh.receiveShadow = true;
          mesh.scale.setScalar(0.001);
          node.add(mesh);
          entry.meshes.push(mesh);
        }
        frames = 0;
      }).catch((error) => host.warn(`3D part failed: ${error && error.message}`));
      return entry;
    }

    // ---- motions from the program
    function motion(mark, now) {
      const part = parts.get(mark.target);
      if (!part) return;
      if (mark.kind === "set") {
        applyPose(part, mark);
        return;
      }
      if (mark.kind === "tween") {
        part.motions = part.motions.filter((m) => !(m.kind === "tween" && ((mark.to && m.to) || (mark.rot && m.rot))));
        part.motions.push({ kind: "tween", start: now, secs: mark.secs || 0.8, to: mark.to, rot: mark.rot, fromPos: part.base.pos.clone(), fromQuat: part.base.quat.clone() });
        return;
      }
      if (mark.kind === "path") {
        const points = mark.points.map((p) => new THREE.Vector3(...p));
        part.motions.push({ kind: "path", start: now, period: mark.period, once: mark.once, curve: new THREE.CatmullRomCurve3(points, !!mark.closed) });
        return;
      }
      part.motions.push({ kind: mark.kind, start: now, period: mark.period || 6, axis: mark.axis ? new THREE.Vector3(...mark.axis).normalize() : AXES.y, amount: mark.amount, center: mark.center ? new THREE.Vector3(...mark.center) : null });
    }

    function applyPose(part, pose) {
      if (pose.pos) part.base.pos.set(pose.pos[0], pose.pos[1], pose.pos[2]);
      if (pose.rot) part.base.quat.setFromEuler(new THREE.Euler(pose.rot[0] * DEG, pose.rot[1] * DEG, pose.rot[2] * DEG));
      if (pose.scale !== undefined) {
        if (typeof pose.scale === "number") part.base.scale.setScalar(pose.scale);
        else part.base.scale.set(pose.scale[0], pose.scale[1], pose.scale[2]);
      }
      if (pose.show !== undefined) for (const node of part.nodes) node.visible = pose.show;
      if (pose.glow !== undefined && part.material) {
        if (!part.material.emissive.getHex()) part.material.emissive.copy(part.material.color);
        part.material.emissiveIntensity = pose.glow;
      }
      if (pose.color && part.material) part.material.color.set(pose.color);
    }

    const scratchQuat = new THREE.Quaternion();
    const scratchVec = new THREE.Vector3();
    function updatePart(part, now) {
      const { node, base } = part;
      for (const mesh of part.meshes) {
        const t = clamp((now - part.born) / (GROW_SECONDS * part.pace), 0, 1);
        mesh.scale.setScalar(t >= 1 ? 1 : Math.max(0.001, easeOutBack(t)));
      }
      node.position.copy(base.pos);
      node.quaternion.copy(base.quat);
      node.scale.copy(base.scale);
      for (const m of part.motions) {
        const age = now - m.start;
        switch (m.kind) {
          case "tween": {
            const t = easeInOut(clamp(age / m.secs, 0, 1));
            if (m.to) { scratchVec.set(m.to[0], m.to[1], m.to[2]); node.position.lerpVectors(m.fromPos, scratchVec, t); }
            if (m.rot) { scratchQuat.setFromEuler(new THREE.Euler(m.rot[0] * DEG, m.rot[1] * DEG, m.rot[2] * DEG)); node.quaternion.slerpQuaternions(m.fromQuat, scratchQuat, t); }
            if (t >= 1) {
              if (m.to) base.pos.set(m.to[0], m.to[1], m.to[2]);
              if (m.rot) base.quat.copy(scratchQuat);
              m.done = true;
            }
            break;
          }
          case "spin": node.quaternion.multiply(scratchQuat.setFromAxisAngle(m.axis, (age / m.period) * Math.PI * 2)); break;
          case "bob": node.position.addScaledVector(m.axis, Math.sin((age / m.period) * Math.PI * 2) * m.amount); break;
          case "orbit": {
            const turn = scratchQuat.setFromAxisAngle(m.axis, (age / m.period) * Math.PI * 2);
            node.position.sub(m.center).applyQuaternion(turn).add(m.center);
            break;
          }
          case "path": {
            const t = m.once ? clamp(age / m.period, 0, 1) : (age / m.period) % 1;
            node.position.copy(m.curve.getPointAt(easeInOut(m.once ? t : t)));
            if (m.once && t >= 1) { base.pos.copy(node.position); m.done = true; }
            break;
          }
          case "pulse": node.scale.multiplyScalar(1 + ((1 + Math.sin((age / m.period) * Math.PI * 2 - Math.PI / 2)) / 2) * m.amount); break;
          default:
        }
      }
      if (part.motions.some((m) => m.done)) part.motions = part.motions.filter((m) => !m.done);
    }

    // ---- labels in the margins beside the object, joined by a thin line
    function addLabel(mark) {
      const group = host.svgElement("g", { class: "lesson-label" });
      const line = host.svgElement("line", { stroke: view.ink, "stroke-width": 1.4 * scale.y, opacity: 0.75 });
      const dot = host.svgElement("circle", { r: 2.6 * scale.y, fill: view.ink });
      const text = host.svgElement("text", {
        "font-size": (mark.size || 19) * scale.y, fill: view.ink, "font-family": "Hand, sans-serif",
        stroke: view.ink === "#FFFFFF" ? "rgba(10,12,16,0.55)" : "rgba(255,255,255,0.55)", "stroke-width": 3 * scale.y, "paint-order": "stroke",
      });
      text.textContent = mark.text;
      group.append(line, dot, text);
      host.labelLayer.appendChild(group);
      labels.push({ mark, group, line, dot, text, born: performance.now() / 1000, side: mark.side, y: null, part: mark.follow ? parts.get(mark.follow) : null, point: mark.point ? new THREE.Vector3(...mark.point) : null });
      group.style.opacity = "0";
    }
    view.ink = mark.ink;

    const scratchCenter = new THREE.Vector3();
    function anchorOf(label) {
      if (label.part) {
        const mesh = label.part.meshes[0];
        if (mesh && mesh.geometry) {
          if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
          mesh.geometry.boundingBox.getCenter(scratchCenter);
          return mesh.localToWorld(scratchCenter.clone());
        }
        return label.part.node.getWorldPosition(new THREE.Vector3());
      }
      return root.localToWorld(label.point.clone());
    }
    function isShown(node) {
      for (let n = node; n; n = n.parent) if (!n.visible) return false;
      return true;
    }
    function updateLabels(now) {
      if (!labels.length) return;
      const originY = box.y + titleInset;
      const entries = [];
      for (const label of labels) {
        const shown = !label.part || (label.part.meshes.length > 0 && isShown(label.part.node));
        const world = shown ? anchorOf(label) : null;
        if (!world) { label.group.style.opacity = "0"; continue; }
        const ndc = world.project(camera);
        const x = box.x + ((ndc.x + 1) / 2) * widthPx;
        const y = originY + ((1 - ndc.y) / 2) * heightPx;
        // A side sticks until the anchor has clearly crossed over, so labels don't flip back and forth.
        if (!label.mark.side) {
          const middle = box.x + widthPx / 2;
          if (!label.side || (label.side === "left" && x > middle + widthPx * 0.12) || (label.side === "right" && x < middle - widthPx * 0.12)) {
            label.side = x < middle ? "left" : "right";
          }
        }
        entries.push({ label, x, y });
      }
      const gap = LABEL_GAP * scale.y;
      for (const side of ["left", "right"]) {
        const column = entries.filter((entry) => entry.label.side === side).sort((a, b) => a.y - b.y);
        let cursor = originY + 18 * scale.y;
        for (const entry of column) { entry.slot = Math.max(cursor, entry.y); cursor = entry.slot + gap; }
        let bottom = originY + heightPx - 8 * scale.y;
        for (let i = column.length - 1; i >= 0; i--) {
          if (column[i].slot > bottom) column[i].slot = bottom;
          bottom = column[i].slot - gap;
        }
        for (const entry of column) {
          const { label } = entry;
          label.y = label.y === null ? entry.slot : label.y + (entry.slot - label.y) * 0.12;
          const inset = 6 * scale.x;
          const textX = side === "left" ? box.x + inset : box.x + box.w - inset;
          label.text.setAttribute("x", textX);
          label.text.setAttribute("y", label.y);
          label.text.setAttribute("text-anchor", side === "left" ? "start" : "end");
          const width = label.width || (label.width = label.text.getComputedTextLength());
          const lineStart = side === "left" ? textX + width + 6 * scale.x : textX - width - 6 * scale.x;
          label.line.setAttribute("x1", lineStart);
          label.line.setAttribute("y1", label.y - 6 * scale.y);
          label.line.setAttribute("x2", entry.x);
          label.line.setAttribute("y2", entry.y);
          label.dot.setAttribute("cx", entry.x);
          label.dot.setAttribute("cy", entry.y);
          label.group.style.opacity = String(clamp((now - label.born) / 0.4, 0, 1));
        }
      }
    }

    // ---- drag and wheel
    let dragging = null;
    element.addEventListener("pointerdown", (event) => {
      dragging = { x: event.clientX, y: event.clientY };
      element.setPointerCapture(event.pointerId);
    });
    element.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      view.dragTurn += (event.clientX - dragging.x) * 0.5;
      view.dragTilt += (event.clientY - dragging.y) * 0.35;
      dragging = { x: event.clientX, y: event.clientY };
      pausedUntil = performance.now() / 1000 + RESUME_SPIN_AFTER_DRAG_SECONDS;
    });
    const endDrag = () => { dragging = null; };
    element.addEventListener("pointerup", endDrag);
    element.addEventListener("pointercancel", endDrag);
    element.addEventListener("wheel", (event) => {
      event.preventDefault();
      view.zoom = clamp(view.zoom * (event.deltaY < 0 ? 1.08 : 0.92), 0.5, 3);
    }, { passive: false });

    // ---- keeping it smooth on a weak GPU: trade sharpness and shadow updates for frame rate
    function adjustQuality(now) {
      const elapsed = now - lastFrameReport;
      if (elapsed < QUALITY_CHECK_SECONDS) return;
      const frameMs = (elapsed * 1000) / renderedFrames;
      const level = QUALITY_LEVELS[qualityLevel];
      console.info(`3D: ${frameMs.toFixed(1)} ms per frame (${(renderMilliseconds / renderedFrames).toFixed(1)} ms to submit), ${renderer.info.render.calls} draw calls, pixel ratio ${level.pixelRatio}`);
      lastFrameReport = now;
      renderMilliseconds = 0;
      renderedFrames = 0;
      if (qualityIsSettled) return;
      // Stepping down only earns its blur if it actually helps. On some machines the
      // time goes to the desktop compositor, so go back to the sharp image and stay.
      if (frameMsBeforeStep !== null && frameMs > frameMsBeforeStep * QUALITY_STEP_MUST_SAVE) {
        setQuality(qualityLevel - 1);
        qualityIsSettled = true;
        return;
      }
      if (frameMs > SLOW_FRAME_MS && qualityLevel < QUALITY_LEVELS.length - 1) {
        frameMsBeforeStep = frameMs;
        setQuality(qualityLevel + 1);
      } else {
        qualityIsSettled = frameMs <= SLOW_FRAME_MS;
      }
    }

    function setQuality(level) {
      qualityLevel = level;
      const next = QUALITY_LEVELS[level];
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, next.pixelRatio));
      renderer.setSize(widthPx, heightPx, false);
      canvas.style.width = `${widthPx}px`;
      canvas.style.height = `${heightPx}px`;
      key.shadow.autoUpdate = next.shadowEvery === 1;
    }

    // ---- the frame
    function update(now) {
      if (disposed) return;
      const dt = Math.min(0.1, now - lastTime);
      lastTime = now;
      if (now > pausedUntil && !dragging) view.spinAngle += view.spin * SPIN_DEGREES_PER_UNIT * dt;
      for (const part of parts.values()) updatePart(part, now);
      if (frames % FRAMING_INTERVAL_FRAMES === 0) measureFraming();
      frames++;
      updateCamera(dt);
      const { shadowEvery } = QUALITY_LEVELS[qualityLevel];
      if (shadowEvery > 1 && frames % shadowEvery === 0) key.shadow.needsUpdate = true;
      const renderStart = performance.now();
      renderer.render(scene, camera);
      renderMilliseconds += performance.now() - renderStart;
      renderedFrames++;
      updateLabels(now);
      adjustQuality(now);
    }

    return {
      mark,
      rect: () => [box.x, box.y, box.w, box.h],
      addPart,
      addLabel,
      motion,
      camera(mark) {
        if (mark.tilt !== undefined) view.tilt = mark.tilt;
        if (mark.turn !== undefined) { view.turn = mark.turn; view.spinAngle = 0; view.dragTurn = 0; }
        if (mark.zoom !== undefined) view.zoom = mark.zoom;
        if (mark.spin !== undefined) view.spin = mark.spin;
        view.target = mark.target ? new THREE.Vector3(...mark.target) : view.target;
      },
      poses(poses) {
        for (const id of Object.keys(poses)) {
          const part = parts.get(id);
          if (part) applyPose(part, poses[id]);
        }
      },
      readout(values) {
        const entries = Object.entries(values || {});
        readout.style.display = entries.length ? "block" : "none";
        const text = entries.map(([name, value]) => `${name}: ${value}`).join("\n");
        if (readout.textContent !== text) readout.textContent = text;
      },
      erasePart(id) {
        const part = parts.get(id);
        if (!part) return;
        for (const node of part.nodes) node.visible = false;
        part.nodes.forEach((node) => node.removeFromParent());
        part.holders.forEach((holder) => holder.removeFromParent());
        parts.delete(id);
        for (let i = labels.length - 1; i >= 0; i--) {
          if (labels[i].part === part) { labels[i].group.remove(); labels.splice(i, 1); }
        }
        frames = 0;
      },
      eraseLabel(labelId) {
        const index = labels.findIndex((label) => label.mark.labelId === labelId);
        if (index >= 0) { labels[index].group.remove(); labels.splice(index, 1); }
      },
      highlightPart(id, color) {
        const part = parts.get(id);
        if (part && part.material) {
          part.material.emissive.set(color);
          part.material.emissiveIntensity = 0.35;
        }
      },
      recolorPart(id, color) {
        const part = parts.get(id);
        if (part && part.material) part.material.color.set(color);
      },
      update,
      dispose() {
        disposed = true;
        labels.forEach((label) => label.group.remove());
        renderer.dispose();
        renderer.forceContextLoss();
        element.remove();
      },
    };
  }

  window.ClickyStage = { create, easeOutCubic };
})();
