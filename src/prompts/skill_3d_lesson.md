
# Drawing in 3D

`const f = figure(x, y, w, h, {title, tilt, spin, turn, zoom})` stands a 3D stage in that rectangle. Over the bare screen its window stands around that rectangle, with a title bar and padding (52 above, 24 on the other sides), so leave that room. Give it room: at least 450 x 400, and bigger is better (a figure around 640 x 480 is normal). The object is framed automatically, and labels go in the margins beside it. It lights itself like a studio photo and turns slowly on its own. `tilt` is degrees of looking down (about 15 for a machine, 45 to 55 for a board or a map). `spin` runs from 0.5 to 2. Over busy screen content the figure stands on a card by itself, and over calm space it floats.

**Copy the real thing as faithfully as you can, and build a lot of it.** Every visible part in its place, with its real proportions, shape, colour and material, down to the small details: the bolts, the labels, the vents, the pins. A 3D answer is judged by how much real detail is on screen. A thin model is a failed answer, however good the words are.

**How much to build. These are minimums, not goals:**
- A living thing, an organ, a cell: at least 22 part statements.
- A machine, an engine, a vehicle: at least 30 part statements, and at least 150 pieces on screen once `around`, `copies` and loops are counted.
- A device with an inside, a phone, a circuit board: at least 40 part statements.
- Get there with more parts on each line, not more lines. A lesson is 6 to 9 `say` lines, and each building line brings 3 to 8 parts. Count as you write. If you're near the end and under the minimum, add the next layer of real detail before the last lines.

**Before the first statement, list the real subsystems, then build every one.** What a complete model holds:
- Heart: outer muscle wall, septum, 4 hollow chambers, both venae cavae, pulmonary trunk and its branches, pulmonary veins on both sides, aorta with its arch and 3 branches, 4 valves, coronary arteries on the surface, a flow arrow for each stretch of the route.
- Jet engine: nacelle, core casing, 2 shafts, fan hub and 20+ blades, 5 to 8 compressor stages (disc, rotor ring, stator ring each), combustor with fuel ring, injectors and flames, 2 to 5 turbine stages, nozzle, tail cone, bypass and core flow arrows.
- Car engine: block, heads, crankshaft, rods, pistons with rings, cams, valves, sump, intake and exhaust runners, plugs, belt.
- Brain: both hemispheres with folds, cerebellum, brain stem, corpus callosum, thalamus, hippocampus, vessels.
- Anything else: think what a textbook cutaway of it labels, then add the fasteners and pipes it leaves out.

**One part per statement, named after what it is.** Each appears the moment its line reaches it, and the variable name is how you move it later:
```js
const crankshaft = f.cyl({r: 0.15, h: 4.7, axis: "z", mat: "steel", bevel: 0.02});
```

**Shapes.** Units are yours (the object gets framed anyway), but keep it around 1 to 10 units across so bevels make sense. Most parts stand along y, centred on `at`.
- `f.box({size: [x, y, z], bevel})`
- `f.cyl({r, h, bevel, rTop})`, or `f.cyl({r, from: [..], to: [..]})` between two points
- `f.cone({r, h, top})`
- `f.tube({r, inner, h})` is a hollow cylinder
- `f.sphere({r, dome: true, thick})`
- `f.torus({r, tube})` lies flat with its hole along y
- `f.capsule({r, h})`
- `f.lathe({profile: [[radius, y], ...]})` is any turned shape (a nose cone, a bottle, a chess piece). The profile runs bottom to top and starts at `y` of its first point.
- `f.pipe({points: [[x, y, z], ...], r})` is a smooth hose, wire or blood vessel
- `f.spring({r, h, turns, wire})`
- `f.gear({r, teeth, h, hole})` has its axle along z
- `f.extrude({points: [[x, y], ...], depth, bevel})` or `{d: "M0 0 L..", unit: 0.01}` pushes a flat outline into depth along z (a wing, a bracket, a logo)
- `f.blob({balls: [[x, y, z, r], ...], sticks: [[x1, y1, z1, x2, y2, z2, r, r2], ...], blend: 0.3, thick})` is lumps and sticks melted together: organs, cells, rocks, anything organic
- `f.poly({r, faces: 4|6|8|12|20})` is a gem or crystal
- `f.surface((u, v) => [x, y, z], {segments, rows})` is a curved sheet
- `f.arrow([[x, y, z], ...], {r, mat})` is a flow arrow along a curve (air through an engine, blood through a heart)
- `f.group({at})` is an invisible handle. Give parts `parent: group` so they all move together.

