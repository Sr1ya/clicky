```js
step(1);
say("A V8 is 8 cylinders in two banks of 4, set in a V around one crankshaft.");
const f = figure(300, 90, 700, 470, {title: "V8 engine cutaway", tilt: 18, turn: 30, spin: 0.6});
const block = f.box({size: [4.6, 1.4, 1.8], at: [0, -0.3, 0], mat: "iron", bevel: 0.05, thick: 0.08, cut: true});
const sump = f.box({size: [4.4, 0.6, 1.5], at: [0, -1.3, 0], mat: "paint:#2B2B2E", bevel: 0.06, thick: 0.05, cut: true});
const sumpBolts = f.cyl({r: 0.03, h: 0.08, at: [-2.1, -1.0, -0.72], copies: {count: 12, step: [0.38, 0, 0]}, mat: "steel"});
const bores = [];
for (let b = 0; b < 2; b++) {
  const s = b ? 1 : -1;
  const bank = f.box({size: [4.4, 1.5, 1.1], at: [0, 1.0, s * 0.75], rot: [s * 45, 0, 0], mat: "alu", bevel: 0.04, thick: 0.06, cut: true});
  const head = f.box({size: [4.4, 0.45, 1.2], at: [0, 1.75, s * 1.5], rot: [s * 45, 0, 0], mat: "alu", bevel: 0.05, cut: true});
  const cover = f.box({size: [4.3, 0.25, 0.9], at: [0, 2.05, s * 1.8], rot: [s * 45, 0, 0], mat: "paint:#A3221E", bevel: 0.08});
  if (b === 0) { f.label(bank, "Cylinder bank"); f.label(cover, "Valve cover"); }
}

step(2);
say("Inside each cylinder a piston slides up and down, sealed by thin rings.");
const pistons = [], rods = [], plugs = [];
for (let i = 0; i < 8; i++) {
  const s = i % 2 ? 1 : -1, x = -1.65 + floor(i / 2) * 1.1 + (s > 0 ? 0.12 : -0.12);
  const p = f.cyl({r: 0.36, h: 0.45, at: [x, 1, s * 0.7], rot: [s * 45, 0, 0], mat: "alu", bevel: 0.03});
  const rings = f.torus({r: 0.36, tube: 0.02, at: [0, 0.12, 0], parent: p, copies: {count: 3, step: [0, -0.07, 0]}, mat: "steel"});
  const rod = f.box({size: [0.12, 1.1, 0.08], at: [x, 0.2, s * 0.35], rot: [s * 45, 0, 0], mat: "steel", bevel: 0.02});
  const plug = f.cyl({r: 0.06, h: 0.4, at: [x, 2.0, s * 1.75], rot: [s * 45, 0, 0], mat: "ceramic"});
  pistons.push([p, s, x]); rods.push(rod); plugs.push(plug);
  if (i === 0) { f.label(p, "Piston"); f.label(rod, "Con rod"); }
}

step(3);
say("Connecting rods turn their up and down push into the crankshaft's spin.");
const crank = f.group({at: [0, -0.5, 0]});
const crankShaft = f.cyl({r: 0.14, h: 5, axis: "x", parent: crank, mat: "steel", bevel: 0.02});
const throws = f.box({size: [0.15, 0.6, 0.35], at: [-1.65, 0.2, 0], copies: {count: 4, step: [1.1, 0, 0]}, parent: crank, mat: "steel", bevel: 0.03});
const pulley = f.cyl({r: 0.5, h: 0.2, axis: "x", at: [2.7, -0.5, 0], mat: "black", bevel: 0.03});
const flywheel = f.gear({r: 0.9, teeth: 60, h: 0.12, at: [-2.6, -0.5, 0], rot: [0, 90, 0], mat: "steel"});
f.label(crankShaft, "Crankshaft");

step(4);
say("Each cylinder runs four strokes: suck, squeeze, bang, blow, with sparks lighting the fuel.");
const cam = f.cyl({r: 0.1, h: 4.6, axis: "x", at: [0, 0.4, 0], mat: "chrome"});
const intake = f.box({size: [0.25, 0.25, 0.8], at: [-1.65, 1.9, 0], copies: {count: 4, step: [1.1, 0, 0]}, mat: "alu", bevel: 0.05});
const plenum = f.box({size: [4, 0.4, 0.7], at: [0, 2.3, 0], mat: "paint:#555", bevel: 0.1});
const exhaust = f.pipe({points: [[-2, 1.4, -2.0], [0, 1.2, -2.2], [2.2, 0.6, -2.2], [2.6, -0.8, -2]], r: 0.15, mat: "steel"});
f.tick((t) => {
  const a = t * 4;
  crank.rot = [-a * 180 / PI, 0, 0];
  pistons.forEach(([p, s, x], i) => {
    const ph = a + i * PI / 4, d = 0.35 * cos(ph);
    p.pos = [x, 1 + d * 0.7, s * (0.7 + d * 0.7)];
    plugs[i].glow = cos(ph) > 0.95 ? 1 : 0;
  });
  f.readout({RPM: 2000, Firing: "every 90 degrees"});
});

step(5);
say("With 8 cylinders, one fires every 90 degrees, so power flows smoothly.");
say("A typical V8 is about 5 litres and makes 400 horsepower or more.");

step(6);
say("The V shape keeps 8 cylinders short and compact enough to fit under a hood.");
say("So, many small explosions push pistons, and the crank turns them into wheel spin.");
button(320, 640, "Why the rumble?", {ask: "Why does a V8 have that distinctive rumbling sound?"});
button(560, 640, "Flat vs cross plane?", {ask: "What's the difference between a flat-plane and cross-plane V8 crankshaft?"});
lessonTitle("How A V8 Engine Works");
```