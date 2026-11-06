//! Real-time graphics: hand-drawn diagram cards and on-screen annotations that
//! Claude describes in a `<visual>{json}</visual>` block of its reply.
//!
//! Rendering happens in a transparent, click-through WebKit view on its own
//! layer-shell surface (rough.js + a handwriting font, bundled from
//! `ui/visual/`). The async pipeline never touches GTK: it queues
//! [`VisualCommand`]s in shared state and a GTK timer forwards them to the page
//! as `window.clicky.handle(...)` calls.
//!
//! 3D models (three.js, `ui/visual/scene3d.js`) render on the same surface.
//! They can be dragged, so the page reports the model's rectangle back over a
//! WebKit script message and that rectangle becomes the surface's input
//! region; everything else stays click-through.

use crate::capture::ScreenTiles;
use crate::companion::CompanionEvent;
use crate::lesson::LessonEvent;
use tokio::sync::mpsc::UnboundedSender;
use crate::state::{MonitorGeometry, Shared};
use base64::Engine;
use gtk::prelude::*;
use gtk::{cairo, gdk, glib};
use javascriptcore::ValueExt;
use gtk_layer_shell::{Edge, KeyboardMode, Layer, LayerShell};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::LazyLock;
use std::time::Duration;
use webkit2gtk::{LoadEvent, SettingsExt, UserContentManagerExt, WebViewExt};

const PAGE_CSS: &str = include_str!("../ui/visual/visual.css");
const PAGE_SCRIPT: &str = include_str!("../ui/visual/visual.js");
const ROUGH_JS: &str = include_str!("../ui/visual/rough.js");
const THREE_JS: &str = include_str!("../ui/visual/three.bundle.js");
const SCENE_SCRIPT: &str = include_str!("../ui/visual/scene3d.js");
const SCULPT_SCRIPT: &str = include_str!("../ui/visual/sculpt.js");
/// Name of `window.webkit.messageHandlers.<name>` the page posts to.
const SCRIPT_MESSAGE_HANDLER: &str = "clicky";
const HANDWRITING_FONT: &[u8] = include_bytes!("../ui/visual/PatrickHand.ttf");
const LESSON_CSS: &str = include_str!("../ui/visual/lesson.css");
const LESSON_SCRIPT: &str = include_str!("../ui/visual/lesson.js");
const SMILES_SCRIPT: &str = include_str!("../ui/visual/smiles-drawer.min.js");
const LESSON_WORKER_SCRIPT: &str = include_str!("../ui/visual/lesson_worker.js");
const LESSON_SOUND_SCRIPT: &str = include_str!("../ui/visual/lesson_sound.js");
const STAGE_SCRIPT: &str = include_str!("../ui/visual/stage3d.js");
/// The page draws model-written programs, so it gets no network at all: pictures
/// come in from Rust as data URLs. This also covers the program's worker.
const PAGE_CONTENT_SECURITY_POLICY: &str = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; \
    worker-src blob:; style-src 'unsafe-inline'; font-src data:; img-src data: blob:; media-src data: blob:";
const COMMAND_POLL_INTERVAL: Duration = Duration::from_millis(30);

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum VisualCommand {
    Show {
        id: u64,
        visual: Value,
        /// Screenshot pixels → CSS pixels on the target monitor.
        scale_x: f64,
        scale_y: f64,
        #[serde(skip)]
        monitor: MonitorGeometry,
    },
    /// Reveals step `index`; streamed replies carry the step itself.
    Step {
        id: u64,
        index: usize,
        #[serde(skip_serializing_if = "Option::is_none")]
        step: Option<Value>,
    },
    /// `None` clears whatever is showing.
    Clear {
        id: Option<u64>,
    },
    /// Removes an older `<visual>` card but leaves a lesson's drawing up.
    #[serde(rename = "clear_card")]
    ClearCard,
    /// Starts (or continues, if a drawing is up) a lesson program.
    #[serde(rename = "lesson_begin")]
    LessonBegin {
        width: u32,
        height: u32,
        scale_x: f64,
        scale_y: f64,
        tiles: ScreenTiles,
        ink: &'static str,
        sounds: bool,
        captions: bool,
        /// Being recorded to a video: the on-screen controls stay out of the picture.
        recording: bool,
        #[serde(skip)]
        monitor: MonitorGeometry,
    },
    #[serde(rename = "lesson_code")]
    LessonCode { text: String },
    #[serde(rename = "lesson_end")]
    LessonEnd,
    /// `event` is "start" or "end"; the pen is paced to these.
    #[serde(rename = "lesson_line")]
    LessonLine {
        k: u64,
        event: &'static str,
        duration: f64,
    },
    /// The user talked over the lesson: marks not drawn yet won't be.
    #[serde(rename = "lesson_interrupt")]
    LessonInterrupt,
    #[serde(rename = "lesson_photo")]
    LessonPhoto { id: String, data: String },
    /// A picture of the card being pinned, or no data if it couldn't be taken.
    #[serde(rename = "lesson_pinned")]
    LessonPinned { data: String, width: f64, height: f64 },
    /// Another app came to the front, or the desktop changed.
    #[serde(rename = "lesson_screen_changed")]
    LessonScreenChanged { reason: String },
}

