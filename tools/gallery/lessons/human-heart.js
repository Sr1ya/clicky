```js
step(1);
say("Your heart is a fist-sized muscle with 4 chambers that work as 2 pumps.");
const f = figure(140, 90, 760, 480, {title: "The human heart", tilt: 10, turn: 10});
const wall = f.blob({balls: [[-0.5, 0.3, 0, 1.0], [0.55, 0.3, 0, 1.0], [-0.35, -0.8, 0, 0.95], [0.4, -0.9, 0, 1.05], [0.1, -1.7, 0, 0.5]], blend: 0.4, mat: "soft:#9E3B35", thick: 0.08, cut: true});
const fat = f.blob({balls: [[0, 0.95, -0.6, 0.45], [-0.8, -0.2, -0.7, 0.35]], blend: 0.3, mat: "soft:#D9B96A"});
f.label(wall, "Heart muscle");

step(2);
say("Up top sit the 2 atria, thin receiving rooms for incoming blood.");
const rightAtrium = f.sphere({r: 0.62, at: [-0.62, 0.45, 0], mat: "soft:#5A3A55", thick: 0.05, cut: true});
const leftAtrium = f.sphere({r: 0.62, at: [0.68, 0.45, 0], mat: "soft:#B5463C", thick: 0.05, cut: true});
const atrialSeptum = f.box({size: [0.08, 0.9, 0.9], at: [0.03, 0.45, 0], mat: "soft:#7E2E2A", bevel: 0.02, cut: true});
f.label(rightAtrium, "Right atrium");

step(3);
say("Below them, the thick ventricles do the real pushing, split by a wall called the septum.");
const rightVentricle = f.sphere({r: 0.72, at: [-0.5, -0.85, 0], scale: [1, 1.15, 1], mat: "soft:#5A3A55", thick: 0.05, cut: true});
const leftVentricle = f.sphere({r: 0.72, at: [0.55, -0.9, 0], scale: [1, 1.2, 1], mat: "soft:#B5463C", thick: 0.12, cut: true});
const septum = f.box({size: [0.14, 1.6, 1.0], at: [0.02, -0.9, 0], rot: [0, 0, -6], mat: "soft:#7E2E2A", bevel: 0.03, cut: true});
const tricuspid = f.torus({r: 0.3, tube: 0.04, at: [-0.55, -0.12, 0], mat: "soft:#E6D2C0"});
const mitral = f.torus({r: 0.3, tube: 0.04, at: [0.6, -0.12, 0], mat: "soft:#E6D2C0"});
const cords = f.cyl({r: 0.01, from: [-0.55, -0.15, 0.2], to: [-0.5, -0.9, 0.1], copies: {count: 4, step: [0.08, 0, -0.1]}, mat: "soft:#F0E4D8"});
f.label(leftVentricle, "Left ventricle");

step(4);
say("Used blood returns through the venae cavae into the right side.");
const superiorCava = f.pipe({points: [[-0.9, 0.95, -0.1], [-0.95, 1.8, -0.1], [-0.95, 2.6, -0.1]], r: 0.2, mat: "soft:#3F5F8A", cut: true});
const inferiorCava = f.pipe({points: [[-0.9, -0.05, -0.2], [-1.3, -0.9, -0.3], [-1.3, -2.2, -0.3]], r: 0.2, mat: "soft:#3F5F8A", cut: true});
const flowIn = f.arrow([[-0.95, 2.4, 0.05], [-0.7, 0.6, 0.05], [-0.55, -0.9, 0.05]], {r: 0.035, mat: "paint:#4D6FA0"});
f.label(superiorCava, "Vena cava");

step(5);
say("The right ventricle sends it up the pulmonary trunk to pick up oxygen in the lungs.");
const trunk = f.pipe({points: [[-0.2, 0.2, -0.3], [-0.1, 1.4, -0.4], [0.2, 1.9, -0.4]], r: 0.2, mat: "soft:#4C6A9A", cut: true});
const pulmArteries = f.pipe({points: [[0.2, 1.9, -0.4], [1.2, 2.0, -0.5], [2.2, 1.8, -0.5]], r: 0.13, mirror: "x", mat: "soft:#4C6A9A"});
const pulmVeins = f.pipe({points: [[1.1, 0.5, -0.4], [1.8, 0.7, -0.5], [2.4, 0.9, -0.5]], r: 0.09, copies: {count: 2, step: [0, -0.35, 0]}, mat: "soft:#A8352D"});
const toLungs = f.arrow([[-0.4, -0.8, 0.05], [-0.15, 0.6, 0.05], [0.1, 1.8, 0.05]], {r: 0.035, mat: "paint:#4D6FA0"});

step(6);
say("Fresh blood returns to the left side, and the left ventricle drives it out the aorta.");
const aorta = f.pipe({points: [[0.4, 0.1, -0.1], [0.35, 1.6, -0.2], [0.0, 2.3, -0.4], [-0.5, 2.0, -0.6], [-0.4, -2.4, -0.9]], r: 0.24, mat: "soft:#B7473C", cut: true});
const branches = f.pipe({points: [[0.0, 2.3, -0.4], [0.0, 3.0, -0.4]], r: 0.07, copies: {count: 3, step: [-0.22, -0.05, -0.08]}, mat: "soft:#B7473C"});
const coronary = f.pipe({points: [[0.4, 0.8, -0.8], [0.9, -0.2, -0.9], [0.4, -1.6, -0.6]], r: 0.04, copies: {count: 2, step: [-0.8, 0, 0]}, mat: "soft:#C0433A"});
const toBody = f.arrow([[0.9, 0.5, 0.05], [0.6, -1.0, 0.05], [0.35, 0.4, 0.05], [0.35, 1.9, 0.05]], {r: 0.035, mat: "paint:#C24A3A"});
f.label(aorta, "Aorta");

step(7);
say("It beats about 70 times a minute, moving roughly 5 litres every minute.");
wall.pulse({amount: 0.06, period: 0.86});
leftVentricle.pulse({amount: 0.08, period: 0.86});
rightVentricle.pulse({amount: 0.08, period: 0.86});
f.view({turn: -20, tilt: 15});

step(8);
say("The left wall is thicker because it pushes blood around your whole body, not only the lungs.");
button(160, 640, "Why the left is thicker", {ask: "Why is the left ventricle wall so much thicker than the right?"});
button(420, 640, "What makes it beat?", {ask: "Show me how electrical signals make the heart beat in 3D."});
lessonTitle("How Blood Flows Through The Heart");
```