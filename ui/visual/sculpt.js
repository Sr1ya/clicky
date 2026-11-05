// Clicky's sculpting and generator engine for detailed 3D models.
//
// sculpt: Claude describes an organic form as blobs (spheres, ellipsoids,
// tapered tubes, rounded boxes, tori) that smoothly melt together, minus
// carved-out cavities, plus surface noise. We evaluate that signed distance
// field on a grid, mesh it with surface nets, snap vertices onto the true
// surface, and bake smooth normals, blended per-blob colors and ambient
// occlusion into the vertices. Good for organs, bones, animals, fruit, cells.
//
// dna / molecule: exact generators for geometry that's tedious to place by
// hand (a double helix with real grooves, ball-and-stick molecules).
//
// Everything returns a THREE.Group whose userData.anchors maps names to local
// points, so labels can be pinned to spots on a surface.
(() => {
  "use strict";

  const num = (value, fallback) => (Number.isFinite(Number(value)) && value !== null && value !== "" ? Number(value) : fallback);
  const DEG = Math.PI / 180;
  const NAMED = {
    ink: 0x3a4150, blue: 0x5b8def, red: 0xef6461, green: 0x4cb36b, orange: 0xf59f3a,
    yellow: 0xf2c94c, purple: 0x8e6cef, teal: 0x2bb3c0, pink: 0xef6fa0, gray: 0xaab2bd,
    white: 0xf4f5f7, black: 0x2b2f36, silver: 0xc9ced6, gold: 0xd4a640, copper: 0xc27c4e,
    // Natural tones so organic models don't look like plastic toys.
    muscle: 0xa8323a, flesh: 0xe0a39a, skin: 0xe8b796, bone: 0xe9e1cc, fat: 0xf0d68a,
    artery: 0xc8202c, vein: 0x3d5aa8, nerve: 0xf2e6a0, cartilage: 0xcfe0e6, brain: 0xe8b4b0,
    liver: 0x7a2a22, lung: 0xe89a9a, enamel: 0xf7f3e8, leaf: 0x4f8f3a, bark: 0x6b4a2e,
  };
  const colorOf = (name, fallback = "gray") => {
    if (typeof name === "string" && /^#[0-9a-f]{6}$/i.test(name)) return new THREE.Color(name);
    return new THREE.Color(NAMED[name] ?? NAMED[fallback] ?? NAMED.gray);
  };
  const vec = (value, fallback = [0, 0, 0]) =>
    Array.isArray(value) && value.length >= 3 ? [num(value[0], 0), num(value[1], 0), num(value[2], 0)] : fallback.slice();

  // ------------------------------------------------------------ noise

  /** Seeded 3D gradient noise in roughly [-1, 1]. */
  function makeNoise(seed = 7) {
    const permutation = new Uint8Array(512);
    const base = Array.from({ length: 256 }, (_, index) => index);
    let state = seed * 9301 + 49297;
    for (let index = 255; index > 0; index--) {
      state = (state * 9301 + 49297) % 233280;
      const swap = Math.floor((state / 233280) * (index + 1));
      [base[index], base[swap]] = [base[swap], base[index]];
    }
    for (let index = 0; index < 512; index++) permutation[index] = base[index & 255];
    const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
    const grad = (hash, x, y, z) => {
      const h = hash & 15;
      const u = h < 8 ? x : y;
      const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
      return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
    };
    const lerp = (a, b, t) => a + (b - a) * t;
    return (x, y, z) => {
      const X = Math.floor(x) & 255;
      const Y = Math.floor(y) & 255;
      const Z = Math.floor(z) & 255;
      x -= Math.floor(x);
      y -= Math.floor(y);
      z -= Math.floor(z);
      const u = fade(x);
      const v = fade(y);
      const w = fade(z);
      const A = permutation[X] + Y;
      const AA = permutation[A] + Z;
      const AB = permutation[A + 1] + Z;
      const B = permutation[X + 1] + Y;
      const BA = permutation[B] + Z;
      const BB = permutation[B + 1] + Z;
      return lerp(
        lerp(lerp(grad(permutation[AA], x, y, z), grad(permutation[BA], x - 1, y, z), u), lerp(grad(permutation[AB], x, y - 1, z), grad(permutation[BB], x - 1, y - 1, z), u), v),
        lerp(lerp(grad(permutation[AA + 1], x, y, z - 1), grad(permutation[BA + 1], x - 1, y, z - 1), u), lerp(grad(permutation[AB + 1], x, y - 1, z - 1), grad(permutation[BB + 1], x - 1, y - 1, z - 1), u), v),
        w,
      );
    };
  }

  // ------------------------------------------------------------ signed distance primitives

  /** Inverse rotation (degrees XYZ) as a 3x3 row-major array, or null. */
  function inverseRotation(rot) {
    if (!Array.isArray(rot)) return null;
    const euler = new THREE.Euler(num(rot[0], 0) * DEG, num(rot[1], 0) * DEG, num(rot[2], 0) * DEG);
    const matrix = new THREE.Matrix4().makeRotationFromEuler(euler).invert();
    const e = matrix.elements;
    return [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]];
  }

  function sdRoundCone(px, py, pz, a, b, r1, r2) {
    // Inigo Quilez's exact round cone between two points.
    const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
    const l2 = bax * bax + bay * bay + baz * baz;
    if (l2 < 1e-10) return Math.hypot(px - a[0], py - a[1], pz - a[2]) - Math.max(r1, r2);
    const rr = r1 - r2;
    const a2 = l2 - rr * rr;
    const il2 = 1 / l2;
    const pax = px - a[0], pay = py - a[1], paz = pz - a[2];
    const y = pax * bax + pay * bay + paz * baz;
    const z = y - l2;
    const xx = pax * l2 - bax * y, xy = pay * l2 - bay * y, xz = paz * l2 - baz * y;
    const x2 = xx * xx + xy * xy + xz * xz;
    const y2 = y * y * l2;
    const z2 = z * z * l2;
    const k = Math.sign(rr) * rr * rr * x2;
    if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
    if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
    return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
  }

  /** Turns one blob description into {sdf(x,y,z), color, k, subtract, bounds}. */
  function compileBlob(blob, defaults) {
    const type = blob.type || blob.shape || "sphere";
    const at = vec(blob.at);
    const inverse = inverseRotation(blob.rot);
    const local = (x, y, z) => {
      let lx = x - at[0], ly = y - at[1], lz = z - at[2];
      if (inverse) [lx, ly, lz] = [inverse[0] * lx + inverse[1] * ly + inverse[2] * lz, inverse[3] * lx + inverse[4] * ly + inverse[5] * lz, inverse[6] * lx + inverse[7] * ly + inverse[8] * lz];
      return [lx, ly, lz];
    };
    let sdf;
    let reach;
    let center = at;
    switch (type) {
      case "ellipsoid": {
        const size = vec(blob.size || blob.radii, [1, 0.7, 0.5]).map((value) => Math.max(1e-3, Math.abs(value)));
        sdf = (x, y, z) => {
          const [lx, ly, lz] = local(x, y, z);
          const k0 = Math.hypot(lx / size[0], ly / size[1], lz / size[2]);
          const k1 = Math.hypot(lx / (size[0] * size[0]), ly / (size[1] * size[1]), lz / (size[2] * size[2]));
          return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(...size);
        };
        reach = Math.max(...size);
        break;
      }
      case "box": {
        const half = vec(blob.size, [1, 1, 1]).map((value) => Math.abs(value) / 2);
        const round = Math.min(num(blob.round, 0.1), ...half);
        sdf = (x, y, z) => {
          const [lx, ly, lz] = local(x, y, z);
          const qx = Math.abs(lx) - half[0] + round, qy = Math.abs(ly) - half[1] + round, qz = Math.abs(lz) - half[2] + round;
          return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - round;
        };
        reach = Math.hypot(...half);
        break;
      }
      case "torus": {
        const major = num(blob.r ?? blob.radius, 1);
        const minor = num(blob.tube, 0.25);
        sdf = (x, y, z) => {
          const [lx, ly, lz] = local(x, y, z);
          return Math.hypot(Math.hypot(lx, lz) - major, ly) - minor;
        };
        reach = major + minor;
        break;
      }
      case "capsule":
      case "cone": {
        const from = vec(blob.from, [0, -0.5, 0]);
        const to = vec(blob.to, [0, 0.5, 0]);
        const r1 = num(blob.r ?? blob.radius, 0.3);
        const r2 = num(blob.r2, r1);
        sdf = (x, y, z) => sdRoundCone(x, y, z, from, to, r1, r2);
        center = from.map((value, index) => (value + to[index]) / 2);
        reach = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) / 2 + Math.max(r1, r2);
        break;
      }
      case "tube": {
        // A smooth path of round cones; each point is [x,y,z] or [x,y,z,radius].
        const radius = num(blob.r ?? blob.radius, 0.2);
        const raw = (blob.path || []).filter(Array.isArray).map((p) => [num(p[0], 0), num(p[1], 0), num(p[2], 0), num(p[3], radius)]);
        if (raw.length < 2) return null;
        // Resample through a Catmull-Rom curve so bends are round, not kinked.
        const curve = new THREE.CatmullRomCurve3(raw.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
        const samples = Math.max(raw.length * 4, 8);
        const points = [];
        for (let index = 0; index <= samples; index++) {
          const t = index / samples;
          const p = curve.getPointAt(t);
          const segment = t * (raw.length - 1);
          const low = Math.min(raw.length - 2, Math.floor(segment));
          const r = raw[low][3] + (raw[low + 1][3] - raw[low][3]) * (segment - low);
          points.push([p.x, p.y, p.z, r]);
        }
        sdf = (x, y, z) => {
          let best = Infinity;
          for (let index = 0; index < points.length - 1; index++) {
            const a = points[index];
            const b = points[index + 1];
            const d = sdRoundCone(x, y, z, a, b, a[3], b[3]);
            if (d < best) best = d;
          }
          return best;
        };
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (const p of points) for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis], p[axis] - p[3]);
          max[axis] = Math.max(max[axis], p[axis] + p[3]);
        }
        center = min.map((value, axis) => (value + max[axis]) / 2);
        reach = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2;
        break;
      }
      default: {
        const r = num(blob.r ?? blob.radius, 0.5);
        sdf = (x, y, z) => Math.hypot(x - at[0], y - at[1], z - at[2]) - r;
        reach = r;
      }
    }
    return {
      sdf,
      center,
      reach,
      color: colorOf(blob.color || defaults.color, defaults.color),
      k: Math.max(0.001, num(blob.k ?? blob.smooth, defaults.smooth)),
      subtract: blob.op === "subtract" || blob.op === "carve",
    };
  }

  // ------------------------------------------------------------ sculpt

  /** Yields to the browser every ~10 ms so long builds don't freeze animation. */
  function slicer() {
    let sliceStart = performance.now();
    return async () => {
      if (performance.now() - sliceStart < 10) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
      sliceStart = performance.now();
    };
  }

  async function buildSculpt(part) {
    const breathe = slicer();
    const defaults = { color: part.color || "muscle", smooth: num(part.smooth, 0.25) };
    const blobs = (part.blobs || part.parts || []).map((blob) => compileBlob(blob, defaults)).filter(Boolean);
    const adds = blobs.filter((blob) => !blob.subtract);
    const subtracts = blobs.filter((blob) => blob.subtract);
    if (!adds.length) return null;

    const detail = part.detail || part.surface || {};
    const noiseAmount = num(detail.amount, 0);
    const noiseScale = num(detail.scale, 3);
    const ridged = Boolean(detail.ridged || detail.folds);
    // Folds look best as one clean layer; finer layers alias into crumple.
    const octaves = Math.max(1, Math.min(4, Math.round(num(detail.octaves, ridged ? 1 : 2))));
    const noise = makeNoise(num(detail.seed, 7));
    const grooveWidth = num(detail.width, 0.26);
    const warp = num(detail.warp, 0.7);
    /** 0..1: how deep in a fold this point is (winding grooves along noise zero-lines). */
    const grooveAt = (x, y, z) => {
      let total = 0;
      let amplitude = 1;
      let frequency = noiseScale;
      let norm = 0;
      for (let octave = 0; octave < octaves; octave++) {
        // Domain warp makes the grooves meander like gyri instead of running straight.
        const wx = x * frequency + warp * noise(x * frequency * 0.5 + 11.3, y * frequency * 0.5, z * frequency * 0.5);
        const wy = y * frequency + warp * noise(x * frequency * 0.5, y * frequency * 0.5 + 27.1, z * frequency * 0.5);
        const wz = z * frequency + warp * noise(x * frequency * 0.5, y * frequency * 0.5, z * frequency * 0.5 + 5.7);
        const line = Math.max(0, 1 - Math.abs(noise(wx, wy, wz)) / grooveWidth);
        total += line * line * amplitude;
        norm += amplitude;
        amplitude *= 0.45;
        frequency *= 2.1;
      }
      return total / norm;
    };
    const fbm = (x, y, z) => {
      if (ridged) return grooveAt(x, y, z) * 2.2 - 0.2;
      let total = 0;
      let amplitude = 1;
      let frequency = noiseScale;
      for (let octave = 0; octave < octaves; octave++) {
        total += noise(x * frequency, y * frequency, z * frequency) * amplitude;
        amplitude *= 0.5;
        frequency *= 2.03;
      }
      return total;
    };
    const grooveColor = detail.grooveColor ? colorOf(detail.grooveColor) : null;

    // Smooth union of the blobs, then smooth carving, then surface detail.
    const field = (x, y, z) => {
      let d = Infinity;
      for (const blob of adds) {
        // Cheap bound: a blob farther than d + k can't change the union.
        if (d !== Infinity) {
          const lower = Math.hypot(x - blob.center[0], y - blob.center[1], z - blob.center[2]) - blob.reach;
          if (lower > d + blob.k) continue;
        }
        const b = blob.sdf(x, y, z);
        if (d === Infinity) {
          d = b;
          continue;
        }
        const k = blob.k;
        const h = Math.max(k - Math.abs(d - b), 0) / k;
        d = Math.min(d, b) - h * h * k * 0.25;
      }
      for (const blob of subtracts) {
        if (Math.hypot(x - blob.center[0], y - blob.center[1], z - blob.center[2]) - blob.reach > blob.k - d) continue;
        const b = blob.sdf(x, y, z);
        const k = blob.k;
        const h = Math.min(Math.max(0.5 - (0.5 * (d + b)) / k, 0), 1);
        d = d + (-b - d) * h + k * h * (1 - h);
      }
      if (noiseAmount && d < noiseAmount * 3) d += noiseAmount * fbm(x, y, z);
      return d;
    };

    // Grid bounds from every blob's reach, padded for blending and noise.
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const blob of adds) for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], blob.center[axis] - blob.reach);
      max[axis] = Math.max(max[axis], blob.center[axis] + blob.reach);
    }
    const largestK = Math.max(...adds.map((blob) => blob.k));
    const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    const padding = largestK * 0.5 + noiseAmount * 2 + extent * 0.03;
    for (let axis = 0; axis < 3; axis++) {
      min[axis] -= padding;
      max[axis] += padding;
    }
    const resolution = Math.max(32, Math.min(140, Math.round(num(part.resolution, 104))));
    const cell = (extent + padding * 2) / resolution;
    const dims = [0, 1, 2].map((axis) => Math.ceil((max[axis] - min[axis]) / cell) + 1);
    const [nx, ny, nz] = dims;
    const values = new Float32Array(nx * ny * nz);
    const index3 = (i, j, k) => i + nx * (j + ny * k);
    // Narrow band: sample a coarse grid, then evaluate exactly only in blocks
    // the surface might pass through; elsewhere interpolate (the sign is all
    // that matters there).
    const B = 4;
    const cdims = dims.map((n) => Math.ceil((n - 1) / B) + 1);
    const coarse = new Float32Array(cdims[0] * cdims[1] * cdims[2]);
    const cIndex = (i, j, k) => i + cdims[0] * (j + cdims[1] * k);
    for (let k = 0; k < cdims[2]; k++) for (let j = 0; j < cdims[1]; j++) for (let i = 0; i < cdims[0]; i++) {
      if (i === 0) await breathe();
      coarse[cIndex(i, j, k)] = field(min[0] + Math.min(i * B, nx - 1) * cell, min[1] + Math.min(j * B, ny - 1) * cell, min[2] + Math.min(k * B, nz - 1) * cell);
    }
    const threshold = B * cell * 1.3 + noiseAmount * 1.2;
    for (let bk = 0; bk < cdims[2] - 1; bk++) for (let bj = 0; bj < cdims[1] - 1; bj++) for (let bi = 0; bi < cdims[0] - 1; bi++) {
      if (bi === 0) await breathe();
      const c = [];
      for (let corner = 0; corner < 8; corner++) c.push(coarse[cIndex(bi + (corner & 1), bj + ((corner >> 1) & 1), bk + ((corner >> 2) & 1))]);
      const far = c.every((value) => value > threshold) || c.every((value) => value < -threshold);
      const i0 = bi * B, j0 = bj * B, k0 = bk * B;
      const i1 = Math.min(i0 + B, nx - 1), j1 = Math.min(j0 + B, ny - 1), k1 = Math.min(k0 + B, nz - 1);
      for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        if (far) {
          const u = (i - i0) / B, v = (j - j0) / B, w = (k - k0) / B;
          const x00 = c[0] + (c[1] - c[0]) * u, x10 = c[2] + (c[3] - c[2]) * u;
          const x01 = c[4] + (c[5] - c[4]) * u, x11 = c[6] + (c[7] - c[6]) * u;
          values[index3(i, j, k)] = (x00 + (x10 - x00) * v) * (1 - w) + (x01 + (x11 - x01) * v) * w;
        } else {
          values[index3(i, j, k)] = field(min[0] + i * cell, min[1] + j * cell, min[2] + k * cell);
        }
      }
    }

    // Surface nets: one vertex per cell that straddles the surface.
    const cellVertex = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
    const cellIndex = (i, j, k) => i + (nx - 1) * (j + (ny - 1) * k);
    const positions = [];
    const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
    const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    const cornerValues = new Float32Array(8);
    for (let k = 0; k < nz - 1; k++) {
      await breathe();
      for (let j = 0; j < ny - 1; j++) {
        for (let i = 0; i < nx - 1; i++) {
          let mask = 0;
          for (let c = 0; c < 8; c++) {
            const value = values[index3(i + corners[c][0], j + corners[c][1], k + corners[c][2])];
            cornerValues[c] = value;
            if (value < 0) mask |= 1 << c;
          }
          if (mask === 0 || mask === 255) continue;
          let sx = 0, sy = 0, sz = 0, count = 0;
          for (const [a, b] of edges) {
            const va = cornerValues[a];
            const vb = cornerValues[b];
            if ((va < 0) === (vb < 0)) continue;
            const t = va / (va - vb);
            sx += corners[a][0] + (corners[b][0] - corners[a][0]) * t;
            sy += corners[a][1] + (corners[b][1] - corners[a][1]) * t;
            sz += corners[a][2] + (corners[b][2] - corners[a][2]) * t;
            count++;
          }
          cellVertex[cellIndex(i, j, k)] = positions.length / 3;
          positions.push(min[0] + (i + sx / count) * cell, min[1] + (j + sy / count) * cell, min[2] + (k + sz / count) * cell);
        }
      }
    }

    // A quad around every grid edge that crosses the surface.
    const indices = [];
    const quad = (a, b, c, d, flip) => {
      if (a < 0 || b < 0 || c < 0 || d < 0) return;
      if (flip) indices.push(a, c, b, a, d, c);
      else indices.push(a, b, c, a, c, d);
    };
    for (let k = 0; k < nz; k++) {
      await breathe();
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const inside = values[index3(i, j, k)] < 0;
          if (i < nx - 1 && j > 0 && k > 0 && j < ny - 1 && k < nz - 1 && inside !== values[index3(i + 1, j, k)] < 0) {
            quad(cellVertex[cellIndex(i, j - 1, k - 1)], cellVertex[cellIndex(i, j, k - 1)], cellVertex[cellIndex(i, j, k)], cellVertex[cellIndex(i, j - 1, k)], !inside);
          }
          if (j < ny - 1 && i > 0 && k > 0 && i < nx - 1 && k < nz - 1 && inside !== values[index3(i, j + 1, k)] < 0) {
            quad(cellVertex[cellIndex(i - 1, j, k - 1)], cellVertex[cellIndex(i - 1, j, k)], cellVertex[cellIndex(i, j, k)], cellVertex[cellIndex(i, j, k - 1)], !inside);
          }
          if (k < nz - 1 && i > 0 && j > 0 && i < nx - 1 && j < ny - 1 && inside !== values[index3(i, j, k + 1)] < 0) {
            quad(cellVertex[cellIndex(i - 1, j - 1, k)], cellVertex[cellIndex(i, j - 1, k)], cellVertex[cellIndex(i, j, k)], cellVertex[cellIndex(i - 1, j, k)], !inside);
          }
        }
      }
    }

    // Snap vertices onto the true surface, then bake normals, colors and AO.
    const vertexCount = positions.length / 3;
    const normals = new Float32Array(positions.length);
    const colors = new Float32Array(positions.length);
    const epsilon = cell * 0.5;
    const gradient = (x, y, z) => {
      const gx = field(x + epsilon, y, z) - field(x - epsilon, y, z);
      const gy = field(x, y + epsilon, z) - field(x, y - epsilon, z);
      const gz = field(x, y, z + epsilon) - field(x, y, z - epsilon);
      const length = Math.hypot(gx, gy, gz) || 1;
      return [gx / length, gy / length, gz / length];
    };
    const blendWidth = Math.max(defaults.smooth * 0.35, cell * 2);
    const aoStep = Math.max(cell * 1.5, extent * 0.012);
    const aoStrength = num(part.ao, 1);
    const color = new THREE.Color();
    for (let v = 0; v < vertexCount; v++) {
      if (v % 256 === 0) await breathe();
      let x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
      {
        const d = field(x, y, z);
        const [gx, gy, gz] = gradient(x, y, z);
        x -= gx * d;
        y -= gy * d;
        z -= gz * d;
      }
      positions[v * 3] = x;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = z;
      const [nxv, nyv, nzv] = gradient(x, y, z);
      normals[v * 3] = nxv;
      normals[v * 3 + 1] = nyv;
      normals[v * 3 + 2] = nzv;

      // Each blob tints the surface near it; blends follow the smooth unions.
      let best = Infinity;
      const distances = adds.map((blob) => {
        const d = blob.sdf(x, y, z);
        if (d < best) best = d;
        return d;
      });
      let weightSum = 0;
      let r = 0, g = 0, b = 0;
      adds.forEach((blob, index) => {
        const weight = Math.exp(-(distances[index] - best) / blendWidth);
        weightSum += weight;
        r += blob.color.r * weight;
        g += blob.color.g * weight;
        b += blob.color.b * weight;
      });
      color.setRGB(r / weightSum, g / weightSum, b / weightSum);
      if (ridged && noiseAmount) {
        // Folds read darker and redder, like the vessels lining real sulci.
        const depth = Math.min(1, grooveAt(x, y, z) * 1.6);
        color.lerp(grooveColor || color.clone().multiplyScalar(0.45).add(new THREE.Color(0.12, 0, 0)), depth * 0.75);
      }

      // Crevices and folds read as deep: sample the field along the normal.
      let occlusion = 0;
      for (let step = 1; step <= 4; step++) {
        const distance = step * aoStep;
        occlusion += (distance - field(x + nxv * distance, y + nyv * distance, z + nzv * distance)) / Math.pow(2, step);
      }
      const ao = Math.min(1, Math.max(0, 1 - (aoStrength * 1.6 * occlusion) / aoStep));
      const shade = 0.42 + 0.58 * ao;
      colors[v * 3] = color.r * shade;
      colors[v * 3 + 1] = color.g * shade;
      colors[v * 3 + 2] = color.b * shade;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    return geometry;
  }

  /** Materials for organic and generated models (vertex-colored where baked). */
  function organicMaterial(part, vertexColors) {
    const kind = part.material || "organic";
    const base = { vertexColors, color: vertexColors ? 0xffffff : colorOf(part.color, "muscle") };
    const opacity = num(part.opacity, 1);
    if (opacity < 1) Object.assign(base, { transparent: true, opacity, depthWrite: opacity >= 0.6 });
    switch (kind) {
      case "skin":
      case "matte":
        return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.75, sheen: 0.6, sheenRoughness: 0.6, sheenColor: 0xffd0c0 });
      case "bone":
        return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.6, clearcoat: 0.15 });
      case "glass":
        return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.05, clearcoat: 1, transparent: true, opacity: Math.min(opacity, 0.35), depthWrite: false, side: THREE.DoubleSide });
      case "plastic":
        return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.4, clearcoat: 0.4 });
      case "metal":
        return new THREE.MeshPhysicalMaterial({ ...base, metalness: 0.85, roughness: 0.3 });
      default:
        // Wet tissue: soft sheen plus a glossy coat.
        return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.5, clearcoat: 0.45, clearcoatRoughness: 0.3, sheen: 0.2, sheenRoughness: 0.6, sheenColor: 0x8a3a3a });
    }
  }

  function anchorsFrom(part, group) {
    for (const label of part.labels || []) {
      if (Array.isArray(label.at)) group.userData.anchors[`@${group.userData.anchorCount++}`] = { label, point: new THREE.Vector3(...vec(label.at)) };
    }
  }

  async function sculpt(part) {
    const geometry = await buildSculpt(part);
    if (!geometry) return null;
    const group = new THREE.Group();
    group.add(new THREE.Mesh(geometry, organicMaterial(part, true)));
    group.userData.anchors = {};
    group.userData.anchorCount = 0;
    anchorsFrom(part, group);
    return group;
  }

  // ------------------------------------------------------------ DNA

  function dna(part) {
    const turns = Math.max(0.5, num(part.turns, 2));
    const height = num(part.height, 3.4 * turns);
    const radius = num(part.radius, 1);
    const perTurn = Math.max(4, Math.round(num(part.pairsPerTurn, 10)));
    const pairCount = Math.round(turns * perTurn);
    const groove = num(part.groove, 140) * DEG; // offset between strands: minor vs major groove
    const sequence = String(part.sequence || "ATGCGTACCGATTGCA").toUpperCase().replace(/[^ATGCU]/g, "") || "ATGC";
    const baseColors = {
      A: colorOf(part.colorA || "#e05252"),
      T: colorOf(part.colorT || "#4f8de0"),
      U: colorOf(part.colorT || "#4f8de0"),
      G: colorOf(part.colorG || "#47b26b"),
      C: colorOf(part.colorC || "#f2c14e"),
    };
    const partner = { A: "T", T: "A", G: "C", C: "G", U: "A" };
    const backboneColor = colorOf(part.backbone || "#c9ced6");
    const phosphateColor = colorOf(part.phosphate || "orange");
    const group = new THREE.Group();
    const angleAt = (t) => t * turns * Math.PI * 2;
    const point = (t, offset) => new THREE.Vector3(Math.cos(angleAt(t) + offset) * radius, t * height - height / 2, Math.sin(angleAt(t) + offset) * radius);

    const physical = (color, extra = {}) => new THREE.MeshPhysicalMaterial({ color, roughness: 0.35, clearcoat: 0.6, clearcoatRoughness: 0.2, ...extra });
    for (const offset of [0, groove]) {
      const samples = [];
      for (let index = 0; index <= pairCount * 6; index++) samples.push(point(index / (pairCount * 6), offset));
      const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(samples), pairCount * 12, radius * 0.11, 14);
      group.add(new THREE.Mesh(tube, physical(backboneColor)));
    }
    const phosphate = new THREE.SphereGeometry(radius * 0.17, 20, 14);
    const sugar = new THREE.IcosahedronGeometry(radius * 0.13, 1);
    const rung = new THREE.CylinderGeometry(radius * 0.075, radius * 0.075, 1, 12);
    const up = new THREE.Vector3(0, 1, 0);
    for (let index = 0; index < pairCount; index++) {
      const t = (index + 0.5) / pairCount;
      const base = sequence[index % sequence.length];
      const a = point(t, 0);
      const b = point(t, groove);
      for (const [end, color] of [[a, phosphateColor], [b, phosphateColor]]) {
        const sphere = new THREE.Mesh(phosphate, physical(color));
        sphere.position.copy(end);
        group.add(sphere);
      }
      // Base pair: two halves meeting in the middle, inset from the backbone.
      const middle = a.clone().add(b).multiplyScalar(0.5);
      for (const [end, letter] of [[a, base], [b, partner[base] || "A"]]) {
        const start = end.clone().lerp(middle, 0.12);
        const direction = middle.clone().sub(start);
        const half = new THREE.Mesh(rung, physical(baseColors[letter] || baseColors.A));
        half.scale.set(1, direction.length(), 1);
        half.position.copy(start).addScaledVector(direction, 0.5);
        half.quaternion.setFromUnitVectors(up, direction.normalize());
        group.add(half);
        const sugarMesh = new THREE.Mesh(sugar, physical(colorOf("white")));
        sugarMesh.position.copy(end.clone().lerp(middle, 0.12));
        group.add(sugarMesh);
      }
    }
    group.userData.anchors = {
      backbone: { point: point(0.18, 0) },
      phosphate: { point: point(0.5 / pairCount, groove) },
      "base pair": { point: point(0.42, 0).add(point(0.42, groove)).multiplyScalar(0.5) },
      "major groove": { point: point(0.72, groove + (Math.PI * 2 - groove) / 2).multiplyScalar(0.9) },
      "minor groove": { point: point(0.6, groove / 2).multiplyScalar(0.9) },
    };
    group.userData.anchorCount = 0;
    anchorsFrom(part, group);
    return group;
  }

  // ------------------------------------------------------------ molecules

  const ELEMENTS = {
    H: [0xffffff, 0.31, 1.1], C: [0x404040, 0.76, 1.7], N: [0x3050f8, 0.71, 1.55], O: [0xff0d0d, 0.66, 1.52],
    F: [0x90e050, 0.57, 1.47], P: [0xff8000, 1.07, 1.8], S: [0xffd030, 1.05, 1.8], Cl: [0x1ff01f, 1.02, 1.75],
    Na: [0xab5cf2, 1.66, 2.27], K: [0x8f40d4, 2.03, 2.75], Ca: [0x3dff00, 1.76, 2.31], Mg: [0x8aff00, 1.41, 1.73],
    Fe: [0xe06633, 1.32, 2.0], Br: [0xa62929, 1.2, 1.85], I: [0x940094, 1.39, 1.98], Si: [0xf0c8a0, 1.11, 2.1],
    Zn: [0x7d80b0, 1.22, 1.39], Cu: [0xc88033, 1.32, 1.4], B: [0xffb5b5, 0.84, 1.92],
  };

  function molecule(part) {
    const atoms = (part.atoms || []).filter(Array.isArray).map((atom) => ({ element: String(atom[0]), position: new THREE.Vector3(num(atom[1], 0), num(atom[2], 0), num(atom[3], 0)) }));
    if (!atoms.length) return null;
    const scale = num(part.scale, 1);
    atoms.forEach((atom) => atom.position.multiplyScalar(scale));
    const spacefill = part.style === "spacefill";
    const info = (element) => ELEMENTS[element] || ELEMENTS[element[0]?.toUpperCase() + (element[1] || "").toLowerCase()] || [0xff66cc, 0.8, 1.8];
    let bonds = (part.bonds || []).filter(Array.isArray).map((bond) => [num(bond[0], 0), num(bond[1], 0), num(bond[2], 1)]);
    if (!part.bonds) {
      // Bond atoms closer than their covalent radii allow (Å-scale coordinates).
      for (let a = 0; a < atoms.length; a++) for (let b = a + 1; b < atoms.length; b++) {
        const limit = (info(atoms[a].element)[1] + info(atoms[b].element)[1]) * 1.2 * scale;
        if (atoms[a].position.distanceTo(atoms[b].position) < limit) bonds.push([a, b, 1]);
      }
    }
    const group = new THREE.Group();
    const material = (color) => new THREE.MeshPhysicalMaterial({ color, roughness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.15 });
    const sphere = new THREE.SphereGeometry(1, 32, 22);
    atoms.forEach((atom) => {
      const [color, covalent, vanDerWaals] = info(atom.element);
      const mesh = new THREE.Mesh(sphere, material(color));
      mesh.scale.setScalar((spacefill ? vanDerWaals : Math.max(0.22, covalent * 0.45)) * scale);
      mesh.position.copy(atom.position);
      group.add(mesh);
    });
    if (!spacefill) {
      const stick = new THREE.CylinderGeometry(0.09 * scale, 0.09 * scale, 1, 14);
      const up = new THREE.Vector3(0, 1, 0);
      for (const [a, b, order] of bonds) {
        if (!atoms[a] || !atoms[b]) continue;
        const from = atoms[a].position;
        const to = atoms[b].position;
        const direction = to.clone().sub(from);
        const length = direction.length();
        const unit = direction.clone().normalize();
        const side = new THREE.Vector3().crossVectors(unit, Math.abs(unit.y) < 0.9 ? up : new THREE.Vector3(1, 0, 0)).normalize();
        const count = Math.max(1, Math.min(3, Math.round(order)));
        for (let line = 0; line < count; line++) {
          const offset = side.clone().multiplyScalar((line - (count - 1) / 2) * 0.2 * scale);
          // Each half takes its atom's color, like standard ball-and-stick renders.
          for (const [start, element] of [[from, atoms[a].element], [from.clone().addScaledVector(direction, 0.5), atoms[b].element]]) {
            const mesh = new THREE.Mesh(stick, material(info(element)[0]));
            mesh.scale.set(1, length / 2, 1);
            mesh.position.copy(start).addScaledVector(direction, 0.25).add(offset);
            mesh.quaternion.setFromUnitVectors(up, unit);
            group.add(mesh);
          }
        }
      }
    }
    group.userData.anchors = {};
    group.userData.anchorCount = 0;
    for (const label of part.labels || []) {
      const atom = atoms[num(label.atom, -1)];
      if (atom) group.userData.anchors[`@${group.userData.anchorCount++}`] = { label, point: atom.position.clone() };
    }
    anchorsFrom(part, group);
    return group;
  }

  window.ClickySculpt = { sculpt, dna, molecule, NAMED };
})();