**Placing a part.** Every part takes these:
- `at: [x, y, z]`, relative to its `parent` if it has one
- `rot: [x, y, z]`, in degrees
- `scale: [x, y, z]` or a number
- `axis: "x"|"z"|"-y"|[x, y, z]` makes its long axis point that way
- `parent: part`, so it moves with that part
- `thick: 0.05` gives a sheet a wall and makes a closed shape hollow

**Many of the same thing.** One statement makes a set:
- `mirror: "x"` (or `["x", "z"]`) adds the mirror image across the figure's middle: a plane's other wing, the left and right wheels.
- `copies: {count: 20, step: [0.25, 0, 0]}` is a row: pins, ribs, keys.
- `around: {count: 16, axis: "y", center: [0, 0, 0]}` is a ring: bolts, fan blades, gear teeth. `arc: 180` makes it part of a circle.
- Rows of whole assemblies that change as they go (compressor stages shrinking along a shaft, ribs, vertebrae) are what a short `for` loop is for. Work out the size and position in it, then write each part of the assembly as a statement inside:
```js
for (let i = 0; i < 7; i++) {
  const x = -2.2 + i * 0.3, radius = 0.6 - i * 0.04;
  const disc = f.cyl({r: radius * 0.5, h: 0.1, axis: "x", at: [x, 0, 0], parent: rotor, mat: "steel", bevel: 0.015});
  const blades = f.box({size: [0.1, radius * 0.5, 0.04], at: [x, radius * 0.75, 0], rot: [25, 0, 0], around: {count: 18, axis: "x", center: [x, 0, 0]}, parent: rotor, mat: "titanium", bevel: 0.01});
  const vanes = f.box({size: [0.08, 0.2, 0.03], at: [x + 0.15, radius + 0.08, 0], rot: [-20, 0, 0], around: {count: 18, axis: "x", center: [x + 0.15, 0, 0]}, mat: "steel", bevel: 0.008});
}
```

**Materials, as real stuff:** `mat: "steel"`, `alu`, `titanium`, `chrome`, `brass`, `copper`, `gold`, `iron`, `black`, `rubber`, `glass`, `water`, `wood`, `ceramic`, `paper`, `plastic:#D8CBB2`, `paint:#167548`, `gloss:red`, `matte:#888`, `metal:#AA8855`, `soft:#9E3B35` for anything living, and `glow:#EE9A43` for a flame, an LED or a spark. Colours are what real things look like, so give a hex when it matters. Choose by what the thing is really made of: a mix of materials is what makes a model look real.

**Showing the inside:**
- `cut: true` on a casing slices away the half facing the viewer, through the figure's middle ([0, 0, 0]), and shows a hatched cut face. The slice stays fixed on the model, and the figure rocks gently instead of spinning all the way round. Use it on shells and put the working parts inside, uncut. Machines and bodies almost always want this.
- Give a cut shell a wall with `thick` (`thick: 0.06`) or it reads as a solid hatched slab, and centre it on the figure's middle or the slice misses it.
- **The slice is the plane z = 0, and everything in front of it (z > 0) is gone.** Centre chambers, casings and vessels on z = 0 so the slice opens them. Surface detail on the removed front (arteries on the outside, front bolts, a front panel) isn't there, so put it on the back half (z < 0). A pipe crossing the slice is cut for you. Whole inner parts (valves, rotors, pistons) stay inside their shell and never stick out past it toward the viewer.
- **Parts touch, they don't run through each other.** Two chambers side by side have centres at least the sum of their radii apart. A wall or septum fits in the gap between chambers, not across them. A pipe's first and last points stop on the surface of what it joins, never at its centre. Only a shell may contain other parts, and what's inside it fits inside its inner radius. Before writing a part, check its numbers against what it sits next to.
- **Flow arrows** run down the middle of the space they describe, one per stretch and at most 5, at about z = 0.05 so they show in the open half. Never lay one across another part.
- Model the inside itself: a chamber, duct or cavity is its own hollow shell (`thick` and `cut: true`) set into the cut wall, and vessels and pipes that pass through are cut too. A solid ball placed in a cut body reads as a ball, not a chamber. Hatching means solid material was sliced, so only leave a part solid and cut if it really is solid. Leave uncut only what should be seen whole inside: valves, rotors, pistons, shafts.
- `cut: "x"` cuts a fixed side.
- `glass` also works for a see-through shell.
- Bevel every machined part (`bevel: 0.01` to `0.03`), since a rounded edge catching the light is most of what makes it look real. Living parts use `soft:` in deep, muted real colours (`#9E3B35` muscle, `#3F5F8A` used blood, `#A8352D` fresh blood), never bright toy colours. A flow arrow is thin (`r: 0.035`) and `paint:`, not `glow:`.

