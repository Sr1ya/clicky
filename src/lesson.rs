//! Lessons: Claude answers with a small drawing program instead of prose. Its code
//! streams into a sandboxed worker in the overlay page (`ui/visual/lesson_worker.js`),
//! which reports each `say()` line back here. This module synthesizes those lines
//! ahead of time, plays them in order, and tells the page when each one starts and
//! ends, because the pen is timed to the voice and not the other way round.

use crate::config::Config;
use crate::speech;
use regex::Regex;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, LazyLock};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::sync::{Semaphore, mpsc};
use tokio::task::{JoinError, JoinHandle};

/// Lines being synthesized at once. The next line is usually ready when the
/// current one ends, which is what makes the voice sound continuous.
const SYNTHESIS_CONCURRENCY: usize = 2;
/// A small breath between lines, since each is its own audio clip.
pub const GAP_BETWEEN_LINES: Duration = Duration::from_millis(90);
/// Long enough for a web lookup in the middle of a program; ends the turn if the
/// page goes away and "done" never comes.
const PAGE_SILENCE_LIMIT: Duration = Duration::from_secs(120);
const WORDS_PER_SECOND: f64 = 2.6;
const MAX_PROGRAM_CHARS_IN_HISTORY: usize = 7000;
const MAX_ROUTING_PREFIX: usize = 24;
const FENCE: &str = "```";

/// What the page reports about the running program.
#[derive(Debug)]
pub enum LessonEvent {
    Say { k: u64, text: String },
    Done { state: String },
}

// ---------------------------------------------------------------- routing the reply

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Route {
    Program,
    /// Plain spoken text, or the older `<visual>` block.
    Speech,
}

static PROGRAM_START: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"^(?:```|//|/\*|(?:const|let|var|for|if|function)\s",
        r"|(?:step|say|erase|clear|startOver|figure|scene3d|paper|sticky|receipt|clipping|photo|text|write|label|point|target|hover",
        r"|frame|ring|num|highlight|underline|connect|trace|arrow|line|curve|circle|ellipse|rect|poly|graph|bars|timeline|table",
        r"|button|seen|noted|plan|lessonTitle|legend|spotlight|sources?|recolor)\s*\(",
        r"|[A-Za-z_$][\w$]*\.[a-zA-Z_$][\w$]*\s*[(=])",
    ))
    .expect("valid program regex")
});

/// Decides from the start of a reply whether it's a program. `None`: not enough yet.
pub fn classify_reply(prefix: &str) -> Option<Route> {
    let text = prefix.trim_start();
    if text.is_empty() {
        return None;
    }
    if PROGRAM_START.is_match(text) {
        return Some(Route::Program);
    }
    // Could this still become one of the openers above?
    let undecided = text.len() < MAX_ROUTING_PREFIX
        && !text.contains(['\n', ' ', ','])
        && text.chars().all(|c| c.is_alphanumeric() || "_$.`/*".contains(c));
    if undecided { None } else { Some(Route::Speech) }
}

/// Removes markdown code fence lines from streamed text; everything else passes through.
#[derive(Default)]
pub struct FenceFilter {
    held: String,
    mid_line: bool,
}

impl FenceFilter {
    pub fn feed(&mut self, delta: &str) -> String {
        let mut out = String::with_capacity(delta.len());
        for ch in delta.chars() {
            if self.mid_line {
                out.push(ch);
                self.mid_line = ch != '\n';
                continue;
            }
            self.held.push(ch);
            let could_be_fence = FENCE.starts_with(self.held.as_str()) || self.held.starts_with(FENCE);
            if !could_be_fence {
                out.push_str(&self.held);
                self.mid_line = ch != '\n';
                self.held.clear();
            } else if ch == '\n' {
                // A whole fence line: gone.
                self.held.clear();
            }
        }
        out
    }

    pub fn finish(&mut self) -> String {
        let held = std::mem::take(&mut self.held);
        if held.starts_with(FENCE) { String::new() } else { held }
    }
}

// ---------------------------------------------------------------- what a program said

static SAY_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\bsay\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)"#).expect("valid say regex")
});

/// The spoken lines of a program, for the panel and for history.
pub fn spoken_lines(program: &str) -> Vec<String> {
    SAY_LINE
        .captures_iter(program)
        .filter_map(|captures| captures.iter().skip(1).flatten().next().map(|m| m.as_str()))
        .map(|line| line.replace("\\\"", "\"").replace("\\'", "'").replace("\\n", " "))
        .collect()
}

