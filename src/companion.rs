//! The companion state machine: push-to-talk → transcript → screenshots →
//! Claude → spoken reply + optional pointing. Mirrors CompanionManager in the
//! macOS app. All events (portal shortcut, D-Bus, panel button) funnel into
//! one channel so they're handled strictly in order.

use crate::audio_input::MicrophoneRecorder;
use crate::capture::{self, ScreenCapture};
use crate::claude::{self, ClaudeReply, ConversationTurn, LabeledImage};
use crate::config::Config;
use crate::lesson::{self, LessonEvent, OwnedTask, QueuedLine, Route};
use crate::pointing;
use crate::speech::{self, SpeechPlayer};
use crate::state::{PointTarget, Shared, VoiceState};
use crate::streaming::{ReplyEvent, StreamingReplyParser};
use crate::visual::{self, VisualCommand};
use anyhow::{Result, anyhow};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc::{self, UnboundedReceiver};
use tokio::task::JoinHandle;

/// Keep only the most recent exchanges so context (and cost) stays bounded.
const MAX_HISTORY_TURNS: usize = 10;
/// How long a finished visual stays up before fading (talking again clears it sooner).
const VISUAL_LINGER: Duration = Duration::from_secs(45);
/// Push-to-talk presses shorter than this dismiss instead of asking.
const QUICK_TAP: Duration = Duration::from_millis(400);
/// Clicky's ink for marks on the real screen: the buddy's own blue.
const LESSON_INK: &str = "#3380FF";
/// Set to run lessons silently, each line timed by its word count (for testing).
const MUTE_ENV_VAR: &str = "CLICKY_MUTE";
/// Pause for a visual step that has nothing to say.
const SILENT_STEP_DURATION: Duration = Duration::from_millis(1500);
/// `clicky present` replays canned replies in chunks like a live stream.
const CANNED_CHUNK_CHARACTERS: usize = 24;
const CANNED_CHUNK_INTERVAL: Duration = Duration::from_millis(12);
const POINTER_PHRASES: &[&str] = &[
    "right here!",
    "this one!",
    "over here!",
    "click this!",
    "here it is!",
    "found it!",
];

#[derive(Debug)]
pub enum CompanionEvent {
    PushToTalkPressed,
    PushToTalkReleased,
    PushToTalkToggled,
    ShowPanel,
    /// Stop talking and clear the drawing (close button, `clicky dismiss`, or a
    /// quick tap of the push-to-talk key).
    Dismiss,
    /// Present a canned reply as if Claude had sent it (`clicky present FILE`),
    /// for testing visuals and pointing without an API call.
    PresentReply(String),
    /// Debug hook: a canned reply that builds on the drawing on screen.
    PresentReplyKeepingDrawing(String),
    /// A turn from words instead of the mic: a lesson's button, or `clicky ask`.
    Ask(String),
    /// A lesson's `photo()` wants a real picture.
    LessonPhoto { id: String, query: String },
    /// A lesson's `point()`: fly the buddy to this canvas pixel.
    PointAtCanvas { x: f64, y: f64 },
    /// Re-read config.toml (after `clicky puter-login` saved a token).
    ReloadConfig,
}

#[derive(Clone)]
pub struct Companion {
    pub shared: Shared,
    pub config: Arc<Mutex<Config>>,
    pub http_client: reqwest::Client,
    pub recorder: MicrophoneRecorder,
    pub speaker: SpeechPlayer,
    pub history: Arc<tokio::sync::Mutex<Vec<ConversationTurn>>>,
    pub app: AppHandle,
}