**Naming:** A name made inside a `for` loop doesn't exist after it, so label a looped part inside the loop on one pass (`if (i === 0) f.label(blades, "Turbine");`), or label the group it hangs on. `f.label(part, "Piston")` writes a short name in the margin with a thin line to the part. Label at most 5 things, the ones the lesson is about, as they're named aloud, in 1 to 3 words each. More than that and the lines cover the model. `f.label([x, y, z], "Here")` labels a spot.

**Making it move.** This is what makes it a lesson and not a statue.
- `f.move(part, {to: [x, y, z], rot: [x, y, z], secs: 3})` glides a part once, during this line. Use it to lift a part out and show it, or to explode an assembly.
- `part.spin({axis: "x", period: 1.2})`, `part.bob({amount, period})`, `part.orbit({axis, center, period})`, `part.pulse({amount: 0.08, period: 0.8})` (a heartbeat), `part.path(points, {period, once: true})`.
- `part.show = false` hides it on this line, and `part.color = "red"` or `part.glow = 1` lights it up. `part.pos = [...]` and `part.rot = [...]` glide there quickly.
- `f.view({turn: 90, tilt: 30, spin: 0.5})` swings it to another side on this line (`zoom` only goes up to 1.1, since the whole model always fits). A figure turns on its own for about 20 seconds after it is built, then rests facing front, and stays wherever the user drags it. Turning to look at what you're describing is good teaching.
- For a real mechanism, use `f.tick((t, dt) => { ... })`. It runs every frame from this line on, with `t` in seconds. Set `pos`, `rot`, `scale`, `show`, `glow` and `color` of parts with real math so the linkage truly works:
```js
f.tick((t) => {
  const a = t * 2;
  const pinX = 0.4 * sin(a), pinY = 0.4 * cos(a);
  const pistonY = pinY + sqrt(1.5 * 1.5 - pinX * pinX);
  piston.pos = [0, pistonY, 0];
  crank.rot = [0, 0, -a * 180 / PI];
  rod.pos = [pinX / 2, (pinY + pistonY) / 2, 0];
  rod.rot = [0, 0, atan2(pinX, pistonY - pinY) * 180 / PI];
  spark.show = sin(a) > 0.97;
});
```
- `f.readout({Stroke: "Power", RPM: 3000})` inside a tick shows a few live numbers.

**Two models at the right density.** These are the standard to match, not templates. Use your own subject's real parts and numbers.

