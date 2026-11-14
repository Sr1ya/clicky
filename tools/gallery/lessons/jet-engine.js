```js
step(1);
say("A jet engine sucks air in, squeezes it, burns it, and blasts it out the back.");
const f = figure(60, 120, 900, 470, {title: "Turbofan jet engine", tilt: 14, turn: 20});
const nacelle = f.lathe({profile: [[1.55, -3.2], [1.7, -2.8], [1.72, -1], [1.6, 0.8], [1.35, 2.2]], axis: "x", mat: "paint:#C9CDD2", thick: 0.06, cut: true});
const core = f.lathe({profile: [[0.95, -1.9], [1.0, -1.2], [1.0, 0.8], [0.85, 2.4], [0.6, 3.4]], axis: "x", mat: "steel", thick: 0.05, cut: true});
const lip = f.torus({r: 1.62, tube: 0.1, rot: [0, 0, 90], at: [-3.2, 0, 0], mat: "alu"});
const rotor = f.group({});
const shaft = f.cyl({r: 0.08, h: 6, axis: "x", at: [0.1, 0, 0], parent: rotor, mat: "chrome", bevel: 0.01});
f.label(nacelle, "Nacelle");

step(2);
say("Up front, a giant fan of 24 blades pulls in huge amounts of air.");
const spinner = f.cone({r: 0.4, h: 0.7, axis: "-x", at: [-3.05, 0, 0], parent: rotor, mat: "chrome"});
const fanHub = f.cyl({r: 0.42, h: 0.3, axis: "x", at: [-2.6, 0, 0], parent: rotor, mat: "titanium", bevel: 0.02});
const fanBlades = f.box({size: [0.22, 1.15, 0.04], at: [-2.6, 1.0, 0], rot: [30, 0, 0], around: {count: 24, axis: "x", center: [-2.6, 0, 0]}, parent: rotor, mat: "titanium", bevel: 0.01});
const outletVanes = f.box({size: [0.12, 0.6, 0.03], at: [-1.9, 1.3, 0], rot: [-15, 0, 0], around: {count: 30, axis: "x", center: [-1.9, 0, 0]}, mat: "alu"});
f.label(fanBlades, "Fan");

step(3);
say("Most of that air bypasses the core, giving most of the thrust, quietly.");
const bypassFlow = f.arrow([[-3.8, 1.3, 0.05], [-1.5, 1.3, 0.05], [1.5, 1.2, 0.05], [3, 1.1, 0.05]], {r: 0.04, mat: "paint:#4D87AB"});
const coreFlow = f.arrow([[-3.8, 0.5, 0.05], [-2, 0.55, 0.05], [-1.6, 0.6, 0.05]], {r: 0.035, mat: "paint:#4D87AB"});

step(4);
say("The rest goes through compressor stages that squeeze it about 40 times tighter.");
for (let i = 0; i < 7; i++) {
  const x = -1.6 + i * 0.22, rr = 0.85 - i * 0.05;
  const disc = f.cyl({r: rr * 0.5, h: 0.06, axis: "x", at: [x, 0, 0], parent: rotor, mat: "steel", bevel: 0.01});
  const blades = f.box({size: [0.07, rr * 0.45, 0.03], at: [x, rr * 0.72, 0], rot: [25, 0, 0], around: {count: 20, axis: "x", center: [x, 0, 0]}, parent: rotor, mat: "titanium", bevel: 0.005});
  const vanes = f.box({size: [0.05, rr * 0.4, 0.025], at: [x + 0.11, rr * 0.75, 0], rot: [-20, 0, 0], around: {count: 20, axis: "x", center: [x + 0.11, 0, 0]}, mat: "steel"});
  if (i === 0) f.label(blades, "Compressor");
}

step(5);
say("Fuel sprays in and burns at around 1,500 degrees Celsius in the combustor.");
const combustor = f.torus({r: 0.55, tube: 0.16, rot: [0, 0, 90], at: [0.1, 0, 0], mat: "metal:#8A7A66", scale: [1, 2, 1]});
const fuelRing = f.torus({r: 0.72, tube: 0.03, rot: [0, 0, 90], at: [-0.2, 0, 0], mat: "copper"});
const injectors = f.cyl({r: 0.025, h: 0.2, axis: "x", at: [-0.1, 0.62, 0], around: {count: 16, axis: "x", center: [-0.1, 0, 0]}, mat: "brass"});
const flames = f.cone({r: 0.07, h: 0.4, axis: "x", at: [0.15, 0.55, 0], around: {count: 16, axis: "x", center: [0.15, 0, 0]}, mat: "glow:#EE9A43"});
f.label(combustor, "Combustor");
flames.pulse({amount: 0.15, period: 0.3});

step(6);
say("Hot gas spins turbines, which turn the shaft that drives the fan and compressor.");
for (let i = 0; i < 4; i++) {
  const x = 0.7 + i * 0.3, rr = 0.55 + i * 0.05;
  const tdisc = f.cyl({r: rr * 0.5, h: 0.08, axis: "x", at: [x, 0, 0], parent: rotor, mat: "steel", bevel: 0.01});
  const tblades = f.box({size: [0.1, rr * 0.45, 0.03], at: [x, rr * 0.75, 0], rot: [-30, 0, 0], around: {count: 22, axis: "x", center: [x, 0, 0]}, parent: rotor, mat: "metal:#877459", bevel: 0.006});
  if (i === 0) f.label(tblades, "Turbine");
}
const hotFlow = f.arrow([[0.2, 0.4, 0.05], [1.5, 0.45, 0.05], [3.0, 0.3, 0.05], [3.9, 0.2, 0.05]], {r: 0.04, mat: "paint:#BE743F"});
const tailCone = f.cone({r: 0.35, h: 1.1, axis: "x", at: [2.6, 0, 0], mat: "iron"});
rotor.spin({axis: "x", period: 0.6});

step(7);
say("Air pushed backward hard pushes the plane forward, that's Newton's third law.");
f.view({turn: 60, tilt: 20});

step(8);
say("So: suck, squeeze, bang, blow, all happening continuously at once.");
button(80, 640, "Why the bypass air?", {ask: "Why do modern jet engines send most air around the core?"});
button(320, 640, "Jet vs propeller", {ask: "How is a turbofan different from a turboprop engine?"});
lessonTitle("How A Jet Engine Works");
```