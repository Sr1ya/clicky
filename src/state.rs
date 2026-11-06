//! State shared between the async pipeline (tokio tasks), the GTK overlay
//! (main thread, 60fps tick), and the Tauri panel (polled via commands).
//! Locks are held only for short reads/writes, so a plain std Mutex is fine.

use crate::capture::ScreenCapture;
use crate::lesson::LessonEvent;
use crate::visual::VisualCommand;
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc::UnboundedSender;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VoiceState {
    Idle,
    Listening,
    Processing,
    Responding,
}

/// Logical (compositor) geometry of one monitor. KWin cursor positions and
/// GDK monitor geometry both use this global logical coordinate space.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct MonitorGeometry {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl MonitorGeometry {
    pub fn contains(&self, point_x: f64, point_y: f64) -> bool {
        point_x >= self.x as f64
            && point_x < (self.x + self.width) as f64
            && point_y >= self.y as f64
            && point_y < (self.y + self.height) as f64
    }
}

/// A UI element Claude asked the buddy to fly to, in global logical coords.
#[derive(Clone, Debug)]
pub struct PointTarget {
    /// Increments for every new target so the overlay can tell a fresh
    /// request apart from the one it is already animating.
    pub request_id: u64,
    pub global_x: f64,
    pub global_y: f64,
    pub bubble_text: String,
}

pub struct SharedState {
    pub voice_state: VoiceState,
    /// RMS microphone level, 0.0..=1.0, drives the waveform next to the cursor.
    pub audio_power_level: f32,
    /// Last known global cursor position reported by the KWin script.
    /// None until the first report arrives (or if KWin scripting is unavailable).
    pub cursor_position: Option<(f64, f64)>,
    pub monitors: Vec<MonitorGeometry>,
    pub point_target: Option<PointTarget>,
    pub next_point_request_id: u64,
    /// Set briefly while screenshotting so the overlay doesn't end up in the image.
    pub hide_overlay_for_capture: bool,
    /// User preference: keep the buddy visible all the time. When false the
    /// buddy only appears during an interaction ("transient mode").
    pub show_cursor_always: bool,
    pub is_tts_playing: bool,
    pub last_transcript: Option<String>,
    pub last_response: Option<String>,
    pub last_error: Option<String>,
    pub hotkey_status: String,
    pub cursor_tracking_status: String,
    /// Drained by the GTK graphics surface every frame or so.
    pub visual_commands: Vec<VisualCommand>,
    pub next_visual_id: u64,
    /// The running program's reports go here while a lesson is being spoken.
    pub lesson_events: Option<UnboundedSender<LessonEvent>>,
    /// While a lesson is being recorded: each spoken clip and when it started.
    pub speech_capture: Option<Vec<(std::time::Instant, Vec<u8>)>>,
    /// What's on the canvas, as the sandbox lists it. `Some` while a drawing is up.
    pub lesson_on_screen: Option<String>,
    /// The screen the lesson is drawn on, to map canvas pixels onto the desktop.
    pub lesson_capture: Option<ScreenCapture>,
}

pub type Shared = Arc<Mutex<SharedState>>;

pub fn new_shared(show_cursor_always: bool) -> Shared {
    Arc::new(Mutex::new(SharedState {
        voice_state: VoiceState::Idle,
        audio_power_level: 0.0,
        cursor_position: None,
        monitors: Vec::new(),
        point_target: None,
        next_point_request_id: 1,
        hide_overlay_for_capture: false,
        show_cursor_always,
        is_tts_playing: false,
        last_transcript: None,
        last_response: None,
        last_error: None,
        hotkey_status: "starting…".into(),
        cursor_tracking_status: "starting…".into(),
        visual_commands: Vec::new(),
        lesson_events: None,
        speech_capture: None,
        lesson_on_screen: None,
        lesson_capture: None,
        next_visual_id: 1,
    }))
}

/// Snapshot sent to the panel UI.
#[derive(Serialize)]
pub struct StatusSnapshot {
    pub voice_state: VoiceState,
    pub last_transcript: Option<String>,
    pub last_response: Option<String>,
    pub last_error: Option<String>,
    pub hotkey_status: String,
    pub cursor_tracking_status: String,
    pub show_cursor_always: bool,
    pub monitors: Vec<MonitorGeometry>,
}

impl SharedState {
    pub fn snapshot(&self) -> StatusSnapshot {
        StatusSnapshot {
            voice_state: self.voice_state,
            last_transcript: self.last_transcript.clone(),
            last_response: self.last_response.clone(),
            last_error: self.last_error.clone(),
            hotkey_status: self.hotkey_status.clone(),
            cursor_tracking_status: self.cursor_tracking_status.clone(),
            show_cursor_always: self.show_cursor_always,
            monitors: self.monitors.clone(),
        }
    }
}
