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
  // A figure turns for this long once it's built, then swings back to its front and rests.
  const TURN_SECONDS_AFTER_BUILT = 20;
  // A figure cut open toward the viewer rocks this far either side instead of going round,
  // so the opening stays in view. Its fastest moment still matches the spin it was given.
  const CUT_SWAY_DEGREES = 28;
  // The hatch on a cut face: line spacing in device pixels at up to 1600 tall, and how dark a line is.
  const HATCH_SPACING_PX = 9;
  const HATCH_LINE_SHADE = 0.72;
  // Turned this far at rest, so a figure shows its depth instead of facing dead on.
  const REST_YAW_DEGREES = -20;
  // The studio: light levels, and how much of the key still reaches what's in shadow.
  const EXPOSURE = 1.7;
  const KEY_LIGHT = 2.4;
  const RIM_LIGHT = 0.55;
  const ENVIRONMENT_LIGHT = 0.75;
  const ROOM_LEVEL = 0.3;
  const KEY_IN_SHADOW = 0.55;
  const AMBIENT_IN_SHADOW = 0.6;
  const GROUND_SHADOW_OPACITY = 0.3;
  const GROUND_SHADOW_COLOR = [0.2, 0.25, 0.36];
  // Corners darken: reach as a share of the model's size, and strength.
  const OCCLUSION_REACH = 0.2;
  const OCCLUSION_STRENGTH = 2.2;
  // Pens, in device pixels at pixel ratio 1: the ink round the object, and the seam between parts.
  const SILHOUETTE_PEN = 0.9;
  const SEAM_PEN = 0.6;
  const SEAM_SHADE = 0.6;
  const GROW_SECONDS = 0.65;
  const LABEL_SIDE_GAP = 22;
  const LABEL_TOP_GAP = 16;
  const LABEL_LINE_HEIGHT = 1.15;
  const LABEL_MIN_SIZE = 14;
  const HIGHLIGHT_SECONDS = 0.7;
  // How much of the object's rectangle the whole model may fill, from any side it turns to.
  const FRAME_FILL = 0.88;
  const FRAMING_DIRECTIONS = 8;
  const FRAMING_SAMPLES_PER_PART = 300;
  const SILHOUETTE_SAMPLES_PER_PART = 48;
  // Lights keep their place by the viewer; shadows keep theirs on the model, from nearly overhead.
  const KEY_DIRECTION = new THREE.Vector3(-0.55, 0.62, 0.56).normalize();
  const RIM_DIRECTION = new THREE.Vector3(0.35, 0.45, -0.85).normalize();
  const SHADOW_DIRECTION = new THREE.Vector3(-0.15, 1, 0.12).normalize();
  const QUALITY_CHECK_SECONDS = 2.5;
  const SLOW_FRAME_MS = 40;
  const QUALITY_STEP_MUST_SAVE = 0.85;
  const QUALITY_LEVELS = [{ pixelRatio: 1.5 }, { pixelRatio: 1 }];

  // AgX on its own washes colour out, so it gets the usual look step: more contrast, more saturation.
  THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment.replace(
    "color = agxDefaultContrastApprox( color );",
    `color = agxDefaultContrastApprox( color );
    float agxLuma = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
    color = pow( max( color, vec3( 0.0 ) ), vec3( 1.3 ) );
    color = vec3( agxLuma ) + 1.365 * ( color - vec3( agxLuma ) );`,
  );

  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const easeOutCubic = (t) => 1 - (1 - t) ** 3;
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  const smoothstep01 = (t) => t * t * (3 - 2 * t);
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
    steel: { color: "#C2C8CF", metalness: 0.95, roughness: 0.24 },
    alu: { color: "#D3D5D6", metalness: 0.55, roughness: 0.55 },
    aluminum: { color: "#D3D5D6", metalness: 0.55, roughness: 0.55 },
    aluminium: { color: "#D3D5D6", metalness: 0.55, roughness: 0.55 },
    titanium: { color: "#8E99A8", metalness: 0.85, roughness: 0.34 },
    chrome: { color: "#EEF2F6", metalness: 1, roughness: 0.08 },
    brass: { color: "#D2A64C", metalness: 0.95, roughness: 0.3 },
    copper: { color: "#CC7F55", metalness: 0.95, roughness: 0.3 },
    gold: { color: "#F2C14E", metalness: 1, roughness: 0.22 },
    iron: { color: "#5E636B", metalness: 0.45, roughness: 0.7 },
    metal: { color: "#C9D1DC", metalness: 0.65, roughness: 0.3, clearcoat: 0.3, clearcoatRoughness: 0.2 },
    black: { color: "#33373D", metalness: 0.1, roughness: 0.4, clearcoat: 0.4, clearcoatRoughness: 0.2 },
    rubber: { color: "#34383D", metalness: 0, roughness: 0.85, sheen: 0.3, sheenRoughness: 0.5 },
    glass: { color: "#DCEBFA", metalness: 0, roughness: 0.06, opacity: 0.28, clearcoat: 1, clearcoatRoughness: 0.05 },
    water: { color: "#3F7390", metalness: 0, roughness: 0.05, opacity: 0.72, clearcoat: 1, clearcoatRoughness: 0.08 },
    wood: { color: "#C99A68", metalness: 0, roughness: 0.7 },
    ceramic: { color: "#F5F0E6", metalness: 0, roughness: 0.25, clearcoat: 0.6, clearcoatRoughness: 0.2 },
    paper: { color: "#FAF7F0", metalness: 0, roughness: 0.95 },
    gloss: { color: "#B9BEC4", metalness: 0, roughness: 0.42, clearcoat: 0.3, clearcoatRoughness: 0.25 },
    paint: { color: "#8A8D92", metalness: 0.05, roughness: 0.4, clearcoat: 0.5, clearcoatRoughness: 0.2 },
    plastic: { color: "#8A8D92", metalness: 0, roughness: 0.5, clearcoat: 0.2, clearcoatRoughness: 0.2 },
    soft: { color: "#B5766A", metalness: 0, roughness: 0.85, sheen: 0.35, sheenRoughness: 0.5 },
    matte: { color: "#8A8D92", metalness: 0, roughness: 0.85, sheen: 0.35, sheenRoughness: 0.5 },
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

  // Every solid part reads the occlusion pass. A cut part also paints the faces seen from
  // behind as a hatched cut surface, with lines measured on the cut plane so they stay on the
  // model while it turns.
  // The key light's shadow, softened by which way the surface faces. Only that light casts one.
  const KEY_SHADE_LIGHTS_CHUNK = THREE.ShaderChunk.lights_fragment_begin.replace(
    /directLight\.color \*= \( directLight\.visible && receiveShadow \) \? getShadow\( directionalShadowMap\[ i \],([^;]*?)\) : 1\.0;/,
    "if ( directLight.visible && receiveShadow ) directLight.color *= studioKeyShade( getShadow( directionalShadowMap[ i ],$1), normal );",
  );
  function applyStudioShading(material, studio, cut) {
    const shadesOcclusion = material.opacity >= 0.6;
    const hatched = !!cut && cut.hatched;
    material.userData.hatched = hatched;
    if (cut) {
      material.side = THREE.DoubleSide;
      material.clipShadows = true;
    }
    material.onBeforeCompile = (shader) => {
      shader.uniforms.studioOcclusion = studio.occlusion;
      shader.uniforms.studioPixels = studio.pixels;
      shader.uniforms.studioShadowDirection = studio.shadowDirection;
      const bands = material.userData.bands;
      if (bands) {
        shader.uniforms.studioBands = { value: Array.from({ length: 16 }, (_, i) => bands[i] || bands[bands.length - 1]) };
        shader.uniforms.studioBandCount = { value: bands.length };
        shader.uniforms.studioBandAxis = material.userData.bandAxis;
        shader.uniforms.studioBandRange = material.userData.bandRange;
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nvarying float vStudioAlong;\nuniform vec3 studioBandAxis;")
          .replace("#include <project_vertex>", "#include <project_vertex>\nvStudioAlong = dot(position, studioBandAxis);");
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", "#include <common>\nvarying float vStudioAlong;\nuniform vec3 studioBands[16];\nuniform int studioBandCount;\nuniform vec2 studioBandRange;")
          .replace("#include <color_fragment>", `#include <color_fragment>
        float bandAt = clamp((vStudioAlong - studioBandRange.x) / max(studioBandRange.y - studioBandRange.x, 1e-5), 0.0, 1.0);
        diffuseColor.rgb *= studioBands[clamp(int(floor((1.0 - bandAt) * float(studioBandCount))), 0, studioBandCount - 1)];`);
      }
      let declarations = `uniform sampler2D studioOcclusion;
        uniform vec2 studioPixels;
        uniform vec3 studioShadowDirection;
        float studioVisibility = 1.0;
        // Faces turned away from the shadow light fall off softly, instead of catching stray shadow-map edges.
        float studioKeyShade(float shadowed, vec3 surfaceNormal) {
          float facing = dot(surfaceNormal, normalize((viewMatrix * vec4(studioShadowDirection, 0.0)).xyz));
          studioVisibility = mix(smoothstep(-0.35, 0.25, facing), shadowed, smoothstep(-0.2, 0.1, facing));
          return mix(${KEY_IN_SHADOW.toFixed(2)}, 1.0, studioVisibility);
        }`;
      if (hatched) {
        shader.uniforms.cutNormal = { value: cut.plane.normal };
        shader.uniforms.cutConstant = cut.plane.uniform;
        shader.uniforms.hatchSpacing = studio.hatchSpacing;
        declarations += "\nvarying vec3 vCutWorld;\nuniform vec3 cutNormal;\nuniform float cutConstant;\nuniform float hatchSpacing;";
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nvarying vec3 vCutWorld;")
          .replace("#include <project_vertex>", "#include <project_vertex>\nvCutWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
      }
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <lights_fragment_begin>", KEY_SHADE_LIGHTS_CHUNK)
        .replace("#include <common>", `#include <common>\n${declarations}`)
        .replace(
          "#include <aomap_fragment>",
          `#include <aomap_fragment>
        float studioShade = ${shadesOcclusion ? "texture2D(studioOcclusion, gl_FragCoord.xy / studioPixels).r" : "1.0"};
        float studioAmbient = mix(${AMBIENT_IN_SHADOW.toFixed(2)}, 1.0, studioVisibility);
        reflectedLight.indirectDiffuse *= studioShade * studioAmbient;
        reflectedLight.indirectSpecular *= mix(1.0, studioShade, 0.75) * studioAmbient;
        reflectedLight.directDiffuse *= mix(1.0, studioShade, 0.3);
        reflectedLight.directSpecular *= mix(1.0, studioShade, 0.3);`,
        );
      // A lit part is a lamp: its colour stays its own instead of going through the film curve.
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <dithering_fragment>",
        `#include <dithering_fragment>
        float studioGlow = max(totalEmissiveRadiance.r, max(totalEmissiveRadiance.g, totalEmissiveRadiance.b));
        if (studioGlow > 0.0) {
          vec3 lamp = totalEmissiveRadiance / studioGlow * min(studioGlow, 0.9);
          float towardViewer = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
          float strength = clamp(studioGlow, 0.0, 1.0);
          vec3 lit = max(outgoingLight * (1.0 - strength), lamp) + lamp * pow(towardViewer, 3.0) * 0.18;
          #ifdef TONE_MAPPING
            lit = mix(toneMapping(lit), min(lit, vec3(1.0)), strength);
          #endif
          gl_FragColor.rgb = linearToOutputTexel(vec4(lit, 1.0)).rgb;
        }`,
      );
      if (hatched) {
        shader.fragmentShader = shader.fragmentShader.replace(
          "gl_FragColor.rgb = linearToOutputTexel(vec4(lit, 1.0)).rgb;\n        }",
          `gl_FragColor.rgb = linearToOutputTexel(vec4(lit, 1.0)).rgb;
        }
        if (!gl_FrontFacing) {
          // Where this pixel's line of sight crosses the cut plane.
          vec3 sight = vCutWorld - cameraPosition;
          float approach = dot(cutNormal, sight);
          vec3 onPlane = abs(approach) > 1e-6 ? cameraPosition + sight * (-(cutConstant + dot(cutNormal, cameraPosition)) / approach) : vCutWorld;
          vec3 across = normalize(cross(cutNormal, abs(cutNormal.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
          vec3 slant = normalize(across + cross(cutNormal, across));
          float lines = dot(onPlane, slant) / hatchSpacing;
          float fromLine = abs(fract(lines) - 0.5);
          float blur = 0.5 * fwidth(lines);
          float hatch = 1.0 - smoothstep(0.1 - blur, 0.1 + blur, fromLine);
          vec3 cutFace = mix(diffuseColor.rgb, vec3(1.0), 0.22) * mix(0.82, 1.0, studioShade) * mix(1.0, ${HATCH_LINE_SHADE.toFixed(2)}, hatch);
          #ifdef TONE_MAPPING
            cutFace = toneMapping(cutFace);
          #endif
          gl_FragColor = linearToOutputTexel(vec4(cutFace, gl_FragColor.a));
        }`,
        );
      }
    };
    material.customProgramCacheKey = () => `clicky-studio-${shadesOcclusion ? 1 : 0}${hatched ? 1 : 0}${material.userData.bands ? 1 : 0}`;
    return material;
  }

  // ---------------------------------------------------------------- the studio's screen passes
  // One extra pass draws each part's id and depth. From those come the occlusion that darkens
  // corners and cavities (read by the materials) and the ink: a thin line round the object and
  // a shaded seam wherever one part meets another, or a cut face meets what's behind it.
  const FULL_SCREEN_VERTEX = "void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }";
  const SURFACE_VERTEX = `#include <common>
    #include <clipping_planes_pars_vertex>
    varying float vDepth;
    void main() {
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      vDepth = -mvPosition.z;
      gl_Position = projectionMatrix * mvPosition;
      #include <clipping_planes_vertex>
    }`;
  const SURFACE_FRAGMENT = `#include <common>
    #include <clipping_planes_pars_fragment>
    uniform float partId;
    uniform float hatched;
    varying float vDepth;
    void main() {
      #include <clipping_planes_fragment>
      float id = hatched > 0.5 && !gl_FrontFacing ? -partId : partId;
      gl_FragColor = vec4(id, vDepth, 0.0, 1.0);
    }`;
  const SURFACE_POINTS = `uniform sampler2D surface;
    uniform vec2 fullSize;
    uniform vec2 frustum;
    uniform vec2 frustumShift;
    float depthAt(ivec2 p) { return texelFetch(surface, p, 0).g; }
    vec3 pointAt(ivec2 p, float depth) {
      vec2 ndc = (vec2(p) + 0.5) / fullSize * 2.0 - 1.0;
      return vec3((ndc + frustumShift) * frustum * depth, -depth);
    }`;
  const OCCLUSION_FRAGMENT = `${SURFACE_POINTS}
    uniform float reach;
    uniform float strength;
    const float GOLDEN_ANGLE = 2.3999632;
    void main() {
      ivec2 size = ivec2(fullSize);
      ivec2 p = ivec2(gl_FragCoord.xy * 2.0);
      float depth = depthAt(p);
      gl_FragColor = vec4(1.0);
      if (depth <= 0.0) return;
      vec3 here = pointAt(p, depth);
      // The nearer neighbour on each axis, so a normal doesn't reach across an edge.
      vec3 xStep = vec3(1e9), yStep = vec3(1e9);
      for (int side = -1; side <= 1; side += 2) {
        ivec2 qx = clamp(p + ivec2(side, 0), ivec2(0), size - 1), qy = clamp(p + ivec2(0, side), ivec2(0), size - 1);
        float dx = depthAt(qx), dy = depthAt(qy);
        if (dx > 0.0) { vec3 v = (pointAt(qx, dx) - here) * float(side); if (length(v) < length(xStep)) xStep = v; }
        if (dy > 0.0) { vec3 v = (pointAt(qy, dy) - here) * float(side); if (length(v) < length(yStep)) yStep = v; }
      }
      if (length(xStep) > 1e8 || length(yStep) > 1e8) return;
      vec3 normal = normalize(cross(xStep, yStep));
      if (dot(normal, -here) < 0.0) normal = -normal;
      float pixelSize = depth * 2.0 * frustum.y / fullSize.y;
      float reachPixels = clamp(reach / max(pixelSize, 1e-7), 2.0, 36.0);
      // A spiral of samples, turned per pixel on a 4x4 tile; the blur pass smooths the tile away.
      int tile = ((p.x & 3) * 5 + (p.y & 3) * 11) & 15;
      float turn = (float(tile) + 0.5) / 16.0;
      float occluded = 0.0;
      const int TAPS = 12;
      for (int k = 0; k < TAPS; k++) {
        float along = (float(k) + fract(turn * 7.0 + 0.5)) / float(TAPS);
        float angle = turn * 6.2831853 + float(k) * GOLDEN_ANGLE;
        ivec2 q = clamp(p + ivec2(round(vec2(cos(angle), sin(angle)) * reachPixels * along)), ivec2(0), size - 1);
        float sampleDepth = depthAt(q);
        if (sampleDepth <= 0.0) continue;
        vec3 toSample = pointAt(q, sampleDepth) - here;
        float squared = dot(toSample, toSample);
        float falloff = max(0.0, 1.0 - squared / (reach * reach));
        occluded += falloff * max(0.0, dot(toSample, normal) - 0.03 * reach) / (squared + 0.02 * reach * reach) * reach;
      }
      gl_FragColor = vec4(vec3(clamp(1.0 - strength * occluded / float(TAPS), 0.0, 1.0)), 1.0);
    }`;
  const OCCLUSION_BLUR_FRAGMENT = `${SURFACE_POINTS}
    uniform sampler2D raw;
    uniform float reach;
    void main() {
      ivec2 cell = ivec2(gl_FragCoord.xy);
      ivec2 cells = textureSize(raw, 0);
      ivec2 p = cell * 2;
      float depth = depthAt(p);
      gl_FragColor = vec4(1.0);
      if (depth <= 0.0) return;
      vec3 here = pointAt(p, depth);
      float near = max(reach * 0.25, 1e-5);
      float total = 0.0, weight = 0.0;
      for (int y = -2; y <= 1; y++) for (int x = -2; x <= 1; x++) {
        ivec2 q = clamp(cell + ivec2(x, y), ivec2(0), cells - 1);
        float d = depthAt(q * 2);
        if (d <= 0.0) continue;
        float w = clamp(1.0 - length(pointAt(q * 2, d) - here) / near, 0.0, 1.0);
        total += texelFetch(raw, q, 0).r * w;
        weight += w;
      }
      gl_FragColor = vec4(vec3(weight > 0.0 ? total / weight : texelFetch(raw, cell, 0).r), 1.0);
    }`;
  const INK_FRAGMENT = `uniform sampler2D surface;
    uniform vec3 inkColor;
    uniform float silhouettePen;
    uniform float seamPen;
    uniform float seamShade;
    void main() {
      ivec2 p = ivec2(gl_FragCoord.xy);
      ivec2 size = textureSize(surface, 0);
      float here = texelFetch(surface, p, 0).r;
      float toOutline = 1e9, toSeam = 1e9;
      const int RADIUS = 2;
      for (int y = -RADIUS; y <= RADIUS; y++) for (int x = -RADIUS; x <= RADIUS; x++) {
        float there = texelFetch(surface, clamp(p + ivec2(x, y), ivec2(0), size - 1), 0).r;
        if (there == here) continue;
        float away = length(vec2(x, y));
        if ((there == 0.0) != (here == 0.0)) toOutline = min(toOutline, away);
        else toSeam = min(toSeam, away);
      }
      float ink = clamp(silhouettePen - toOutline + 1.0, 0.0, 1.0);
      float shade = 1.0 - clamp(seamPen - toSeam + 1.0, 0.0, 1.0) * (1.0 - seamShade);
      // Blended as colour + what's there * (1 - alpha), so this one output both inks and shades.
      gl_FragColor = vec4(inkColor * ink * shade, 1.0 - (1.0 - ink) * shade);
    }`;

  const GROUND_FRAGMENT = `uniform sampler2D depthMap;
    uniform mat4 lightMatrix;
    uniform mat4 lightView;
    uniform float lift, heightScale, radius, halfSize, tapRadius, opacity;
    uniform vec2 center;
    uniform vec3 shadowColor;
    varying vec3 vWorld;
    const vec2 DISK[12] = vec2[12](vec2(-0.326, -0.406), vec2(-0.840, -0.074), vec2(-0.696, 0.457), vec2(-0.203, 0.621),
      vec2(0.962, -0.195), vec2(0.473, -0.480), vec2(0.519, 0.767), vec2(0.185, -0.893),
      vec2(0.507, 0.064), vec2(0.896, 0.412), vec2(-0.322, -0.933), vec2(-0.792, -0.598));
    void main() {
      vec4 world = vec4(vWorld + vec3(0.0, lift, 0.0), 1.0);
      vec4 clip = lightMatrix * world;
      vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
      if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) discard;
      float here = -(lightView * world).z;
      float shade = 0.0;
      // Soft by height: what stands well above the ground throws a fainter shadow than what touches it.
      for (int k = 0; k < 12; k++) {
        vec4 hit = texture2D(depthMap, uv + DISK[k] * tapRadius);
        if (hit.g > 0.0 && hit.g < here) {
          float height = (here - hit.g) * heightScale;
          shade += 1.0 - smoothstep(radius * 0.05, radius * 0.7, height);
        }
      }
      shade /= 12.0;
      float out_ = length(vWorld.xz - center) / halfSize;
      float alpha = shade * opacity * (1.0 - smoothstep(0.55, 1.0, out_));
      gl_FragColor = vec4(shadowColor * alpha, alpha);
    }`;

  function inkFor(hex) {
    // On a bare background the labels are white, but the line round the object stays dark.
    const match = /^#([0-9a-f]{6})$/i.exec(hex || "");
    const value = match && hex.toUpperCase() !== "#FFFFFF" ? parseInt(match[1], 16) : 0x080e1e;
    return new THREE.Vector3((value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255);
  }

  function createStudioPasses(renderer, root, camera, studio, inkHex) {
    if (!renderer.extensions.has("EXT_color_buffer_float")) {
      console.warn("3D: no float render targets, so no occlusion or ink");
      return null;
    }
    const nearest = { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
    const surface = new THREE.WebGLRenderTarget(1, 1, { ...nearest, type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: true });
    const raw = new THREE.WebGLRenderTarget(1, 1, { ...nearest, depthBuffer: false });
    const occlusion = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    studio.occlusion.value = occlusion.texture;

    const shared = { surface: { value: surface.texture }, fullSize: { value: new THREE.Vector2(1, 1) }, frustum: { value: new THREE.Vector2(1, 1) }, frustumShift: { value: new THREE.Vector2() }, reach: { value: 1 } };
    const screenMaterial = (fragmentShader, uniforms, extra) => new THREE.ShaderMaterial({
      vertexShader: FULL_SCREEN_VERTEX, fragmentShader, uniforms, depthTest: false, depthWrite: false, toneMapped: false, blending: THREE.NoBlending, ...extra,
    });
    const occlusionMaterial = screenMaterial(OCCLUSION_FRAGMENT, { ...shared, strength: { value: OCCLUSION_STRENGTH } });
    const blurMaterial = screenMaterial(OCCLUSION_BLUR_FRAGMENT, { ...shared, raw: { value: raw.texture } });
    const inkUniforms = { surface: shared.surface, inkColor: { value: inkFor(inkHex) }, silhouettePen: { value: SILHOUETTE_PEN }, seamPen: { value: SEAM_PEN }, seamShade: { value: SEAM_SHADE } };
    const inkMaterial = screenMaterial(INK_FRAGMENT, inkUniforms, {
      transparent: true, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });

    const triangle = new THREE.BufferGeometry();
    triangle.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const screen = new THREE.Mesh(triangle, occlusionMaterial);
    screen.frustumCulled = false;
    const screenScene = new THREE.Scene();
    screenScene.add(screen);
    const screenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    function drawScreen(material, target) {
      screen.material = material;
      renderer.setRenderTarget(target);
      renderer.render(screenScene, screenCamera);
    }

    let nextPartId = 1;
    const drawn = [];
    const skipped = [];
    const meshById = new Map();
    function surfaceMaterialFor(mesh) {
      if (mesh.userData.surfaceMaterial) return mesh.userData.surfaceMaterial;
      const shown = mesh.material;
      const material = new THREE.ShaderMaterial({
        vertexShader: SURFACE_VERTEX, fragmentShader: SURFACE_FRAGMENT, clipping: !!shown.clippingPlanes, blending: THREE.NoBlending, toneMapped: false,
        side: shown.side, clippingPlanes: shown.clippingPlanes,
        uniforms: { partId: { value: nextPartId }, hatched: { value: shown.userData.hatched ? 1 : 0 } },
      });
      meshById.set(nextPartId++, mesh);
      mesh.userData.surfaceMaterial = material;
      return material;
    }

    function drawSurfaces(target, viewer) {
      drawn.length = skipped.length = 0;
      root.traverse((node) => {
        if (!node.isMesh) return;
        if (node.material.opacity < 0.6) {
          if (node.visible) skipped.push(node);
        } else {
          drawn.push(node, node.material);
        }
      });
      for (const node of skipped) node.visible = false;
      for (let i = 0; i < drawn.length; i += 2) drawn[i].material = surfaceMaterialFor(drawn[i]);
      const previousTarget = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      renderer.render(root, viewer);
      renderer.setRenderTarget(previousTarget);
      for (let i = 0; i < drawn.length; i += 2) drawn[i].material = drawn[i + 1];
      for (const node of skipped) node.visible = true;
    }

    // The ground shadow: seen from the shadow light, how far each thing stands above the ground.
    const groundDepth = new THREE.WebGLRenderTarget(1024, 1024, { ...nearest, type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: true });
    const groundCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    const groundUniforms = {
      depthMap: { value: groundDepth.texture }, lightMatrix: { value: new THREE.Matrix4() }, lightView: { value: new THREE.Matrix4() },
      lift: { value: 0 }, heightScale: { value: 1 }, radius: { value: 1 }, center: { value: new THREE.Vector2() }, halfSize: { value: 1 },
      tapRadius: { value: 0 }, shadowColor: { value: new THREE.Vector3() }, opacity: { value: GROUND_SHADOW_OPACITY },
    };
    const toDisplay = (value) => (value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055);
    groundUniforms.shadowColor.value.set(...GROUND_SHADOW_COLOR.map(toDisplay));
    const groundMaterial = new THREE.ShaderMaterial({
      vertexShader: "varying vec3 vWorld; void main() { vec4 world = modelMatrix * vec4(position, 1.0); vWorld = world.xyz; gl_Position = projectionMatrix * viewMatrix * world; }",
      fragmentShader: GROUND_FRAGMENT, uniforms: groundUniforms, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    const scratchMatrix = new THREE.Matrix4();
    const scratchEye = new THREE.Vector3();

    const size = new THREE.Vector2();
    return {
      groundMaterial,
      // Where the shadow light looks from. The depth map is redrawn only when something moved.
      groundFrom(center, radius, floorY, moved) {
        const half = radius * 1.2;
        groundCamera.left = groundCamera.bottom = -half;
        groundCamera.right = groundCamera.top = half;
        groundCamera.near = radius * 0.5;
        groundCamera.far = radius * 8;
        groundCamera.position.copy(scratchEye.copy(center).addScaledVector(SHADOW_DIRECTION, radius * 4));
        groundCamera.up.set(0, 0, 1);
        groundCamera.lookAt(center);
        groundCamera.updateProjectionMatrix();
        groundCamera.updateMatrixWorld();
        groundUniforms.lightView.value.copy(groundCamera.matrixWorldInverse);
        groundUniforms.lightMatrix.value.copy(scratchMatrix.multiplyMatrices(groundCamera.projectionMatrix, groundCamera.matrixWorldInverse));
        groundUniforms.lift.value = radius * 0.004;
        groundUniforms.heightScale.value = SHADOW_DIRECTION.y;
        groundUniforms.radius.value = radius;
        groundUniforms.center.value.set(center.x, center.z);
        groundUniforms.halfSize.value = radius * 1.9;
        groundUniforms.tapRadius.value = (1 / 1024) * 1.6 * 2;
        if (moved) drawSurfaces(groundDepth, groundCamera);
      },
      // The part under a pixel of the canvas (x and y in device pixels from the top left), or null.
      meshAt(x, y) {
        const pixel = new Float32Array(4);
        renderer.readRenderTargetPixels(surface, Math.round(x), Math.round(size.y - 1 - y), 1, 1, pixel);
        return meshById.get(Math.abs(Math.round(pixel[0]))) || null;
      },
      resize() {
        renderer.getDrawingBufferSize(size);
        surface.setSize(size.x, size.y);
        const halfWidth = Math.max(1, Math.ceil(size.x / 2)), halfHeight = Math.max(1, Math.ceil(size.y / 2));
        raw.setSize(halfWidth, halfHeight);
        occlusion.setSize(halfWidth, halfHeight);
        shared.fullSize.value.copy(size);
        studio.pixels.value.copy(size);
        const pen = Math.max(1, renderer.getPixelRatio());
        inkUniforms.silhouettePen.value = SILHOUETTE_PEN * pen;
        inkUniforms.seamPen.value = SEAM_PEN * pen;
      },
      // Before the picture: what the materials read.
      prepare(reach) {
        drawSurfaces(surface, camera);
        const projection = camera.projectionMatrix.elements;
        shared.frustum.value.set(1 / projection[0], 1 / projection[5]);
        shared.frustumShift.value.set(projection[8], projection[9]);
        shared.reach.value = reach;
        drawScreen(occlusionMaterial, raw);
        drawScreen(blurMaterial, occlusion);
        renderer.setRenderTarget(null);
      },
      // After the picture: the ink on top of it.
      ink() {
        const autoClear = renderer.autoClear;
        renderer.autoClear = false;
        drawScreen(inkMaterial, null);
        renderer.autoClear = autoClear;
      },
    };
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
  // A wall: the surface, a copy pushed in by `thickness` facing the other way, and a rim
  // round every open edge. A closed part comes out hollow, which shows once it's cut.
  function solidify(geometry, thickness) {
    const outer = geometry.index ? geometry.toNonIndexed() : geometry;
    const position = outer.attributes.position;
    const count = position.count - (position.count % 3);
    // Copies of a point (at a seam or a hard edge) move as one, so the wall stays in one piece.
    const pointOf = new Uint32Array(count);
    const points = [];
    const seen = new Map();
    for (let i = 0; i < count; i++) {
      const key = `${Math.round(position.getX(i) * 1e5)},${Math.round(position.getY(i) * 1e5)},${Math.round(position.getZ(i) * 1e5)}`;
      let point = seen.get(key);
      if (point === undefined) {
        point = points.length;
        seen.set(key, point);
        points.push({ at: new THREE.Vector3().fromBufferAttribute(position, i), facing: new THREE.Vector3() });
      }
      pointOf[i] = point;
    }
    // Each point's way out comes from the faces round it, weighted by their area.
    const edgeA = new THREE.Vector3(), edgeB = new THREE.Vector3(), faceNormal = new THREE.Vector3();
    const edges = new Map();
    for (let i = 0; i < count; i += 3) {
      const corners = [pointOf[i], pointOf[i + 1], pointOf[i + 2]];
      edgeA.subVectors(points[corners[1]].at, points[corners[0]].at);
      edgeB.subVectors(points[corners[2]].at, points[corners[0]].at);
      faceNormal.crossVectors(edgeA, edgeB);
      for (let k = 0; k < 3; k++) {
        points[corners[k]].facing.add(faceNormal);
        const from = corners[k], to = corners[(k + 1) % 3];
        if (from === to) continue;
        const key = from < to ? from * points.length + to : to * points.length + from;
        const edge = edges.get(key);
        if (edge) edge.uses++;
        else edges.set(key, { from, to, uses: 1 });
      }
    }
    for (const point of points) {
      point.facing.normalize();
      point.inner = point.at.clone().addScaledVector(point.facing, -thickness);
    }

    // The inside wall: every triangle pushed in and wound the other way, so it faces the hollow.
    const hasUv = !!outer.attributes.uv;
    const inner = new THREE.BufferGeometry();
    const innerPosition = new Float32Array(count * 3), innerNormal = new Float32Array(count * 3);
    const innerUv = hasUv ? new Float32Array(count * 2) : null;
    const normal = outer.attributes.normal, uv = outer.attributes.uv;
    for (let i = 0; i < count; i++) {
      const triangleStart = i - (i % 3);
      const source = i % 3 === 0 ? i : triangleStart + 3 - (i % 3);
      const point = points[pointOf[source]].inner;
      innerPosition.set([point.x, point.y, point.z], i * 3);
      innerNormal.set([-normal.getX(source), -normal.getY(source), -normal.getZ(source)], i * 3);
      if (hasUv) innerUv.set([uv.getX(source), uv.getY(source)], i * 2);
    }
    inner.setAttribute("position", new THREE.BufferAttribute(innerPosition, 3));
    inner.setAttribute("normal", new THREE.BufferAttribute(innerNormal, 3));
    if (hasUv) inner.setAttribute("uv", new THREE.BufferAttribute(innerUv, 2));

    const rim = [];
    for (const { from, to, uses } of edges.values()) {
      if (uses !== 1) continue;
      const a = points[from], b = points[to];
      rim.push(...a.at.toArray(), ...a.inner.toArray(), ...b.inner.toArray(), ...a.at.toArray(), ...b.inner.toArray(), ...b.at.toArray());
    }
    const pieces = [outer, inner];
    if (rim.length) {
      const band = new THREE.BufferGeometry();
      band.setAttribute("position", new THREE.Float32BufferAttribute(rim, 3));
      band.computeVertexNormals();
      if (hasUv) band.setAttribute("uv", new THREE.BufferAttribute(new Float32Array((rim.length / 3) * 2), 2));
      pieces.push(band);
    }
    return merge(pieces);
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

  // A tube's cross-section, walked round once, with its four rims rounded.
  function bevelledTubeProfile(outer, inner, h, bevel) {
    const corners = [[inner, -h / 2], [outer, -h / 2], [outer, h / 2], [inner, h / 2]];
    const points = [new THREE.Vector2(inner, -h / 2 + bevel)];
    corners.forEach(([x, y], i) => {
      const previous = corners[(i + 3) % 4], next = corners[(i + 1) % 4];
      const toward = ([px, py]) => { const length = Math.hypot(px - x, py - y) || 1; return [x + ((px - x) / length) * bevel, y + ((py - y) / length) * bevel]; };
      const start = toward(previous), end = toward(next);
      for (let k = 0; k <= 4; k++) {
        const t = k / 4, u = 1 - t;
        points.push(new THREE.Vector2(u * u * start[0] + 2 * u * t * x + t * t * end[0], u * u * start[1] + 2 * u * t * y + t * t * end[1]));
      }
    });
    points.push(points[0].clone());
    return points;
  }

  function arrowGeometry(shape) {
    const points = (shape.points || []).map((p) => vectorOf(p, null)).filter(Boolean);
    if (points.length < 2) return null;
    const r = num(shape.r, 0.04);
    const curve = new THREE.CatmullRomCurve3(points, false, "centripetal", 0.2);
    const length = curve.getLength();
    const head = Math.min(num(shape.head, r * 5), length * 0.6);
    const headRadius = num(shape.headR, r * 2.6);
    const headStart = curve.getUtoTmapping(Math.max(0, (length - head) / length));
    const shaftPoints = Array.from({ length: 49 }, (_, i) => curve.getPoint((headStart * i) / 48));
    const shaftSegments = clamp(Math.round((length / r) * 2), 16, 400);
    const shaft = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(shaftPoints, false, "centripetal", 0.2), shaftSegments, r, 12, false);
    const base = curve.getPoint(headStart);
    const direction = curve.getPoint(1).sub(base);
    if (direction.lengthSq() < 1e-12) direction.set(1, 0, 0);
    const cone = new THREE.ConeGeometry(headRadius, head, 24).translate(0, head / 2, 0);
    cone.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(AXES.y, direction.normalize()));
    cone.translate(base.x, base.y, base.z);
    const tail = new THREE.SphereGeometry(r, 12, 8).translate(points[0].x, points[0].y, points[0].z);
    return merge([shaft, cone, tail]);
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
    const depth = num(shape.depth, num(shape.h, 0.3));
    const bevel = shape.bevel === false ? 0 : Math.min(typeof shape.bevel === "number" ? Math.max(0, shape.bevel) : 0.015, depth * (typeof shape.bevel === "number" ? 0.45 : 0.2));
    const options = { depth, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: typeof shape.bevel === "number" ? 3 : 2, curveSegments: 12 };
    let shapes = null;
    const outline = Array.isArray(shape.points) ? shape.points : shape.shape;
    if (typeof shape.d === "string") shapes = shapesFromPath(shape.d, num(shape.unit, 0.01));
    else if (Array.isArray(outline) && outline.length >= 3) shapes = [new THREE.Shape(outline.map((p) => new THREE.Vector2(p[0], p[1])))];
    if (!shapes || !shapes.length) return null;
    // An outline's coordinates are where the part sits, so it isn't re-centred.
    return new THREE.ExtrudeGeometry(shapes, options).translate(0, 0, -depth / 2);
  }

  function latheGeometry(shape) {
    const profile = (shape.profile || []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (profile.length < 2) return null;
    let points = profile.map((p) => new THREE.Vector2(Math.max(0, p[0]), p[1]));
    if (points[0].y > points[points.length - 1].y) points.reverse();
    const geometry = new THREE.LatheGeometry(points, 64);
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
        if (bevel > 0) return new THREE.LatheGeometry(roundedProfile(r, top, h, bevel), 64);
        return new THREE.CylinderGeometry(top, r, h, 48);
      }
      case "cone": return new THREE.CylinderGeometry(num(shape.top, num(shape.rTop, 0)), num(shape.r, 0.5), num(shape.h, 1), 48);
      case "tube": {
        const outer = num(shape.r, 0.5);
        const inner = Math.min(num(shape.inner, outer * 0.8), outer * 0.995), h = num(shape.h, 1);
        const bevel = Math.min(num(shape.bevel, 0), (outer - inner) * 0.45, h * 0.45);
        if (bevel > 0.0005) return new THREE.LatheGeometry(bevelledTubeProfile(outer, inner, h, bevel), 64);
        return hollowCylinder(outer, inner, h, 64);
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
        const closed = !!shape.closed && points.length >= 3;
        const curve = new THREE.CatmullRomCurve3(points, closed, "centripetal", 0.2);
        // Left open at the ends, like a vessel or a hose that's been cut to length.
        return new THREE.TubeGeometry(curve, clamp(points.length * 24, 24, 2400), num(shape.r, 0.1), clamp(Math.round(num(shape.seg, 16)), 4, 32), closed);
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
          gl_FragColor = vec4(c * ${ROOM_LEVEL.toFixed(2)}, 1.0);
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
    // The figure's rectangle is what it draws in. A window stands around it, with a title bar and
    // padding; alone on paper it only has a title above it.
    const titleInset = mark.card ? 0 : !mark.onPaper && mark.title ? 28 * scale.y : 0;
    const pad = mark.card ? 24 * scale.x : 0, head = mark.card ? 28 * scale.y : 0;
    const outer = mark.card
      ? { x: Math.max(2, box.x - pad), y: Math.max(2, box.y - pad - head) }
      : { x: box.x, y: box.y };
    if (mark.card) { outer.w = box.x + box.w + pad - outer.x; outer.h = box.y + box.h + pad - outer.y; } else { outer.w = box.w; outer.h = box.h; }

    const element = document.createElement("div");
    element.className = `lesson-stage${mark.card ? " lesson-window" : ""}`;
    Object.assign(element.style, { left: `${outer.x}px`, top: `${outer.y}px`, width: `${outer.w}px`, height: `${outer.h}px` });
    if (mark.card || mark.title) {
      const bar = document.createElement("div");
      bar.className = mark.card ? "lesson-window-bar" : "lesson-stage-title";
      bar.style.height = `${mark.card ? head : titleInset}px`;
      bar.style.fontSize = `${13 * scale.y}px`;
      const title = document.createElement("span");
      title.className = "lesson-window-title";
      title.textContent = mark.title || "";
      bar.appendChild(title);
      element.appendChild(bar);
    }
    const canvas = document.createElement("canvas");
    canvas.className = "lesson-stage-canvas";
    canvas.style.left = `${box.x - outer.x}px`;
    canvas.style.top = `${box.y - outer.y + titleInset}px`;
    element.appendChild(canvas);
    if (mark.card && host.decorateWindow) {
      host.decorateWindow(element, element.querySelector(".lesson-window-bar"), "plain");
    }
    const readout = document.createElement("div");
    readout.className = "lesson-readout";
    readout.style.top = `${box.y - outer.y + titleInset + 8}px`;
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
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.toneMappingExposure = EXPOSURE;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.localClippingEnabled = true;

    const scene = new THREE.Scene();
    scene.environment = bakeStudio(renderer);
    scene.environmentIntensity = ENVIRONMENT_LIGHT;

    const key = new THREE.DirectionalLight(0xfff6ea, KEY_LIGHT);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -0.0015;
    key.shadow.radius = 2;
    key.shadow.autoUpdate = false;
    // Shading comes from the key's place by the viewer, but its shadow is cast from the shadow
    // light above the model, so shadows don't slide over the surface as the view turns.
    const shadowFrom = { matrixWorld: new THREE.Matrix4(), target: { matrixWorld: new THREE.Matrix4() } };
    const castKeyShadow = key.shadow.updateMatrices.bind(key.shadow);
    key.shadow.updateMatrices = () => castKeyShadow(shadowFrom);
    scene.add(key);
    scene.add(key.target);
    const rim = new THREE.DirectionalLight(0xcfe0ff, RIM_LIGHT);
    scene.add(rim);
    scene.add(rim.target);

    // The object draws in its own rectangle inside the stage, leaving the sides to its labels.
    const sideRoom = Math.min(130, Math.max(56, mark.w * 0.2));
    const hasSideRoom = mark.w > sideRoom * 2 + 80;
    const objectRect = hasSideRoom
      ? { x: sideRoom * scale.x, y: 6 * scale.y, w: widthPx - sideRoom * 2 * scale.x, h: heightPx - 12 * scale.y }
      : { x: 0, y: 0, w: widthPx, h: heightPx };
    const camera = new THREE.PerspectiveCamera(mark.camera.fov, objectRect.w / objectRect.h, 0.05, 500);
    if (hasSideRoom) camera.setViewOffset(objectRect.w, objectRect.h, -objectRect.x, -objectRect.y, widthPx, heightPx);
    const root = new THREE.Group();
    scene.add(root);
    const blank = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    blank.needsUpdate = true;
    const studio = { occlusion: { value: blank }, pixels: { value: new THREE.Vector2(1, 1) }, hatchSpacing: { value: 0.05 }, shadowDirection: { value: SHADOW_DIRECTION } };
    const passes = createStudioPasses(renderer, root, camera, studio, mark.ink);
    if (passes) passes.resize();
    // The ground shows only the object's shadow, and fades before its edge.
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2),
      passes ? passes.groundMaterial : new THREE.ShadowMaterial({ opacity: GROUND_SHADOW_OPACITY }),
    );
    floor.receiveShadow = !passes;
    floor.renderOrder = -1;
    floor.visible = false;
    scene.add(floor);

    // ---- what the stage is doing
    const parts = new Map();
    const labels = [];
    const motions = [];
    const shapeCache = new Map();
    const view = {
      tilt: mark.camera.tilt, zoom: mark.camera.zoom, spin: mark.camera.spin, userZoom: 1, target: null,
      // The camera orbits a model that stays put.
      theta: 0, phi: Math.PI / 2 - mark.camera.tilt * DEG, thetaDelta: 0, phiDelta: 0,
      restingYaw: (REST_YAW_DEGREES + mark.camera.turn) * DEG, viewYaw: (REST_YAW_DEGREES + mark.camera.turn) * DEG,
      hasRestingView: mark.camera.turn !== 0,
      swing: null, swayStart: null, heldSince: null, turnRestartedAt: -Infinity, begunRestingSwing: false, tookControl: false,
      // Framing: where the camera looks and how far back it stands, eased toward what the last refit worked out.
      framing: null, center: new THREE.Vector3(), radius: 6, objectRadius: 1, floorY: undefined,
      extent: null, extentTarget: null, revision: 0,
    };
    let needsRefit = false, lastRefit = -Infinity, lastTime = performance.now() / 1000, lastUpdate = null, tickEnvelope = null;
    let drawCalls = 0, disposed = false;
    let lastFrameReport = lastTime, renderMilliseconds = 0, renderedFrames = 0, qualityLevel = 0;
    let frameMsBeforeStep = null, qualityIsSettled = false;
    const scratchMatrix = new THREE.Matrix4();

    const allMeshes = () => {
      const meshes = [];
      for (const part of parts.values()) meshes.push(...part.meshes);
      return meshes;
    };

    // ---- framing: fit the whole model, from every side it will turn to, using its final size
    function samplesOf(mesh, count) {
      const position = mesh.geometry.attributes.position;
      const stride = Math.max(1, Math.floor(position.count / count));
      const list = [];
      for (let i = 0; i < position.count; i += stride) list.push(position.getX(i), position.getY(i), position.getZ(i));
      return list;
    }
    function worldSamples(mesh) {
      const holder = mesh.parent;
      holder.updateWorldMatrix(true, false);
      const cache = mesh.userData.framing || (mesh.userData.framing = { local: samplesOf(mesh, FRAMING_SAMPLES_PER_PART), matrix: null, world: null });
      if (!cache.matrix || !cache.matrix.equals(holder.matrixWorld)) {
        cache.matrix = holder.matrixWorld.clone();
        const elements = holder.matrixWorld.elements;
        const world = new Float32Array(cache.local.length);
        for (let i = 0; i < cache.local.length; i += 3) {
          const x = cache.local[i], y = cache.local[i + 1], z = cache.local[i + 2];
          world[i] = elements[0] * x + elements[4] * y + elements[8] * z + elements[12];
          world[i + 1] = elements[1] * x + elements[5] * y + elements[9] * z + elements[13];
          world[i + 2] = elements[2] * x + elements[6] * y + elements[10] * z + elements[14];
        }
        cache.world = world;
      }
      return cache.world;
    }
    function turnedAxes(yaw, tilt) {
      const back = new THREE.Vector3(0, Math.sin(tilt), Math.cos(tilt));
      const right = new THREE.Vector3(1, 0, 0);
      const up = new THREE.Vector3().crossVectors(back, right);
      for (const axis of [right, up, back]) axis.applyAxisAngle(AXES.y, yaw);
      return { right, up, back };
    }
    function refit(now) {
      needsRefit = false;
      lastRefit = now;
      const meshes = allMeshes();
      if (!meshes.length) return;
      const min = new THREE.Vector3(Infinity, Infinity, Infinity), max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
      const tilt = view.tilt * DEG;
      const projectionX = 1 / (Math.tan((camera.fov * DEG) / 2) * (objectRect.w / objectRect.h));
      const projectionY = 1 / Math.tan((camera.fov * DEG) / 2);
      const views = view.spin !== 0 ? FRAMING_DIRECTIONS : 1;
      const restYaw = views === 1 && !view.hasRestingView ? 0 : view.restingYaw;
      const axes = [];
      const directions = [];
      for (let k = 0; k < views; k++) {
        const axis = turnedAxes(restYaw - (k * Math.PI) / 4, tilt);
        axes.push(axis);
        directions.push(
          axis.back.clone().addScaledVector(axis.right, projectionX / FRAME_FILL), axis.back.clone().addScaledVector(axis.right, -projectionX / FRAME_FILL),
          axis.back.clone().addScaledVector(axis.up, projectionY / FRAME_FILL), axis.back.clone().addScaledVector(axis.up, -projectionY / FRAME_FILL),
        );
      }
      const reaches = new Float64Array(directions.length).fill(-Infinity);
      for (const mesh of meshes) {
        const world = worldSamples(mesh);
        for (let i = 0; i < world.length; i += 3) {
          const x = world[i], y = world[i + 1], z = world[i + 2];
          if (x < min.x) min.x = x; if (y < min.y) min.y = y; if (z < min.z) min.z = z;
          if (x > max.x) max.x = x; if (y > max.y) max.y = y; if (z > max.z) max.z = z;
        }
        // Each part's reach toward each side of the frame is remembered until it moves or the view changes.
        const key = `${views},${restYaw.toFixed(4)},${tilt.toFixed(4)}`;
        const cache = mesh.userData.framing;
        if (cache.reachKey !== key || cache.reachOf !== world) {
          cache.reachKey = key;
          cache.reachOf = world;
          cache.reaches = directions.map((direction) => {
            let best = -Infinity;
            for (let i = 0; i < world.length; i += 3) {
              const along = direction.x * world[i] + direction.y * world[i + 1] + direction.z * world[i + 2];
              if (along > best) best = along;
            }
            return best;
          });
        }
        for (let d = 0; d < reaches.length; d++) if (cache.reaches[d] > reaches[d]) reaches[d] = cache.reaches[d];
      }
      // A running mechanism keeps the room it has needed so far, so the framing doesn't breathe with it.
      if (lesson3dTicks.running) {
        if (tickEnvelope && tickEnvelope.reaches.length === reaches.length) {
          min.min(tickEnvelope.min);
          max.max(tickEnvelope.max);
          for (let d = 0; d < reaches.length; d++) reaches[d] = Math.max(reaches[d], tickEnvelope.reaches[d]);
        }
        tickEnvelope = { min: min.clone(), max: max.clone(), reaches: Array.from(reaches) };
      }
      const center = min.clone().add(max).multiplyScalar(0.5);
      let distance = 0.1;
      directions.forEach((direction, d) => { distance = Math.max(distance, reaches[d] - direction.dot(center)); });
      if (view.zoom !== 1) distance /= Math.min(view.zoom, 1.1);
      view.framing = { center, distance };
      view.objectRadius = Math.max(0.001, max.clone().sub(min).length() / 2);
      view.floorY = min.y;
      camera.near = Math.max(0.01, distance / 500);
      camera.far = Math.max(500, distance * 20);
      view.extentTarget = silhouette(meshes, axes, center, distance, projectionX, projectionY);
      view.revision++;
      labelsNeedLayout = true;
    }
    // The box the model fills in the object's rectangle, over every side it turns to.
    function silhouette(meshes, axes, center, distance, projectionX, projectionY) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const mesh of meshes) {
        const world = mesh.userData.framing.world;
        const stride = 3 * Math.max(1, Math.floor(world.length / 3 / SILHOUETTE_SAMPLES_PER_PART));
        for (const { right, up, back } of axes) {
          for (let i = 0; i < world.length; i += stride) {
            const x = world[i] - center.x, y = world[i + 1] - center.y, z = world[i + 2] - center.z;
            const depth = distance - (back.x * x + back.y * y + back.z * z);
            if (depth <= 0) continue;
            const screenX = ((right.x * x + right.y * y + right.z * z) * projectionX) / depth;
            const screenY = ((up.x * x + up.y * y + up.z * z) * projectionY) / depth;
            if (screenX < minX) minX = screenX; if (screenX > maxX) maxX = screenX;
            if (screenY < minY) minY = screenY; if (screenY > maxY) maxY = screenY;
          }
        }
      }
      if (minX > maxX) return null;
      return {
        x: objectRect.x + ((minX + 1) / 2) * objectRect.w, y: objectRect.y + ((1 - maxY) / 2) * objectRect.h,
        w: ((maxX - minX) / 2) * objectRect.w, h: ((maxY - minY) / 2) * objectRect.h,
      };
    }

    // ---- the camera
    function swingToFront(now, yaw, speed, shortest, longest) {
      if (dragging && dragging.moved) return;
      if (!view.hasRestingView && view.spin === 0) { needsRefit = true; view.hasRestingView = true; }
      const turnSpeed = view.thetaDelta * 0.05 * 60;
      const to = Math.round((view.theta + turnSpeed * 0.5 - yaw) / (Math.PI * 2)) * Math.PI * 2 + yaw;
      const distance = Math.abs(to - view.theta);
      view.thetaDelta = 0;
      if (distance <= 0.002) { view.theta = to; view.swing = null; return; }
      view.swing = { start: now, from: view.theta, to, speed: turnSpeed, seconds: clamp(distance / speed, shortest, longest) };
    }
    const builtAt = () => {
      let built = 0;
      for (const part of parts.values()) built = Math.max(built, part.born + GROW_SECONDS * part.pace);
      for (const label of labels) built = Math.max(built, label.born + 0.4 + label.mark.text.length * 0.015);
      return built;
    };
    function spinScale(now) {
      if (view.tookControl || view.heldSince !== null) return 0;
      if (now - Math.max(builtAt(), view.turnRestartedAt) <= TURN_SECONDS_AFTER_BUILT) {
        view.begunRestingSwing = false;
        return 1;
      }
      if (!view.begunRestingSwing) {
        view.begunRestingSwing = true;
        if (view.spin !== 0) swingToFront(now, view.viewYaw, 0.6, 2.5, 6);
      }
      return 0;
    }
    function updateCamera(now) {
      const steps = clamp(((now - (lastUpdate === null ? now : lastUpdate)) * 60), 0, 4);
      lastUpdate = now;
      if (needsRefit) refit(now);
      else if (lesson3dTicks.running && now - lastRefit > 1) refit(now);
      const ease = 1 - 0.94 ** steps;
      if (view.framing) {
        if (!view.hasFramed) {
          view.hasFramed = true;
          view.center.copy(view.framing.center);
          view.radius = view.framing.distance;
        } else {
          view.center.lerp(view.framing.center, ease);
          view.radius += (view.framing.distance - view.radius) * ease;
        }
      }
      if (view.extentTarget) {
        if (!view.extent) view.extent = { ...view.extentTarget };
        else for (const key of ["x", "y", "w", "h"]) view.extent[key] += (view.extentTarget[key] - view.extent[key]) * ease;
      }
      const scaleOfSpin = spinScale(now);
      const beingDragged = dragging && dragging.moved;
      if (view.spin !== 0 && !beingDragged && !view.swing) {
        if (cuts.some((cut) => cut.facing) && CUT_SWAY_DEGREES > 0) {
          if (scaleOfSpin > 0) {
            if (view.swayStart === null) view.swayStart = now;
            const amplitude = CUT_SWAY_DEGREES * DEG;
            const speed = 0.10472 * view.spin * 2.5;
            const phase = ((now - view.swayStart) * Math.abs(speed)) / amplitude;
            const center = view.restingYaw + Math.round((view.theta - view.restingYaw) / (Math.PI * 2)) * Math.PI * 2;
            view.thetaDelta = center - Math.sign(speed || 1) * amplitude * Math.sin(phase) - view.theta;
          }
        } else {
          view.thetaDelta -= 0.0017453 * view.spin * 2.5 * scaleOfSpin * steps;
        }
      }
      const follow = 1 - 0.95 ** steps;
      view.theta += view.thetaDelta * follow;
      view.phi = clamp(view.phi + view.phiDelta * follow, 1e-6, Math.PI);
      view.thetaDelta *= 1 - follow;
      view.phiDelta *= 1 - follow;
      if (!beingDragged && Math.abs(view.phiDelta) < 0.001) {
        const settledTilt = clamp(90 - view.phi / DEG, -89, 89);
        if (Math.abs(settledTilt - view.tilt) > 2) { view.tilt = settledTilt; needsRefit = true; }
      }
      if (view.swing) {
        if (beingDragged) view.swing = null;
        else {
          const t = clamp((now - view.swing.start) / view.swing.seconds, 0, 1), t2 = t * t, t3 = t2 * t;
          view.theta = (2 * t3 - 3 * t2 + 1) * view.swing.from + (t3 - 2 * t2 + t) * view.swing.seconds * view.swing.speed + (3 * t2 - 2 * t3) * view.swing.to;
          view.thetaDelta = 0;
          if (t >= 1) view.swing = null;
        }
      }

      const radius = view.radius / view.userZoom;
      const sinPhi = Math.sin(view.phi);
      camera.position.set(view.center.x + radius * sinPhi * Math.sin(view.theta), view.center.y + radius * Math.cos(view.phi), view.center.z + radius * sinPhi * Math.cos(view.theta));
      camera.lookAt(view.center);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();

      // The lights and the studio around them stay where they are for the viewer.
      const reach = Math.max(view.objectRadius, 0.001) * 4;
      key.position.copy(KEY_DIRECTION).applyAxisAngle(AXES.y, view.theta).multiplyScalar(reach).add(view.center);
      key.target.position.copy(view.center);
      rim.position.copy(RIM_DIRECTION).applyAxisAngle(AXES.y, view.theta).multiplyScalar(reach).add(view.center);
      rim.target.position.copy(view.center);
      scene.environmentRotation.set(0, view.theta, 0);

      // The shadow stays with the model, and is redrawn only when something on it moved.
      const r = view.objectRadius;
      const box = view.framing ? view.framing.center : view.center;
      shadowFrom.matrixWorld.makeTranslation(box.x + SHADOW_DIRECTION.x * r * 4, box.y + SHADOW_DIRECTION.y * r * 4, box.z + SHADOW_DIRECTION.z * r * 4);
      shadowFrom.target.matrixWorld.makeTranslation(box.x, box.y, box.z);
      const shadowCamera = key.shadow.camera;
      shadowCamera.left = shadowCamera.bottom = -r * 1.2;
      shadowCamera.right = shadowCamera.top = r * 1.2;
      shadowCamera.near = r * 0.5;
      shadowCamera.far = r * 8;
      shadowCamera.updateProjectionMatrix();
      key.shadow.normalBias = r * 0.008;
      const moved = somethingMoved(r, box);
      if (moved) key.shadow.needsUpdate = true;

      if (view.floorY !== undefined) {
        floor.visible = camera.position.y > view.floorY;
        floor.position.set(box.x, view.floorY - r * 0.004, box.z);
        floor.scale.set(r * 1.9, 1, r * 1.9);
        if (passes) passes.groundFrom(box, r, view.floorY, moved);
      }
      updateClipping(radius);
    }
    // Whether the last shadow still holds: every part and its size and place, and each cut.
    let shadowDrawnFrom = [];
    function somethingMoved(radius, center) {
      const now = [radius, center.x, center.y, center.z];
      root.updateMatrixWorld(true);
      for (const mesh of allMeshes()) {
        if (mesh.material.opacity < 0.6) continue;
        now.push(mesh.visible && isShown(mesh) ? 1 : 0, ...mesh.matrixWorld.elements);
      }
      for (const cut of cuts) now.push(cut.plane.normal.x, cut.plane.normal.y, cut.plane.normal.z, cut.plane.constant);
      const moved = now.length !== shadowDrawnFrom.length || now.some((value, i) => value !== shadowDrawnFrom[i]);
      if (moved) shadowDrawnFrom = now;
      return moved;
    }

    // ---- cutaways
    // A cut belongs to the model: the plane turns with it, so turning never changes what's
    // cut away. cut: true takes the side nearest the viewer at the view the lesson asked for,
    // squared up to the model's own axes; dragging or swaying doesn't move it.
    const cuts = [];
    const scratchSize = new THREE.Vector2();
    function updateClipping(distance) {
      const pixelsTall = renderer.getDrawingBufferSize(scratchSize).y;
      const spacingPixels = HATCH_SPACING_PX * Math.max(1, pixelsTall / 1600);
      studio.hatchSpacing.value = (spacingPixels * 2 * distance * Math.tan((camera.fov * DEG) / 2)) / pixelsTall;
      const quarter = view.spin === 0 && !view.hasRestingView ? 0 : Math.round(view.restingYaw / (Math.PI / 2)) * (Math.PI / 2);
      for (const cut of cuts) {
        if (cut.facing) cut.axis.set(Math.sin(quarter), 0, Math.cos(quarter));
        cut.plane.normal.copy(cut.axis).negate();
        cut.plane.constant = cut.at;
        cut.plane.uniform.value = cut.at;
      }
    }
    function planeFor(cut) {
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
      plane.uniform = { value: 0 };
      if (cut === true) cuts.push({ plane, facing: true, axis: AXES.z.clone(), at: 0 });
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
      if (mark.material.bands) {
        material.userData.bands = mark.material.bands.map((color) => new THREE.Color(color));
        material.userData.bandAxis = { value: new THREE.Vector3(0, 1, 0) };
        material.userData.bandRange = { value: new THREE.Vector2(0, 1) };
        if (!mark.material.color) material.color.set("#FFFFFF");
      }
      const plane = mark.cut ? planeFor(mark.cut) : null;
      if (plane) material.clippingPlanes = [plane];
      // Glass and sheets marked double are seen through, so they aren't painted as a cut face.
      const cutFace = plane ? { plane, hatched: material.opacity >= 0.6 && !mark.material.double } : null;
      applyStudioShading(material, studio, cutFace);
      if (mark.kind === "poly" || mark.material.flat) material.flatShading = true;
      entry.material = material;

      Promise.resolve(geometryFor(mark, axis)).then((geometry) => {
        if (disposed || !geometry) return;
        entry.born = performance.now() / 1000;
        // A sculpted blob bakes its occlusion into vertex colours; the material carries the tint.
        material.vertexColors = !!geometry.attributes.color;
        // Stripes run along the part's longest side, whichever way it was laid.
        if (material.userData.bands) {
          if (!geometry.boundingBox) geometry.computeBoundingBox();
          const size = geometry.boundingBox.getSize(new THREE.Vector3());
          const longest = size.y >= size.x && size.y >= size.z ? "y" : size.x >= size.z ? "x" : "z";
          material.userData.bandAxis.value.set(longest === "x" ? 1 : 0, longest === "y" ? 1 : 0, longest === "z" ? 1 : 0);
          material.userData.bandRange.value.set(geometry.boundingBox.min[longest], geometry.boundingBox.max[longest]);
        }
        for (const node of nodes) {
          const mesh = new THREE.Mesh(geometry, material);
          mesh.castShadow = (material.opacity >= 0.6) && !(material.emissiveIntensity > 0.5);
          mesh.receiveShadow = true;
          mesh.scale.setScalar(0.0001);
          node.add(mesh);
          entry.meshes.push(mesh);
        }
        needsRefit = true;
      }).catch((error) => host.warn(`3D part failed: ${error && error.message}`));
      return entry;
    }

    // ---- motions from the program
    // A part told to spin about an axis that misses it turns about its own middle instead of
    // swinging around the figure: a fan placed by its blades, a wheel built off-centre.
    function spinPivot(part, axisList) {
      const axis = new THREE.Vector3(...(axisList || [0, 1, 0]));
      const inverse = new THREE.Matrix4();
      const parent = part.node.parent;
      if (parent) { parent.updateWorldMatrix(true, false); inverse.copy(parent.matrixWorld).invert(); }
      const bounds = new THREE.Box3(), point = new THREE.Vector3();
      const collect = (entry) => {
        for (const mesh of entry.meshes) {
          mesh.parent.updateWorldMatrix(true, false);
          const samples = samplesOf(mesh, 200);
          for (let i = 0; i < samples.length; i += 3) {
            bounds.expandByPoint(point.set(samples[i], samples[i + 1], samples[i + 2]).applyMatrix4(mesh.parent.matrixWorld).applyMatrix4(inverse));
          }
        }
        for (const child of parts.values()) if (child.mark.parent === entry.id) collect(child);
      };
      collect(part);
      if (bounds.isEmpty()) return null;
      bounds.expandByScalar(bounds.getSize(point).length() * 0.05 + 0.0001);
      const hits = new THREE.Ray(part.base.pos.clone().addScaledVector(axis, -1e4), axis.clone().normalize()).intersectsBox(bounds);
      return hits ? null : bounds.getCenter(new THREE.Vector3());
    }

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
      if (mark.kind === "tween" || mark.kind === "path") needsRefit = true;
      part.motions.push({ kind: mark.kind, start: now, pivot: mark.kind === "spin" ? spinPivot(part, mark.axis) : null, period: mark.period || 6, axis: mark.axis ? new THREE.Vector3(...mark.axis).normalize() : AXES.y, amount: mark.amount, center: mark.center ? new THREE.Vector3(...mark.center) : null });
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
        mesh.scale.setScalar(t >= 1 ? 1 : Math.max(0.0001, easeOutCubic(t)));
      }
      node.position.copy(base.pos);
      node.quaternion.copy(base.quat);
      node.scale.copy(base.scale);
      for (const m of part.motions) {
        const age = now - m.start;
        switch (m.kind) {
          case "tween": {
            const t = smoothstep01(clamp(age / m.secs, 0, 1));
            if (m.to) { scratchVec.set(m.to[0], m.to[1], m.to[2]); node.position.lerpVectors(m.fromPos, scratchVec, t); }
            if (m.rot) { scratchQuat.setFromEuler(new THREE.Euler(m.rot[0] * DEG, m.rot[1] * DEG, m.rot[2] * DEG)); node.quaternion.slerpQuaternions(m.fromQuat, scratchQuat, t); }
            if (t >= 1) {
              if (m.to) base.pos.set(m.to[0], m.to[1], m.to[2]);
              if (m.rot) base.quat.copy(scratchQuat);
              m.done = true;
            }
            break;
          }
          case "spin": {
            const turn = scratchQuat.setFromAxisAngle(m.axis, (age / m.period) * Math.PI * 2);
            node.quaternion.premultiply(turn);
            if (m.pivot) node.position.sub(m.pivot).applyQuaternion(turn).add(m.pivot);
            break;
          }
          case "bob": node.position.addScaledVector(m.axis, Math.sin((age / m.period) * Math.PI * 2) * m.amount); break;
          case "orbit": {
            const turn = scratchQuat.setFromAxisAngle(m.axis, (age / m.period) * Math.PI * 2);
            node.position.sub(m.center).applyQuaternion(turn).add(m.center);
            break;
          }
          case "path": {
            const t = m.once ? clamp(age / m.period, 0, 1) : (age / m.period) % 1;
            node.position.copy(m.curve.getPoint(m.once ? smoothstep01(t) : t));
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
      const halo = view.ink === "#FFFFFF" ? "rgba(8,14,30,0.55)" : "rgba(255,255,255,0.6)";
      const group = host.svgElement("g", { class: "lesson-label" });
      const lineHalo = host.svgElement("line", { stroke: halo, "stroke-width": (2.2 + 2.8) * scale.y, "stroke-linecap": "round" });
      const line = host.svgElement("line", { stroke: view.ink, "stroke-width": 2.2 * scale.y, "stroke-linecap": "round" });
      const dotHalo = host.svgElement("circle", { r: (3.6 + 1.6) * scale.y, fill: halo });
      const dot = host.svgElement("circle", { r: 3.6 * scale.y, fill: view.ink });
      const text = host.svgElement("text", {
        fill: view.ink, "font-family": "Hand, sans-serif",
        stroke: halo, "stroke-width": 3 * scale.y, "paint-order": "stroke",
      });
      // Words are written left to right, as if by the pen.
      const clipId = `lesson-label-clip-${++labelClipCount}`;
      const clip = host.svgElement("clipPath", { id: clipId });
      const clipRect = host.svgElement("rect", { x: 0, y: 0, width: 0, height: 0 });
      clip.appendChild(clipRect);
      text.setAttribute("clip-path", `url(#${clipId})`);
      group.append(clip, lineHalo, line, dotHalo, dot, text);
      host.labelLayer.appendChild(group);
      labels.push({
        mark, group, lineHalo, line, dotHalo, dot, text, clip, clipRect, born: performance.now() / 1000,
        requestedSlot: mark.side === "left" ? 0 : mark.side === "right" ? 1 : null,
        slot: null, fitting: null, box: null, targetBox: null,
        part: mark.follow ? parts.get(mark.follow) : null,
      });
      group.style.opacity = "0";
      if (cardTransform) group.setAttribute("transform", cardTransform);
      if (labelsHidden) group.style.display = "none";
      labelsNeedLayout = true;
    }
    function anchorOf(label) {
      if (label.part) {
        const mesh = label.part.meshes[0];
        if (mesh && mesh.geometry) {
          if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
          mesh.geometry.boundingBox.getCenter(scratchCenter);
          return mesh.parent.localToWorld(scratchCenter.clone());
        }
        return label.part.node.getWorldPosition(new THREE.Vector3());
      }
      return root.localToWorld(label.point ? label.point.clone() : new THREE.Vector3(...(label.mark.point || [0, 0, 0])));
    }
    function isShown(node) {
      for (let n = node; n; n = n.parent) if (!n.visible) return false;
      return true;
    }
    const labelShown = (label) => !label.part || (label.part.meshes.length > 0 && isShown(label.part.node));
    function projectOnCanvas(world) {
      const ndc = world.clone().project(camera);
      return { x: ((ndc.x + 1) / 2) * widthPx, y: ((1 - ndc.y) / 2) * heightPx };
    }
    // Words fitted to the room a side has: whole on one line if they fit, then on two, then smaller.
    const measuring = document.createElement("canvas").getContext("2d");
    function widthOf(words, size) {
      measuring.font = `${size}px Hand, sans-serif`;
      return measuring.measureText(words).width;
    }
    function fitWords(label, room, tall) {
      const words = label.mark.text;
      const pieces = words.split(/\s+/);
      const wanted = (label.mark.size || 19) * scale.y;
      const smallest = LABEL_MIN_SIZE * scale.y;
      for (let size = wanted; size >= smallest; size -= scale.y) {
        const lineHeight = size * LABEL_LINE_HEIGHT;
        const whole = widthOf(words, size);
        if (whole <= room && lineHeight <= tall) return { lines: [words], size, width: whole, height: lineHeight };
        if (pieces.length > 1 && lineHeight * 2 <= tall) {
          let best = null;
          for (let cut = 1; cut < pieces.length; cut++) {
            const first = pieces.slice(0, cut).join(" "), second = pieces.slice(cut).join(" ");
            const width = Math.max(widthOf(first, size), widthOf(second, size));
            if (!best || width < best.width) best = { lines: [first, second], size, width, height: lineHeight * 2 };
          }
          if (best.width <= room) return best;
        }
      }
      return null;
    }
    const LEFT = 0, RIGHT = 1, TOP = 2, BOTTOM = 3;
    const opposite = (slot) => (slot === LEFT ? RIGHT : slot === RIGHT ? LEFT : slot === TOP ? BOTTOM : TOP);
    // Puts each label in a margin: left or right of the model, or above or below a wide one.
    // A label that has been written keeps its side, and only glides along it to make room.
    function layOutLabels() {
      labelsNeedLayout = false;
      const extent = view.extent;
      const shown = labels.filter(labelShown);
      if (!extent || !shown.length) return;
      const area = { minX: 8 * scale.x, minY: 8 * scale.y, maxX: widthPx - 8 * scale.x, maxY: heightPx - 8 * scale.y };
      area.w = area.maxX - area.minX; area.h = area.maxY - area.minY;
      const sideGap = LABEL_SIDE_GAP * scale.x, topGap = LABEL_TOP_GAP * scale.y;
      const edge = { minX: extent.x, maxX: extent.x + extent.w, minY: extent.y, maxY: extent.y + extent.h, midX: extent.x + extent.w / 2, midY: extent.y + extent.h / 2 };
      const room = [edge.minX - sideGap - area.minX, area.maxX - (edge.maxX + sideGap), edge.minY - topGap - area.minY, area.maxY - (edge.maxY + topGap)];
      const wide = extent.w >= extent.h * 1.5;
      const rowWidth = clamp(area.w / 3, 120 * scale.x, 240 * scale.x);
      const tryFit = (label, slot) => (slot === LEFT || slot === RIGHT ? fitWords(label, room[slot], area.h) : fitWords(label, Math.min(rowWidth, area.w), room[slot]));
      const preferred = (x, y) => {
        if (!wide) return x < edge.midX ? LEFT : RIGHT;
        const margin = extent.w * 0.14;
        if (x < edge.minX + margin) return LEFT;
        if (x > edge.maxX - margin) return RIGHT;
        return y < edge.midY ? TOP : BOTTOM;
      };
      const items = [];
      for (const label of shown) {
        const anchor = projectOnCanvas(anchorOf(label));
        if (label.slot !== null && label.fitting) {
          items.push({ label, anchor, slot: label.slot, fitting: label.fitting, movable: false });
          continue;
        }
        const first = label.requestedSlot ?? preferred(anchor.x, anchor.y);
        const byX = anchor.x < edge.midX ? LEFT : RIGHT;
        const order = [first, opposite(first), byX, opposite(byX), anchor.y < edge.midY ? TOP : BOTTOM];
        let slot = null, fitting = null;
        for (const candidate of order) {
          fitting = tryFit(label, candidate);
          if (fitting) { slot = candidate; break; }
        }
        if (!fitting) {
          slot = room[RIGHT] >= room[LEFT] ? RIGHT : LEFT;
          const size = LABEL_MIN_SIZE * scale.y;
          fitting = { lines: [label.mark.text], size, width: widthOf(label.mark.text, size), height: size * LABEL_LINE_HEIGHT };
        }
        items.push({ label, anchor, slot, fitting, movable: label.requestedSlot === null });
      }
      // Sides share the labels: the one nearest the middle crosses when one side has too many.
      const balance = (a, b, allowed, within, alongY) => {
        for (let guard = 0; guard < items.length; guard++) {
          const countA = items.filter((item) => item.slot === a).length, countB = items.filter((item) => item.slot === b).length;
          if (Math.abs(countA - countB) < allowed) return;
          const heavy = countA > countB ? a : b, light = heavy === a ? b : a;
          const offCentre = (item) => (alongY ? Math.abs(item.anchor.y - edge.midY) : Math.abs(item.anchor.x - edge.midX));
          const mover = items.filter((item) => item.slot === heavy && item.movable && offCentre(item) <= within).sort((p, q) => offCentre(p) - offCentre(q))[0];
          if (!mover) return;
          const fitting = tryFit(mover.label, light);
          if (!fitting) return;
          mover.slot = light;
          mover.fitting = fitting;
        }
      };
      if (wide) balance(TOP, BOTTOM, 3, extent.h * 0.25, true);
      else balance(LEFT, RIGHT, 2, extent.w * 0.2, false);
      // A margin that's full passes its least attached label on.
      const lengthOf = (item, slot) => (slot === LEFT || slot === RIGHT ? item.fitting.height : item.fitting.width);
      const gapOf = (slot) => (slot === LEFT || slot === RIGHT ? 6 * scale.y : 14 * scale.x);
      const capacity = (slot) => (slot === LEFT || slot === RIGHT ? area.h : area.w);
      const fits = (slot) => {
        const inSlot = items.filter((item) => item.slot === slot);
        return inSlot.reduce((total, item) => total + lengthOf(item, slot), 0) + Math.max(0, inSlot.length - 1) * gapOf(slot) <= capacity(slot);
      };
      for (let guard = 0; guard < items.length; guard++) {
        const full = [LEFT, RIGHT, TOP, BOTTOM].find((slot) => !fits(slot));
        if (full === undefined) break;
        const mover = items.filter((item) => item.slot === full && item.movable)[0];
        if (!mover) break;
        const elsewhere = [opposite(full), full < 2 ? TOP : LEFT, full < 2 ? BOTTOM : RIGHT].find((slot) => {
          const fitting = tryFit(mover.label, slot);
          return fitting && (mover.nextFitting = fitting);
        });
        if (elsewhere === undefined) break;
        mover.slot = elsewhere;
        mover.fitting = mover.nextFitting;
      }
      // Along its margin each label stays near its anchor; ones that collide move apart as a group.
      for (const slot of [LEFT, RIGHT, TOP, BOTTOM]) {
        const vertical = slot === LEFT || slot === RIGHT;
        const inSlot = items.filter((item) => item.slot === slot).sort((a, b) => (vertical ? a.anchor.y - b.anchor.y : a.anchor.x - b.anchor.x));
        if (!inSlot.length) continue;
        const low = vertical ? area.minY : area.minX, high = vertical ? area.maxY : area.maxX, gap = gapOf(slot);
        const clusters = [];
        for (const item of inSlot) {
          clusters.push({ items: [item], length: lengthOf(item, slot) });
          for (;;) {
            const last = clusters[clusters.length - 1];
            last.start = clamp(
              last.items.reduce((total, member, i) => {
                const before = last.items.slice(0, i).reduce((sum, other) => sum + lengthOf(other, slot) + gap, 0);
                return total + (vertical ? member.anchor.y : member.anchor.x) - lengthOf(member, slot) / 2 - before;
              }, 0) / last.items.length,
              low, Math.max(low, high - last.length),
            );
            if (clusters.length < 2) break;
            const previous = clusters[clusters.length - 2];
            if (previous.start + previous.length + gap <= last.start) break;
            previous.items.push(...last.items);
            previous.length += gap + last.length;
            clusters.pop();
          }
        }
        for (const cluster of clusters) {
          let along = cluster.start;
          for (const item of cluster.items) {
            const { width, height } = item.fitting;
            let x, y;
            if (slot === LEFT) { x = edge.minX - sideGap - width; y = along; }
            else if (slot === RIGHT) { x = edge.maxX + sideGap; y = along; }
            else if (slot === TOP) { x = along; y = edge.minY - topGap - height; }
            else { x = along; y = edge.maxY + topGap; }
            item.target = { x: clamp(x, area.minX, Math.max(area.minX, area.maxX - width)), y: clamp(y, area.minY, Math.max(area.minY, area.maxY - height)), width, height };
            along += lengthOf(item, slot) + gap;
          }
        }
      }
      for (const item of items) {
        const { label } = item;
        label.slot = item.slot;
        label.fitting = item.fitting;
        label.targetBox = item.target;
        if (!label.box) label.box = { ...item.target };
      }
    }
    function writeWords(label) {
      if (label.writtenSize === label.fitting.size && label.writtenLines === label.fitting.lines.join("|")) return;
      label.writtenSize = label.fitting.size;
      label.writtenLines = label.fitting.lines.join("|");
      label.text.textContent = "";
      label.text.setAttribute("font-size", label.fitting.size);
      label.spans = label.fitting.lines.map((words) => {
        const span = host.svgElement("tspan", {});
        span.textContent = words;
        label.text.appendChild(span);
        return span;
      });
    }
    function updateLabels(now) {
      if (!labels.length) return;
      if (labelsNeedLayout) layOutLabels();
      const steps = clamp((now - lastLabelTime) * 60, 0, 240);
      lastLabelTime = now;
      const glide = 1 - 0.78 ** steps;
      for (const label of labels) {
        if (!labelShown(label) || !label.box || !label.targetBox) { label.group.style.opacity = "0"; continue; }
        const { box: shownBox, targetBox, fitting, slot } = label;
        shownBox.x += (targetBox.x - shownBox.x) * glide;
        shownBox.y += (targetBox.y - shownBox.y) * glide;
        shownBox.width = targetBox.width;
        shownBox.height = targetBox.height;
        writeWords(label);
        const point = projectOnCanvas(anchorOf(label));
        const originX = box.x, originY = box.y + titleInset;
        const rightAligned = slot === LEFT;
        const textX = originX + (rightAligned ? shownBox.x + shownBox.width : shownBox.x);
        const lineStep = fitting.size * LABEL_LINE_HEIGHT;
        label.text.setAttribute("text-anchor", rightAligned ? "end" : slot === RIGHT ? "start" : "middle");
        const centreX = originX + shownBox.x + shownBox.width / 2;
        label.spans.forEach((span, i) => {
          span.setAttribute("x", slot === TOP || slot === BOTTOM ? centreX : textX);
          span.setAttribute("y", originY + shownBox.y + fitting.size * 0.895 + i * lineStep);
        });
        // The leader runs from the word's near edge to a dot on the part.
        let fromX, fromY;
        if (slot === LEFT) { fromX = shownBox.x + shownBox.width + 5 * scale.x; fromY = shownBox.y + shownBox.height / 2; }
        else if (slot === RIGHT) { fromX = shownBox.x - 5 * scale.x; fromY = shownBox.y + shownBox.height / 2; }
        else if (slot === TOP) { fromX = shownBox.x + shownBox.width / 2; fromY = shownBox.y + shownBox.height + 3 * scale.y; }
        else { fromX = shownBox.x + shownBox.width / 2; fromY = shownBox.y - 3 * scale.y; }
        for (const stroke of [label.lineHalo, label.line]) {
          stroke.setAttribute("x1", originX + fromX);
          stroke.setAttribute("y1", originY + fromY);
          stroke.setAttribute("x2", originX + point.x);
          stroke.setAttribute("y2", originY + point.y);
        }
        for (const spot of [label.dotHalo, label.dot]) {
          spot.setAttribute("cx", originX + point.x);
          spot.setAttribute("cy", originY + point.y);
        }
        const age = now - label.born;
        label.group.style.opacity = String(clamp(age / 0.25, 0, 1));
        const writing = clamp(age / (0.4 + label.mark.text.length * 0.015), 0, 1);
        if (writing < 1) {
          label.clipRect.setAttribute("x", originX + shownBox.x - 6);
          label.clipRect.setAttribute("y", originY + shownBox.y - 6);
          label.clipRect.setAttribute("width", (shownBox.width + 12) * writing);
          label.clipRect.setAttribute("height", shownBox.height + 12);
        } else if (label.clip) {
          label.text.removeAttribute("clip-path");
          label.clip.remove();
          label.clip = null;
        }
      }
    }

    let cardScale = 1, cardTransform = "", labelsHidden = false;
    let labelClipCount = 0, labelsNeedLayout = false, lastLabelTime = performance.now() / 1000;
    const lesson3dTicks = { running: false };
    view.ink = mark.ink;

    const scratchCenter = new THREE.Vector3();

    // ---- drag, click and wheel
    let dragging = null;
    element.addEventListener("pointerdown", (event) => {
      dragging = { x: event.clientX, y: event.clientY, travel: 0, moved: false };
      element.setPointerCapture(event.pointerId);
    });
    element.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const dx = event.clientX - dragging.x, dy = event.clientY - dragging.y;
      dragging.travel += Math.hypot(dx, dy);
      dragging.x = event.clientX;
      dragging.y = event.clientY;
      if (!dragging.moved && dragging.travel > 3) {
        dragging.moved = true;
        // Once they've taken hold of it, it stays where they leave it.
        view.tookControl = true;
        view.swing = null;
      }
      if (dragging.moved) {
        const tall = Math.max(1, objectRect.h * cardScale);
        view.thetaDelta -= (Math.PI * 2 * dx) / tall;
        view.phiDelta -= (Math.PI * 2 * dy) / tall;
      }
    });
    const endDrag = (event) => {
      const wasClick = dragging && !dragging.moved && event.type === "pointerup";
      if (dragging && dragging.moved) labelsNeedLayout = true;
      dragging = null;
      if (wasClick) clickAt(event);
    };
    element.addEventListener("pointerup", endDrag);
    element.addEventListener("pointercancel", endDrag);
    element.addEventListener("wheel", (event) => {
      event.preventDefault();
      view.userZoom = clamp(view.userZoom * (event.deltaY < 0 ? 1.08 : 0.92), 0.5, 3);
    }, { passive: false });
    // A part's name as it would be said: rightAtrium is "the right atrium".
    function spoken(part) {
      const name = part.mark.name;
      if (name) return `the ${name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\s+\d+$/, "").toLowerCase()}`;
      return "this part";
    }
    function flash(part, now) {
      if (part && part.material) part.highlightStart = now;
    }
    // Clicking a label or a part asks about it.
    function clickAt(event) {
      const bounds = canvas.getBoundingClientRect();
      const x = ((event.clientX - bounds.left) * widthPx) / bounds.width, y = ((event.clientY - bounds.top) * heightPx) / bounds.height;
      const now = performance.now() / 1000;
      for (const label of labels) {
        if (!label.box || !labelShown(label)) continue;
        const point = projectOnCanvas(anchorOf(label));
        const inWords = x >= label.box.x - 4 && x <= label.box.x + label.box.width + 4 && y >= label.box.y - 4 && y <= label.box.y + label.box.height + 4;
        if (inWords || Math.hypot(point.x - x, point.y - y) < 9) {
          flash(label.part, now);
          if (host.ask) host.ask(`What's this? (I just clicked the ${label.mark.text} on the 3D model you drew.)`);
          return;
        }
      }
      if (!passes) return;
      const pixelRatio = renderer.getPixelRatio();
      const mesh = passes.meshAt(x * pixelRatio, y * pixelRatio);
      if (!mesh) return;
      const part = [...parts.values()].find((entry) => entry.meshes.includes(mesh));
      if (!part) return;
      flash(part, now);
      if (host.ask) host.ask(`What's this? (I just clicked ${spoken(part)} on the 3D model you drew.)`);
    }

    // ---- keeping it smooth on a weak GPU: trade sharpness and shadow updates for frame rate
    function adjustQuality(now) {
      const elapsed = now - lastFrameReport;
      if (elapsed < QUALITY_CHECK_SECONDS) return;
      const frameMs = (elapsed * 1000) / renderedFrames;
      const level = QUALITY_LEVELS[qualityLevel];
      console.info(`3D: ${frameMs.toFixed(1)} ms per frame (${(renderMilliseconds / renderedFrames).toFixed(1)} ms to submit), ${drawCalls} draw calls, pixel ratio ${level.pixelRatio}`);
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
      if (passes) passes.resize();
    }

    function updateHighlight(part, now) {
      const material = part.material;
      if (!part.restEmissive) part.restEmissive = { color: material.emissive.clone(), intensity: material.emissiveIntensity };
      const age = now - part.highlightStart;
      material.emissive.copy(part.restEmissive.color);
      material.emissiveIntensity = part.restEmissive.intensity;
      if (age < 0 || age > HIGHLIGHT_SECONDS) { part.highlightStart = undefined; part.restEmissive = null; return; }
      const strength = Math.sin((Math.PI * age) / HIGHLIGHT_SECONDS);
      material.emissive.multiplyScalar(material.emissiveIntensity).add(scratchColor.copy(material.color).multiplyScalar(0.42).addScalar(0.1).multiplyScalar(strength));
      material.emissiveIntensity = 1;
    }
    const scratchColor = new THREE.Color();

    // ---- the frame
    function update(now) {
      if (disposed) return;
      lastTime = now;
      for (const part of parts.values()) {
        updatePart(part, now);
        if (part.highlightStart !== undefined) updateHighlight(part, now);
      }
      updateCamera(now);
      const renderStart = performance.now();
      if (passes) passes.prepare(view.objectRadius * OCCLUSION_REACH);
      renderer.render(scene, camera);
      drawCalls = renderer.info.render.calls;
      if (passes) passes.ink();
      renderMilliseconds += performance.now() - renderStart;
      renderedFrames++;
      updateLabels(now);
      adjustQuality(now);
    }

    return {
      mark,
      element,
      rect: () => {
        const r = element.getBoundingClientRect();
        return [r.left, r.top, r.width, r.height];
      },
      // Where its card has been dragged or zoomed to: canvas pixels, and a scale about the origin.
      setCardTransform(dx, dy, k, tx, ty) {
        cardScale = k;
        element.style.transformOrigin = "0 0";
        element.style.transform = `translate(${k * (outer.x + dx) + tx - outer.x}px, ${k * (outer.y + dy) + ty - outer.y}px) scale(${k})`;
        cardTransform = `translate(${tx} ${ty}) scale(${k}) translate(${dx} ${dy})`;
        for (const label of labels) label.group.setAttribute("transform", cardTransform);
      },
      // Out of sight while another card is shown big.
      setHidden(hidden) {
        element.style.opacity = hidden ? "0" : "";
        for (const label of labels) label.group.style.display = hidden ? "none" : "";
        labelsHidden = hidden;
      },
      // Keeps the picture sharp while the card is shown bigger.
      setSharpness(k) {
        renderer.setPixelRatio(Math.min(3, Math.min(window.devicePixelRatio || 1, QUALITY_LEVELS[qualityLevel].pixelRatio) * Math.max(1, k)));
        renderer.setSize(widthPx, heightPx, false);
        canvas.style.width = `${widthPx}px`;
        canvas.style.height = `${heightPx}px`;
        if (passes) passes.resize();
        key.shadow.needsUpdate = true;
      },
      addPart,
      addLabel,
      motion,
      camera(mark) {
        const now = performance.now() / 1000;
        if (mark.tilt !== undefined) {
          view.tilt = mark.tilt;
          view.phiDelta = Math.PI / 2 - mark.tilt * DEG - view.phi;
          needsRefit = true;
        }
        if (mark.zoom !== undefined) { view.zoom = clamp(mark.zoom, 0.5, 3); needsRefit = true; }
        if (mark.fov !== undefined) { camera.fov = mark.fov; needsRefit = true; }
        if (mark.spin !== undefined) view.spin = mark.spin;
        if (mark.turn !== undefined) {
          view.viewYaw = view.restingYaw = (REST_YAW_DEGREES + mark.turn) * DEG;
          view.hasRestingView = true;
          swingToFront(now, view.viewYaw, 1.4, 0.6, 2);
          needsRefit = true;
        }
        if (mark.spin) {
          view.heldSince = null;
          view.turnRestartedAt = now;
          view.begunRestingSwing = false;
        }
      },
      // A new question is being answered: stop turning and face front.
      holdStill() {
        if (view.heldSince !== null) return;
        const now = performance.now() / 1000;
        view.heldSince = now;
        if (!view.tookControl && view.spin !== 0) swingToFront(now, view.viewYaw, 1.6, 0.35, 1);
      },
      ticksRunning(running) { lesson3dTicks.running = !!running; },
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
        needsRefit = true;
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