impl VisualCommand {
    fn page_object(&self) -> &'static str {
        match self {
            VisualCommand::LessonBegin { .. }
            | VisualCommand::LessonCode { .. }
            | VisualCommand::LessonEnd
            | VisualCommand::LessonLine { .. }
            | VisualCommand::LessonInterrupt
            | VisualCommand::LessonPhoto { .. }
            | VisualCommand::LessonPinned { .. }
            | VisualCommand::LessonScreenChanged { .. } => "clickyLesson",
            _ => "clicky",
        }
    }
}

pub fn send(shared: &Shared, command: VisualCommand) {
    shared.lock().unwrap().visual_commands.push(command);
}

// ---------------------------------------------------------------- parsing

static VISUAL_BLOCK_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    // A missing closing tag (truncated reply) still counts as a block.
    Regex::new(r"(?s)<visual>(.*?)(?:</visual>|$)").expect("valid visual regex")
});

/// Splits a reply into the text outside the `<visual>` block and the parsed
/// visual. Returns no visual when the block is missing, isn't valid JSON, or
/// has no steps — the caller then falls back to plain speech.
pub fn extract_visual_block(reply_text: &str) -> (String, Option<Value>) {
    let Some(captures) = VISUAL_BLOCK_PATTERN.captures(reply_text) else {
        return (reply_text.to_string(), None);
    };
    let whole = captures.get(0).expect("group 0 always exists");
    let remaining = format!("{} {}", &reply_text[..whole.start()], &reply_text[whole.end()..])
        .trim()
        .to_string();
    let body = captures.get(1).map_or("", |body| body.as_str());
    let visual = parse_visual_json(body);
    if visual.is_none() {
        log::warn!(
            "ignoring unparseable visual block: {}",
            body.chars().take(200).collect::<String>()
        );
    }
    (remaining, visual)
}

fn parse_visual_json(body: &str) -> Option<Value> {
    // Tolerate ```json fences or stray prose around the object.
    let start = body.find('{')?;
    let end = body.rfind('}')?;
    let visual: Value = serde_json::from_str(body.get(start..=end)?).ok()?;
    let has_steps = visual["steps"].as_array().is_some_and(|steps| !steps.is_empty());
    has_steps.then_some(visual)
}