/// How a program is remembered in the conversation. The code keeps Claude writing
/// programs and tells it what exists; a very long one shrinks to what was said.
pub fn program_for_history(program: &str) -> String {
    let clean = FenceFilter::strip(program);
    let code = clean.trim();
    if code.chars().count() <= MAX_PROGRAM_CHARS_IN_HISTORY {
        return format!("{FENCE}js\n{code}\n{FENCE}");
    }
    let lines: Vec<String> = spoken_lines(code)
        .iter()
        .map(|line| format!("say({line:?});"))
        .collect();
    format!(
        "{FENCE}js\n// (a long drawing, shortened here; what's on screen is listed in the next message)\n{}\n{FENCE}",
        lines.join("\n")
    )
}

impl FenceFilter {
    fn strip(text: &str) -> String {
        let mut filter = FenceFilter::default();
        let mut out = filter.feed(text);
        out.push_str(&filter.finish());
        out
    }
}

/// The note in front of the user's words each turn: the canvas, and any drawing
/// that's still on screen, whose variables are still alive in the sandbox.
pub fn turn_context(width: u32, height: u32, state_on_screen: Option<&str>) -> String {
    let mut note = format!("[This turn] Canvas: {width}x{height}, the same pixels as the primary screenshot.\n");
    if let Some(state) = state_on_screen.filter(|state| !state.trim().is_empty()) {
        note.push_str(
            "[Your drawing is still on screen and your program is still running: every variable you made still exists. \
             If this continues the topic, keep drawing on it (keep counting steps, erase what no longer helps). \
             If it's a new topic, start with clear().]\n<on_screen>\n",
        );
        note.push_str(state);
        note.push_str("\n</on_screen>\n");
    }
    note
}

// ---------------------------------------------------------------- the voice

/// A spawned task that's cancelled when its owner goes away, so interrupting a turn
/// doesn't leave synthesis and playback running behind it.
pub struct OwnedTask<T>(JoinHandle<T>);

impl<T> OwnedTask<T> {
    pub fn spawn(future: impl Future<Output = T> + Send + 'static) -> Self
    where
        T: Send + 'static,
    {
        OwnedTask(tokio::spawn(future))
    }
}

impl<T> Drop for OwnedTask<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl<T> Future for OwnedTask<T> {
    type Output = Result<T, JoinError>;
    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.0).poll(context)
    }
}

/// Audio for one line, or `None` when only the system voice is available.
pub async fn synthesize_line(http_client: &reqwest::Client, config: &Config, text: &str) -> Option<Vec<u8>> {
    if !config.elevenlabs_api_key.is_empty() {
        match speech::synthesize_with_elevenlabs(http_client, &config.elevenlabs_api_key, &config.elevenlabs_voice_id, text).await {
            Ok(audio) => return Some(audio),
            Err(error) => log::warn!("ElevenLabs failed: {error:#}"),
        }
    }
    if !config.fish_api_key.is_empty() {
        match speech::synthesize_with_fish(http_client, &config.fish_api_key, &config.fish_tts_model, &config.fish_voice_id, text).await {
            Ok(audio) => return Some(audio),
            Err(error) => log::warn!("Fish Audio failed: {error:#}"),
        }
    }
    if !config.puter_auth_token.is_empty() {
        let settings = crate::puter::VoiceSettings {
            provider: &config.puter_tts_provider,
            voice: &config.puter_tts_voice,
            model: &config.puter_tts_model,
        };
        match crate::puter::synthesize(http_client, &config.puter_auth_token, &settings, text).await {
            Ok(audio) => return Some(audio),
            Err(error) => log::warn!("Puter TTS failed: {error:#}"),
        }
    }
    None
}

/// How long a clip plays, when the decoder knows.
pub fn audio_duration(audio: &[u8]) -> Option<f64> {
    use rodio::Source;
    let decoder = rodio::Decoder::try_from(std::io::Cursor::new(audio.to_vec())).ok()?;
    decoder.total_duration().map(|duration| duration.as_secs_f64())
}

pub fn estimated_duration(text: &str) -> f64 {
    text.split_whitespace().count() as f64 / WORDS_PER_SECOND
}

