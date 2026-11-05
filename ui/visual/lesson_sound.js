// The small sounds a lesson makes as it's drawn: paper landing, a pen flick, a part
// clicking into place. All synthesized, so there are no audio files to ship. A cue
// that fails (no audio device, say) stays silent and never breaks the drawing.
(() => {
  "use strict";

  const MASTER_GAIN = 0.16;
  const NOISE_SECONDS = 2;
  let context = null;
  let master = null;
  let noise = null;
  let enabled = true;

  function audio() {
    if (!enabled) return null;
    if (!context) {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) { enabled = false; return null; }
      context = new Context();
      master = context.createGain();
      master.gain.value = MASTER_GAIN;
      master.connect(context.destination);
      noise = context.createBuffer(1, context.sampleRate * NOISE_SECONDS, context.sampleRate);
      const samples = noise.getChannelData(0);
      for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    }
    if (context.state === "suspended") context.resume();
    return context;
  }

  // A burst of filtered noise: paper, felt tip, eraser.
  function swish({ at = 0, seconds, type = "bandpass", from, to, q = 0.8, gain = 1, attack = 0.008 }) {
    const ctx = context;
    const start = ctx.currentTime + at;
    const source = ctx.createBufferSource();
    source.buffer = noise;
    source.loop = true;
    source.loopStart = Math.random() * (NOISE_SECONDS - 0.5);
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(from, start);
    filter.frequency.exponentialRampToValueAtTime(to || from, start + seconds);
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(gain, start + attack);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + seconds);
    source.connect(filter).connect(envelope).connect(master);
    source.start(start, source.loopStart);
    source.stop(start + seconds + 0.02);
  }

  // A short pitched sound: a soft knock, a bell partial.
  function tone({ at = 0, seconds, from, to, type = "sine", gain = 1 }) {
    const ctx = context;
    const start = ctx.currentTime + at;
    const oscillator = ctx.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(from, start);
    oscillator.frequency.exponentialRampToValueAtTime(to || from, start + seconds);
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(gain, start);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + seconds);
    oscillator.connect(envelope).connect(master);
    oscillator.start(start);
    oscillator.stop(start + seconds + 0.02);
  }

  const vary = (value, spread = 0.12) => value * (1 + (Math.random() * 2 - 1) * spread);

  const CUES = {
    "paper-place": () => { swish({ seconds: 0.16, from: 2600, to: 900, gain: 0.7 }); tone({ at: 0.05, seconds: 0.09, from: vary(130), to: 70, gain: 0.8 }); },
    "sticky-press": () => { tone({ seconds: 0.08, from: vary(180), to: 90, gain: 0.8 }); swish({ seconds: 0.07, from: 1800, gain: 0.3 }); },
    "photo-drop": () => { swish({ seconds: 0.12, from: 3400, to: 1400, gain: 0.5 }); tone({ at: 0.04, seconds: 0.08, from: vary(210), to: 120, gain: 0.6 }); },
    "pen-flick": () => swish({ seconds: 0.07, type: "highpass", from: vary(3200), gain: 0.28 }),
    "build-3d": () => { tone({ seconds: 0.05, from: vary(720, 0.25), to: 300, type: "triangle", gain: 0.34 }); swish({ seconds: 0.03, from: 2400, gain: 0.14 }); },
    highlighter: () => swish({ seconds: 0.26, from: 1500, to: 2200, q: 1.4, gain: 0.3, attack: 0.03 }),
    eraser: () => swish({ seconds: 0.24, from: 900, to: 700, q: 1.2, gain: 0.34, attack: 0.02 }),
    slide: () => swish({ seconds: 0.2, from: 700, to: 1800, gain: 0.26, attack: 0.04 }),
    "page-clear": () => swish({ seconds: 0.34, from: 3800, to: 600, gain: 0.5, attack: 0.03 }),
    "pill-pop": () => tone({ seconds: 0.07, from: vary(620), to: 900, gain: 0.3 }),
    "button-appear": () => { tone({ seconds: 0.16, from: 880, gain: 0.22 }); tone({ at: 0.05, seconds: 0.2, from: 1320, gain: 0.16 }); },
    "target-ping": () => tone({ seconds: 0.24, from: 1180, gain: 0.3 }),
    whoosh: () => swish({ seconds: 0.4, from: 400, to: 2400, gain: 0.34, attack: 0.1 }),
    ding: () => { tone({ seconds: 0.5, from: 1560, gain: 0.26 }); tone({ seconds: 0.3, from: 3120, gain: 0.08 }); },
    tada: () => { tone({ seconds: 0.2, from: 660, gain: 0.26 }); tone({ at: 0.12, seconds: 0.3, from: 990, gain: 0.26 }); },
    nope: () => { tone({ seconds: 0.11, from: 240, to: 200, type: "triangle", gain: 0.4 }); tone({ at: 0.12, seconds: 0.14, from: 190, to: 150, type: "triangle", gain: 0.4 }); },
    sparkle: () => { for (let i = 0; i < 4; i++) tone({ at: i * 0.05, seconds: 0.16, from: vary(2400 + i * 400), gain: 0.1 }); },
  };

  window.ClickySound = {
    setEnabled(value) { enabled = !!value; },
    play(name) {
      const cue = CUES[name];
      if (!cue) return;
      try { if (audio()) cue(); } catch (error) { enabled = false; }
    },
  };
})();