impl Companion {
    pub async fn run(self, mut events: UnboundedReceiver<CompanionEvent>) {
        let mut active_transcription: Option<JoinHandle<Result<String>>> = None;
        let mut response_task: Option<JoinHandle<()>> = None;
        let mut pressed_at: Option<std::time::Instant> = None;

        while let Some(event) = events.recv().await {
            let event = match event {
                CompanionEvent::PushToTalkToggled if active_transcription.is_some() => {
                    CompanionEvent::PushToTalkReleased
                }
                CompanionEvent::PushToTalkToggled => CompanionEvent::PushToTalkPressed,
                other => other,
            };
            match event {
                CompanionEvent::PushToTalkPressed => {
                    if active_transcription.is_some() {
                        continue;
                    }
                    // Talking again interrupts whatever Clicky was doing.
                    if let Some(task) = response_task.take() {
                        task.abort();
                    }
                    self.speaker.stop();
                    pressed_at = Some(std::time::Instant::now());
                    active_transcription = self.start_listening().await;
                }
                CompanionEvent::PushToTalkReleased => {
                    let Some(transcription) = active_transcription.take() else {
                        continue;
                    };
                    self.recorder.stop();
                    // A quick tap means "dismiss", not a question: pressing already
                    // stopped the speech and cleared the drawing, so drop the recording.
                    if pressed_at.take().is_some_and(|start| start.elapsed() < QUICK_TAP) {
                        transcription.abort();
                        {
                            let mut state = self.shared.lock().unwrap();
                            state.lesson_on_screen = None;
                            state.visual_commands.push(VisualCommand::Clear { id: None });
                        }
                        self.set_voice_state(VoiceState::Idle);
                        continue;
                    }
                    self.set_voice_state(VoiceState::Processing);
                    let companion = self.clone();
                    response_task = Some(tokio::spawn(async move {
                        companion.finish_turn(transcription).await;
                    }));
                }
                CompanionEvent::ShowPanel => show_panel(&self.app),
                CompanionEvent::ReloadConfig => {
                    *self.config.lock().unwrap() = Config::load();
                    log::info!("config reloaded");
                }
                CompanionEvent::Dismiss => {
                    if let Some(task) = response_task.take() {
                        task.abort();
                    }
                    self.speaker.stop();
                    {
                        let mut state = self.shared.lock().unwrap();
                        state.point_target = None;
                        state.hide_overlay_for_capture = false;
                        state.lesson_events = None;
                        state.lesson_on_screen = None;
                        state.visual_commands.push(VisualCommand::Clear { id: None });
                    }
                    if active_transcription.is_none() {
                        self.set_voice_state(VoiceState::Idle);
                    }
                }
                CompanionEvent::PresentReply(reply_text) => {
                    if let Some(task) = response_task.take() {
                        task.abort();
                    }
                    self.speaker.stop();
                    {
                        let mut state = self.shared.lock().unwrap();
                        state.lesson_on_screen = None;
                        state.visual_commands.push(VisualCommand::Clear { id: None });
                    }
                    let companion = self.clone();
                    response_task = Some(tokio::spawn(async move {
                        companion.present_canned_reply(&reply_text).await;
                    }));
                }
                CompanionEvent::PresentReplyKeepingDrawing(reply_text) => {
                    if let Some(task) = response_task.take() {
                        task.abort();
                    }
                    self.speaker.stop();
                    visual::send(&self.shared, VisualCommand::LessonInterrupt);
                    let companion = self.clone();
                    response_task = Some(tokio::spawn(async move {
                        companion.present_canned_reply(&reply_text).await;
                    }));
                }
                CompanionEvent::Ask(question) => {
                    if let Some(task) = response_task.take() {
                        task.abort();
                    }
                    self.speaker.stop();
                    self.interrupt_drawing();
                    self.set_voice_state(VoiceState::Processing);
                    let companion = self.clone();
                    response_task = Some(tokio::spawn(async move {
                        companion.answer(&question).await;
                    }));
                }
                CompanionEvent::LessonPhoto { id, query } => {
                    let (http_client, shared) = (self.http_client.clone(), self.shared.clone());
                    tokio::spawn(async move {
                        if let Some(data) = crate::web_reference::find_photo(&http_client, &query).await {
                            visual::send(&shared, VisualCommand::LessonPhoto { id, data });
                        } else {
                            log::warn!("no photo found for {query:?}");
                        }
                    });
                }
                CompanionEvent::PointAtCanvas { x, y } => {
                    let capture = self.shared.lock().unwrap().lesson_capture.clone();
                    if let Some(capture) = capture {
                        self.fly_to(&capture, x, y);
                    }
                }
                CompanionEvent::PushToTalkToggled => unreachable!("mapped above"),
            }
        }
    }