pub struct QueuedLine {
    pub k: u64,
    pub text: String,
    pub audio: OwnedTask<Option<Vec<u8>>>,
}

/// Starts synthesizing each line the moment the page reports it and hands the lines
/// over in order. Ends when the program is done (returning its on-screen state).
pub async fn collect_lines(
    mut events: mpsc::UnboundedReceiver<LessonEvent>,
    lines: mpsc::UnboundedSender<QueuedLine>,
    http_client: reqwest::Client,
    config: Config,
    is_muted: bool,
) -> Option<String> {
    let limiter = Arc::new(Semaphore::new(SYNTHESIS_CONCURRENCY));
    loop {
        let event = match tokio::time::timeout(PAGE_SILENCE_LIMIT, events.recv()).await {
            Ok(Some(event)) => event,
            Ok(None) => return None,
            Err(_) => {
                log::warn!("the drawing page went quiet; ending the turn");
                return None;
            }
        };
        match event {
            LessonEvent::Say { k, text } => {
                let (client, config_for_line, limiter, line) = (http_client.clone(), config.clone(), limiter.clone(), text.clone());
                let audio = OwnedTask::spawn(async move {
                    if is_muted {
                        return None;
                    }
                    let _permit = limiter.acquire_owned().await.ok()?;
                    synthesize_line(&client, &config_for_line, &line).await
                });
                if lines.send(QueuedLine { k, text, audio }).is_err() {
                    return None;
                }
            }
            LessonEvent::Done { state } => return Some(state),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_programs_and_speech() {
        assert_eq!(classify_reply("  ```js\nstep(1)"), Some(Route::Program));
        assert_eq!(classify_reply("step(1);"), Some(Route::Program));
        assert_eq!(classify_reply("const f = figure("), Some(Route::Program));
        assert_eq!(classify_reply("say(\"hi\")"), Some(Route::Program));
        assert_eq!(classify_reply("f.view({turn:0})"), Some(Route::Program));
        assert_eq!(classify_reply("hello there, friend"), Some(Route::Speech));
        assert_eq!(classify_reply("<visual>{"), Some(Route::Speech));
        assert_eq!(classify_reply("[POINT:none]"), Some(Route::Speech));
        assert_eq!(classify_reply("Sure, here it is"), Some(Route::Speech));
        // Not enough yet: these may still become a program.
        assert_eq!(classify_reply("``"), None);
        assert_eq!(classify_reply("ste"), None);
        assert_eq!(classify_reply(""), None);
    }

    #[test]
    fn fence_filter_drops_fence_lines_across_chunks() {
        let mut filter = FenceFilter::default();
        let mut out = String::new();
        for chunk in ["``", "`j", "s\nsay(\"a\");\n", "`", "``\n", "```js\nstep(2);", "\n``", "`"] {
            out.push_str(&filter.feed(chunk));
        }
        out.push_str(&filter.finish());
        assert_eq!(out, "say(\"a\");\nstep(2);\n");
    }

    #[test]
    fn fence_filter_keeps_backticks_inside_code() {
        let mut filter = FenceFilter::default();
        let out = filter.feed("say(`hi`);\n`x`;\n");
        assert_eq!(out, "say(`hi`);\n`x`;\n");
    }

    #[test]
    fn finds_spoken_lines() {
        let program = "step(1);\nsay(\"One \\\"two\\\".\");\nconst f = figure(1,2,3,4);\nsay('three');\nsay(`four`);";
        assert_eq!(spoken_lines(program), vec!["One \"two\".", "three", "four"]);
    }

    #[test]
    fn long_programs_shrink_in_history() {
        let short = "say(\"hi\");";
        assert_eq!(program_for_history(short), "```js\nsay(\"hi\");\n```");
        let long = format!("say(\"hello\");\n{}", "f.box({size:[1,1,1]});\n".repeat(600));
        let remembered = program_for_history(&long);
        assert!(remembered.contains("say(\"hello\");"));
        assert!(!remembered.contains("f.box"));
    }

    #[test]
    fn turn_context_mentions_a_live_drawing() {
        assert!(!turn_context(1280, 720, None).contains("on_screen"));
        assert!(!turn_context(1280, 720, Some("  ")).contains("on_screen"));
        assert!(turn_context(1280, 720, Some("p1 (m0-m3): const f = figure(1,2,3,4)")).contains("const f"));
    }
}