/// The spoken line of every step, in order (empty strings for silent steps).
pub fn step_lines(visual: &Value) -> Vec<String> {
    visual["steps"]
        .as_array()
        .map(|steps| {
            steps
                .iter()
                .map(|step| step["say"].as_str().unwrap_or("").trim().to_string())
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------- GTK side

type InputRects = Rc<RefCell<Vec<cairo::RectangleInt>>>;

struct VisualSurface {
    window: gtk::Window,
    /// Areas that take the mouse (a 3D model being shown); empty = click-through.
    input_rects: InputRects,
    web_view: webkit2gtk::WebView,
    monitor: Option<MonitorGeometry>,
    is_page_ready: Rc<Cell<bool>>,
    is_hidden_for_capture: bool,
}

/// Creates the graphics surface and starts forwarding commands. Must run on
/// the GTK main thread, before the buddy overlay so the buddy stacks on top.
pub fn start(shared: Shared, companion_events: UnboundedSender<CompanionEvent>) {
    let is_page_ready = Rc::new(Cell::new(false));
    let input_rects: InputRects = Rc::default();
    let (window, web_view) = create_visual_window(is_page_ready.clone(), input_rects.clone(), companion_events, shared.clone());
    let surface = Rc::new(RefCell::new(VisualSurface {
        window,
        input_rects,
        web_view,
        monitor: None,
        is_page_ready,
        is_hidden_for_capture: false,
    }));

    glib::timeout_add_local(COMMAND_POLL_INTERVAL, move || {
        forward_pending_commands(&surface, &shared);
        glib::ControlFlow::Continue
    });
}

fn create_visual_window(
    is_page_ready: Rc<Cell<bool>>,
    input_rects: InputRects,
    companion_events: UnboundedSender<CompanionEvent>,
    shared: Shared,
) -> (gtk::Window, webkit2gtk::WebView) {
    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    window.set_title("Clicky graphics");
    window.set_decorated(false);
    window.set_app_paintable(true);
    window.set_accept_focus(false);
    window.set_skip_taskbar_hint(true);
    window.set_skip_pager_hint(true);
    if let Some(visual) = WidgetExt::screen(&window).and_then(|screen| screen.rgba_visual()) {
        window.set_visual(Some(&visual));
    }

    window.init_layer_shell();
    window.set_namespace("clicky-graphics");
    window.set_layer(Layer::Overlay);
    for edge in [Edge::Top, Edge::Bottom, Edge::Left, Edge::Right] {
        window.set_anchor(edge, true);
    }
    window.set_exclusive_zone(-1);
    window.set_keyboard_mode(KeyboardMode::None);
    if let Some(monitor) = primary_or_first_monitor() {
        window.set_monitor(&monitor);
    }

    let web_view = webkit2gtk::WebView::new();
    web_view.set_background_color(&gdk::RGBA::new(0.0, 0.0, 0.0, 0.0));
    if let Some(settings) = WebViewExt::settings(&web_view) {
        settings.set_enable_developer_extras(cfg!(debug_assertions));
        settings.set_enable_write_console_messages_to_stdout(true);
    }
    web_view.connect_load_changed(move |_, load_event| {
        if load_event == LoadEvent::Finished {
            is_page_ready.set(true);
        }
    });
    if let Some(content_manager) = web_view.user_content_manager() {
        content_manager.register_script_message_handler(SCRIPT_MESSAGE_HANDLER);
        let window_for_messages = window.clone();
        let input_rects_for_messages = input_rects.clone();
        let shared_for_messages = shared;
        content_manager.connect_script_message_received(
            Some(SCRIPT_MESSAGE_HANDLER),
            move |_, result| {
                let Some(message) = result.js_value().map(|value| value.to_str().to_string()) else {
                    return;
                };
                if is_dismiss_message(&message) {
                    let _ = companion_events.send(CompanionEvent::Dismiss);
                    return;
                }
                if handle_lesson_message(&message, &shared_for_messages, &companion_events) {
                    return;
                }
                if let Some(rects) = parse_input_rects(&message) {
                    log::debug!("graphics input region: {rects:?}");
                    *input_rects_for_messages.borrow_mut() = rects;
                    apply_input_region(&window_for_messages, &input_rects_for_messages);
                }
            },
        );
    }
    web_view.load_html(&build_page_html(), None);
    window.add(&web_view);

    // An empty input region makes the whole surface click-through.
    let input_rects_for_realize = input_rects.clone();
    window.connect_realize(move |window| apply_input_region(window, &input_rects_for_realize));
    window.show_all();
    apply_input_region(&window, &input_rects);
    (window, web_view)
}

/// Messages from the lesson player. Returns false for anything else. Opening a page
/// and copying only ever come from the user pressing a button the program drew;
/// typing and handing off happen as a line is heard, as the prompt lays down.
fn handle_lesson_message(message: &str, shared: &Shared, companion_events: &UnboundedSender<CompanionEvent>) -> bool {
    let Ok(message) = serde_json::from_str::<Value>(message) else {
        return false;
    };
    let text = |key: &str| message[key].as_str().unwrap_or_default().to_string();
    let report = |event: LessonEvent| {
        if let Some(events) = &shared.lock().unwrap().lesson_events {
            let _ = events.send(event);
        }
    };
    match message["type"].as_str().unwrap_or_default() {
        "say" => report(LessonEvent::Say { k: message["k"].as_u64().unwrap_or(0), text: text("text") }),
        "done" => report(LessonEvent::Done { state: text("state") }),
        "warn" => log::warn!("drawing: {}", text("message")),
        "ask" => {
            let _ = companion_events.send(CompanionEvent::Ask(text("text")));
        }
        "photo" => {
            let _ = companion_events.send(CompanionEvent::LessonPhoto { id: text("id"), query: text("query") });
        }
        "point" => {
            let _ = companion_events.send(CompanionEvent::PointAtCanvas {
                x: message["x"].as_f64().unwrap_or(0.0),
                y: message["y"].as_f64().unwrap_or(0.0),
            });
        }
        "open" => {
            let url = text("url");
            if url.starts_with("https://") || url.starts_with("http://") {
                if let Err(error) = std::process::Command::new("xdg-open").arg(&url).spawn() {
                    log::warn!("couldn't open {url}: {error}");
                }
            }
        }
        "type_text" => {
            let _ = companion_events.send(CompanionEvent::TypeText {
                x: message["x"].as_f64().unwrap_or(0.0),
                y: message["y"].as_f64().unwrap_or(0.0),
                text: text("text"),
            });
        }
        "handoff" => {
            let _ = companion_events.send(CompanionEvent::HandOff { task: text("task"), label: text("label") });
        }
        "pin" => {
            let number = |key: &str| message[key].as_f64().unwrap_or(0.0);
            let _ = companion_events.send(CompanionEvent::PinCard { x: number("x"), y: number("y"), width: number("w"), height: number("h") });
        }
        "save_video" => {
            let _ = companion_events.send(CompanionEvent::SaveVideo);
        }
        "copy" => {
            if let Err(error) = std::process::Command::new("wl-copy").arg("--").arg(text("text")).spawn() {
                log::warn!("couldn't copy: {error}");
            }
        }
        _ => return false,
    }
    true
}

/// `{"type":"dismiss"}`: the user closed the drawing.
fn is_dismiss_message(message: &str) -> bool {
    serde_json::from_str::<Value>(message).is_ok_and(|value| value["type"] == "dismiss")
}

/// `{"type":"input","rects":[[x,y,w,h],...]}` from the page, in CSS pixels
/// (which equal the surface's logical pixels).
fn parse_input_rects(message: &str) -> Option<Vec<cairo::RectangleInt>> {
    let message: Value = serde_json::from_str(message).ok()?;
    if message["type"] != "input" {
        return None;
    }
    Some(
        message["rects"]
            .as_array()?
            .iter()
            .filter_map(|rect| {
                let values: Vec<i32> = rect
                    .as_array()?
                    .iter()
                    .filter_map(|value| value.as_f64().map(|number| number.round() as i32))
                    .collect();
                match values[..] {
                    [x, y, width, height] if width > 0 && height > 0 => {
                        Some(cairo::RectangleInt::new(x, y, width, height))
                    }
                    _ => None,
                }
            })
            .collect(),
    )
}

fn apply_input_region(window: &gtk::Window, input_rects: &InputRects) {
    window.input_shape_combine_region(Some(&cairo::Region::create_rectangles(
        &input_rects.borrow(),
    )));
}

fn build_page_html() -> String {
    let font_base64 = base64::engine::general_purpose::STANDARD.encode(HANDWRITING_FONT);
    let mut html = String::with_capacity(
        font_base64.len() + ROUGH_JS.len() + THREE_JS.len() + SCENE_SCRIPT.len() + SCULPT_SCRIPT.len() + 32_000,
    );
    html.push_str("<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"");
    html.push_str(PAGE_CONTENT_SECURITY_POLICY);
    html.push_str("\"><style>");
    html.push_str("@font-face{font-family:'Hand';font-weight:400 700;src:url(data:font/ttf;base64,");
    html.push_str(&font_base64);
    html.push_str(") format('truetype');}");
    html.push_str(PAGE_CSS);
    html.push_str(LESSON_CSS);
    html.push_str("</style></head><body><script type=\"text/plain\" id=\"lesson-worker-source\">");
    html.push_str(LESSON_WORKER_SCRIPT);
    html.push_str("</script><script>");
    html.push_str(ROUGH_JS);
    html.push_str("</script><script>");
    html.push_str(THREE_JS);
    html.push_str("</script><script>");
    html.push_str(SCENE_SCRIPT);
    html.push_str("</script><script>");
    html.push_str(SCULPT_SCRIPT);
    html.push_str("</script><script>");
    html.push_str(PAGE_SCRIPT);
    html.push_str("</script><script>");
    html.push_str(LESSON_SOUND_SCRIPT);
    html.push_str("</script><script>");
    html.push_str(STAGE_SCRIPT);
    html.push_str("</script><script>");
    html.push_str(SMILES_SCRIPT);
    html.push_str("</script><script>");
    html.push_str(LESSON_SCRIPT);
    html.push_str("</script></body></html>");
    html
}

fn forward_pending_commands(surface_cell: &Rc<RefCell<VisualSurface>>, shared: &Shared) {
    let mut surface = surface_cell.borrow_mut();
    if !surface.is_page_ready.get() {
        return;
    }
    let (commands, hide_for_capture) = {
        let mut state = shared.lock().unwrap();
        (
            std::mem::take(&mut state.visual_commands),
            state.hide_overlay_for_capture,
        )
    };

    if hide_for_capture != surface.is_hidden_for_capture {
        surface.is_hidden_for_capture = hide_for_capture;
        run_script(
            &surface.web_view,
            &format!("window.clicky.setHidden({hide_for_capture})"),
        );
    }

    for command in commands {
        let target_monitor = match &command {
            VisualCommand::Show { monitor, .. } | VisualCommand::LessonBegin { monitor, .. } => Some(*monitor),
            _ => None,
        };
        if let Some(monitor) = target_monitor
            && surface.monitor != Some(monitor)
        {
            move_to_monitor(&mut surface, monitor);
        }
        match serde_json::to_string(&command) {
            Ok(command_json) => run_script(
                &surface.web_view,
                &format!("window.{}.handle({command_json})", command.page_object()),
            ),
            Err(error) => log::error!("couldn't serialize visual command: {error}"),
        }
    }
}

fn move_to_monitor(surface: &mut VisualSurface, geometry: MonitorGeometry) {
    surface.monitor = Some(geometry);
    let Some(gdk_monitor) = find_gdk_monitor(geometry) else {
        return;
    };
    // Layer surfaces pick their output when mapped, so remap on the new one.
    surface.window.hide();
    surface.window.set_monitor(&gdk_monitor);
    surface.window.show_all();
    apply_input_region(&surface.window, &surface.input_rects);
}

fn find_gdk_monitor(geometry: MonitorGeometry) -> Option<gdk::Monitor> {
    let display = gdk::Display::default()?;
    (0..display.n_monitors())
        .filter_map(|index| display.monitor(index))
        .find(|monitor| {
            let rectangle = monitor.geometry();
            (rectangle.x(), rectangle.y(), rectangle.width(), rectangle.height())
                == (geometry.x, geometry.y, geometry.width, geometry.height)
        })
}

fn primary_or_first_monitor() -> Option<gdk::Monitor> {
    let display = gdk::Display::default()?;
    display.primary_monitor().or_else(|| display.monitor(0))
}

fn run_script(web_view: &webkit2gtk::WebView, script: &str) {
    web_view.evaluate_javascript(
        script,
        None,
        None,
        None::<&gtk::gio::Cancellable>,
        |result| {
            if let Err(error) = result {
                log::warn!("visual script failed: {error}");
            }
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_visual_and_keeps_surrounding_text() {
        let reply = r#"here's the idea. <visual>{"title":"t","steps":[{"say":"one","draw":[]},{"say":"two"}]}</visual> [POINT:none]"#;
        let (remaining, visual) = extract_visual_block(reply);
        assert!(remaining.starts_with("here's the idea.") && remaining.ends_with("[POINT:none]"));
        let visual = visual.expect("visual parsed");
        assert_eq!(step_lines(&visual), vec!["one", "two"]);
    }

    #[test]
    fn tolerates_code_fences_and_missing_close_tag() {
        let reply = "<visual>\n```json\n{\"steps\":[{\"say\":\"hi\"}]}\n```";
        let (remaining, visual) = extract_visual_block(reply);
        assert_eq!(remaining, "");
        assert!(visual.is_some());
    }

    #[test]
    fn parses_input_rects_from_page_messages() {
        let rects = parse_input_rects(r#"{"type":"input","rects":[[10,20,300.4,200],[0,0,0,5]]}"#)
            .expect("input message");
        assert_eq!(rects, vec![cairo::RectangleInt::new(10, 20, 300, 200)]);
        assert_eq!(parse_input_rects(r#"{"type":"input","rects":[]}"#), Some(vec![]));
        assert_eq!(parse_input_rects(r#"{"type":"other"}"#), None);
    }

    #[test]
    fn rejects_invalid_or_stepless_visuals() {
        assert!(extract_visual_block("<visual>{not json}</visual>").1.is_none());
        assert!(extract_visual_block("<visual>{\"steps\":[]}</visual>").1.is_none());
        let (remaining, visual) = extract_visual_block("plain answer [POINT:none]");
        assert_eq!(remaining, "plain answer [POINT:none]");
        assert!(visual.is_none());
    }
}