    async fn start_listening(&self) -> Option<JoinHandle<Result<String>>> {
        let assemblyai_api_key = self.config.lock().unwrap().assemblyai_api_key.clone();
        {
            let mut state = self.shared.lock().unwrap();
            state.point_target = None;
            state.last_error = None;
            // An aborted response may have been mid-screenshot with the overlay hidden.
            state.hide_overlay_for_capture = false;
            // Talking again stops the pen. A drawing stays up, since the next
            // question may build on it; the older card style clears.
            state.lesson_events = None;
            state.visual_commands.push(VisualCommand::LessonInterrupt);
            state.visual_commands.push(VisualCommand::ClearCard);
        }
        if assemblyai_api_key.is_empty() {
            self.report_error("add your AssemblyAI key in the Clicky panel first");
            show_panel(&self.app);
            return None;
        }

        self.set_voice_state(VoiceState::Listening);
        let (pcm16_chunk_sender, pcm16_chunk_receiver) = mpsc::unbounded_channel();
        if let Err(error) = self.recorder.start(pcm16_chunk_sender).await {
            self.report_error(&error);
            self.set_voice_state(VoiceState::Idle);
            return None;
        }
        Some(tokio::spawn(crate::transcription::transcribe_push_to_talk(
            assemblyai_api_key,
            pcm16_chunk_receiver,
        )))
    }

    async fn finish_turn(&self, transcription: JoinHandle<Result<String>>) {
        let transcript = match transcription.await {
            Ok(Ok(transcript)) => transcript,
            Ok(Err(error)) => {
                self.report_error(&format!("transcription failed: {error:#}"));
                self.set_voice_state(VoiceState::Idle);
                return;
            }
            Err(_) => return,
        };
        if transcript.trim().is_empty() {
            log::info!("empty transcript, nothing to send");
            self.set_voice_state(VoiceState::Idle);
            return;
        }
        log::info!("transcript: {transcript}");
        self.answer(&transcript).await;
    }

    /// A whole turn from the user's words.
    async fn answer(&self, words: &str) {
        self.shared.lock().unwrap().last_transcript = Some(words.to_string());
        if let Err(error) = self.respond_to(words).await {
            self.report_error(&format!("{error:#}"));
            speech::speak_with_system_voice(
                &self.shared,
                "sorry, something went wrong. check the clicky panel.",
            )
            .await;
        }
        self.set_voice_state(VoiceState::Idle);
    }

    async fn respond_to(&self, transcript: &str) -> Result<()> {
        let config = self.config.lock().unwrap().clone();
        if config.anthropic_api_key.is_empty() {
            return Err(anyhow!("add your Anthropic API key in the Clicky panel"));
        }

        let started = std::time::Instant::now();
        let screen_captures = self.capture_screens_without_overlay().await?;
        log::info!("turn: screens captured at {} ms", started.elapsed().as_millis());
        let question = self.question_with_context(transcript, &screen_captures);
        let labeled_images: Vec<LabeledImage> = screen_captures
            .iter()
            .map(|capture| LabeledImage {
                jpeg_base64: capture.jpeg_base64.clone(),
                label: capture.label.clone(),
            })
            .collect();

        // The stream feeds the presenter while it is still arriving, so Clicky
        // starts talking (and drawing) at the first complete sentence or step.
        let (event_sender, event_receiver) = mpsc::unbounded_channel();
        let mut feeder = ReplyFeeder::new(event_sender);
        let stream = async {
            let result = {
                let history = self.history.lock().await;
                claude::ask_claude_with_screenshots(
                    &self.http_client,
                    &config.api_base_url,
                    &config.anthropic_api_key,
                    &config.model,
                    &config.effort,
                    pointing::COMPANION_SYSTEM_PROMPT,
                    &history,
                    &labeled_images,
                    &question,
                    &mut |delta| feeder.feed(delta),
                )
                .await
            };
            let is_program = feeder.is_program();
            let full_text = feeder.finish();
            if !is_program {
                self.point_from_reply(&full_text, &screen_captures);
            } else {
                save_last_reply(&full_text);
            }
            result.map(|reply| (reply, full_text, is_program))
        };
        let presenter = self.run_presenter(&config, event_receiver, &screen_captures);
        let (stream_result, ()) = tokio::join!(stream, presenter);
        let (reply, full_text, is_program) = stream_result?;

        if matches!(reply, ClaudeReply::Refused) && full_text.trim().is_empty() {
            self.speak(&config, "sorry, i can't help with that one.").await;
        }
        if is_program {
            self.remember_program(transcript, &full_text).await;
        } else {
            self.remember_turn(transcript, &full_text).await;
        }
        Ok(())
    }

