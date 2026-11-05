```js
step(1);
say("A piston turns small explosions of fuel into spinning motion.");
const f = figure(40, 90, 640, 500, {title: "One cylinder", tilt: 14, spin: 0.5});
const block = f.tube({r: 0.62, inner: 0.5, h: 2.6, at: [0, 1.1, 0], mat: "iron", cut: true});
const crank = f.group({at: [0, -0.8, 0]});
const shaft = f.cyl({r: 0.12, h: 1.4, axis: "z", parent: crank, mat: "steel", bevel: 0.02});
const web = f.box({size: [0.3, 0.7, 0.14], at: [0, 0.2, 0.2], parent: crank, mirror: "z", mat: "iron", bevel: 0.03});
f.label(block, "Cylinder");

step(2);
say("Burning fuel pushes this piston down, and the rod turns the crankshaft.");
const piston = f.cyl({r: 0.49, h: 0.5, mat: "alu", bevel: 0.03});
const rings = f.tube({r: 0.495, inner: 0.47, h: 0.03, at: [0, 0.14, 0], parent: piston, copies: {count: 3, step: [0, -0.07, 0]}, mat: "steel"});
const rod = f.cyl({r: 0.07, h: 1.5, mat: "steel"});
const spark = f.sphere({r: 0.12, at: [0, 2.3, 0], mat: "glow:#EE9A43"});
f.label(piston, "Piston");
f.label(shaft, "Crankshaft");
f.tick((t) => {
  const a = t * 2;
  const pinX = 0.4 * sin(a), pinY = 0.4 * cos(a) - 0.8;
  const top = pinY + sqrt(1.5 * 1.5 - pinX * pinX);
  piston.pos = [0, top, 0];
  crank.rot = [0, 0, -a * 180 / PI];
  rod.pos = [pinX / 2, (pinY + top) / 2, 0];
  rod.rot = [0, 0, atan2(pinX, top - pinY) * 180 / PI];
  spark.show = cos(a) > 0.96;
  f.readout({RPM: 1200});
});

step(3);
say("Heavy parts keep it spinning between explosions, so the motion stays smooth.");
const flywheel = f.cyl({r: 0.9, h: 0.16, axis: "z", at: [0, 0, 0.9], parent: crank, mat: "steel", bevel: 0.03});
const bolts = f.cyl({r: 0.04, h: 0.2, axis: "z", at: [0.6, 0, 0.9], parent: crank, around: {count: 8, axis: "z", center: [0, 0, 0.9]}, mat: "black"});
f.label(flywheel, "Flywheel");
f.view({turn: 40, zoom: 1.2});
button(60, 640, "Why 4 strokes?", {ask: "Why do most engines use four strokes?"});
button(260, 640, "Show the valves", {ask: "Add the valves to this model and show when they open."});
lessonTitle("How A Piston Works");
```