A living thing, cut open:
```js
step(1);
say("Your eye is a fluid-filled ball that focuses light onto a sheet of nerve cells.");
const f = figure(700, 110, 540, 500, {title: "The human eye", tilt: 8, turn: 25});
const sclera = f.sphere({r: 1.2, mat: "soft:#E6DFD2", thick: 0.07, cut: true});
const choroid = f.sphere({r: 1.12, mat: "soft:#6E2F2B", thick: 0.03, cut: true});
const retina = f.sphere({r: 1.08, mat: "soft:#C9785F", thick: 0.025, cut: true});
const jelly = f.sphere({r: 1.04, mat: "water", cut: true});
f.label(sclera, "Sclera");

step(2);
say("Light enters through the clear cornea, then the pupil, a hole in the iris.");
const cornea = f.sphere({r: 0.62, dome: true, at: [-0.82, 0, 0], rot: [0, 0, 90], mat: "glass", thick: 0.03});
const aqueous = f.sphere({r: 0.5, at: [-0.98, 0, 0], scale: [0.35, 1, 1], mat: "water"});
const iris = f.tube({r: 0.62, inner: 0.2, h: 0.04, axis: "x", at: [-0.82, 0, 0], mat: "soft:#3F6B7A", bevel: 0.01, cut: true});
const irisFibres = f.box({size: [0.012, 0.36, 0.012], at: [-0.8, 0.4, 0], around: {count: 40, axis: "x", center: [-0.8, 0, 0]}, mat: "soft:#6F97A3"});
const lightIn = f.arrow([[-2.3, 0.3, 0.05], [-1.2, 0.2, 0.05], [-0.7, 0.14, 0.05]], {r: 0.02, mat: "paint:#D9B24A"});
f.label(cornea, "Cornea");
f.label(iris, "Iris");

step(3);
say("Behind it the lens bends that light, pulled into shape by tiny fibres.");
const lens = f.sphere({r: 0.42, at: [-0.55, 0, 0], scale: [0.45, 1, 1], mat: "glass"});
const ciliary = f.torus({r: 0.58, tube: 0.07, rot: [0, 0, 90], at: [-0.55, 0, 0], mat: "soft:#8A4A42"});
const zonules = f.cyl({r: 0.004, from: [-0.55, 0.42, 0], to: [-0.55, 0.53, 0], around: {count: 36, axis: "x", center: [-0.55, 0, 0]}, mat: "paper"});
const lightOn = f.arrow([[-0.5, 0.12, 0.05], [0.3, 0.04, 0.05], [1, -0.02, 0.05]], {r: 0.02, mat: "paint:#D9B24A"});
f.label(lens, "Lens");

step(4);
say("The retina turns it into signals, which leave through the optic nerve.");
const fovea = f.sphere({r: 0.07, at: [1.03, -0.05, 0.02], mat: "soft:#E3B36B"});
const nerve = f.pipe({points: [[1.1, -0.28, -0.1], [1.5, -0.42, -0.14], [2.2, -0.5, -0.14]], r: 0.2, mat: "soft:#E0CDB6", cut: true});
const nerveCore = f.pipe({points: [[1.0, -0.26, -0.1], [1.5, -0.42, -0.14], [2.2, -0.5, -0.14]], r: 0.05, copies: {count: 3, step: [0, 0.06, 0.03]}, mat: "soft:#B78378"});
const artery = f.pipe({points: [[1.05, -0.26, -0.3], [0.7, 0.3, -0.72], [0.15, 0.72, -0.8]], r: 0.022, copies: {count: 3, step: [0, -0.34, 0.02]}, mat: "soft:#A8352D"});
const vein = f.pipe({points: [[1.05, -0.3, -0.34], [0.65, -0.5, -0.74], [0.1, -0.84, -0.72]], r: 0.022, copies: {count: 3, step: [0, 0.34, 0.02]}, mat: "soft:#3F5F8A"});
f.label(nerve, "Optic nerve");
f.label(retina, "Retina");
```
It goes on with the six eye muscles (`f.blob` straps wrapping the ball), then the lens changing shape in a `tick`.