    /// Presents a canned reply through the same streaming path, delivered in
    /// small chunks like a real stream (`clicky present FILE`).
    async fn present_canned_reply(&self, reply_text: &str) {
        let config = self.config.lock().unwrap().clone();
        self.set_voice_state(VoiceState::Processing);
        let screen_captures = match self.capture_screens_without_overlay().await {
            Ok(screen_captures) => screen_captures,
            Err(error) => {
                self.report_error(&format!("{error:#}"));
                self.set_voice_state(VoiceState::Idle);
                return;
            }
        };
        let (event_sender, event_receiver) = mpsc::unbounded_channel();
        let mut feeder = ReplyFeeder::new(event_sender);
        let stream = async {
            let characters: Vec<char> = reply_text.chars().collect();
            for chunk in characters.chunks(CANNED_CHUNK_CHARACTERS) {
                feeder.feed(&chunk.iter().collect::<String>());
                tokio::time::sleep(CANNED_CHUNK_INTERVAL).await;
            }
            let is_program = feeder.is_program();
            let full_text = feeder.finish();
            if !is_program {
                self.point_from_reply(&full_text, &screen_captures);
            }
        };
        let presenter = self.run_presenter(&config, event_receiver, &screen_captures);
        tokio::join!(stream, presenter);
        self.set_voice_state(VoiceState::Idle);
    }

    /// Speaks and draws reply events in order as they arrive.
    async fn run_presenter(
        &self,
        config: &Config,
        mut events: mpsc::UnboundedReceiver<ReplyEvent>,
        screen_captures: &[ScreenCapture],
    ) {
        let mut visual_id: Option<u64> = None;
        let mut step_index = 0;
        let mut lesson_voice: Option<OwnedTask<()>> = None;
        while let Some(event) = events.recv().await {
            match event {
                ReplyEvent::Speech(text) => self.speak(config, &text).await,
                ReplyEvent::ProgramStart => {
                    lesson_voice = self.begin_lesson(config, screen_captures);
                }
                ReplyEvent::ProgramCode(text) => {
                    visual::send(&self.shared, VisualCommand::LessonCode { text });
                }
                ReplyEvent::ProgramEnd => visual::send(&self.shared, VisualCommand::LessonEnd),
                ReplyEvent::VisualHeader(header) => {
                    visual_id = self.show_visual(header, screen_captures);
                    step_index = 0;
                }
                ReplyEvent::VisualStep(step) => {
                    let line = step["say"].as_str().unwrap_or("").trim().to_string();
                    if let Some(id) = visual_id {
                        visual::send(
                            &self.shared,
                            VisualCommand::Step {
                                id,
                                index: step_index,
                                step: Some(step),
                            },
                        );
                        step_index += 1;
                    }
                    if !line.is_empty() {
                        self.speak(config, &line).await;
                    } else if visual_id.is_some() {
                        tokio::time::sleep(SILENT_STEP_DURATION).await;
                    }
                }
            }
        }
        if let Some(voice) = lesson_voice {
            let _ = voice.await;
        }
        if let Some(id) = visual_id {
            let shared = self.shared.clone();
            tokio::spawn(async move {
                tokio::time::sleep(VISUAL_LINGER).await;
                visual::send(&shared, VisualCommand::Clear { id: Some(id) });
            });
        }
    }

