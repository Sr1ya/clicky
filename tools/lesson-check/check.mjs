// Replays lesson programs through the sandbox in small chunks, the way a stream
// delivers them, and fails if a statement breaks or a mark loses its line.
// Usage: node tools/lesson-check/check.mjs [folder of programs]
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const folder = process.argv[2] || join(here, "samples");
const workerSource = readFileSync(join(here, "../../ui/visual/lesson_worker.js"), "utf8");
const CHUNK_SIZES = [1, 7, 37, 400];

function startWorker() {
  const listeners = [];
  const posted = [];
  const context = { console };
  context.self = context;
  context.postMessage = (message) => posted.push(message);
  context.addEventListener = (_, handler) => listeners.push(handler);
  vm.createContext(context);
  vm.runInContext(workerSource, context);
  return {
    posted,
    send: (data) => listeners.forEach((handler) => handler({ data: JSON.parse(JSON.stringify(data)) })),
  };
}

const withoutFences = (code) => code.split("\n").filter((line) => !line.startsWith("```")).join("\n");

let failures = 0;
for (const file of readdirSync(folder).filter((name) => name.endsWith(".js")).sort()) {
  const code = withoutFences(readFileSync(join(folder, file), "utf8"));
  const outcomes = new Set();
  for (const size of CHUNK_SIZES) {
    const worker = startWorker();
    worker.send({ type: "begin", width: 1280, height: 720 });
    for (let i = 0; i < code.length; i += size) worker.send({ type: "code", text: code.slice(i, i + size) });
    worker.send({ type: "end" });
    const events = worker.posted.flatMap((message) => (message.type === "events" ? message.events : []));
    const marks = events.filter((event) => event.kind === "mark");
    const says = events.filter((event) => event.kind === "say");
    const problems = events.filter((event) => event.kind === "warn").map((event) => event.message);
    if (marks.some((event) => event.mark.line === undefined)) problems.push("a mark has no line");
    if (!worker.posted.some((message) => message.type === "done")) problems.push("the program never finished");
    outcomes.add(`${says.length} lines, ${marks.length} marks`);
    for (const problem of problems) {
      console.log(`FAIL ${file} (chunks of ${size}): ${problem}`);
      failures++;
    }
  }
  // However the stream is cut, the program must come out the same.
  if (outcomes.size > 1) {
    console.log(`FAIL ${file}: differs by chunk size: ${[...outcomes].join(" / ")}`);
    failures++;
  } else {
    console.log(`ok   ${file}: ${[...outcomes][0]}`);
  }
}
process.exit(failures ? 1 : 0);