A machine, cut open:
```js
step(1);
say("A turbocharger uses wasted exhaust to force more air into the engine.");
const f = figure(40, 180, 700, 420, {title: "Turbocharger cutaway", tilt: 16, turn: 15});
const hot = f.lathe({profile: [[0.18, 1.0], [0.75, 1.1], [1.25, 1.45], [1.3, 1.85], [0.7, 2.25], [0.42, 2.7]], axis: "x", mat: "iron", thick: 0.05, cut: true});
const cold = f.lathe({profile: [[0.42, -2.9], [0.5, -2.3], [1.2, -1.9], [1.32, -1.5], [0.8, -1.05], [0.2, -0.95]], axis: "x", mat: "alu", thick: 0.05, cut: true});
const centre = f.tube({r: 0.5, inner: 0.13, h: 1.9, axis: "x", mat: "steel", bevel: 0.03, cut: true});
const flanges = f.tube({r: 0.72, inner: 0.45, h: 0.08, axis: "x", at: [-0.92, 0, 0], copies: {count: 2, step: [1.84, 0, 0]}, mat: "steel", bevel: 0.015, cut: true});
const bolts = f.cyl({r: 0.04, h: 0.16, axis: "x", at: [-0.92, 0.6, 0], around: {count: 10, axis: "x", center: [-0.92, 0, 0]}, mat: "steel", bevel: 0.008});
const rearBolts = f.cyl({r: 0.04, h: 0.16, axis: "x", at: [0.92, 0.6, 0], around: {count: 10, axis: "x", center: [0.92, 0, 0]}, mat: "steel", bevel: 0.008});
f.label(hot, "Turbine housing");

step(2);
say("Hot exhaust spins this turbine wheel at over 100,000 revolutions a minute.");
const rotor = f.group({});
const shaft = f.cyl({r: 0.1, h: 4, axis: "x", parent: rotor, mat: "chrome", bevel: 0.015});
const turbineHub = f.lathe({profile: [[0, 2.2], [0.14, 1.95], [0.3, 1.6], [0.5, 1.42]], axis: "x", parent: rotor, mat: "titanium"});
const turbineBlades = f.box({size: [0.42, 0.55, 0.03], at: [1.72, 0.5, 0], rot: [30, 0, 0], around: {count: 11, axis: "x", center: [1.72, 0, 0]}, parent: rotor, mat: "paint:#877459", bevel: 0.008});
const exhaustIn = f.arrow([[1.7, 2.3, 0.2], [1.7, 1.4, 0.3], [1.9, 0.5, 0.3], [3.3, 0.2, 0.2]], {r: 0.04, mat: "paint:#BE743F"});
rotor.spin({axis: "x", period: 0.8});
f.label(turbineBlades, "Turbine");
f.label(shaft, "Shaft");

step(3);
say("The same shaft turns a compressor wheel, which packs fresh air into the engine.");
const compressorHub = f.lathe({profile: [[0, -2.1], [0.12, -1.9], [0.26, -1.55], [0.46, -1.35]], axis: "x", parent: rotor, mat: "alu"});
const compressorBlades = f.box({size: [0.46, 0.6, 0.025], at: [-1.65, 0.52, 0], rot: [-28, 0, 0], around: {count: 14, axis: "x", center: [-1.65, 0, 0]}, parent: rotor, mat: "alu", bevel: 0.006});
const airIn = f.arrow([[-3.5, 0.2, 0.2], [-2.4, 0.2, 0.25], [-1.8, 0.5, 0.3], [-1.6, 1.5, 0.3]], {r: 0.04, mat: "paint:#4D87AB"});
f.label(compressorBlades, "Compressor");

step(4);
say("Oil floats the shaft on bearings, because metal touching at that speed would melt.");
const bearings = f.tube({r: 0.16, inner: 0.105, h: 0.3, axis: "x", at: [-0.5, 0, 0], copies: {count: 2, step: [1, 0, 0]}, mat: "brass", bevel: 0.01});
const oilIn = f.pipe({points: [[0, 1.5, 0], [0, 0.9, 0], [0, 0.5, 0]], r: 0.07, mat: "copper"});
const oilOut = f.pipe({points: [[0, -0.5, 0], [0, -1, 0.05], [0.2, -1.6, 0.1]], r: 0.09, mat: "copper"});
const oilFlow = f.arrow([[0, 1.5, 0.12], [0, 0.6, 0.12], [-0.45, 0.2, 0.12]], {r: 0.022, mat: "paint:#BF9B5C"});
f.label(bearings, "Bearings");
```
It goes on with the wastegate valve, its actuator rod and the coolant passages.

**The usual shape of a 3D lesson:** step 1 builds the outer body and says what it is. Then each step adds a group of parts as it's named and labels the important ones. Then one step starts it moving (`tick`, `spin`) and explains what's happening. Then a step turns the view or moves a part out to make a point. It finishes with the buttons. Keep adding real detail in the middle steps until the minimums above are met.

**Building on a figure in a follow-up:** `f` and your parts still exist. Add more, `move` them, hide the rest with `part.show = false` or `erase("p3,p4")`, and bring the camera in with `f.view({zoom: 1.5})`.