    /// Opens the canvas and starts the voice. The page reports each `say()` as it
    /// runs; lines are synthesized ahead and spoken in order.
    fn begin_lesson(&self, config: &Config, screen_captures: &[ScreenCapture]) -> Option<OwnedTask<()>> {
        let capture = screen_captures
            .iter()
            .find(|capture| capture.is_cursor_screen)
            .or_else(|| screen_captures.first())?;
        let (events_in, events_out) = mpsc::unbounded_channel();
        let mut canvas_capture = capture.clone();
        canvas_capture.jpeg_base64.clear();
        {
            let mut state = self.shared.lock().unwrap();
            state.lesson_events = Some(events_in);
            state.lesson_capture = Some(canvas_capture);
            state.visual_commands.push(VisualCommand::LessonBegin {
                width: capture.screenshot_width,
                height: capture.screenshot_height,
                scale_x: capture.monitor.width as f64 / capture.screenshot_width as f64,
                scale_y: capture.monitor.height as f64 / capture.screenshot_height as f64,
                tiles: capture.tiles.clone(),
                ink: LESSON_INK,
                sounds: config.drawing_sounds,
                monitor: capture.monitor,
            });
        }
        let companion = self.clone();
        let config = config.clone();
        Some(OwnedTask::spawn(async move { companion.run_lesson_voice(config, events_out).await }))
    }

    async fn run_lesson_voice(&self, config: Config, events: mpsc::UnboundedReceiver<LessonEvent>) {
        let is_muted = std::env::var_os(MUTE_ENV_VAR).is_some();
        let (lines_in, mut lines_out) = mpsc::unbounded_channel::<QueuedLine>();
        let intake = OwnedTask::spawn(lesson::collect_lines(events, lines_in, self.http_client.clone(), config, is_muted));

        let started = std::time::Instant::now();
        let mut spoken = Vec::new();
        while let Some(QueuedLine { k, text, audio }) = lines_out.recv().await {
            let audio = audio.await.ok().flatten();
            if spoken.is_empty() {
                log::info!("lesson: first line to mouth in {} ms", started.elapsed().as_millis());
            }
            self.set_voice_state(VoiceState::Responding);
            let duration = audio
                .as_deref()
                .and_then(lesson::audio_duration)
                .unwrap_or_else(|| lesson::estimated_duration(&text));
            visual::send(&self.shared, VisualCommand::LessonLine { k, event: "start", duration });
            match audio {
                Some(audio) => self.play_and_wait(audio).await,
                None if is_muted => tokio::time::sleep(Duration::from_secs_f64(duration)).await,
                None => speech::speak_with_system_voice(&self.shared, &text).await,
            }
            visual::send(&self.shared, VisualCommand::LessonLine { k, event: "end", duration });
            spoken.push(text);
            tokio::time::sleep(lesson::GAP_BETWEEN_LINES).await;
        }
        let state = intake.await.ok().flatten();
        let mut shared = self.shared.lock().unwrap();
        shared.lesson_events = None;
        // An empty list means the program spoke without drawing, so there's nothing on screen.
        shared.lesson_on_screen = state.filter(|state| !state.trim().is_empty());
        shared.last_response = Some(spoken.join(" "));
    }

    /// The user's words with what Claude needs to know about the canvas this turn.
    fn question_with_context(&self, words: &str, screen_captures: &[ScreenCapture]) -> String {
        let capture = screen_captures
            .iter()
            .find(|capture| capture.is_cursor_screen)
            .or_else(|| screen_captures.first());
        let Some(capture) = capture else {
            return words.to_string();
        };
        let on_screen = self.shared.lock().unwrap().lesson_on_screen.clone();
        format!(
            "{}\n{words}",
            lesson::turn_context(capture.screenshot_width, capture.screenshot_height, on_screen.as_deref())
        )
    }

