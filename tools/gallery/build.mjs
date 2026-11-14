// Builds the web gallery in docs/ (served by GitHub Pages): the same lesson engine the
// app runs, replaying programs Claude wrote during real Clicky lessons.
// Usage: node tools/gallery/build.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const visual = (name) => readFileSync(join(root, "ui/visual", name), "utf8");
const docs = join(root, "docs");
mkdirSync(docs, { recursive: true });

// Marks that point at things on the asker's screen. There's no screen behind the gallery.
const SCREEN_ONLY = /^\s*(point|seen|underline|ring|frame|num)\(/;

// A lesson places its figure on calm space beside what the asker was reading. Here the
// figure gets the whole stage, with its buttons centred underneath.
const STAGE = { width: 1280, figure: "figure(214, 62, 852, 566", buttonY: 672, buttonGap: 16 };
function fillStage(code) {
  const labels = [...code.matchAll(/^button\(\d+,\s*\d+,\s*"([^"]*)"/gm)].map((match) => match[1]);
  const widths = labels.map((label) => label.length * 7.6 + 24);
  let x = (STAGE.width - widths.reduce((sum, width) => sum + width, 0) - STAGE.buttonGap * (labels.length - 1)) / 2;
  let index = 0;
  return code
    .replace(/figure\(\s*\d+,\s*\d+,\s*\d+,\s*\d+/, STAGE.figure)
    .replace(/^button\(\d+,\s*\d+,/gm, () => {
      const placed = `button(${Math.round(x)}, ${STAGE.buttonY},`;
      x += widths[index++] + STAGE.buttonGap;
      return placed;
    });
}

const lessons = JSON.parse(readFileSync(join(here, "lessons.json"), "utf8")).map((entry) => {
  const raw = readFileSync(join(here, "lessons", entry.file), "utf8");
  const code = fillStage(raw.split("\n").filter((line) => !line.startsWith("```") && !SCREEN_ONLY.test(line)).join("\n").trim());
  const title = entry.title || (code.match(/lessonTitle\("([^"]+)"\)/) || [])[1] || entry.file;
  const parts = (code.match(/\bf\.(?!label|tick|explode|cut|turn|view)[a-z]+\(/g) || []).length;
  return { id: entry.file.replace(/\.js$/, ""), title, question: entry.question, parts, code };
});

// A closing script tag inside inlined source would end the element early.
const inline = (source) => source.replace(/<\/script/gi, "<\\/script");
const font = readFileSync(join(root, "ui/visual/PatrickHand.ttf")).toString("base64");
const CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; style-src 'unsafe-inline'; font-src data:; img-src data: blob:; media-src data: blob:";

const player = `<!doctype html><html><head><meta charset="utf-8"><title>Clicky lesson player</title>
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>@font-face{font-family:'Hand';font-weight:400 700;src:url(data:font/ttf;base64,${font}) format('truetype');}
${visual("visual.css")}
${visual("lesson.css")}
html,body{background:transparent;}
</style></head><body>
<script type="text/plain" id="lesson-worker-source">${inline(visual("lesson_worker.js"))}</script>
<script>${inline(readFileSync(join(here, "player.js"), "utf8"))}</script>
${["rough.js", "three.bundle.js", "scene3d.js", "sculpt.js", "visual.js", "lesson_sound.js", "stage3d.js", "smiles-drawer.min.js", "lesson.js"]
  .map((name) => `<script>${inline(visual(name))}</script>`).join("\n")}
</body></html>`;
writeFileSync(join(docs, "player.html"), player);

const page = readFileSync(join(here, "index.template.html"), "utf8")
  .replace("/*LESSONS*/[]", inline(JSON.stringify(lessons)));
writeFileSync(join(docs, "index.html"), page);
// GitHub Pages runs Jekyll unless told not to; nothing here needs it.
writeFileSync(join(docs, ".nojekyll"), "");

for (const lesson of lessons) console.log(`${lesson.id}: "${lesson.title}", ${lesson.parts} part statements`);
console.log(`player.html ${(player.length / 1e6).toFixed(2)} MB, index.html ${(page.length / 1e3).toFixed(0)} kB`);
