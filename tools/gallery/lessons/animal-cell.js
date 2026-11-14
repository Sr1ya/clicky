```js
step(1);
say("An animal cell is a soft bag of jelly packed with tiny working parts.");
const f = figure(120, 90, 760, 500, {title: "Inside an animal cell", tilt: 25, turn: 20});
const membrane = f.blob({balls: [[0, 0, 0, 2.2], [0.6, 0.3, 0.2, 1.8], [-0.7, -0.2, -0.1, 1.8]], blend: 0.4, mat: "soft:#D9A7A0", thick: 0.06, cut: true});
const cytoplasm = f.sphere({r: 2.0, scale: [1.15, 0.85, 1], mat: "water", cut: true});
f.label(membrane, "Cell membrane");

step(2);
say("In the middle sits the nucleus, which holds the DNA, the cell's instructions.");
const nucleus = f.sphere({r: 0.75, at: [0, 0, -0.2], mat: "soft:#6B4E8A", thick: 0.05, cut: true});
const nucleolus = f.sphere({r: 0.28, at: [0.1, 0.05, -0.25], mat: "soft:#3E2A5C"});
const pores = f.sphere({r: 0.04, at: [0, 0.76, -0.2], around: {count: 14, axis: "z", center: [0, 0, -0.2]}, mat: "soft:#4A3568"});
const chromatin = f.pipe({points: [[-0.4, 0.2, -0.3], [-0.1, 0.4, -0.4], [0.3, 0.2, -0.3], [0.4, -0.3, -0.4], [-0.2, -0.4, -0.3]], r: 0.025, mat: "soft:#B18BC9"});
f.label(nucleus, "Nucleus");

step(3);
say("Wrapped around it, the rough ER is studded with ribosomes that build proteins.");
for (let i = 0; i < 5; i++) {
  const er = f.torus({r: 0.95 + i * 0.13, tube: 0.035, rot: [90, 0, 0], at: [0, 0, -0.2], scale: [1, 1, 0.8], mat: "soft:#4F7FA8", cut: true});
  if (i === 0) f.label(er, "Rough ER");
}
const ribosomes = f.sphere({r: 0.03, at: [1.3, 0, -0.2], around: {count: 40, axis: "z", center: [0, 0, -0.2]}, mat: "soft:#2E3C5A"});
const freeRibo = f.sphere({r: 0.03, at: [-1.5, 0.6, -0.4], copies: {count: 12, step: [0.2, -0.1, 0.05]}, mat: "soft:#2E3C5A"});

step(4);
say("Mitochondria burn sugar to make ATP, the energy every part runs on.");
const mitoPos = [[1.6, 0.6, -0.5], [-1.7, -0.5, -0.4], [0.9, -1.0, -0.6], [-1.0, 0.9, -0.7]];
for (let i = 0; i < 4; i++) {
  const mito = f.capsule({r: 0.18, h: 0.5, at: mitoPos[i], rot: [0, 0, 40 + i * 50], mat: "soft:#C0603A"});
  const cristae = f.box({size: [0.02, 0.28, 0.2], at: mitoPos[i], rot: [0, 0, 40 + i * 50], mat: "soft:#E3A06B"});
  if (i === 0) f.label(mito, "Mitochondria");
}

step(5);
say("The Golgi stacks fold and package those proteins, then ship them in little bubbles.");
const golgi = f.torus({r: 0.4, tube: 0.05, at: [0.4, -1.2, -0.3], rot: [70, 0, 0], arc: 180, copies: {count: 5, step: [0, -0.1, 0]}, mat: "soft:#D9B24A"});
const vesicles = f.sphere({r: 0.07, at: [0.9, -1.1, -0.2], copies: {count: 6, step: [0.15, 0.12, 0.05]}, mat: "soft:#E8C875"});
const lysosomes = f.sphere({r: 0.12, at: [-1.2, -1.0, -0.3], copies: {count: 3, step: [0.35, 0.2, -0.1]}, mat: "soft:#7A9A4A"});
const centrioles = f.cyl({r: 0.06, h: 0.25, at: [-0.9, 0.2, -0.5], copies: {count: 2, step: [0.15, 0.1, 0]}, rot: [0, 0, 90], mat: "soft:#8A6B4E"});
f.label(golgi, "Golgi");
vesicles.bob({amount: 0.08, period: 2});

step(6);
say("A typical cell is only about 20 micrometres wide, yet holds all this machinery.");
nucleus.pulse({amount: 0.03, period: 3});
f.view({turn: 60, tilt: 35});

step(7);
say("So the nucleus gives orders, and everything around it builds, packs and powers.");
button(140, 650, "Plant vs animal cell", {ask: "How is a plant cell different from an animal cell?"});
button(380, 650, "How mitochondria work", {ask: "Show me how mitochondria make energy in 3D."});
lessonTitle("Inside An Animal Cell");
```