    /// Stops the pen; the drawing itself stays for the next question to build on.
    fn interrupt_drawing(&self) {
        let mut state = self.shared.lock().unwrap();
        state.lesson_events = None;
        state.visual_commands.push(VisualCommand::LessonInterrupt);
    }

    fn fly_to(&self, capture: &ScreenCapture, pixel_x: f64, pixel_y: f64) {
        let (global_x, global_y) = pointing::screenshot_pixel_to_global(capture, pixel_x, pixel_y);
        let mut state = self.shared.lock().unwrap();
        let request_id = state.next_point_request_id;
        state.next_point_request_id += 1;
        state.point_target = Some(PointTarget {
            request_id,
            global_x,
            global_y,
            bubble_text: String::new(),
        });
    }

    /// A program is remembered as code: it shows Claude the form its answers take and what it built.
    async fn remember_program(&self, words: &str, program: &str) {
        let mut history = self.history.lock().await;
        history.push(ConversationTurn {
            user_transcript: words.to_string(),
            assistant_reply: lesson::program_for_history(program),
        });
        let overflow = history.len().saturating_sub(MAX_HISTORY_TURNS);
        history.drain(..overflow);
    }

    /// Opens an (empty) card or 3D stage; steps are added as they stream in.
    fn show_visual(&self, header: serde_json::Value, screen_captures: &[ScreenCapture]) -> Option<u64> {
        let capture = header["screen"]
            .as_u64()
            .and_then(|screen_number| screen_captures.get((screen_number as usize).wrapping_sub(1)))
            .or_else(|| screen_captures.iter().find(|capture| capture.is_cursor_screen))
            .or_else(|| screen_captures.first())?;
        let id = {
            let mut state = self.shared.lock().unwrap();
            let id = state.next_visual_id;
            state.next_visual_id += 1;
            id
        };
        visual::send(
            &self.shared,
            VisualCommand::Show {
                id,
                visual: header,
                scale_x: capture.monitor.width as f64 / capture.screenshot_width as f64,
                scale_y: capture.monitor.height as f64 / capture.screenshot_height as f64,
                monitor: capture.monitor,
            },
        );
        Some(id)
    }

    /// Flies the buddy to the reply's `[POINT]` target, as soon as the reply ends.
    fn point_from_reply(&self, full_text: &str, screen_captures: &[ScreenCapture]) {
        save_last_reply(full_text);
        let (text_outside_visual, visual) = visual::extract_visual_block(full_text);
        let parsed = pointing::parse_point_tag(&text_outside_visual);
        log::info!(
            "reply: {} (point: {:?} {:?}, visual: {})",
            parsed.spoken_text,
            parsed.pixel_coordinate,
            parsed.element_label,
            visual.as_ref().map_or("none".to_string(), |visual| format!(
                "\"{}\", {} step(s)",
                visual["title"].as_str().unwrap_or("untitled"),
                visual::step_lines(visual).len()
            )),
        );
        let Some((pixel_x, pixel_y)) = parsed.pixel_coordinate else {
            return;
        };
        let target_capture = parsed
            .screen_number
            .and_then(|screen_number| screen_captures.get(screen_number.wrapping_sub(1)))
            .or_else(|| screen_captures.iter().find(|capture| capture.is_cursor_screen));
        if let Some(capture) = target_capture {
            let (global_x, global_y) = pointing::screenshot_pixel_to_global(capture, pixel_x, pixel_y);
            let mut state = self.shared.lock().unwrap();
            let request_id = state.next_point_request_id;
            state.next_point_request_id += 1;
            let phrase_index = (request_id as usize) % POINTER_PHRASES.len();
            state.point_target = Some(PointTarget {
                request_id,
                global_x,
                global_y,
                bubble_text: POINTER_PHRASES[phrase_index].to_string(),
            });
        }
    }

