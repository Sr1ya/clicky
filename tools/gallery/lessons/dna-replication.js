```js
step(1);
say("DNA copies itself by unzipping into two strands, and each one becomes a template.");
const f = figure(380, 90, 680, 500, {title: "DNA replication", tilt: 12, spin: 0.6});
const parent = f.group({at: [0, 1.6, 0]});
for (let i = 0; i < 14; i++) {
  const y = i * 0.32, a = i * 36 * PI / 180;
  const bb1 = f.sphere({r: 0.12, at: [cos(a) * 0.9, y, sin(a) * 0.9], parent, mat: "gloss:#2F6FB0"});
  const bb2 = f.sphere({r: 0.12, at: [-cos(a) * 0.9, y, -sin(a) * 0.9], parent, mat: "gloss:#C8453A"});
  const rung = f.cyl({r: 0.05, from: [cos(a) * 0.85, y, sin(a) * 0.85], to: [-cos(a) * 0.85, y, -sin(a) * 0.85], parent, mat: i % 2 ? "paint:#E0B43A" : "paint:#4FA36B"});
  if (i === 6) f.label(rung, "Base pairs");
}

step(2);
say("Down here the helix is still whole: two backbones held by paired bases.");
const spine1 = f.spring({r: 0.9, h: 4.2, turns: 1.3, wire: 0.05, at: [0, 3.7, 0], mat: "matte:#2F6FB0"});
f.label(spine1, "Parent helix");

step(3);
say("An enzyme called helicase sits at the fork and pulls the strands apart.");
const helicase = f.torus({r: 0.55, tube: 0.25, at: [0, 1.3, 0], mat: "soft:#8E5BA8"});
helicase.spin({axis: "y", period: 1.5});
f.label(helicase, "Helicase");

step(4);
say("The opened strands split left and right, exposing their bases.");
const left = f.pipe({points: [[0.3, 1.2, 0], [1.2, 0, 0], [2, -1.6, 0], [2.4, -3, 0]], r: 0.1, mat: "gloss:#2F6FB0"});
const right = f.pipe({points: [[-0.3, 1.2, 0], [-1.2, 0, 0], [-2, -1.6, 0], [-2.4, -3, 0]], r: 0.1, mat: "gloss:#C8453A"});
const baseL = f.cyl({r: 0.04, h: 0.35, axis: "x", at: [1.3, -0.3, 0], copies: {count: 7, step: [0.16, -0.4, 0]}, mat: "paint:#E0B43A"});
const baseR = f.cyl({r: 0.04, h: 0.35, axis: "x", at: [-1.3, -0.3, 0], copies: {count: 7, step: [-0.16, -0.4, 0]}, mat: "paint:#4FA36B"});

step(5);
say("DNA polymerase walks along each one, adding matching bases: A with T, G with C.");
const polL = f.sphere({r: 0.32, at: [1.8, -1.2, 0], mat: "soft:#3E9C8F"});
const polR = f.sphere({r: 0.32, at: [-1.8, -1.2, 0], mat: "soft:#3E9C8F"});
const newL = f.pipe({points: [[1.0, -0.6, 0.3], [1.6, -1.8, 0.3], [2.0, -3, 0.3]], r: 0.09, mat: "gloss:#F2E6C8"});
const newR = f.pipe({points: [[-1.0, -0.6, 0.3], [-1.6, -1.8, 0.3], [-2.0, -3, 0.3]], r: 0.09, mat: "gloss:#F2E6C8"});
f.label(polL, "Polymerase");
f.label(newL, "New strand");
f.tick((t) => { const s = (t * 0.25) % 1; polL.pos = [1.2 + s, -0.4 - s * 2.4, 0]; polR.pos = [-1.2 - s, -0.4 - s * 2.4, 0]; });

step(6);
say("It's fast: about 50 bases a second in humans, with roughly one error per billion.");

step(7);
say("So each new DNA keeps one old strand and one new one, a semi-conservative copy.");
button(380, 640, "Why the lagging strand?", {ask: "Why is one DNA strand copied in short Okazaki fragments?"});
button(640, 640, "How errors are fixed", {ask: "How does DNA polymerase proofread and fix copying mistakes?"});
lessonTitle("How DNA Copies Itself");
```