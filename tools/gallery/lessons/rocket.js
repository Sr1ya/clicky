```js
step(1);
say("Starship is two rockets stacked: a giant booster below and the ship on top.");
const f = figure(330, 90, 600, 520, {title: "Starship and Super Heavy", tilt: 12, turn: 20, spin: 0.6});
const booster = f.group({});
const ship = f.group({});
const boosterShell = f.tube({r: 0.45, inner: 0.43, h: 7.1, at: [0, 3.55, 0], parent: booster, mat: "metal:#C9CCD0", cut: true});
const stringers = f.box({size: [0.02, 7, 0.02], at: [0, 3.55, -0.44], around: {count: 24, axis: "y", arc: 180, center: [0, 3.55, 0]}, parent: booster, mat: "steel"});
const shipShell = f.tube({r: 0.45, inner: 0.43, h: 3.5, at: [0, 9.05, 0], parent: ship, mat: "metal:#C9CCD0", cut: true});
const nose = f.lathe({profile: [[0.45, 10.8], [0.43, 11.4], [0.34, 11.9], [0.18, 12.2], [0.02, 12.32]], parent: ship, mat: "metal:#C9CCD0", thick: 0.02, cut: true});
const heatTiles = f.tube({r: 0.455, inner: 0.44, h: 4.9, at: [0, 9.6, 0], arc: 180, rot: [0, 180, 0], parent: ship, mat: "matte:#1E1E22"});
f.label(boosterShell, "Super Heavy");
f.label(shipShell, "Starship");

step(2);
say("Most of each stage is two tanks: liquid oxygen and liquid methane, kept super cold.");
const loxTank = f.cyl({r: 0.42, h: 3.6, at: [0, 2.0, 0], parent: booster, mat: "glass", cut: true});
const ch4Tank = f.cyl({r: 0.42, h: 2.6, at: [0, 5.3, 0], parent: booster, mat: "paint:#7E9BB8", cut: true});
const commonDome = f.sphere({r: 0.42, dome: true, at: [0, 3.85, 0], scale: [1, 0.35, 1], parent: booster, mat: "steel", thick: 0.02, cut: true});
const downcomer = f.cyl({r: 0.06, h: 3.7, at: [0, 1.95, 0], parent: booster, mat: "chrome", bevel: 0.01});
const shipLox = f.cyl({r: 0.42, h: 1.4, at: [0, 8.1, 0], parent: ship, mat: "glass", cut: true});
const shipCh4 = f.cyl({r: 0.42, h: 1.2, at: [0, 9.5, 0], parent: ship, mat: "paint:#7E9BB8", cut: true});
const headerTank = f.sphere({r: 0.16, at: [0, 11.3, -0.05], parent: ship, mat: "steel"});
const cargoBay = f.cyl({r: 0.4, h: 0.6, at: [0, 10.6, 0], parent: ship, mat: "matte:#3A3F47", cut: true});
f.label(loxTank, "Oxygen tank");

step(3);
say("Thirty three Raptor engines fire at the bottom, burning that fuel together.");
const thrustPlate = f.cyl({r: 0.44, h: 0.08, at: [0, 0.02, 0], parent: booster, mat: "steel", bevel: 0.01});
const innerEngines = f.cone({r: 0.06, h: 0.22, axis: "-y", at: [0.12, -0.12, 0], around: {count: 3, axis: "y"}, parent: booster, mat: "metal:#8A6A4A"});
const midEngines = f.cone({r: 0.06, h: 0.22, axis: "-y", at: [0.27, -0.12, 0], around: {count: 10, axis: "y"}, parent: booster, mat: "metal:#8A6A4A"});
const outerEngines = f.cone({r: 0.055, h: 0.2, axis: "-y", at: [0.39, -0.1, 0], around: {count: 20, axis: "y"}, parent: booster, mat: "metal:#8A6A4A"});
const skirt = f.tube({r: 0.47, inner: 0.44, h: 0.3, at: [0, 0.1, 0], parent: booster, mat: "steel", cut: true});
const plume = f.cone({r: 0.5, h: 1.6, axis: "-y", at: [0, -1.0, 0], parent: booster, mat: "glow:#EE9A43"});
f.label(outerEngines, "33 Raptors");

step(4);
say("Grid fins up top steer the booster, and four flaps steer the ship.");
const gridFins = f.box({size: [0.04, 0.35, 0.5], at: [0.5, 6.7, 0], around: {count: 4, axis: "y", center: [0, 6.7, 0]}, parent: booster, mat: "titanium", bevel: 0.01});
const chines = f.box({size: [0.06, 1.4, 0.03], at: [0.47, 0.9, 0], around: {count: 4, axis: "y", center: [0, 0.9, 0]}, parent: booster, mat: "steel"});
const hotStage = f.tube({r: 0.45, inner: 0.4, h: 0.25, at: [0, 7.22, 0], parent: booster, mat: "steel", cut: true});
const hotVents = f.box({size: [0.03, 0.15, 0.08], at: [0, 7.22, -0.46], around: {count: 10, axis: "y", arc: 180, center: [0, 7.22, 0]}, parent: booster, mat: "black"});
const aftFlaps = f.box({size: [0.6, 0.9, 0.04], at: [0.6, 7.9, 0], mirror: "x", parent: ship, mat: "matte:#1E1E22", bevel: 0.01});
const foreFlaps = f.box({size: [0.35, 0.6, 0.04], at: [0.48, 11.4, 0], rot: [0, 0, 10], mirror: "x", parent: ship, mat: "matte:#1E1E22", bevel: 0.01});
const seaRaptors = f.cone({r: 0.06, h: 0.2, axis: "-y", at: [0.1, 7.2, 0], around: {count: 3, axis: "y", center: [0, 7.2, 0]}, parent: ship, mat: "metal:#8A6A4A"});
const vacRaptors = f.cone({r: 0.12, h: 0.35, axis: "-y", at: [0.3, 7.15, 0], around: {count: 3, axis: "y", center: [0, 7.15, 0]}, parent: ship, mat: "metal:#8A6A4A"});
const shipFlame = f.cone({r: 0.35, h: 1.2, axis: "-y", at: [0, 6.5, 0], parent: ship, mat: "glow:#EE9A43"});
f.label(gridFins, "Grid fins");

step(5);
say("At liftoff it makes about 7,000 tons of thrust and climbs faster and faster.");
f.view({tilt: 6, zoom: 0.9});
f.tick((t) => {
  const s = t % 14;
  const climb = 0.08 * min(s, 6) * min(s, 6);
  booster.pos = [s > 6 ? -(s - 6) * 0.3 : 0, s > 6 ? climb - (s - 6) * 0.4 : climb, 0];
  booster.rot = [0, 0, s > 6 ? min((s - 6) * 30, 180) : 0];
  ship.pos = [0, s > 6 ? climb + (s - 6) * (1 + (s - 6) * 0.3) : climb, 0];
  plume.show = s < 6;
  shipFlame.show = s > 5.8;
  f.readout({Stage: s < 6 ? "Booster burn" : "Ship burn", Time: round(s * 12) + " s"});
});

step(6);
say("After about 2 and a half minutes, the ship lights its own engines while still attached.");
say("That hot staging pushes it away, and the booster flips round to fly home.");

step(7);
say("The ship keeps burning to orbit, and the booster gets caught back at the tower.");
button(330, 650, "How is the booster caught?", {ask: "How does the tower catch the Super Heavy booster with its arms?"});
button(590, 650, "Why steel, not carbon?", {ask: "Why is Starship made of stainless steel instead of carbon fibre?"});
lessonTitle("How Starship Launches");
```