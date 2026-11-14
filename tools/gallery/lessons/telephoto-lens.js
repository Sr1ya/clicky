```js
step(1);
clear();
say("A telephoto lens, like the long one in this photo, makes faraway things look big.");
seen("Reading about a Nikon super-telephoto lens with a photo");
point(560, 410, "Telephoto lens");
const f = figure(620, 160, 600, 440, {title: "Telephoto lens cutaway", tilt: 14, turn: 20, spin: 0.5});
const barrel = f.tube({r: 0.9, inner: 0.84, h: 5.6, axis: "x", mat: "matte:#1E1E1E", bevel: 0.03, thick: 0.06, cut: true});
const hood = f.tube({r: 1.15, inner: 1.08, h: 1.4, axis: "x", at: [-3.5, 0, 0], mat: "matte:#151515", bevel: 0.03, cut: true});
const goldRing = f.tube({r: 0.93, inner: 0.88, h: 0.06, axis: "x", at: [-1.6, 0, 0], mat: "gold", cut: true});
const rearBarrel = f.tube({r: 0.6, inner: 0.54, h: 1.3, axis: "x", at: [3.4, 0, 0], mat: "matte:#222222", bevel: 0.02, cut: true});
const mount = f.tube({r: 0.5, inner: 0.42, h: 0.12, axis: "x", at: [4.1, 0, 0], mat: "chrome", bevel: 0.01, cut: true});
const grips = f.tube({r: 0.94, inner: 0.9, h: 0.05, axis: "x", at: [0.4, 0, 0], copies: {count: 10, step: [0.08, 0, 0]}, mat: "rubber", cut: true});
const switches = f.box({size: [0.12, 0.06, 0.08], at: [1.6, 0.4, -0.85], copies: {count: 3, step: [0.2, 0, 0]}, mat: "black", bevel: 0.01});
const tripodFoot = f.box({size: [0.8, 0.5, 0.3], at: [1.2, -1.1, -0.3], mat: "matte:#1E1E1E", bevel: 0.04});
f.label(barrel, "Barrel");

step(2);
say("Up front, large glass elements gather light and bend it inward, toward the middle.");
const frontLens = f.sphere({r: 0.82, at: [-2.7, 0, 0], scale: [0.22, 1, 1], mat: "glass"});
const frontLens2 = f.sphere({r: 0.78, at: [-2.3, 0, 0], scale: [0.18, 1, 1], mat: "glass"});
const holders = f.tube({r: 0.84, inner: 0.76, h: 0.08, axis: "x", at: [-2.7, 0, 0], copies: {count: 3, step: [0.35, 0, 0]}, mat: "alu", cut: true});
const rayTop = f.arrow([[-4.6, 0.65, 0.05], [-2.7, 0.65, 0.05], [0.6, 0.28, 0.05]], {r: 0.03, mat: "paint:#D9B24A"});
const rayBot = f.arrow([[-4.6, -0.65, 0.05], [-2.7, -0.65, 0.05], [0.6, -0.28, 0.05]], {r: 0.03, mat: "paint:#D9B24A"});
f.label(frontLens, "Front group");

step(3);
say("The ridged Phase Fresnel element bends light like thick glass, but weighs far less.");
underline(152, 702, 380);
const pfElement = f.cyl({r: 0.76, h: 0.06, axis: "x", at: [-1.95, 0, 0], mat: "glass"});
const pfRidges = f.torus({r: 0.15, tube: 0.008, rot: [0, 0, 90], at: [-1.95, 0, 0], copies: {count: 5, step: [0, 0, 0]}, scale: [1, 1, 1], mat: "metal:#7FA8C8"});
const pfOuter = f.torus({r: 0.45, tube: 0.008, rot: [0, 0, 90], at: [-1.95, 0, 0], copies: {count: 3, step: [0, 0, 0]}, mat: "metal:#7FA8C8"});
f.label(pfElement, "PF element");

step(4);
say("Then a spreading group behind bends the rays back out, so focus lands far behind.");
const rearGroup = f.sphere({r: 0.4, at: [1.2, 0, 0], scale: [0.15, 1, 1], mat: "glass"});
const rearGroup2 = f.sphere({r: 0.38, at: [1.5, 0, 0], scale: [0.15, 1, 1], mat: "glass"});
const rayTop2 = f.arrow([[0.6, 0.28, 0.05], [1.4, 0.24, 0.05], [4.5, 0, 0.05]], {r: 0.03, mat: "paint:#D9B24A"});
const rayBot2 = f.arrow([[0.6, -0.28, 0.05], [1.4, -0.24, 0.05], [4.5, 0, 0.05]], {r: 0.03, mat: "paint:#D9B24A"});
const sensor = f.box({size: [0.04, 0.5, 0.7], at: [4.6, 0, 0], mat: "metal:#3A5A7A", bevel: 0.01});
f.label(rearGroup, "Spreading group");

step(5);
say("Inside, a focus group slides back and forth, and a VR group shifts to cancel shake.");
const focusGroup = f.sphere({r: 0.55, at: [-0.4, 0, 0], scale: [0.18, 1, 1], mat: "glass"});
const focusRing = f.tube({r: 0.6, inner: 0.55, h: 0.1, axis: "x", at: [-0.4, 0, 0], mat: "alu"});
const vrGroup = f.sphere({r: 0.42, at: [0.5, 0, 0], scale: [0.15, 1, 1], mat: "glass"});
const vrMagnets = f.box({size: [0.1, 0.12, 0.12], at: [0.5, 0.52, 0], around: {count: 4, axis: "x", center: [0.5, 0, 0]}, mat: "copper", bevel: 0.01});
const aperture = f.box({size: [0.02, 0.35, 0.15], at: [0.9, 0.42, 0], rot: [30, 0, 0], around: {count: 9, axis: "x", center: [0.9, 0, 0]}, mat: "black"});
f.tick((t) => {
  const x = -0.4 + 0.25 * sin(t * 1.2);
  focusGroup.pos = [x, 0, 0];
  focusRing.pos = [x, 0, 0];
  vrGroup.pos = [0.5, 0.04 * sin(t * 9), 0];
  f.readout({Focus: x > -0.4 ? "near" : "far", VR: "up to 5 stops"});
});

step(6);
say("Your page says this VR cancels shake up to 5 stops, which makes handheld shooting possible.");
underline(152, 108, 960);
f.view({turn: 70, tilt: 22});

step(7);
say("So the glass gathers, the rear group stretches, and the barrel stays shorter than its focal length.");
button(640, 660, "Telephoto vs zoom", {ask: "What's the difference between a telephoto lens and a zoom lens?"});
button(870, 660, "How PF works", {ask: "How does a Phase Fresnel lens element work?"});
lessonTitle("How A Telephoto Lens Works");
```