    /// Records the spoken answer for the panel and the conversation history.
    async fn remember_turn(&self, transcript: &str, full_text: &str) {
        let (text_outside_visual, visual) = visual::extract_visual_block(full_text);
        let parsed = pointing::parse_point_tag(&text_outside_visual);
        let mut spoken_text = parsed.spoken_text;
        for line in visual.iter().flat_map(visual::step_lines).filter(|line| !line.is_empty()) {
            if !spoken_text.is_empty() {
                spoken_text.push(' ');
            }
            spoken_text.push_str(&line);
        }
        self.shared.lock().unwrap().last_response = Some(spoken_text.clone());

        let mut remembered_reply = spoken_text;
        if let Some(visual) = &visual {
            // So follow-ups like "explain that diagram more" have context.
            remembered_reply.push_str(&format!(
                " [you drew a visual titled \"{}\" for this answer]",
                visual["title"].as_str().unwrap_or("untitled")
            ));
        }
        let mut history = self.history.lock().await;
        history.push(ConversationTurn {
            user_transcript: transcript.to_string(),
            assistant_reply: remembered_reply,
        });
        let overflow = history.len().saturating_sub(MAX_HISTORY_TURNS);
        history.drain(..overflow);
    }

    /// Hides the overlay for a moment so the buddy doesn't show up in its own screenshot.
    async fn capture_screens_without_overlay(&self) -> Result<Vec<capture::ScreenCapture>> {
        let (monitors, cursor_position) = {
            let mut state = self.shared.lock().unwrap();
            state.hide_overlay_for_capture = true;
            (state.monitors.clone(), state.cursor_position)
        };
        tokio::time::sleep(Duration::from_millis(120)).await;
        let result = capture::capture_all_screens(&monitors, cursor_position).await;
        self.shared.lock().unwrap().hide_overlay_for_capture = false;
        result
    }

    async fn speak(&self, config: &Config, text: &str) {
        log::debug!("speaking: {text}");
        if !config.elevenlabs_api_key.is_empty() {
            match speech::synthesize_with_elevenlabs(
                &self.http_client,
                &config.elevenlabs_api_key,
                &config.elevenlabs_voice_id,
                text,
            )
            .await
            {
                Ok(mp3_bytes) => {
                    self.play_and_wait(mp3_bytes).await;
                    return;
                }
                Err(error) => {
                    log::warn!("ElevenLabs failed, trying the next voice: {error:#}");
                    self.shared.lock().unwrap().last_error = Some(format!("ElevenLabs: {error:#}"));
                }
            }
        }
        if !config.puter_auth_token.is_empty() {
            match self.speak_with_puter(config, text).await {
                Ok(()) => return,
                Err(error) => {
                    log::warn!("Puter TTS failed, using system voice: {error:#}");
                    self.shared.lock().unwrap().last_error = Some(format!("Puter: {error:#}"));
                }
            }
        }
        self.set_voice_state(VoiceState::Responding);
        speech::speak_with_system_voice(&self.shared, text).await;
    }

    /// Fails only if the first piece can't be synthesized, so a long reply that
    /// already started out loud never restarts in the system voice.
    async fn speak_with_puter(&self, config: &Config, text: &str) -> Result<()> {
        let settings = crate::puter::VoiceSettings {
            provider: &config.puter_tts_provider,
            voice: &config.puter_tts_voice,
            model: &config.puter_tts_model,
        };
        for (index, chunk) in crate::puter::split_for_synthesis(text).iter().enumerate() {
            let started = std::time::Instant::now();
            let audio = match crate::puter::synthesize(
                &self.http_client,
                &config.puter_auth_token,
                &settings,
                chunk,
            )
            .await
            {
                Ok(audio) => audio,
                Err(error) if index == 0 => return Err(error),
                Err(error) => {
                    log::warn!("Puter TTS failed mid-reply: {error:#}");
                    return Ok(());
                }
            };
            log::info!(
                "Puter TTS: {} chars in {} ms",
                chunk.chars().count(),
                started.elapsed().as_millis()
            );
            self.play_and_wait(audio).await;
        }
        Ok(())
    }

