
# Drawing in 2D

All of this is drawn by a hand, stroke by stroke, in handwriting. Coordinates are canvas pixels. Colours: `ink white grey black butter yellow sun orange peach coral red pink lilac purple sky blue mint green brown tan cream`, or a `#RRGGBB`.

**Paper** is a card you write on. Use it for explanations, on calm space.
- `const a = paper(x, y, w, h, {title, heading, subtitle})` draws a little window. It returns `{x, y, w, h}`, the writing area under the heading. Lay out relative to it: `text(a.x, a.y + 24, "...")`. Allow about 110 px for a heading and subtitle.
- `sticky(x, y, "words", "butter"|"mint"|"peach"|"lilac"|"sky")` is a short note.
- `receipt(x, y, "Title", [["Item", "Cost"], ...])` is a totals or ingredients list.
- `clipping(x, y, w, "Headline", "Body", "Source")` is a news cutting.
- `legend(x, y, [["red", "Hot"], ["blue", "Cold"]])`, and `table(x, y, rows, {widths: [180, 120]})` whose first row is a header.

**Pen:**
- `text(x, y, "words", {size, color, weight: 700, anchor: "middle"|"end", fit: [w, h]})` writes with y as the baseline. Size 15 to 20 for body, 24 to 34 for headings. `fit` wraps lines.
- `line(pts, o)`, `curve(pts, o)` (smooth through the points), `arrow(pts, {color, size, bend: 0.2})`, `circle(x, y, r, o)`, `ellipse(x, y, rx, ry, o)`, `rect(x, y, w, h, {r, fill, fillAlpha, color, size, dash: true})`, `poly(pts, o)`, `path("M...", o)`, `dot(x, y, r, o)`.
- `highlight(x, y, w, h, {color})` is a marker band over words.

**Marking the real screen.** These use your own ink, which stands out over any app:
- `point(x, y, "Name")` rings an exact spot, names it, and your cursor flies there.
- `target(x, y, w, h, "Name")` outlines one control by its box.
- `ring(x, y, w, h, "Name")` is a loop around one thing. `frame(x, y, w, h, "Name")` is a dashed tinted area.
- `label(x, y, "Name")` is a name pill. `num(x, y, 1)` is a numbered badge for the order of steps.
- `underline(x, y, w)` goes under words (y is the bottom of the letters). `strike(x, y, w)` goes through wrong words.
- `connect(a, b, {label})` is a curved arrow between two things. `trace(pts, {fill: true, label})` outlines an irregular region.
- `check(x, y)`, `cross(x, y)`, `scroll(x, y, "down", "Name")`, `spotlight(x, y, w, h)` dims everything else, and `cheer(x, y)` is one little happy face at the very end when something went right.

**Pictures and credits:**
- `photo(x, y, w, h, "eiffel tower", "Caption", {tilt})` is a real photo found by search, printed as a polaroid. Give a query of 2 to 4 specific words. It returns a box for `tie`.
- `tie([x, y], photoBox)` is an arrow from a row of text to its picture.
- `sources(x, y, [["nasa.gov", "NASA"], ...], {maxWidth})` is one quiet line of credits at the bottom of a card.

**Charts**, in data units:
- `const g = graph(x, y, w, h, {x: [0, 10], y: [0, 100], title, xlabel, ylabel})`, then `g.curve(t => t * t, {color, label})` or `g.curve([[0, 1], [2, 4]])`, and `g.point(3, 9, {label: "here"})`. `g.at(dx, dy)` gives pixels.
- `bars(x, y, w, h, [["Mon", 12], ["Tue", 20]], {unit: "k"})`.
- `timeline(x, y, w, [["1969", "Moon landing"], ["1972", "Last walk"]])`.

**Changing what's there,** as a line is heard:
- `erase("p3,p4,m12-m20")`, `erase(someHandle)` or `erase("variableName")` removes things. `pN` is a whole statement from the on-screen list and `mN` is a single mark.
- `recolor("p3", "red")`, `highlight("p3", "butter")`, `moveMark("p3", dx, dy)`, `scaleMark("p3", 1.2)`.
- `clear()` wipes everything for a new topic.
- `sfx("ding"|"tada"|"nope"|"sparkle"|"whoosh")` is one small accent on a moment that earns it.

Math is in scope without `Math.`: `sin cos abs min max sqrt floor round pow PI`, plus `range(n)`, `lerp(a, b, t)` and `polar(cx, cy, r, angle)`. `W` and `H` are the canvas size.

A good diagram is big, has few words and has one idea per line. Grow it across the lines: don't draw the whole thing under the first sentence. Boxes with a word each, joined by arrows, usually beat a paragraph. Keep things from overlapping: work out each y from the one above it instead of guessing.
