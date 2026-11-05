
# Drawing in 3D

`const f = figure(x, y, w, h, {title, tilt, spin, turn, zoom})` stands a 3D stage in that rectangle. Give it room: at least 450 x 400, and bigger is better (a figure around 640 x 480 is normal). The object is framed automatically, and labels go in the margins beside it. It lights itself like a studio photo and turns slowly on its own. `tilt` is degrees of looking down (about 15 for a machine, 45 to 55 for a board or a map). `spin` runs from 0.5 to 2. Over busy screen content the figure stands on a card by itself, and over calm space it floats.

**Copy the real thing as faithfully as you can.** Every visible part in its place, with its real proportions, shape, colour and material, down to the small details: the bolts, the labels, the vents, the pins. This is the whole point of the 3D answer, so never settle for a simplified or "medium detail" model when you can do better. A plain box with labels is a failure. Use `find_reference_images` first for any real object, and copy what you see.

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

**Many of the same thing.** Use one statement, not a loop:
- `mirror: "x"` (or `["x", "z"]`) adds the mirror image across the figure's middle: a plane's other wing, the left and right wheels.
- `copies: {count: 20, step: [0.25, 0, 0]}` is a row: pins, ribs, keys.
- `around: {count: 16, axis: "y", center: [0, 0, 0]}` is a ring: bolts, fan blades, gear teeth. `arc: 180` makes it part of a circle.

**Materials, as real stuff:** `mat: "steel"`, `alu`, `titanium`, `chrome`, `brass`, `copper`, `gold`, `iron`, `black`, `rubber`, `glass`, `water`, `wood`, `ceramic`, `paper`, `plastic:#D8CBB2`, `paint:#167548`, `gloss:red`, `matte:#888`, `metal:#AA8855`, `soft:#9E3B35` for anything living, and `glow:#EE9A43` for a flame, an LED or a spark. Colours are what real things look like, so give a hex when it matters. Choose by what the thing is really made of: a mix of materials is what makes a model look real.

**Showing the inside:**
- `cut: true` on a casing slices away the half facing the viewer, whichever way it turns, and shows a hatched cut face. Use it on shells and put the working parts inside, uncut. Machines and bodies almost always want this.
- `cut: "x"` cuts a fixed side.
- `glass` also works for a see-through shell.

**Naming:** `f.label(part, "Piston")` writes a short name in the margin with a thin line to the part. Label 2 to 7 things, as they're named aloud, in 1 to 3 words each. `f.label([x, y, z], "Here")` labels a spot.

**Making it move.** This is what makes it a lesson and not a statue.
- `f.move(part, {to: [x, y, z], rot: [x, y, z], secs: 3})` glides a part once, during this line. Use it to lift a part out and show it, or to explode an assembly.
- `part.spin({axis: "x", period: 1.2})`, `part.bob({amount, period})`, `part.orbit({axis, center, period})`, `part.pulse({amount: 0.08, period: 0.8})` (a heartbeat), `part.path(points, {period, once: true})`.
- `part.show = false` hides it on this line, and `part.color = "red"` or `part.glow = 1` lights it up. `part.pos = [...]` and `part.rot = [...]` glide there quickly.
- `f.view({turn: 90, tilt: 30, zoom: 1.4, spin: 0.5})` shows it from another side or closer, on this line. Turning to look at what you're describing is good teaching.
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

**The usual shape of a 3D lesson:** step 1 builds the outer body and says what it is. Then each step adds a group of parts as it's named and labels the important ones. Then one step starts it moving (`tick`, `spin`) and explains what's happening. Then a step turns the view or moves a part out to make a point. It finishes with the buttons. Keep adding real detail in the middle steps, and aim for 20 to 100 parts for a real object.

**Building on a figure in a follow-up:** `f` and your parts still exist. Add more, `move` them, hide the rest with `part.show = false` or `erase("p3,p4")`, and bring the camera in with `f.view({zoom: 1.5})`.