    async fn play_and_wait(&self, audio: Vec<u8>) {
        self.speaker.play_mp3(audio);
        self.set_voice_state(VoiceState::Responding);
        self.speaker.wait_until_finished().await;
    }

    fn set_voice_state(&self, voice_state: VoiceState) {
        self.shared.lock().unwrap().voice_state = voice_state;
    }

    fn report_error(&self, message: &str) {
        log::error!("{message}");
        self.shared.lock().unwrap().last_error = Some(message.to_string());
    }
}

pub fn show_panel(app: &AppHandle) {
    if let Some(panel) = app.get_webview_window("panel") {
        let _ = panel.show();
        let _ = panel.unminimize();
        let _ = panel.set_focus();
    }
}

/// The raw reply, so a drawing can be inspected or replayed with `clicky present`.
fn save_last_reply(full_text: &str) {
    if let Some(cache) = dirs_cache_file("last_reply.txt") {
        if let Err(error) = std::fs::write(&cache, full_text) {
            log::debug!("couldn't save {}: {error}", cache.display());
        }
    }
}

/// Turns streamed text into presenter events and keeps the full reply. The start of
/// the reply decides its route: a program for the sandbox, or plain speech.
struct ReplyFeeder {
    parser: StreamingReplyParser,
    fences: lesson::FenceFilter,
    route: Option<Route>,
    full_text: String,
    events: mpsc::UnboundedSender<ReplyEvent>,
}

impl ReplyFeeder {
    fn new(events: mpsc::UnboundedSender<ReplyEvent>) -> Self {
        ReplyFeeder {
            parser: StreamingReplyParser::new(),
            fences: lesson::FenceFilter::default(),
            route: None,
            full_text: String::new(),
            events,
        }
    }

    fn is_program(&self) -> bool {
        // A reply too short to decide goes as speech, so it's still heard.
        self.route == Some(Route::Program)
    }

    fn feed(&mut self, delta: &str) {
        self.full_text.push_str(delta);
        match self.route {
            Some(route) => self.deliver(route, delta),
            None => {
                let Some(route) = lesson::classify_reply(&self.full_text) else {
                    return;
                };
                self.route = Some(route);
                if route == Route::Program {
                    let _ = self.events.send(ReplyEvent::ProgramStart);
                }
                let everything = self.full_text.clone();
                self.deliver(route, &everything);
            }
        }
    }

    fn deliver(&mut self, route: Route, text: &str) {
        match route {
            Route::Program => {
                let code = self.fences.feed(text);
                if !code.is_empty() {
                    let _ = self.events.send(ReplyEvent::ProgramCode(code));
                }
            }
            Route::Speech => {
                for event in self.parser.feed(text) {
                    let _ = self.events.send(event);
                }
            }
        }
    }

    /// Flushes the last events and closes the channel so the presenter can end.
    fn finish(mut self) -> String {
        if self.route.is_none() {
            let everything = self.full_text.clone();
            self.route = Some(Route::Speech);
            self.deliver(Route::Speech, &everything);
        }
        if self.route == Some(Route::Program) {
            let code = self.fences.finish();
            if !code.is_empty() {
                let _ = self.events.send(ReplyEvent::ProgramCode(code));
            }
            let _ = self.events.send(ReplyEvent::ProgramEnd);
        } else {
            for event in self.parser.finish() {
                let _ = self.events.send(event);
            }
        }
        self.full_text
    }
}

/// `$XDG_CACHE_HOME/clicky/<name>` (or `~/.cache/clicky/<name>`), creating the folder.
fn dirs_cache_file(name: &str) -> Option<std::path::PathBuf> {
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".cache")))?;
    let folder = base.join("clicky");
    std::fs::create_dir_all(&folder).ok()?;
    Some(folder.join(name))
}
