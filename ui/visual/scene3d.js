// Clicky's 3D layer: models Claude describes as parts (boxes, cylinders,
// lathes, extrusions, tubes, flow arrows), built up step by step on a
// transparent WebGL stage that floats over the user's screen. Drag rotates,
// the wheel zooms, hovering highlights a part.
//
// visual.js owns the lifecycle: ClickyScene.create(spec, host) when a visual
// with "scene3d" arrives, scene.revealStep(elements) as each step streams in
// and is spoken (parts are built then, and the camera re-frames smoothly),
// scene.dispose() when it's cleared.
(() => {
  "use strict";

  const COLORS = {
    ink: 0x3a4150, blue: 0x5b8def, red: 0xef6461, green: 0x4cb36b, orange: 0xf59f3a,
    yellow: 0xf2c94c, purple: 0x8e6cef, teal: 0x2bb3c0, pink: 0xef6fa0, gray: 0xaab2bd,
    white: 0xf4f5f7, black: 0x2b2f36, silver: 0xc9ced6, gold: 0xd4a640, copper: 0xc27c4e,
  };
  const CSS_COLORS = {
    ink: "#3a4150", blue: "#3b6fe0", red: "#e03e3e", green: "#2f9e44", orange: "#e8590c",
    yellow: "#d9a400", purple: "#7048e8", teal: "#0c8599", pink: "#d6336c", gray: "#6c757d",
    white: "#868e96", black: "#2b2f36", silver: "#868e96", gold: "#b08900", copper: "#a85d32",
  };
  const VIEW_DIRECTIONS = {
    iso: [1, 0.75, 1.25], front: [0, 0.15, 1], back: [0, 0.15, -1], side: [1, 0.15, 0],
    left: [-1, 0.15, 0], right: [1, 0.15, 0], top: [0, 1, 0.02], bottom: [0, -1, 0.02],
  };
  // True isometric: the camera looks down (1,1,1), 35.26 degrees above the floor.
  const ISO_DIRECTIONS = { ...VIEW_DIRECTIONS, iso: [1, 1, 1], "iso-left": [-1, 1, 1], "iso-back": [-1, 1, -1], "iso-right": [1, 1, -1] };
  const DEG = Math.PI / 180;
  // three.js r186 addons, bundled by tools/three-bundle (see entry.js there).
  const ADDONS = window.THREE_ADDONS || {};
  // Edge lines live on their own layer so the AO pass can skip them.
  const LINE_LAYER = 2;

  // Perlin noise (as in the isometric-model skill) for deform's bumps and folds; about -1..1.
  const PERM = new Uint8Array(512);
  {
    const p = [...Array(256).keys()];
    let seed = 11;
    for (let i = 255; i > 0; i--) {
      seed = (seed * 16807) % 2147483647;
      const j = seed % (i + 1);
      [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
  }
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const mix = (a, b, t) => a + t * (b - a);
  function grad(hash, x, y, z) {
    const h = hash & 15;
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
    return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
  }
  function noise3(x, y, z) {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
    x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
    const u = fade(x), v = fade(y), w = fade(z);
    const A = PERM[X] + Y, AA = PERM[A] + Z, AB = PERM[A + 1] + Z, B = PERM[X + 1] + Y, BA = PERM[B] + Z, BB = PERM[B + 1] + Z;
    return mix(
      mix(mix(grad(PERM[AA], x, y, z), grad(PERM[BA], x - 1, y, z), u), mix(grad(PERM[AB], x, y - 1, z), grad(PERM[BB], x - 1, y - 1, z), u), v),
      mix(mix(grad(PERM[AA + 1], x, y, z - 1), grad(PERM[BA + 1], x - 1, y, z - 1), u), mix(grad(PERM[AB + 1], x, y - 1, z - 1), grad(PERM[BB + 1], x - 1, y - 1, z - 1), u), v),
      w,
    );
  }
  const inRange = (range, value) => !Array.isArray(range) || (value >= num(range[0], -Infinity) && value <= num(range[1], Infinity));

  /**
   * The skill's deform: a unit sphere pushed into an organic shape — stretched
   * by "size", tapered, bent, roughened or folded with noise, flattened top or
   * bottom, and coloured by region — with shading baked into vertex colours.
   * Much cheaper than a sculpt; good for organs, rocks, fruit, creatures, blobs.
   */
  function deformGeometry(part) {
    const size = Array.isArray(part.size) ? part.size : [num(part.radius, 1), num(part.radius, 1), num(part.radius, 1)];
    const [sx, sy, sz] = [num(size[0], 1), num(size[1], 1), num(size[2], 1)];
    const segments = Math.max(48, Math.min(220, Math.round(num(part.segments, 160))));
    const geometry = new THREE.SphereGeometry(1, segments, Math.round(segments * 0.75));
    geometry.deleteAttribute("uv");
    geometry.deleteAttribute("normal");
    const position = geometry.attributes.position;
    const colors = new Float32Array(position.count * 3);
    const roughen = part.noise && typeof part.noise === "object" ? part.noise : null;
    const amount = num(roughen?.amount, 0.08);
    const scale = num(roughen?.scale, 2.5);
    const width = num(roughen?.width, 0.18);
    const seed = num(part.seed, 0) * 13.7;
    const flatten = typeof part.flatten === "number" ? { bottom: part.flatten } : part.flatten || {};
    const taper = num(part.taper, 0);
    const bend = num(part.bend, 0);
    const twist = num(part.twist, 0) * DEG;
    const base = colorOf(part.color);
    const regions = (Array.isArray(part.regions) ? part.regions : []).map((region) => ({ ...region, tint: colorOf(region.color) }));
    const v = new THREE.Vector3();
    for (let index = 0; index < position.count; index++) {
      v.fromBufferAttribute(position, index);
      // Regions are chosen on the undeformed unit sphere, so ranges are -1..1 on each axis.
      const region = regions.find((candidate) => inRange(candidate.x, v.x) && inRange(candidate.y, v.y) && inRange(candidate.z, v.z));
      const color = region ? region.tint : base;
      let shade = 1;
      if (roughen) {
        const n = noise3(v.x * scale + seed, v.y * scale + seed * 0.5, v.z * scale);
        if (roughen.folds || roughen.ridged) {
          // Grooves where the noise crosses zero: brain folds, walnut, bark, coral.
          const groove = Math.min(1, Math.abs(n) / width);
          v.multiplyScalar(1 - amount * (1 - groove));
          shade = 0.55 + 0.45 * groove;
        } else {
          v.multiplyScalar(1 + amount * n);
          shade = 1 + 0.3 * n;
        }
      }
      const widen = Math.max(0.05, 1 + taper * v.y);
      v.x *= widen;
      v.z *= widen;
      if (twist) {
        const angle = twist * v.y;
        const [x, z] = [v.x, v.z];
        v.x = x * Math.cos(angle) - z * Math.sin(angle);
        v.z = x * Math.sin(angle) + z * Math.cos(angle);
      }
      if (flatten.bottom !== undefined && v.y < flatten.bottom) v.y = flatten.bottom;
      if (flatten.top !== undefined && v.y > flatten.top) v.y = flatten.top;
      v.x += bend * v.y * v.y;
      position.setXYZ(index, v.x * sx, v.y * sy, v.z * sz);
      colors[index * 3] = color.r * shade;
      colors[index * 3 + 1] = color.g * shade;
      colors[index * 3 + 2] = color.b * shade;
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    // Weld the sphere's seam so normals are smooth all the way round.
    const welded = ADDONS.mergeVertices ? ADDONS.mergeVertices(geometry, 1e-5) : geometry;
    welded.computeVertexNormals();
    return orientAlongAxis(welded, part.axis);
  }

  /** The skill's rr + slab: a flat rounded plate, optionally with rounded holes (PCBs, decks, trays, floors). */
  function slabGeometry(part) {
    const size = Array.isArray(part.size) ? part.size : [2, 2];
    const [w, d] = [num(size[0], 2), num(size[size.length > 2 ? 2 : 1], 2)];
    const thickness = num(part.thickness, size.length > 2 ? num(size[1], 0.1) : 0.1);
    const radius = Math.min(num(part.radius, Math.min(w, d) * 0.08), Math.min(w, d) / 2 - 0.001);
    const shape = roundedRectShape(w, d, Math.max(0.001, radius));
    for (const hole of Array.isArray(part.holes) ? part.holes : []) {
      const at = Array.isArray(hole.at) ? hole.at : [0, 0];
      const hs = Array.isArray(hole.size) ? hole.size : [num(hole.r, 0.1) * 2, num(hole.r, 0.1) * 2];
      const [hw, hd] = [num(hs[0], 0.2), num(hs[1], 0.2)];
      const hr = Math.min(num(hole.radius, hole.r !== undefined ? Math.min(hw, hd) / 2 : 0.05), Math.min(hw, hd) / 2 - 0.0005);
      // Shape y maps to -z once the plate is laid flat.
      const points = roundedRectShape(hw, hd, Math.max(0.0005, hr)).getPoints(10).map((point) => new THREE.Vector2(point.x + num(at[0], 0), point.y - num(at[1], 0)));
      shape.holes.push(new THREE.Path(points));
    }
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 14 });
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, -thickness / 2, 0);
    return geometry;
  }

  const num = (value, fallback) => (Number.isFinite(Number(value)) && value !== null && value !== "" ? Number(value) : fallback);
  const vec3 = (value, fallback = [0, 0, 0]) =>
    Array.isArray(value) && value.length >= 3 ? new THREE.Vector3(num(value[0], 0), num(value[1], 0), num(value[2], 0)) : new THREE.Vector3(...fallback);
  const colorOf = (name) => {
    if (typeof name === "string" && /^#[0-9a-f]{6}$/i.test(name)) return new THREE.Color(name);
    return new THREE.Color(COLORS[name] ?? COLORS.gray);
  };
  const cssColorOf = (name) => (typeof name === "string" && /^#[0-9a-f]{6}$/i.test(name) ? name : CSS_COLORS[name] || CSS_COLORS.ink);
  const easeOutBack = (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

  /** Geometry is built along +Y; "axis" turns it to lie along X or Z. */
  function orientAlongAxis(geometry, axis) {
    if (axis === "x") geometry.rotateZ(-Math.PI / 2);
    else if (axis === "z") geometry.rotateX(Math.PI / 2);
    return geometry;
  }

  /** Extrusions are built facing +Z; "axis" turns the extrusion direction. */
  function orientExtrusion(geometry, axis) {
    if (axis === "y") geometry.rotateX(-Math.PI / 2);
    else if (axis === "x") geometry.rotateY(Math.PI / 2);
    return geometry;
  }

  function roundedRectShape(w, h, r) {
    const shape = new THREE.Shape();
    const x = -w / 2;
    const y = -h / 2;
    shape.moveTo(x + r, y);
    shape.lineTo(x + w - r, y);
    shape.quadraticCurveTo(x + w, y, x + w, y + r);
    shape.lineTo(x + w, y + h - r);
    shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    shape.lineTo(x + r, y + h);
    shape.quadraticCurveTo(x, y + h, x, y + h - r);
    shape.lineTo(x, y + r);
    shape.quadraticCurveTo(x, y, x + r, y);
    return shape;
  }

  function buildGeometry(part) {
    const axis = part.axis;
    switch (part.shape) {
      case "box": {
        const size = Array.isArray(part.size) ? part.size : [1, 1, 1];
        return new THREE.BoxGeometry(num(size[0], 1), num(size[1], 1), num(size[2], 1));
      }
      case "sphere":
        return new THREE.SphereGeometry(num(part.radius, 0.5), 48, 32);
      case "dome":
      case "hemisphere":
        return orientAlongAxis(new THREE.SphereGeometry(num(part.radius, 0.5), 48, 20, 0, Math.PI * 2, 0, Math.PI / 2), axis);
      case "roundbox": {
        const size = Array.isArray(part.size) ? part.size : [1, 1, 1];
        const [w, h, d] = [num(size[0], 1), num(size[1], 1), num(size[2], 1)];
        if (ADDONS.RoundedBoxGeometry) {
          // Every edge and corner rounded, like a moulded product body.
          const radius = Math.min(num(part.radius, Math.min(w, h, d) * 0.15), Math.min(w, h, d) / 2 - 0.001);
          return new ADDONS.RoundedBoxGeometry(w, h, d, 5, Math.max(0.001, radius));
        }
        const radius = Math.min(num(part.radius, Math.min(w, h, d) * 0.15), w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001);
        const bevel = Math.min(radius, d * 0.3);
        const shape = roundedRectShape(w - bevel * 2, h - bevel * 2, Math.max(0.001, radius - bevel));
        const geometry = new THREE.ExtrudeGeometry(shape, { depth: d - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 4, curveSegments: 8 });
        geometry.translate(0, 0, -(d - bevel * 2) / 2);
        return geometry;
      }
      case "deform":
        return deformGeometry(part);
      case "slab":
      case "plate":
        return slabGeometry(part);
      case "frame":
      case "bezel":
      case "rim": {
        // A hollow rounded-rectangle rim: phone frames, bezels, laptop lids, cases, picture frames.
        const size = Array.isArray(part.size) ? part.size : [2, 3, 0.3];
        const [w, h, d] = [num(size[0], 2), num(size[1], 3), num(size[2], 0.3)];
        const radius = Math.min(num(part.radius, Math.min(w, h) * 0.12), Math.min(w, h) / 2 - 0.002);
        const wall = Math.min(num(part.wall, Math.min(w, h) * 0.05), Math.min(w, h) / 2 - 0.01);
        const shape = roundedRectShape(w, h, Math.max(0.001, radius));
        shape.holes.push(new THREE.Path(roundedRectShape(w - wall * 2, h - wall * 2, Math.max(0.001, radius - wall)).getPoints(12)));
        const bevel = Math.min(wall * 0.35, d * 0.25);
        const geometry = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.001, d - bevel * 2), bevelEnabled: bevel > 0.002, bevelThickness: bevel, bevelSize: bevel * 0.8, bevelSegments: 3, curveSegments: 10 });
        geometry.translate(0, 0, -(d - bevel * 2) / 2);
        return orientExtrusion(geometry, axis || "z");
      }
      case "ring":
      case "washer": {
        const outer = num(part.radius, 0.6);
        const inner = Math.min(num(part.inner, outer * 0.6), outer - 0.01);
        const half = num(part.height, 0.15) / 2;
        const profile = [[inner, -half], [outer, -half], [outer, half], [inner, half], [inner, -half]].map(([r, y]) => new THREE.Vector2(r, y));
        return orientAlongAxis(new THREE.LatheGeometry(profile, 64), axis);
      }
      case "gear": {
        const teeth = Math.max(4, Math.round(num(part.teeth, 16)));
        const radius = num(part.radius, 1);
        const toothDepth = num(part.toothDepth, radius * 0.16);
        const shape = new THREE.Shape();
        for (let index = 0; index < teeth; index++) {
          const base = (index / teeth) * Math.PI * 2;
          const pitch = (Math.PI * 2) / teeth;
          const corners = [[base, radius - toothDepth], [base + pitch * 0.18, radius], [base + pitch * 0.5, radius], [base + pitch * 0.68, radius - toothDepth]];
          corners.forEach(([angle, r], corner) => {
            const x = Math.cos(angle) * r;
            const y = Math.sin(angle) * r;
            if (index === 0 && corner === 0) shape.moveTo(x, y);
            else shape.lineTo(x, y);
          });
        }
        shape.closePath();
        const hole = num(part.hole, radius * 0.22);
        if (hole > 0) {
          const path = new THREE.Path();
          path.absarc(0, 0, hole, 0, Math.PI * 2, true);
          shape.holes.push(path);
        }
        const depth = num(part.depth, radius * 0.3);
        const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: depth * 0.08, bevelSize: depth * 0.06, bevelSegments: 2, curveSegments: 24 });
        geometry.translate(0, 0, -depth / 2);
        return orientExtrusion(geometry, axis || "z");
      }
      case "spring":
      case "helix":
      case "coil": {
        const radius = num(part.radius, 0.4);
        const height = num(part.height, 1.5);
        const turns = num(part.turns, 6);
        const points = [];
        const segments = Math.max(48, Math.round(turns * 32));
        for (let index = 0; index <= segments; index++) {
          const t = index / segments;
          const angle = t * turns * Math.PI * 2;
          points.push(new THREE.Vector3(Math.cos(angle) * radius, t * height - height / 2, Math.sin(angle) * radius));
        }
        return orientAlongAxis(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), segments, num(part.tube, radius * 0.08), 10), axis);
      }
      case "cylinder": {
        const radius = num(part.radius, 0.5);
        return orientAlongAxis(
          new THREE.CylinderGeometry(num(part.radiusTop, radius), num(part.radiusBottom, radius), num(part.height, 1), 40),
          axis,
        );
      }
      case "cone":
        return orientAlongAxis(new THREE.ConeGeometry(num(part.radius, 0.5), num(part.height, 1), 40), axis);
      case "torus":
        return orientAlongAxis(new THREE.TorusGeometry(num(part.radius, 0.6), num(part.tube, 0.15), 18, 48).rotateX(Math.PI / 2), axis);
      case "capsule":
        // r186 signature: (radius, height, capSegments, radialSegments, heightSegments).
        return orientAlongAxis(new THREE.CapsuleGeometry(num(part.radius, 0.3), num(part.length, num(part.height, 1)), 10, 32, 1), axis);
      case "lathe": {
        const profile = (part.profile || []).filter((p) => Array.isArray(p)).map((p) => new THREE.Vector2(Math.max(0, num(p[0], 0)), num(p[1], 0)));
        if (profile.length < 2) return null;
        return orientAlongAxis(new THREE.LatheGeometry(profile, 48), axis);
      }
      case "extrude": {
        const points = (part.points || []).filter((p) => Array.isArray(p));
        if (points.length < 3) return null;
        const shape = new THREE.Shape(points.map((p) => new THREE.Vector2(num(p[0], 0), num(p[1], 0))));
        const depth = num(part.depth, 0.2);
        const bevel = Math.min(depth * 0.25, 0.06);
        const geometry = new THREE.ExtrudeGeometry(shape, {
          depth,
          bevelEnabled: true,
          bevelThickness: bevel,
          bevelSize: bevel,
          bevelSegments: 2,
        });
        geometry.translate(0, 0, -depth / 2);
        return orientExtrusion(geometry, part.axis);
      }
      case "wedge":
      case "roof":
      case "ramp": {
        // A triangular prism: a gable roof (ridge along the depth) or a ramp.
        const size = Array.isArray(part.size) ? part.size : [1, 1, 1];
        const [w, h, d] = [num(size[0], 1), num(size[1], 1), num(size[2], 1)];
        // size stays [x, y, z] in model units; "axis" is the ridge direction (default x).
        const ramp = part.shape === "ramp" || part.slope === "ramp";
        const alongZ = part.axis === "z";
        const base = alongZ ? w : d;
        const length = alongZ ? d : w;
        const corners = ramp ? [[-base / 2, -h / 2], [base / 2, -h / 2], [-base / 2, h / 2]] : [[-base / 2, -h / 2], [base / 2, -h / 2], [0, h / 2]];
        const geometry = new THREE.ExtrudeGeometry(new THREE.Shape(corners.map(([x, y]) => new THREE.Vector2(x, y))), { depth: length, bevelEnabled: false });
        geometry.translate(0, 0, -length / 2);
        if (!alongZ) geometry.rotateY(Math.PI / 2);
        return geometry;
      }
      case "tube": {
        const path = (part.path || []).filter((p) => Array.isArray(p)).map((p) => vec3(p));
        if (path.length < 2) return null;
        return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(path), Math.max(24, path.length * 16), num(part.radius, 0.06), 12);
      }
      default:
        return null;
    }
  }

  /** A 4-band ramp so toon shading gives each face one flat tone. */
  let toonRamp = null;
  function toonGradient() {
    if (toonRamp) return toonRamp;
    const data = new Uint8Array([90, 90, 90, 255, 150, 150, 150, 255, 205, 205, 205, 255, 255, 255, 255, 255]);
    toonRamp = new THREE.DataTexture(data, 4, 1, THREE.RGBAFormat);
    toonRamp.minFilter = toonRamp.magFilter = THREE.NearestFilter;
    toonRamp.generateMipmaps = false;
    toonRamp.needsUpdate = true;
    return toonRamp;
  }

  /** Isometric style: flat illustrated tones instead of studio PBR. */
  /** Isometric style: the skill's flat-lit Lambert look — clean, saturated, readable from any angle. */
  function buildIsoMaterial(part) {
    const color = colorOf(part.color);
    const opacity = num(part.opacity, part.material === "glass" ? 0.3 : 1);
    const base = { transparent: opacity < 1, opacity, depthWrite: opacity >= 0.6 };
    const emissive = part.emissive ? { emissive: colorOf(part.emissive === true ? part.color : part.emissive), emissiveIntensity: num(part.glow, 0.8) } : {};
    const white = new THREE.Color(0xffffff);
    switch (part.material) {
      case "glass":
      case "frosted":
        return new THREE.MeshLambertMaterial({ ...base, color: color.clone().lerp(white, 0.55), side: THREE.DoubleSide });
      case "glow":
        return new THREE.MeshLambertMaterial({ ...base, color, emissive: color, emissiveIntensity: 1.1 });
      case "metal":
      case "brushed":
      case "chrome":
        return new THREE.MeshLambertMaterial({ ...base, color: color.clone().lerp(new THREE.Color(0xdfe4ea), 0.2), ...emissive });
      case "screen":
        return new THREE.MeshLambertMaterial({ ...base, color: part.emissive ? color : new THREE.Color(0x14161c), ...emissive });
      default:
        return new THREE.MeshLambertMaterial({ ...base, color, ...emissive });
    }
  }

  // Realistic style materials, using what r186's MeshPhysicalMaterial offers
  // (threejs-materials skill): transmission glass, anisotropic brushed metal,
  // clearcoat paint, sheen fabric and rubber, iridescence, dispersion.
  function buildMaterial(part) {
    if (part.__iso) return buildIsoMaterial(part);
    const color = colorOf(part.color);
    const opacity = num(part.opacity, 1);
    const base = { color, transparent: opacity < 1, opacity, depthWrite: opacity >= 0.6 };
    const emissive = part.emissive ? { emissive: colorOf(part.emissive === true ? part.color : part.emissive), emissiveIntensity: num(part.glow, 1) } : {};
    const white = new THREE.Color(0xffffff);
    switch (part.material) {
      case "metal":
        return new THREE.MeshPhysicalMaterial({ ...base, metalness: 1, roughness: 0.3, ...emissive });
      case "chrome":
        return new THREE.MeshPhysicalMaterial({ ...base, color: color.clone().lerp(white, 0.35), metalness: 1, roughness: 0.05, ...emissive });
      case "brushed":
        // Anisotropic highlights stretch along the brushing direction.
        return new THREE.MeshPhysicalMaterial({ ...base, metalness: 1, roughness: 0.34, anisotropy: 0.85, anisotropyRotation: part.axis === "x" ? Math.PI / 2 : 0, ...emissive });
      case "paint":
      case "carpaint":
        return new THREE.MeshPhysicalMaterial({ ...base, metalness: 0.55, roughness: 0.38, clearcoat: 1, clearcoatRoughness: 0.04, ...emissive });
      case "glass": {
        // Clear casings exist to show what's inside, so this stays alpha-blended:
        // physical transmission on a transparent overlay turns milky when nothing
        // opaque sits behind it, and hides transmissive parts inside it.
        const glassOpacity = num(part.opacity, 0.26);
        return new THREE.MeshPhysicalMaterial({ ...base, color: color.clone().lerp(white, 0.45), transparent: true, opacity: glassOpacity, depthWrite: false, metalness: 0, roughness: 0.04, ior: 1.5, specularIntensity: 1, clearcoat: 1, clearcoatRoughness: 0.04, side: THREE.DoubleSide, ...emissive });
      }
      case "frosted":
        return new THREE.MeshPhysicalMaterial({ ...base, color: color.clone().lerp(white, 0.55), metalness: 0, roughness: 0.42, transmission: 1, thickness: num(part.thickness, 0.3), ior: 1.45, side: THREE.DoubleSide, ...emissive });
      case "gem":
      case "crystal":
        return new THREE.MeshPhysicalMaterial({ ...base, color: color.clone().lerp(white, 0.5), metalness: 0, roughness: 0, transmission: 1, thickness: num(part.thickness, 1), ior: 2.2, dispersion: 4, attenuationColor: color, attenuationDistance: 1.2, ...emissive });
      case "liquid":
      case "water":
        return new THREE.MeshPhysicalMaterial({ ...base, color: color.clone().lerp(white, 0.25), metalness: 0, roughness: 0.02, transmission: 0.9, thickness: num(part.thickness, 1), ior: 1.33, attenuationColor: color, attenuationDistance: 1.5, ...emissive });
      case "iridescent":
        return new THREE.MeshPhysicalMaterial({ ...base, metalness: 0.3, roughness: 0.18, iridescence: 1, iridescenceIOR: 1.3, iridescenceThicknessRange: [120, 480], ...emissive });
      case "matte":
        return new THREE.MeshPhysicalMaterial({ ...base, metalness: 0, roughness: 0.92, ...emissive });
      case "rubber":
        return new THREE.MeshPhysicalMaterial({ ...base, metalness: 0, roughness: 0.82, sheen: 0.5, sheenRoughness: 0.7, sheenColor: color.clone().lerp(white, 0.3), ...emissive });
      case "fabric":
      case "cloth":
        return new THREE.MeshPhysicalMaterial({ ...base, metalness: 0, roughness: 0.95, sheen: 1, sheenRoughness: 0.5, sheenColor: color.clone().lerp(white, 0.5), ...emissive });
      case "ceramic":
        return new THREE.MeshPhysicalMaterial({ ...base, metalness: 0, roughness: 0.3, clearcoat: 0.9, clearcoatRoughness: 0.15, ...emissive });
      case "wood":
        return new THREE.MeshPhysicalMaterial({ ...base, metalness: 0, roughness: 0.7, clearcoat: 0.25, clearcoatRoughness: 0.5, ...emissive });
      case "screen":
        // A glossy display: black glass unless it's switched on (emissive).
        return new THREE.MeshPhysicalMaterial({ ...base, color: part.emissive ? color : new THREE.Color(0x0b0d12), metalness: 0, roughness: 0.15, clearcoat: 1, clearcoatRoughness: 0.03, ...emissive });
      case "glow":
        return new THREE.MeshStandardMaterial({ ...base, emissive: color, emissiveIntensity: 2.2, roughness: 0.4 });
      default:
        return new THREE.MeshPhysicalMaterial({ ...base, metalness: 0, roughness: 0.4, clearcoat: 0.4, clearcoatRoughness: 0.3, ...emissive });
    }
  }

  /** Text or a simple UI drawn on a canvas: screens, signs, chip markings, printed labels. */
  function printedTexture(part, pxWidth, pxHeight) {
    const canvas = document.createElement("canvas");
    canvas.width = pxWidth;
    canvas.height = pxHeight;
    const context = canvas.getContext("2d");
    const hex = (value) => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
    const transparentBg = part.bg === "none" || part.bg === false;
    if (!transparentBg) {
      context.fillStyle = hex(part.bg) ? part.bg : part.bg ? cssColorOf(part.bg) : "#0d1117";
      context.fillRect(0, 0, pxWidth, pxHeight);
    }
    const lines = Array.isArray(part.lines) ? part.lines.map(String) : String(part.text ?? "").split("\n");
    const foreground = hex(part.fg) ? part.fg : part.fg ? cssColorOf(part.fg) : transparentBg ? "#1f2430" : "#f4f6fa";
    const longest = Math.max(1, ...lines.map((line) => line.length));
    const fontSize = Math.min((pxHeight * 0.82) / Math.max(1, lines.length) / 1.25, (pxWidth * 0.9) / (longest * 0.56));
    context.fillStyle = foreground;
    context.textAlign = part.align === "left" ? "left" : "center";
    context.textBaseline = "middle";
    context.font = `${part.bold === false ? 500 : 700} ${fontSize}px ${part.font === "mono" ? "monospace" : "'Noto Sans', 'DejaVu Sans', sans-serif"}`;
    const x = part.align === "left" ? pxWidth * 0.06 : pxWidth / 2;
    lines.forEach((line, index) => context.fillText(line, x, pxHeight / 2 + (index - (lines.length - 1) / 2) * fontSize * 1.25));
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace; // a canvas used as a color map is sRGB (threejs-textures)
    texture.anisotropy = 8;
    return texture;
  }

  /** A soft studio "room" for reflections, so metal and glass look real. */
  function studioEnvironment(renderer) {
    if (ADDONS.RoomEnvironment) {
      // RoomEnvironment's softboxes give crisp, believable highlights (threejs-lighting skill).
      const pmrem = new THREE.PMREMGenerator(renderer);
      const room = new ADDONS.RoomEnvironment();
      const texture = pmrem.fromScene(room, 0.04).texture;
      room.dispose();
      pmrem.dispose();
      return texture;
    }
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new THREE.Scene();
    room.add(new THREE.Mesh(new THREE.BoxGeometry(12, 12, 12), new THREE.MeshBasicMaterial({ color: 0x6f7682, side: THREE.BackSide })));
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.MeshBasicMaterial({ color: 0x3d424b }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -5.9;
    room.add(floor);
    const panel = (x, y, z, w, h, intensity) => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(intensity, intensity, intensity * 1.02), side: THREE.DoubleSide }));
      mesh.position.set(x, y, z);
      mesh.lookAt(0, 0, 0);
      room.add(mesh);
    };
    panel(0, 5.8, 0, 7, 7, 5);
    panel(-5.8, 1.5, 2, 3, 6, 3);
    panel(5.8, 2.5, -1, 2.5, 5, 4);
    panel(1, 1, 5.8, 6, 2, 1.6);
    const texture = pmrem.fromScene(room, 0.04).texture;
    pmrem.dispose();
    return texture;
  }

  /** Glowing beads streaming along a path (air, fuel, current, blood, data). */
  function buildFlow(part) {
    const path = (part.path || []).filter((p) => Array.isArray(p)).map((p) => vec3(p));
    if (path.length < 2) return null;
    const curve = new THREE.CatmullRomCurve3(path);
    const color = colorOf(part.color || "teal");
    const group = new THREE.Group();
    const guide = new THREE.Mesh(
      new THREE.TubeGeometry(curve, Math.max(32, path.length * 20), num(part.radius, 0.08) * 0.5, 8),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false }),
    );
    group.add(guide);
    const count = Math.max(3, Math.min(60, Math.round(num(part.count, curve.getLength() * 4))));
    const beadGeometry = new THREE.SphereGeometry(num(part.radius, 0.08) * 1.4, 12, 8);
    const beadMaterial = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.3, roughness: 0.3 });
    const beads = [];
    for (let index = 0; index < count; index++) {
      const bead = new THREE.Mesh(beadGeometry, beadMaterial);
      group.add(bead);
      beads.push(bead);
    }
    group.userData.stream = { curve, beads, speed: num(part.speed, 0.25), offset: 0 };
    return group;
  }

  /** A fat flow arrow from → to, built along +Y then rotated into place. */
  function buildArrow(part) {
    const from = vec3(part.from);
    const to = vec3(part.to, [0, 1, 0]);
    const direction = to.clone().sub(from);
    const length = Math.max(direction.length(), 0.01);
    const thickness = num(part.radius, Math.max(0.035, length * 0.035));
    const headLength = Math.min(length * 0.35, thickness * 6);
    const material = new THREE.MeshStandardMaterial({ color: colorOf(part.color || "orange"), emissive: colorOf(part.color || "orange"), emissiveIntensity: 0.35, roughness: 0.5, transparent: true, opacity: 0.95 });
    const group = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(thickness, thickness, length - headLength, 16), material);
    shaft.position.y = (length - headLength) / 2;
    const head = new THREE.Mesh(new THREE.ConeGeometry(thickness * 2.6, headLength, 20), material);
    head.position.y = length - headLength / 2;
    group.add(shaft, head);
    group.position.copy(from);
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
    group.userData.flow = { material, phase: Math.random() * Math.PI * 2 };
    return group;
  }

  function contactShadowTexture() {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const context = canvas.getContext("2d");
    const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, "rgba(0,0,0,0.32)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(canvas);
  }

  function create(spec, host) {
    const stage = document.createElement("div");
    stage.className = "stage3d";
    const canvas = document.createElement("canvas");
    const labelLayer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    labelLayer.classList.add("stage3d-leaders");
    stage.append(canvas, labelLayer);
    if (host.closeButton) stage.appendChild(host.closeButton());
    if (spec.title) {
      const title = document.createElement("div");
      title.className = "stage3d-title";
      title.textContent = spec.title;
      stage.appendChild(title);
    }

    // The skill's viewer UI: a legend of parts (the colour key), an inspector
    // for the tapped/hovered/narrated part, and Explode / Auto-rotate / Reset
    // plus the model's own toggles. "ui":"labels" keeps floating leader labels instead.
    const useDock = spec.ui !== "labels";
    const dock = useDock ? buildDock() : null;
    function buildDock() {
      const element = document.createElement("div");
      element.className = "stage3d-dock";
      element.innerHTML = `<div class="stage3d-legend"></div>
        <div class="stage3d-inspector" aria-live="polite"><div class="k"></div><div class="n"><span class="sw"></span><span class="pname"></span></div><div class="d"></div></div>
        <div class="stage3d-controls"></div>`;
      return element;
    }
    if (dock) {
      stage.appendChild(dock);
      stage.classList.add("has-dock");
      if (typeof spec.accent === "string" && /^#[0-9a-f]{6}$/i.test(spec.accent)) stage.style.setProperty("--accent3d", spec.accent);
    }

    const sizeFraction = { small: 0.34, medium: 0.46, large: 0.58 }[spec.size] || 0.46;
    const width = Math.round(innerWidth * sizeFraction);
    const height = Math.round(Math.min(innerHeight * (dock ? 0.88 : 0.78), width * 0.82 + (dock ? 120 : 0)));
    stage.style.width = `${width}px`;
    stage.style.height = `${height}px`;
    stage.style.visibility = "hidden";
    document.body.appendChild(stage);
    const [left, top] = host.place(spec.place, width, height);
    stage.style.left = `${left}px`;
    stage.style.top = `${top}px`;
    stage.style.visibility = "";

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: "high-performance" });
    } catch (error) {
      console.error("WebGL unavailable, skipping 3D", error);
      stage.remove();
      return null;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    renderer.setClearColor(0x000000, 0);
    renderer.localClippingEnabled = true;
    // "style":"iso" — a flat, illustrated isometric diorama: orthographic
    // camera at the true isometric angle, three-tone toon faces, ink
    // outlines and a ground tile with crisp shadows.
    const iso = spec.style === "iso" || spec.style === "isometric";
    const directions = iso ? ISO_DIRECTIONS : VIEW_DIRECTIONS;
    const scene = new THREE.Scene();
    let keyLight;
    // Soft PCF shadows in both styles: the model shadows itself and the floor.
    renderer.shadowMap.enabled = spec.shadows !== false;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    if (iso) {
      renderer.toneMapping = THREE.NoToneMapping;
      // The skill's rig: cool sky / dark ground hemisphere, a key from up-left-front
      // that casts the shadows, and a soft blue rim from behind. Since r155 light
      // intensities are physical, so the skill's r128 values are scaled by PI.
      scene.add(new THREE.HemisphereLight(0xeef2ff, 0x1d1f28, 0.6 * Math.PI));
      keyLight = new THREE.DirectionalLight(0xffffff, 0.8 * Math.PI);
      keyLight.position.set(-2, 6, 3);
      const rimLight = new THREE.DirectionalLight(0xa9c8ff, 0.3 * Math.PI);
      rimLight.position.set(4, 1, -4);
      scene.add(rimLight);
      keyLight.castShadow = renderer.shadowMap.enabled;
      keyLight.shadow.mapSize.set(2048, 2048);
      keyLight.shadow.bias = -0.0006;
      keyLight.shadow.normalBias = 0.02;
      scene.add(keyLight, keyLight.target);
    } else {
      // ACES by default (most natural on organic colours); "tone":"neutral" keeps product colours exact.
      renderer.toneMapping = { aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping }[spec.tone] ?? THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = num(spec.exposure, 1);
      try {
        scene.environment = studioEnvironment(renderer);
        scene.environmentIntensity = 0.85; // envMapIntensity no longer scales scene.environment
        scene.environmentRotation.set(0, 0.6, 0);
      } catch (error) {
        console.warn("no environment map", error);
      }
      scene.add(new THREE.HemisphereLight(0xffffff, 0x8a96a8, 0.55));
      keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
      keyLight.position.set(5, 10, 7);
      keyLight.castShadow = renderer.shadowMap.enabled;
      keyLight.shadow.mapSize.set(2048, 2048);
      keyLight.shadow.radius = 5;
      keyLight.shadow.intensity = 0.7;
      keyLight.shadow.bias = -0.0004;
      keyLight.shadow.normalBias = 0.02;
      scene.add(keyLight.target);
      const fillLight = new THREE.DirectionalLight(0xdfe8ff, 0.7);
      fillLight.position.set(-7, 3, -5);
      const rimLight = new THREE.DirectionalLight(0xffffff, 1.2);
      rimLight.position.set(-2, 4, -9);
      scene.add(keyLight, fillLight, rimLight);
    }
    const keyDirection = keyLight.position.clone().normalize();

    const aspect = width / height;
    const camera = iso ? new THREE.OrthographicCamera(-aspect, aspect, 1, -1, 0.01, 2000) : new THREE.PerspectiveCamera(32, aspect, 0.01, 1000);
    camera.layers.enable(LINE_LAYER);
    // Ambient occlusion darkens creases, joints and contact points, which is
    // most of what makes stacked primitives read as one solid object.
    // (threejs-postprocessing: RenderPass -> GTAOPass -> OutputPass, MSAA buffer.)
    let composer = null;
    let aoPass = null;
    if (spec.ao !== false && ADDONS.EffectComposer && ADDONS.GTAOPass) {
      try {
        const target = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, samples: 4 });
        composer = new ADDONS.EffectComposer(renderer, target);
        composer.setSize(width, height);
        composer.addPass(new ADDONS.RenderPass(scene, camera));
        aoPass = new ADDONS.GTAOPass(scene, camera, width, height, undefined, { radius: 0.5, thickness: 1, scale: 1, samples: 16 }, { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6 });
        aoPass.blendIntensity = iso ? 0.75 : 1;
        // Edge lines would draw garbage into the AO normal/depth pass: hide them for it.
        const renderAo = aoPass.render.bind(aoPass);
        aoPass.render = (...args) => {
          camera.layers.disable(LINE_LAYER);
          renderAo(...args);
          camera.layers.enable(LINE_LAYER);
        };
        composer.addPass(aoPass);
        composer.addPass(new ADDONS.OutputPass());
      } catch (error) {
        console.warn("ambient occlusion unavailable", error);
        composer = null;
        aoPass = null;
      }
    }
    // Drop AO if this machine can't hold ~30 fps with it (threejs-performance: measure first).
    const perf = { frames: 0, total: 0 };

    // pivot spins (drag / idle sway); model sits inside it, shifted so the
    // parts built so far stay centred on the pivot.
    const pivot = new THREE.Group();
    const model = new THREE.Group();
    pivot.add(model);
    scene.add(pivot);

    // Parts stream in step by step, so the framing grows as they arrive.
    const parts = new Map();
    let anonymousCount = 0;
    const modelBounds = new THREE.Box3();
    const frameTarget = { center: new THREE.Vector3(), radius: 1 };
    const frameNow = { center: new THREE.Vector3(), radius: 1, initialised: false };

    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: contactShadowTexture(), transparent: true, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.visible = false;
    model.add(shadow);

    // Isometric diorama tile (opt-in with "ground"): a thick slab the model stands on.
    let ground = null;
    if (iso && spec.ground) {
      const groundSpec = typeof spec.ground === "object" ? spec.ground : {};
      ground = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshToonMaterial({ color: colorOf(groundSpec.color || "#e9edf2"), gradientMap: toonGradient() }),
      );
      ground.receiveShadow = true;
      ground.userData.spec = groundSpec;
      const groundEdges = new THREE.LineSegments(new THREE.EdgesGeometry(ground.geometry), new THREE.LineBasicMaterial({ color: 0x8792a2, transparent: true, opacity: 0.55 }));
      groundEdges.layers.set(LINE_LAYER);
      ground.add(groundEdges);
      ground.visible = false;
      ground.scale.setScalar(0.001);
      model.add(ground);
    }

    // Otherwise an invisible floor that only shows the model's shadow (the skill's ShadowMaterial floor).
    let shadowFloor = null;
    if (!ground && renderer.shadowMap.enabled) {
      shadowFloor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: iso ? 0.3 : 0.2, depthWrite: false }));
      shadowFloor.rotation.x = -Math.PI / 2;
      shadowFloor.receiveShadow = true;
      shadowFloor.visible = false;
      model.add(shadowFloor);
    }

    function addPart(element) {
      const holder = buildPart(element);
      if (!holder) return null;
      const id = element.id || `part-${anonymousCount++}`;
      holder.userData.id = id;
      holder.userData.spec = element;
      // Measured before parenting, so the box is in model coordinates.
      holder.updateMatrixWorld(true);
      const partBounds = new THREE.Box3().setFromObject(holder);
      holder.userData.home = holder.position.clone();
      holder.userData.homeCenter = partBounds.isEmpty() ? holder.position.clone() : partBounds.getCenter(new THREE.Vector3());
      holder.userData.restMatrix = holder.matrix.clone();
      holder.visible = false;
      holder.scale.setScalar(0.001);
      const parent = element.parent && parts.get(element.parent);
      if (parent) {
        // Sub-assembly: keep model coordinates, but move/rotate with the parent.
        const local = new THREE.Matrix4().copy(parent.userData.restMatrix).invert().multiply(holder.userData.restMatrix);
        local.decompose(holder.position, holder.quaternion, new THREE.Vector3());
        holder.userData.home = holder.position.clone();
        parent.add(holder);
      } else {
        model.add(holder);
      }
      parts.set(id, holder);
      if (!partBounds.isEmpty()) growBounds(partBounds);
      return holder;
    }

    /** Grows the framing (and contact shadow) to include a box in model coordinates. */
    function growBounds(box) {
      modelBounds.union(box);
      const size = modelBounds.getSize(new THREE.Vector3());
      modelBounds.getCenter(frameTarget.center);
      frameTarget.radius = Math.max(size.length() / 2, 0.5);
      if (!frameNow.initialised) {
        frameNow.center.copy(frameTarget.center);
        frameNow.radius = frameTarget.radius;
        frameNow.initialised = true;
      }
      const footprint = Math.max(size.x, size.z) * 1.5 + 0.2;
      shadow.position.set(frameTarget.center.x, modelBounds.min.y - frameTarget.radius * 0.04, frameTarget.center.z);
      shadow.scale.set(footprint, footprint, 1);
      shadow.visible = !ground && !iso;
      if (shadowFloor) {
        shadowFloor.position.set(frameTarget.center.x, modelBounds.min.y - 0.003, frameTarget.center.z);
        shadowFloor.scale.set(footprint * (iso ? 6 : 1.8), footprint * (iso ? 6 : 1.8), 1);
        shadowFloor.visible = true;
      }
      if (ground) {
        const pad = num(ground.userData.spec.pad, 0.6);
        const [gw, gd] = Array.isArray(ground.userData.spec.size)
          ? [num(ground.userData.spec.size[0], size.x), num(ground.userData.spec.size[1], size.z)]
          : [size.x + pad * 2, size.z + pad * 2];
        const thickness = num(ground.userData.spec.height, Math.max(0.12, Math.min(gw, gd) * 0.06));
        ground.userData.target = { position: new THREE.Vector3(frameTarget.center.x, modelBounds.min.y - thickness / 2 - 0.001, frameTarget.center.z), scale: new THREE.Vector3(gw, thickness, gd) };
        if (!ground.visible) {
          ground.visible = true;
          ground.position.copy(ground.userData.target.position);
          tween(500, (t) => ground.scale.copy(ground.userData.target.scale).multiplyScalar(Math.max(0.001, easeOutBack(t))));
          ground.userData.grown = performance.now() + 520;
        }
      }
    }

    /** Eases the model's centring and the camera distance toward the current parts. */
    // While exploded, frame the parts where they actually are (the skill zooms
    // out by a fixed 30%; measuring keeps far-flung parts on screen too).
    const liveBounds = new THREE.Box3();
    let liveBoundsAge = 0;
    let explodeLevel = 0;
    function measureLiveBounds() {
      liveBounds.makeEmpty();
      const toModel = model.matrixWorld.clone().invert();
      for (const holder of parts.values()) {
        if (holder.parent !== model || !holder.visible || ["flow", "arrow"].includes(holder.userData.spec.shape)) continue;
        const box = new THREE.Box3().setFromObject(holder);
        if (!box.isEmpty()) liveBounds.union(box.applyMatrix4(toModel));
      }
    }
    function updateFraming(delta) {
      const k = 1 - Math.exp(-delta * 4);
      explodeLevel += ((exploded ? 1 : 0) - explodeLevel) * (1 - Math.exp(-delta * 3));
      if (explodeLevel > 0.01 && ++liveBoundsAge % 6 === 0) {
        measureLiveBounds();
        if (!liveBounds.isEmpty()) {
          const box = modelBounds.clone().union(liveBounds);
          box.getCenter(frameTarget.center);
          frameTarget.radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.5);
        }
      } else if (explodeLevel <= 0.01 && !modelBounds.isEmpty()) {
        modelBounds.getCenter(frameTarget.center);
        frameTarget.radius = Math.max(modelBounds.getSize(new THREE.Vector3()).length() / 2, 0.5);
      }
      frameNow.center.lerp(frameTarget.center, k);
      frameNow.radius += (frameTarget.radius - frameNow.radius) * k;
      model.position.copy(frameNow.center).negate();
      if (iso) {
        camState.distance = frameNow.radius * 6 + 10;
        if (ground?.userData.target && performance.now() > (ground.userData.grown || 0)) {
          ground.position.lerp(ground.userData.target.position, k);
          ground.scale.lerp(ground.userData.target.scale, k);
        }
      } else {
        camState.distance = (frameNow.radius / Math.sin((camera.fov * DEG) / 2)) * 1.08;
      }
      if (keyLight.castShadow) {
        // Shadow camera hugs the model so the map stays sharp (threejs-lighting skill).
        const reach = frameNow.radius * 1.9 + 1;
        const shadowCamera = keyLight.shadow.camera;
        shadowCamera.left = shadowCamera.bottom = -reach;
        shadowCamera.right = shadowCamera.top = reach;
        shadowCamera.near = 0.1;
        shadowCamera.far = reach * 4;
        shadowCamera.updateProjectionMatrix();
        keyLight.position.copy(keyDirection).multiplyScalar(reach * 2);
        keyLight.target.position.set(0, 0, 0);
      }
      if (aoPass) aoPass.updateGtaoMaterial({ radius: Math.max(0.15, frameNow.radius * 0.09) });
    }

    const camState = {
      direction: vec3(directions[spec.view] || directions.iso).normalize(),
      distance: 10,
      target: new THREE.Vector3(),
      zoom: 1,
    };
    // The dock covers the bottom of the stage: aim the model at the space above it.
    let dockSpace = 0;
    function measureDock() {
      dockSpace = dock ? dock.offsetHeight + 14 : 0;
    }
    function applyCamera() {
      const roomy = height / Math.max(120, height - dockSpace);
      camera.position.copy(camState.target).addScaledVector(camState.direction, camState.distance * (iso ? 1 : camState.zoom * roomy));
      if (dockSpace) camera.setViewOffset(width, height, 0, dockSpace / 2, width, height);
      else camera.clearViewOffset();
      if (Math.abs(camState.direction.y) > 0.98) camera.up.set(0, 0, -Math.sign(camState.direction.y));
      else camera.up.set(0, 1, 0);
      camera.lookAt(camState.target);
      if (iso) {
        // Orthographic framing: the half-height fits the model's bounding sphere.
        const half = frameNow.radius * (ground ? 1.3 : 1.12) * camState.zoom * roomy;
        camera.top = half;
        camera.bottom = -half;
        camera.left = -half * aspect;
        camera.right = half * aspect;
        camera.updateProjectionMatrix();
      }
    }
    applyCamera();

    // ------------------------------------------------------------ labels
    const labels = [];
    let stepCount = 0;
    /** Older labels shrink to just their name so the newest ones stand out. */
    function ageLabels() {
      for (const label of labels) if (label.step < stepCount) label.element.classList.add("old");
    }
    function freshenLabel(holder) {
      for (const label of labels) if (label.holder === holder) label.element.classList.remove("old");
    }
    function addLabel(holder, text, colorName, side, desc, point = null) {
      const element = document.createElement("div");
      element.className = "label3d";
      const title = document.createElement("div");
      title.textContent = text;
      element.appendChild(title);
      if (desc) {
        const detail = document.createElement("div");
        detail.className = "label3d-desc";
        detail.textContent = desc;
        element.appendChild(detail);
      }
      element.style.borderColor = cssColorOf(colorName);
      stage.appendChild(element);
      const leader = document.createElementNS("http://www.w3.org/2000/svg", "line");
      leader.setAttribute("stroke", cssColorOf(colorName));
      leader.setAttribute("stroke-width", "1.5");
      labelLayer.appendChild(leader);
      labels.push({ holder, element, leader, side, point, bornAt: performance.now(), step: stepCount });
    }

    function updateLabels() {
      const stageCenter = new THREE.Vector2(width / 2, height / 2);
      const placed = [];
      for (const label of labels) {
        if (!label.holder.visible) {
          label.element.style.opacity = 0;
          label.leader.setAttribute("opacity", 0);
          continue;
        }
        const anchor = label.point ? label.point.getWorldPosition(new THREE.Vector3()) : new THREE.Box3().setFromObject(label.holder).getCenter(new THREE.Vector3());
        const projected = anchor.clone().project(camera);
        const x = (projected.x * 0.5 + 0.5) * width;
        const y = (-projected.y * 0.5 + 0.5) * height;
        let direction;
        switch (label.side) {
          case "left": direction = new THREE.Vector2(-1, -0.25); break;
          case "right": direction = new THREE.Vector2(1, -0.25); break;
          case "top": direction = new THREE.Vector2(0.2, -1); break;
          case "bottom": direction = new THREE.Vector2(0.2, 1); break;
          default: direction = new THREE.Vector2(x, y).sub(stageCenter);
        }
        if (direction.lengthSq() < 1) direction.set(1, -0.4);
        direction.normalize();
        const boxWidth = label.element.offsetWidth;
        const boxHeight = label.element.offsetHeight;
        const reach = Math.min(width, height) * 0.2;
        let labelX = x + direction.x * reach;
        let labelY = y + direction.y * reach * 0.8;
        labelX = Math.min(Math.max(labelX, boxWidth / 2 + 4), width - boxWidth / 2 - 4);
        labelY = Math.min(Math.max(labelY, boxHeight / 2 + 4), height - boxHeight / 2 - 4);
        // Nudge away from labels already placed this frame so none overlap.
        for (let attempt = 0; attempt < 8; attempt++) {
          const clash = placed.find(
            (other) => Math.abs(other.x - labelX) < (other.width + boxWidth) / 2 + 6 && Math.abs(other.y - labelY) < (other.height + boxHeight) / 2 + 4,
          );
          if (!clash) break;
          const below = clash.y + (clash.height + boxHeight) / 2 + 4;
          const above = clash.y - (clash.height + boxHeight) / 2 - 4;
          labelY = below + boxHeight / 2 < height && (labelY >= clash.y || above - boxHeight / 2 < 0) ? below : above;
        }
        placed.push({ x: labelX, y: labelY, width: boxWidth, height: boxHeight });
        label.element.style.transform = `translate(${labelX - boxWidth / 2}px, ${labelY - boxHeight / 2}px)`;
        const age = Math.min(1, (performance.now() - label.bornAt) / 400) * (label.ghosted ? 0.35 : 1);
        label.element.style.opacity = age;
        label.leader.setAttribute("x1", x);
        label.leader.setAttribute("y1", y);
        label.leader.setAttribute("x2", labelX);
        label.leader.setAttribute("y2", labelY);
        label.leader.setAttribute("opacity", age);
      }
    }

    // ------------------------------------------------------------ parts & actions
    function buildUnit(element) {
      if (element.shape === "panel" || element.shape === "screen" || element.shape === "sign") {
        // A flat printed face (screen UI, sign, chip marking, label), facing +z unless "axis" or "rot" turn it.
        const size = Array.isArray(element.size) ? element.size : [2, 1];
        const [w, h] = [num(size[0], 2), num(size[1], 1)];
        const scale = 256 / Math.max(0.1, Math.min(w, h));
        const texture = printedTexture(element, Math.min(2048, Math.round(w * scale)), Math.min(2048, Math.round(h * scale)));
        const transparentBg = element.bg === "none" || element.bg === false;
        const glowing = element.shape === "screen" ? element.emissive !== false : element.emissive === true;
        const material = new THREE.MeshPhysicalMaterial({
          map: texture,
          transparent: transparentBg,
          roughness: element.shape === "screen" ? 0.15 : 0.55,
          clearcoat: element.shape === "screen" ? 1 : 0,
          emissive: glowing ? 0xffffff : 0x000000,
          emissiveMap: glowing ? texture : null,
          emissiveIntensity: glowing ? num(element.glow, 0.9) : 0,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          depthWrite: !transparentBg,
        });
        const plane = new THREE.PlaneGeometry(w, h);
        if (element.axis === "y") plane.rotateX(-Math.PI / 2);
        else if (element.axis === "x") plane.rotateY(Math.PI / 2);
        const panel = new THREE.Mesh(plane, material);
        panel.receiveShadow = true;
        return panel;
      }
      const geometry = buildGeometry(element);
      if (!geometry) return null;
      const mesh = new THREE.Mesh(geometry, buildMaterial(iso ? { ...element, __iso: true } : element));
      if (geometry.attributes.color) {
        // deform bakes its colours and fold shading into the vertices.
        mesh.material.vertexColors = true;
        mesh.material.color.set(0xffffff);
      }
      const seeThrough = mesh.material.transmission > 0 || mesh.material.opacity < 0.6;
      mesh.castShadow = !seeThrough && element.shadow !== false;
      mesh.receiveShadow = true;
      // Like the skill: in iso, dark outlines on hard-edged shapes only; curved ones read by shading.
      const boxy = ["box", "roundbox", "slab", "plate", "wedge", "roof", "ramp", "frame", "bezel", "rim", "extrude", "gear"].includes(element.shape);
      if (element.outline === true || (element.outline !== false && (!iso || boxy) && element.shape !== "deform")) {
        const edgeGeometry = new THREE.EdgesGeometry(geometry, seeThrough ? 40 : 30);
        const edgeColor = seeThrough ? new THREE.Color(0xffffff) : iso ? new THREE.Color(0x06080b) : colorOf(element.color).multiplyScalar(0.4);
        let edges;
        if (iso && ADDONS.LineSegments2) {
          // Fat screen-space ink lines; WebGL itself only draws 1px lines (threejs-geometry: Lines).
          const lineMaterial = new ADDONS.LineMaterial({ color: edgeColor, linewidth: num(element.lineWidth, 1.4), transparent: true, opacity: seeThrough ? 0.4 : 0.55, worldUnits: false });
          lineMaterial.resolution.set(width, height);
          edges = new ADDONS.LineSegments2(new ADDONS.LineSegmentsGeometry().fromEdgesGeometry(edgeGeometry), lineMaterial);
          edgeGeometry.dispose();
        } else {
          edges = new THREE.LineSegments(edgeGeometry, new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: seeThrough ? 0.35 : 0.28 }));
        }
        edges.layers.set(LINE_LAYER);
        mesh.add(edges);
      }
      return mesh;
    }

    function buildPart(element) {
      const holder = new THREE.Group();
      if (element.shape === "arrow") {
        holder.add(buildArrow(element));
        return holder;
      }
      if (["sculpt", "organic", "dna", "molecule"].includes(element.shape) && window.ClickySculpt) {
        // Detailed generated models: sculpted organic forms, DNA, molecules.
        const kind = element.shape === "organic" ? "sculpt" : element.shape;
        let model;
        try {
          model = window.ClickySculpt[kind](element);
        } catch (error) {
          console.error("couldn't build", kind, error);
        }
        if (!model) return null;
        holder.position.copy(vec3(element.at));
        const rotation = vec3(element.rot).multiplyScalar(DEG);
        holder.rotation.set(rotation.x, rotation.y, rotation.z);
        const attach = (built) => {
          if (!built) return;
          if (element.axis === "x") built.rotation.z = -Math.PI / 2;
          else if (element.axis === "z") built.rotation.x = Math.PI / 2;
          holder.add(built);
          holder.userData.model = built;
        };
        if (typeof model.then === "function") {
          // Sculpts build in time slices; the part fills in when ready.
          holder.userData.pending = model.then((built) => {
            if (disposed || !built) return;
            // Measure in model coordinates (holder's rest transform, scale 1).
            const probe = new THREE.Group();
            probe.applyMatrix4(holder.userData.restMatrix || new THREE.Matrix4());
            if (element.axis === "x") built.rotation.z = -Math.PI / 2;
            else if (element.axis === "z") built.rotation.x = Math.PI / 2;
            probe.add(built);
            probe.updateMatrixWorld(true);
            growBounds(new THREE.Box3().setFromObject(probe));
            probe.remove(built);
            holder.add(built);
            holder.userData.model = built;
            built.traverse((object) => object.isMesh && ((object.castShadow = object.material?.opacity >= 0.6), (object.receiveShadow = true)));
            built.scale.setScalar(0.001);
            tween(700, (t) => built.scale.setScalar(Math.max(0.001, easeOutBack(t))));
            if (holder.userData.revealed) addPinnedLabels(holder, element.labels);
          }).catch((error) => console.error("sculpt failed", error));
        } else {
          attach(model);
        }
        return holder;
      }
      if (element.shape === "flow") {
        const flow = buildFlow(element);
        if (!flow) return null;
        holder.add(flow);
        return holder;
      }
      const unit = buildUnit(element);
      if (!unit) return null;
      const at = vec3(element.at);
      const rotation = vec3(element.rot).multiplyScalar(DEG);
      const repeat = element.repeat;
      if (!repeat || typeof repeat !== "object") {
        holder.add(unit);
        holder.position.copy(at);
        holder.rotation.set(rotation.x, rotation.y, rotation.z);
        return holder;
      }
      // Repeated parts (bolts, fins, teeth, keys, cells): copies share geometry.
      const count = Math.max(1, Math.min(200, Math.round(num(repeat.count, 2))));
      if (repeat.radial || repeat.around) {
        const center = vec3(repeat.center || repeat.around, [0, 0, 0]);
        const axis = { x: new THREE.Vector3(1, 0, 0), z: new THREE.Vector3(0, 0, 1) }[repeat.axis] || new THREE.Vector3(0, 1, 0);
        const sweep = num(repeat.sweep, 360) * DEG;
        const full = Math.abs(sweep - Math.PI * 2) < 1e-3;
        for (let index = 0; index < count; index++) {
          const angle = num(repeat.start, 0) * DEG + (full ? (index / count) * sweep : (count > 1 ? (index / (count - 1)) * sweep : 0));
          const spoke = new THREE.Group();
          spoke.position.copy(center);
          spoke.quaternion.setFromAxisAngle(axis, angle);
          const copy = index === 0 ? unit : unit.clone();
          copy.position.copy(at).sub(center);
          copy.rotation.set(rotation.x, rotation.y, rotation.z);
          spoke.add(copy);
          holder.add(spoke);
        }
      } else {
        const step = vec3(repeat.step, [1, 0, 0]);
        const count2 = Math.max(1, Math.min(50, Math.round(num(repeat.count2, 1))));
        const step2 = vec3(repeat.step2, [0, 0, 1]);
        for (let row = 0; row < count2; row++) {
          for (let index = 0; index < count; index++) {
            const copy = row === 0 && index === 0 ? unit : unit.clone();
            copy.position.copy(at).addScaledVector(step, index).addScaledVector(step2, row);
            copy.rotation.set(rotation.x, rotation.y, rotation.z);
            holder.add(copy);
          }
        }
      }
      return holder;
    }

    const tweens = [];
    const spinners = [];
    const clip = { local: null, world: new THREE.Plane(new THREE.Vector3(-1, 0, 0), 1e6) };
    let orbitSpeed = 0;
    // "explodeStart": teardowns open already pulled apart (offsets from each part's "explode").
    let exploded = spec.explodeStart ? { middle: null, factor: 0.9 } : null;
    const oscillators = [];
    function startOscillating(holder, spec) {
      const axis = "xyz".includes(spec.axis) && spec.axis ? spec.axis : "y";
      oscillators.push({ holder, axis, base: holder.position[axis], amount: num(spec.amount, 0.5), speed: num(spec.speed, 1), phase: num(spec.phase, 0) * DEG, startedAt: performance.now() });
    }
    function tween(duration, update) {
      tweens.push({ startedAt: performance.now(), duration: Math.max(1, duration), update });
    }

    /** Where a part sits in the current exploded view: its own "explode" offset, or pushed away from the middle. */
    function explodedPosition(target, state) {
      const to = target.userData.home.clone();
      const spec = target.userData.spec;
      if (Array.isArray(spec.explode)) return to.add(vec3(spec.explode));
      const away = (target.userData.homeCenter || target.position).clone().sub(state.middle || frameTarget.center);
      if (state.axis && "xyz".includes(state.axis)) for (const key of "xyz") if (key !== state.axis) away[key] = 0;
      return to.addScaledVector(away, state.factor);
    }

    function revealPart(holder, delay) {
      const element = holder.userData.spec;
      setTimeout(() => {
        if (exploded && !exploded.onlyListed && holder.parent === model) {
          // The model is pulled apart: a new part slides out to its exploded place.
          const from = holder.position.clone();
          const to = explodedPosition(holder, exploded);
          tween(900, (t) => holder.position.lerpVectors(from, to, easeInOut(t)));
        }
        holder.visible = true;
        tween(650, (t) => holder.scale.setScalar(Math.max(0.001, easeOutBack(t))));
        if (element.label) {
          if (dock) addChip(holder, element.label, element.desc, element.short);
          else addLabel(holder, element.label, element.labelColor || element.color, element.labelSide, element.desc);
        } else if (dock && holder.parent === model && Array.isArray(element.labels) && element.labels.length) {
          // A sculpt named only by pinned labels still gets a legend chip, so it can be picked.
          const name = element.name || String(element.id || "part").replace(/[-_]+/g, " ");
          const pinned = element.labels;
          const desc = element.desc || (pinned.length === 1 && pinned[0].desc ? pinned[0].desc : pinned.map((label) => label.text).filter(Boolean).join(", "));
          addChip(holder, name, desc, element.short);
        }
        holder.userData.revealed = true;
        if (holder.userData.model) addPinnedLabels(holder, element.labels);
        if (element.spin) spinners.push({ holder, axis: element.spin.axis || element.axis || "y", speed: num(element.spin.speed, 1) });
        if (element.oscillate) startOscillating(holder, element.oscillate);
      }, delay);
    }

    /** Labels pinned to points on a generated model: {"text","desc","at"} or {"anchor"} or {"atom"}. */
    function addPinnedLabels(holder, list) {
      const model = holder.userData.model;
      if (!model || !Array.isArray(list)) return;
      const anchors = Object.values(model.userData.anchors || {});
      list.forEach((label, index) => {
        let entry = anchors.find((candidate) => candidate.label === label);
        if (!entry && label.anchor) entry = model.userData.anchors?.[label.anchor];
        if (!entry) return;
        const marker = new THREE.Object3D();
        marker.position.copy(entry.point);
        model.add(marker);
        setTimeout(
          () => addLabel(holder, label.text || label.label || label.anchor || "", label.color || "ink", label.side || label.labelSide, label.desc, marker),
          220 * index,
        );
      });
    }

    function setOpacity(holder, opacity) {
      holder.traverse((object) => {
        if (object.material) {
          object.material.transparent = true;
          object.material.opacity = object.isLineSegments ? opacity * 0.5 : opacity;
          object.material.depthWrite = opacity >= 0.6;
          object.material.needsUpdate = true;
        }
      });
    }

    // ---- x-ray: when the camera focuses on a part, parts in front of it fade out
    const ghosted = new Set();
    function ghost(holder) {
      if (ghosted.has(holder)) return;
      ghosted.add(holder);
      const materials = [];
      holder.traverse((object) => {
        if (!object.material) return;
        const material = object.material;
        if (!material.userData.ghostBase) material.userData.ghostBase = { opacity: material.opacity, transparent: material.transparent, depthWrite: material.depthWrite };
        material.transparent = true;
        material.depthWrite = false;
        material.needsUpdate = true;
        materials.push(material);
      });
      tween(500, (t) => materials.forEach((material) => (material.opacity = material.userData.ghostBase.opacity * (1 - 0.88 * t))));
      for (const label of labels) if (label.holder === holder) label.ghosted = true;
    }
    function unghostAll() {
      for (const holder of ghosted) {
        holder.traverse((object) => {
          const base = object.material?.userData.ghostBase;
          if (!base) return;
          Object.assign(object.material, base);
          object.material.needsUpdate = true;
          delete object.material.userData.ghostBase;
        });
        for (const label of labels) if (label.holder === holder) label.ghosted = false;
      }
      ghosted.clear();
      if (selected) {
        selected = null;
        refreshChips();
        stage.dataset.selected = "";
      }
    }
    /** Casts rays from the camera at the focused part and ghosts whatever is in the way. */
    function ghostOccluders(target) {
      const box = new THREE.Box3().setFromObject(target);
      if (box.isEmpty()) return;
      const center = box.getCenter(new THREE.Vector3());
      const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.35);
      const samples = [center];
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) samples.push(center.clone().add(new THREE.Vector3(sx * half.x, sy * half.y, 0)));
      const related = (holder) => {
        for (let node = holder; node; node = node.parent) if (node === target) return true;
        for (let node = target; node; node = node.parent) if (node === holder) return true;
        return false;
      };
      const candidates = [...parts.values()].filter((holder) => holder.visible);
      const caster = new THREE.Raycaster();
      for (const point of samples) {
        const origin = camera.isOrthographicCamera ? point.clone().addScaledVector(camState.direction, camState.distance) : camera.position.clone();
        const direction = point.clone().sub(origin);
        const reach = direction.length();
        caster.set(origin, direction.normalize());
        caster.far = reach - 0.02;
        for (const hit of caster.intersectObjects(candidates, true)) {
          if (!hit.object.isMesh) continue;
          let holder = hit.object;
          while (holder && !holder.userData.id) holder = holder.parent;
          // Ghost the outermost assembly that's in the way, never the focused part's family.
          while (holder?.parent?.userData.id && !related(holder.parent)) holder = holder.parent;
          if (holder && !related(holder)) ghost(holder);
        }
      }
    }

    function runAction(element, delay) {
      const holder = parts.get(element.id);
      setTimeout(() => {
        switch (element.action) {
          case "move": {
            if (!holder) return;
            const from = holder.position.clone();
            let to;
            if (Array.isArray(element.by)) {
              to = from.clone().add(vec3(element.by));
            } else {
              to = vec3(element.to);
              // "to" is in model coordinates; children of a sub-assembly live in its space.
              const parentRest = holder.parent?.userData?.restMatrix;
              if (holder.parent !== model && parentRest) to.applyMatrix4(new THREE.Matrix4().copy(parentRest).invert());
            }
            tween(num(element.duration, 1.2) * 1000, (t) => holder.position.lerpVectors(from, to, easeInOut(t)));
            break;
          }
          case "rotate": {
            if (!holder) return;
            const from = holder.rotation.clone();
            const to = vec3(element.to).multiplyScalar(DEG);
            tween(num(element.duration, 1) * 1000, (t) => {
              const k = easeInOut(t);
              holder.rotation.set(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k, from.z + (to.z - from.z) * k);
            });
            break;
          }
          case "spin":
            if (holder) spinners.push({ holder, axis: element.axis || "y", speed: num(element.speed, 1) });
            break;
          case "oscillate":
            if (holder) startOscillating(holder, element);
            break;
          case "stop":
            for (let index = spinners.length - 1; index >= 0; index--) if (spinners[index].holder === holder) spinners.splice(index, 1);
            for (let index = oscillators.length - 1; index >= 0; index--) {
              if (oscillators[index].holder !== holder) continue;
              holder.position[oscillators[index].axis] = oscillators[index].base;
              oscillators.splice(index, 1);
            }
            break;
          case "opacity":
          case "hide": {
            if (!holder) return;
            const target = element.action === "hide" ? 0 : num(element.value, 0.3);
            tween(600, (t) => setOpacity(holder, 1 + (target - 1) * t));
            if (target === 0) setTimeout(() => (holder.visible = false), 620);
            break;
          }
          case "highlight":
            if (holder) {
              highlight(holder, 2200);
              freshenLabel(holder);
              showInfo(holder);
            }
            break;
          case "label":
            if (holder && dock) addChip(holder, element.text || holder.userData.spec.label || "", element.desc, element.short);
            else if (holder) addLabel(holder, element.text || "", element.color || holder.userData.spec.color, element.labelSide, element.desc);
            break;
          case "view": {
            const fromDirection = camState.direction.clone();
            const toDirection = vec3(directions[element.view] || directions.iso).normalize();
            const fromTarget = camState.target.clone();
            const toTarget = holder ? new THREE.Box3().setFromObject(holder).getCenter(new THREE.Vector3()) : new THREE.Vector3();
            const fromZoom = camState.zoom;
            const toZoom = holder ? Math.max(0.45, num(element.zoom, 0.6)) : num(element.zoom, 1);
            userRotated = false;
            unghostAll();
            if (holder) {
              freshenLabel(holder);
              showInfo(holder);
              // The camera is flying to a part: stop turning so it stays in view.
              setAutoSpin(false);
            }
            tween(1100, (t) => {
              const k = easeInOut(t);
              camState.direction.copy(fromDirection).lerp(toDirection, k).normalize();
              camState.target.lerpVectors(fromTarget, toTarget, k);
              camState.zoom = fromZoom + (toZoom - fromZoom) * k;
              if (t >= 1 && holder) {
                // Camera has arrived: see-through whatever hides the part being explained.
                applyCamera();
                scene.updateMatrixWorld();
                ghostOccluders(holder);
              }
            });
            break;
          }
          case "explode":
          case "assemble": {
            unghostAll();
            const targets = targetParts(element);
            const center = new THREE.Box3();
            for (const target of targets) center.expandByPoint(target.userData.homeCenter || target.position);
            const middle = center.getCenter(new THREE.Vector3());
            // Remembered so parts added in later steps arrive already pulled apart.
            exploded = element.action === "explode" ? { middle, factor: num(element.factor, 0.9), axis: element.axis, onlyListed: Array.isArray(element.ids) } : null;
            syncControls();
            for (const target of targets) {
              const from = target.position.clone();
              const to = exploded ? explodedPosition(target, exploded) : target.userData.home.clone();
              tween(num(element.duration, 1.4) * 1000, (t) => target.position.lerpVectors(from, to, easeInOut(t)));
            }
            break;
          }
          case "cut": {
            // Slice the model open along an axis to show the inside.
            const axisKey = "xyz".includes(element.axis) ? element.axis : "x";
            const normal = new THREE.Vector3();
            normal[axisKey] = element.keep === "above" ? 1 : -1;
            const finalAt = num(element.at, 0);
            const bounds = new THREE.Box3();
            for (const holderItem of parts.values()) bounds.union(new THREE.Box3().setFromObject(holderItem));
            const startAt = element.keep === "above" ? bounds.min[axisKey] - 0.01 : bounds.max[axisKey] + 0.01;
            const local = new THREE.Plane(normal.clone(), 0);
            clip.local = local;
            const targets = targetParts(element).filter((target) => !["arrow", "flow"].includes(target.userData.spec.shape));
            for (const target of targets) {
              target.traverse((object) => {
                if (!object.material) return;
                object.material.clippingPlanes = [clip.world];
                if (object.isMesh) object.material.side = THREE.DoubleSide;
                object.material.needsUpdate = true;
              });
            }
            tween(num(element.duration, 1.3) * 1000, (t) => {
              const position = startAt + (finalAt - startAt) * easeInOut(t);
              local.constant = element.keep === "above" ? -position : position;
            });
            break;
          }
          case "uncut":
            clip.local = null;
            for (const holderItem of parts.values()) holderItem.traverse((object) => {
              if (object.material?.clippingPlanes) {
                object.material.clippingPlanes = null;
                object.material.needsUpdate = true;
              }
            });
            break;
          case "orbit":
            orbitSpeed = num(element.speed, 0.12);
            userRotated = false;
            setAutoSpin(true);
            break;
          case "turn": {
            // Swing the whole model around (90 shows the next isometric side).
            orbitSpeed = 0;
            userRotated = true;
            setAutoSpin(false);
            const from = pivot.rotation.y;
            const to = from + num(element.by, 90) * DEG;
            const fromTilt = pivot.rotation.x;
            tween(num(element.duration, 1.1) * 1000, (t) => {
              const k = easeInOut(t);
              pivot.rotation.y = from + (to - from) * k;
              pivot.rotation.x = fromTilt * (1 - k);
            });
            break;
          }
          case "color": {
            if (!holder) return;
            const target = colorOf(element.color);
            const materials = [];
            holder.traverse((object) => object.isMesh && object.material.color && materials.push(object.material));
            const starts = materials.map((material) => material.color.clone());
            tween(num(element.duration, 0.9) * 1000, (t) => materials.forEach((material, index) => material.color.copy(starts[index]).lerp(target, t)));
            break;
          }
          default:
            console.warn("unknown 3D action", element);
        }
      }, delay);
    }

    /** Parts named by "ids" (or "id"), else every top-level part. */
    function targetParts(element) {
      const ids = Array.isArray(element.ids) ? element.ids : element.id ? [element.id] : null;
      if (ids) return ids.map((id) => parts.get(id)).filter(Boolean);
      return [...parts.values()].filter((holderItem) => holderItem.parent === model);
    }

    function rememberEmissive(material) {
      if (!material.userData.baseEmissive) material.userData.baseEmissive = { color: material.emissive.clone(), intensity: material.emissiveIntensity };
    }
    function restoreEmissive(material) {
      const base = material.userData.baseEmissive;
      if (!base) return;
      material.emissive.copy(base.color);
      material.emissiveIntensity = base.intensity;
    }

    function highlight(holder, duration) {
      const materials = [];
      holder.traverse((object) => {
        if (object.isMesh && object.material.emissive) materials.push(object.material);
      });
      materials.forEach(rememberEmissive);
      materials.forEach((material) => material.emissive.set(0xffc94d));
      tween(duration, (t) => {
        const pulse = Math.sin(t * Math.PI * 4) * 0.5 + 0.5;
        materials.forEach((material) => (material.emissiveIntensity = (1 - t) * 0.9 * pulse));
        if (t >= 1) materials.forEach(restoreEmissive);
      });
    }

    // ------------------------------------------------------------ interaction
    let dragging = null;
    let userRotated = false;
    let hovered = null;
    let selected = null;
    let spinVelocity = 0;
    // Iso models turn slowly on their own, like the skill's viewer; the realistic style sways.
    let autoSpin = iso && spec.spin !== false;
    const raycaster = new THREE.Raycaster();
    const pickable = (holder) => holder.visible && !["flow", "arrow"].includes(holder.userData.spec?.shape) && holder.userData.spec?.pick !== false;
    /** The part under the pointer: the nearest labelled part (or its labelled parent). */
    function pick(event) {
      const rect = canvas.getBoundingClientRect();
      const pointer = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      for (const hit of raycaster.intersectObjects([...parts.values()].filter(pickable), true)) {
        if (!hit.object.isMesh) continue;
        if (selected && hit.object.material.opacity < 0.3) continue; // click through dimmed parts
        let holder = hit.object;
        while (holder && !holder.userData.id) holder = holder.parent;
        if (holder && !pickable(holder)) continue;
        let labelled = holder;
        while (labelled && !labelled.userData.spec?.label && labelled.parent?.userData.id) labelled = labelled.parent;
        if (!labelled?.userData.spec?.label && holder.userData.spec?.group) labelled = parts.get(holder.userData.spec.group) || labelled;
        return labelled?.userData.spec?.label ? labelled : holder;
      }
      return null;
    }
    // "group": parts that belong to a labelled part without moving with it
    // (four rotors that each spin on their own axis, but are one legend entry).
    const groupOf = (holder) => holder?.userData.spec?.group || holder?.userData.id;
    const relatedTo = (holder, other) => {
      if (groupOf(holder) === groupOf(other)) return true;
      for (let node = holder; node; node = node.parent) if (node === other) return true;
      for (let node = other; node; node = node.parent) if (node === holder) return true;
      return false;
    };
    /** The skill's tap-to-inspect: everything else fades so the chosen part stands alone. */
    function selectPart(holder) {
      const next = holder && holder !== selected ? holder : null;
      unghostAll();
      selected = next;
      if (selected) {
        for (const other of parts.values()) {
          if (other.parent !== model) continue;
          // Keep the selected part, its parent/children, and its group mates.
          const family = relatedTo(other, selected) || [...parts.values()].some((member) => relatedTo(member, selected) && relatedTo(other, member) && groupOf(member) === groupOf(selected));
          if (!family) ghost(other);
        }
      }
      refreshChips();
      showInfo(selected);
      stage.dataset.selected = selected?.userData.id || "";
    }

    // ---- dock: legend chips, inspector, controls
    const chips = new Map();
    const swatchOf = (name) => {
      if (typeof name === "string" && /^#[0-9a-f]{6}$/i.test(name)) return name;
      // Anatomy names (artery, muscle, vein…) come from the sculpt palette.
      const hex = COLORS[name] ?? window.ClickySculpt?.NAMED?.[name] ?? COLORS.gray;
      return `#${hex.toString(16).padStart(6, "0")}`;
    };
    function addChip(holder, name, desc, short) {
      if (!dock) return;
      holder.userData.info = { name, desc: desc || "" };
      let chip = chips.get(holder);
      if (!chip) {
        chip = document.createElement("button");
        chip.className = "chip3d";
        chip.setAttribute("aria-pressed", "false");
        chip.addEventListener("click", (event) => {
          event.stopPropagation();
          selectPart(holder);
        });
        chip.addEventListener("pointerenter", () => !selected && showInfo(holder));
        chip.addEventListener("pointerleave", () => !selected && showInfo(null));
        dock.querySelector(".stage3d-legend").appendChild(chip);
        chips.set(holder, chip);
      }
      chip.innerHTML = `<span class="sw"></span>`;
      chip.querySelector(".sw").style.background = swatchOf(holder.userData.spec.color);
      chip.append(short || name);
      requestAnimationFrame(measureDock);
    }
    function refreshChips() {
      for (const [holder, chip] of chips) chip.setAttribute("aria-pressed", String(holder === selected));
    }
    const kindLabel = typeof spec.kind === "string" && spec.kind ? spec.kind : "Part";
    function showInfo(holder) {
      if (!dock) return;
      const info = holder?.userData.info || (holder?.userData.spec?.label ? { name: holder.userData.spec.label, desc: holder.userData.spec.desc || "" } : null);
      dock.querySelector(".k").textContent = info ? kindLabel : spec.title || "3d model";
      dock.querySelector(".pname").textContent = info ? info.name : `Tap a ${kindLabel.toLowerCase()}`;
      dock.querySelector(".d").textContent = info ? info.desc : spec.hint || "Tap a part or its chip to inspect it. Drag to rotate, scroll to zoom.";
      dock.querySelector(".stage3d-inspector .sw").style.background = info ? swatchOf(holder.userData.spec.color) : "transparent";
    }
    const controlButtons = {};
    function addControl(label, pressed, onClick) {
      const button = document.createElement("button");
      button.textContent = label;
      if (pressed !== null) button.setAttribute("aria-pressed", String(pressed));
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        onClick(button);
      });
      dock.querySelector(".stage3d-controls").appendChild(button);
      return button;
    }
    function setAutoSpin(on) {
      autoSpin = on;
      if (!on) userRotated = true;
      syncControls();
    }
    function syncControls() {
      controlButtons.explode?.setAttribute("aria-pressed", String(Boolean(exploded)));
      controlButtons.spin?.setAttribute("aria-pressed", String(autoSpin));
    }
    // The model's own toggles: {"label","on","do":[actions],"undo":[actions]}.
    const customActions = (Array.isArray(spec.actions) ? spec.actions : []).filter((action) => action && action.label).slice(0, 4);
    function runAll(list) {
      (Array.isArray(list) ? list : []).forEach((element, index) => runAction({ on: "3d", ...element }, index * 60));
    }
    /** Runs a toggle's "do" once every part it names has been built. */
    function applyPendingToggles() {
      for (const action of customActions) {
        if (!action.pressed || action.applied) continue;
        const ids = (action.do || []).flatMap((element) => [element.id, ...(element.ids || [])]).filter(Boolean);
        if (ids.every((id) => parts.has(id))) {
          action.applied = true;
          runAll(action.do);
        }
      }
    }
    if (dock) {
      controlButtons.explode = addControl("Explode", Boolean(exploded), () => runAction({ on: "3d", action: exploded ? "assemble" : "explode" }, 0));
      for (const action of customActions) {
        action.pressed = action.on === true;
        action.applied = false;
        addControl(String(action.label), action.pressed, (button) => {
          action.pressed = !action.pressed;
          button.setAttribute("aria-pressed", String(action.pressed));
          action.applied = action.pressed;
          runAll(action.pressed ? action.do : action.undo);
        });
      }
      controlButtons.spin = addControl("Auto-rotate", autoSpin, () => setAutoSpin(!autoSpin));
      addControl("Reset view", null, () => {
        selectPart(null);
        unghostAll();
        spinVelocity = 0;
        pivot.rotation.set(0, 0, 0);
        camState.zoom = 1;
        camState.target.set(0, 0, 0);
        camState.direction.copy(vec3(directions[spec.view] || directions.iso)).normalize();
      });
      showInfo(null);
      requestAnimationFrame(measureDock);
    }

    canvas.addEventListener("pointerdown", (event) => {
      dragging = { x: event.clientX, y: event.clientY, lastX: event.clientX, moved: 0, rotationX: pivot.rotation.x, rotationY: pivot.rotation.y };
      spinVelocity = 0;
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (dragging) {
        const dx = event.clientX - dragging.lastX;
        dragging.lastX = event.clientX;
        dragging.moved += Math.abs(dx) + Math.abs(event.clientY - dragging.y) * 0.02;
        if (dragging.moved < 4) return;
        userRotated = true;
        pivot.rotation.y += dx * 0.009;
        spinVelocity = dx * 0.009;
        // Iso keeps its true isometric tilt: turn about the vertical axis only.
        if (!iso) pivot.rotation.x = Math.max(-1.1, Math.min(1.1, dragging.rotationX + (event.clientY - dragging.y) * 0.008));
        return;
      }
      setHovered(pick(event));
    });
    const endDrag = (event) => {
      if (dragging && dragging.moved < 4 && event.type === "pointerup") {
        // A tap, not a drag: inspect the part (or clear on empty space).
        spinVelocity = 0;
        selectPart(pick(event));
      }
      dragging = null;
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("pointerleave", () => setHovered(null));
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      camState.zoom = Math.max(0.3, Math.min(2.5, camState.zoom * Math.exp(event.deltaY * 0.0012)));
    }, { passive: false });

    function setHovered(holder) {
      if (hovered === holder) return;
      const paint = (target, on) =>
        target?.traverse((object) => {
          if (object.isMesh && object.material.emissive) {
            rememberEmissive(object.material);
            if (on) {
              object.material.emissive.set(0x3355aa);
              object.material.emissiveIntensity = 0.35;
            } else {
              restoreEmissive(object.material);
            }
          }
        });
      paint(hovered, false);
      hovered = holder;
      paint(hovered, true);
      canvas.style.cursor = hovered ? "pointer" : "grab";
      if (!selected) showInfo(hovered);
    }

    // ------------------------------------------------------------ loop
    let lastFrame = performance.now();
    const startedAt = lastFrame;
    let disposed = false;
    function frame(now) {
      const delta = Math.max(0, Math.min(0.05, (now - lastFrame) / 1000));
      lastFrame = now;
      for (let index = tweens.length - 1; index >= 0; index--) {
        const active = tweens[index];
        const t = Math.min(1, (now - active.startedAt) / active.duration);
        if (t < 0) continue;
        active.update(t);
        if (t >= 1) tweens.splice(index, 1);
      }
      for (const spinner of spinners) spinner.holder.rotation[spinner.axis] += spinner.speed * Math.PI * 2 * delta;
      for (const wave of oscillators) {
        const seconds = (now - wave.startedAt) / 1000;
        wave.holder.position[wave.axis] = wave.base + Math.sin(seconds * wave.speed * Math.PI * 2 + wave.phase) * wave.amount;
      }
      model.traverse((object) => {
        const flow = object.userData.flow;
        if (flow) flow.material.opacity = 0.65 + 0.35 * Math.sin(now / 260 + flow.phase);
        const stream = object.userData.stream;
        if (stream) {
          stream.offset = (((stream.offset + delta * stream.speed) % 1) + 1) % 1;
          stream.beads.forEach((bead, index) => {
            const t = (stream.offset + index / stream.beads.length) % 1;
            stream.curve.getPointAt(t, bead.position);
            bead.scale.setScalar(0.6 + 0.4 * Math.sin(t * Math.PI));
          });
        }
      });
      if (!dragging) {
        if (autoSpin) pivot.rotation.y += (orbitSpeed ? orbitSpeed * Math.PI * 2 : 0.18) * delta;
        else if (!userRotated && !iso) pivot.rotation.y = Math.sin((now - startedAt) / 2600) * 0.32; // gentle idle sway
        // A flick keeps turning and slows down, like the skill's viewer.
        pivot.rotation.y += spinVelocity;
        spinVelocity *= Math.pow(0.93, delta * 60);
      }
      updateFraming(delta);
      applyCamera();
      scene.updateMatrixWorld();
      if (clip.local) clip.world.copy(clip.local).applyMatrix4(model.matrixWorld);
      // The AO pass renders without clipping planes, so it would shade cut-away parts.
      if (aoPass) aoPass.enabled = !clip.local;
      if (now - startedAt > 1500 && perf.frames < 90) {
        perf.frames += 1;
        perf.total += delta;
        if (perf.frames === 90) {
          const ms = (perf.total / 90) * 1000;
          console.info(`3D: ${ms.toFixed(1)} ms per frame (ambient occlusion ${aoPass ? "on" : "off"})`);
          if (aoPass && ms > 1000 / 28) {
            console.warn("3D: ambient occlusion too slow here, turning it off");
            composer.dispose();
            composer = null;
            aoPass = null;
          }
        }
      }
      stage.dataset.ao = composer ? "on" : "off";
      if (composer) composer.render(delta);
      else renderer.render(scene, camera);
      updateLabels();
    }
    renderer.setAnimationLoop(frame);

    host.setInteractive(stage);

    return {
      element: stage,
      revealStep(elements) {
        stepCount += 1;
        // Only age labels when this step brings new ones of its own.
        if (elements.some((element) => element.label || element.labels || element.action === "label")) ageLabels();
        let delay = 0;
        for (const element of elements) {
          if (element.action) {
            runAction(element, delay);
            delay += 120;
            continue;
          }
          const holder = addPart(element);
          if (!holder) continue;
          revealPart(holder, delay);
          delay += 160;
        }
        setTimeout(applyPendingToggles, delay + 200);
      },
      dispose() {
        disposed = true;
        renderer.setAnimationLoop(null);
        // Free GPU memory explicitly (threejs-fundamentals: Cleanup).
        scene.traverse((object) => {
          object.geometry?.dispose();
          const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
          for (const material of materials) {
            for (const value of Object.values(material)) if (value?.isTexture && value !== toonRamp) value.dispose();
            material.dispose();
          }
        });
        scene.environment?.dispose();
        composer?.dispose();
        renderer.dispose();
        renderer.forceContextLoss();
        stage.remove();
      },
    };
  }

  window.ClickyScene = { create };
})();
