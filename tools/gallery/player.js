// Stands in for the Rust side of Clicky inside the web gallery: it feeds a lesson
// program to the page and times each spoken line by its word count, the way the app
// does when it runs muted. The gallery page talks to it with postMessage.
(() => {
  const CANVAS = { width: 1280, height: 720 };
  const WORDS_PER_SECOND = 2.6;
  const GAP_BETWEEN_LINES = 0.09;
  const INSTANT_LINE = 0.12;

  let run = 0;
  let speed = 1;
  let waiting = [];
  let speaking = false;
  let programDone = false;

  const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  const tell = (message) => window.parent.postMessage({ clickyGallery: true, ...message }, "*");
  const lesson = (command) => window.clickyLesson.handle(command);

  function lineSeconds(text) {
    if (speed === 0) return INSTANT_LINE;
    const words = String(text).trim().split(/\s+/).filter(Boolean).length;
    return Math.max(0.8, words / WORDS_PER_SECOND) / speed;
  }

  async function speakLines(mine) {
    if (speaking) return;
    speaking = true;
    while (waiting.length && mine === run) {
      const line = waiting.shift();
      const duration = lineSeconds(line.text);
      lesson({ type: "lesson_line", k: line.k, event: "start", duration });
      tell({ type: "line", k: line.k, text: line.text });
      await sleep(duration);
      if (mine !== run) break;
      lesson({ type: "lesson_line", k: line.k, event: "end", duration });
      await sleep(speed === 0 ? 0.02 : GAP_BETWEEN_LINES / speed);
    }
    speaking = false;
    if (mine !== run) speakLines(run);
    else if (programDone && !waiting.length) tell({ type: "finished" });
  }

  // What the page would send to Rust.
  window.webkit = { messageHandlers: { clicky: { postMessage(json) {
    let message;
    try { message = JSON.parse(json); } catch { return; }
    if (message.type === "say") {
      waiting.push({ k: message.k, text: message.text });
      speakLines(run);
    } else if (message.type === "done") {
      programDone = true;
      if (!speaking && !waiting.length) tell({ type: "finished" });
    } else if (message.type === "ask") {
      tell({ type: "ask", text: message.text });
    } else if (message.type === "dismiss") {
      window.clicky.handle({ type: "clear", id: null });
      tell({ type: "closed" });
    } else if (message.type === "save_video") {
      tell({ type: "note", text: "In the app, that button saves the lesson as a video with the voice on top." });
    } else if (message.type === "warn") {
      console.warn("lesson:", message.message);
    }
  } } } };

  function play(code, options) {
    run++;
    speed = options.speed;
    waiting = [];
    programDone = false;
    window.clicky.handle({ type: "clear", id: null });
    lesson({
      type: "lesson_begin",
      width: CANVAS.width,
      height: CANVAS.height,
      scale_x: window.innerWidth / CANVAS.width,
      scale_y: window.innerHeight / CANVAS.height,
      tiles: null,
      ink: "#3380FF",
      sounds: !!options.sounds,
      captions: true,
      recording: false,
    });
    lesson({ type: "lesson_code", text: code });
    lesson({ type: "lesson_end" });
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || !data.clickyGallery) return;
    if (data.type === "play") play(data.code, data);
  });
  window.addEventListener("load", () => tell({ type: "ready" }));
})();
