step(1); say("Here's the difference between a stack and a queue.")
const a = paper(60, 60, 620, 460, {title: "Stack vs queue", heading: "Two ways to line up", subtitle: "Last in first out, or first in first out"})
text(a.x, a.y + 20, "Stack", {size: 28, weight: 700, color: "blue"})
if (a.w > 100) {
  rect(a.x, a.y + 40, 120, 40, {r: 6, fill: "sky"})
} else {
  rect(a.x, a.y + 40, 60, 40)
}
for (const i of range(3)) {
  rect(a.x + i * 30, a.y + 100, 24, 24)
}

step(2);
say(`A stack takes the newest item first, like a pile of plates.`);
arrow([[a.x + 200, a.y + 60], [a.x + 300, a.y + 60]], {color: "red", bend: 0.2});
const label = "shadowing a call by name still works";
const box = /plates/.test("plates") ? [a.x, a.y, 10, 10] : null;
text(a.x, a.y + 160, label, {size: 16});
const g = graph(700, 100, 400, 280, {x: [0, 10], y: [0, 100], title: "Growth"});
g.curve(t => t * t, {color: "blue", label: "n squared"});
g.point(5, 25, {label: "here"});

step(3);
say("That's the whole idea.");
erase("p3");
highlight(a.x, a.y + 140, 200, 30);
button(60, 560, "Which is faster?", {ask: "Is a stack faster than a queue?"});
lessonTitle("Stacks And Queues");
