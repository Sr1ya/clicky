//! The blue triangle buddy.
//!
//! One transparent, click-through window per monitor, placed on the Wayland
//! `overlay` layer via gtk-layer-shell (so it floats above everything, never
//! takes focus, and isn't managed like a normal window). Drawing is plain cairo
//! driven by a 60 fps GTK timer on the main thread; only the small region around
//! the buddy is redrawn each frame.
//!
//! Animation behaviour ports BlueCursorView from the macOS app: follow the
//! cursor, fly along a quadratic Bézier arc to a target, stream a speech bubble,
//! hold, then fly back.

use crate::state::{MonitorGeometry, Shared, VoiceState};
use gtk::prelude::*;
use gtk::{cairo, gdk, glib};
use gtk_layer_shell::{Edge, KeyboardMode, Layer, LayerShell};
use std::cell::{Cell, RefCell};
use std::f64::consts::PI;
use std::rc::Rc;
use std::time::{Duration, Instant};

const FRAME_INTERVAL: Duration = Duration::from_millis(16);
/// The buddy sits this far right/below the real pointer, like the macOS app.
const CURSOR_FOLLOW_OFFSET: (f64, f64) = (35.0, 25.0);
/// Land beside the element instead of covering it.
const TARGET_OFFSET: (f64, f64) = (8.0, 12.0);
const RESTING_ROTATION_DEGREES: f64 = -35.0;
const BUDDY_BLUE: (f64, f64, f64) = (0.23, 0.51, 0.96);
const CHARACTER_STREAM_INTERVAL: Duration = Duration::from_millis(45);
const BUBBLE_HOLD_DURATION: Duration = Duration::from_secs(3);
const BUBBLE_FADE_DURATION: Duration = Duration::from_millis(500);
/// Moving the mouse this far during the return flight snaps back to following.
const RETURN_FLIGHT_CANCEL_DISTANCE: f64 = 100.0;
/// In transient mode, how long the buddy lingers after an interaction ends.
const TRANSIENT_LINGER: Duration = Duration::from_secs(1);
/// Half-size of the area around the buddy that gets redrawn each frame.
const DIRTY_HALF_EXTENT: f64 = 48.0;
const DIRTY_BUBBLE_WIDTH: f64 = 320.0;

#[derive(Clone, Copy)]
enum AfterFlight {
    PointAtTarget,
    ResumeFollowing,
}

enum BuddyMode {
    FollowingCursor,
    Flying {
        start: (f64, f64),
        control: (f64, f64),
        end: (f64, f64),
        started_at: Instant,
        duration_seconds: f64,
        after_flight: AfterFlight,
        cursor_when_started: Option<(f64, f64)>,
    },
    Pointing {
        streaming_started_at: Instant,
        streaming_finished_at: Option<Instant>,
    },
}

struct Buddy {
    position: (f64, f64),
    rotation_degrees: f64,
    flight_scale: f64,
    mode: BuddyMode,
    opacity: f64,
    bubble_text: String,
    bubble_visible_characters: usize,
    bubble_opacity: f64,
    handled_point_request_id: u64,
    active_point_request_id: Option<u64>,
    last_active_at: Instant,
    started_at: Instant,
    // Copied from shared state each frame for drawing.
    voice_state: VoiceState,
    audio_power_level: f64,
    smoothed_audio_level: f64,
    previous_dirty_rect: Option<(f64, f64, f64, f64)>,
}

/// A small surface that travels with the buddy. Repainting a monitor-sized GTK
/// surface every frame takes a whole CPU core on Wayland and starves everything else
/// on the main thread, including the graphics surface.
struct OverlaySurface {
    window: gtk::Window,
    geometry: MonitorGeometry,
    /// Where the surface sits on its monitor (the layer-shell margins).
    origin: Rc<Cell<(i32, i32)>>,
}

struct Overlay {
    shared: Shared,
    surfaces: Vec<OverlaySurface>,
    buddy: Buddy,
}

/// Creates the overlay windows and starts the animation loop. Must run on the
/// GTK main thread (Tauri's setup hook on Linux).
pub fn start(shared: Shared) {
    if !gtk_layer_shell::is_supported() {
        log::warn!("compositor lacks wlr-layer-shell; the buddy may not stay on top");
    }
    let now = Instant::now();
    let overlay = Rc::new(RefCell::new(Overlay {
        shared,
        surfaces: Vec::new(),
        buddy: Buddy {
            position: (0.0, 0.0),
            rotation_degrees: RESTING_ROTATION_DEGREES,
            flight_scale: 1.0,
            mode: BuddyMode::FollowingCursor,
            opacity: 0.0,
            bubble_text: String::new(),
            bubble_visible_characters: 0,
            bubble_opacity: 0.0,
            handled_point_request_id: 0,
            active_point_request_id: None,
            last_active_at: now,
            started_at: now,
            voice_state: VoiceState::Idle,
            audio_power_level: 0.0,
            smoothed_audio_level: 0.0,
            previous_dirty_rect: None,
        },
    }));

    rebuild_surfaces(&overlay);
    if let Some(display) = gdk::Display::default() {
        let overlay_for_added = overlay.clone();
        display.connect_monitor_added(move |_, _| rebuild_surfaces(&overlay_for_added));
        let overlay_for_removed = overlay.clone();
        display.connect_monitor_removed(move |_, _| rebuild_surfaces(&overlay_for_removed));
    }

    glib::timeout_add_local(FRAME_INTERVAL, move || {
        tick(&overlay);
        glib::ControlFlow::Continue
    });
}

fn rebuild_surfaces(overlay: &Rc<RefCell<Overlay>>) {
    let Some(display) = gdk::Display::default() else {
        return;
    };
    let old_surfaces = std::mem::take(&mut overlay.borrow_mut().surfaces);
    for surface in old_surfaces {
        surface.window.close();
    }

    let mut geometries = Vec::new();
    for monitor_index in 0..display.n_monitors() {
        let Some(monitor) = display.monitor(monitor_index) else {
            continue;
        };
        let rectangle = monitor.geometry();
        let geometry = MonitorGeometry {
            x: rectangle.x(),
            y: rectangle.y(),
            width: rectangle.width(),
            height: rectangle.height(),
        };
        geometries.push(geometry);
        let origin = Rc::new(Cell::new((0, 0)));
        let window = create_overlay_window(&monitor, overlay.clone(), geometry, origin.clone());
        overlay
            .borrow_mut()
            .surfaces
            .push(OverlaySurface { window, geometry, origin });
    }
    log::info!("overlay on {} monitor(s): {geometries:?}", geometries.len());
    overlay.borrow().shared.lock().unwrap().monitors = geometries;
}

fn create_overlay_window(
    monitor: &gdk::Monitor,
    overlay: Rc<RefCell<Overlay>>,
    geometry: MonitorGeometry,
    origin: Rc<Cell<(i32, i32)>>,
) -> gtk::Window {
    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    window.set_title("Clicky overlay");
    window.set_decorated(false);
    window.set_app_paintable(true);
    window.set_accept_focus(false);
    window.set_skip_taskbar_hint(true);
    window.set_skip_pager_hint(true);
    if let Some(visual) = WidgetExt::screen(&window).and_then(|screen| screen.rgba_visual()) {
        window.set_visual(Some(&visual));
    }

    window.init_layer_shell();
    window.set_namespace("clicky");
    window.set_layer(Layer::Overlay);
    window.set_monitor(monitor);
    window.set_anchor(Edge::Top, true);
    window.set_anchor(Edge::Left, true);
    window.set_size_request(surface_size().0, surface_size().1);
    window.set_exclusive_zone(-1);
    window.set_keyboard_mode(KeyboardMode::None);

    window.connect_draw(move |_, context| {
        let overlay = overlay.borrow();
        // The buddy is drawn in monitor coordinates; this surface is a window onto them.
        let (origin_x, origin_y) = origin.get();
        context.translate(-origin_x as f64, -origin_y as f64);
        draw_buddy(context, &overlay.buddy, geometry);
        glib::Propagation::Stop
    });

    // An empty input region makes the whole surface click-through.
    window.connect_realize(|window| {
        window.input_shape_combine_region(Some(&cairo::Region::create()));
    });
    window.input_shape_combine_region(Some(&cairo::Region::create()));
    window.show_all();
    window
}

// ---------------------------------------------------------------- animation

fn tick(overlay_cell: &Rc<RefCell<Overlay>>) {
    let mut overlay_guard = overlay_cell.borrow_mut();
    // Plain &mut so `buddy` and `shared` can be borrowed independently.
    let overlay: &mut Overlay = &mut overlay_guard;
    let now = Instant::now();

    let (
        cursor,
        point_target,
        hide_for_capture,
        show_always,
        is_tts_playing,
        voice_state,
        audio_level,
        first_monitor,
    ) = {
        let state = overlay.shared.lock().unwrap();
        (
            state.cursor_position,
            state.point_target.clone(),
            state.hide_overlay_for_capture,
            state.show_cursor_always,
            state.is_tts_playing,
            state.voice_state,
            state.audio_power_level as f64,
            state.monitors.first().copied(),
        )
    };

    let buddy = &mut overlay.buddy;
    buddy.voice_state = voice_state;
    buddy.audio_power_level = audio_level;
    buddy.smoothed_audio_level += (audio_level - buddy.smoothed_audio_level) * 0.35;

    // Where the buddy rests when not flying: beside the pointer, or (without
    // KWin cursor reports) near the centre of the first monitor.
    let resting_position = cursor
        .map(|(x, y)| (x + CURSOR_FOLLOW_OFFSET.0, y + CURSOR_FOLLOW_OFFSET.1))
        .or_else(|| {
            first_monitor.map(|monitor| {
                (
                    monitor.x as f64 + monitor.width as f64 * 0.5,
                    monitor.y as f64 + monitor.height as f64 * 0.5,
                )
            })
        })
        .unwrap_or(buddy.position);

    // A new pointing request from Claude starts a flight.
    if let Some(target) = &point_target {
        if target.request_id != buddy.handled_point_request_id {
            buddy.handled_point_request_id = target.request_id;
            buddy.active_point_request_id = Some(target.request_id);
            buddy.bubble_text = target.bubble_text.clone();
            buddy.bubble_visible_characters = 0;
            buddy.bubble_opacity = 0.0;
            if matches!(buddy.mode, BuddyMode::FollowingCursor) {
                buddy.position = resting_position;
            }
            let destination = (
                target.global_x + TARGET_OFFSET.0,
                target.global_y + TARGET_OFFSET.1,
            );
            log::debug!("flying from {:?} to {destination:?}", buddy.position);
            start_flight(buddy, destination, AfterFlight::PointAtTarget, now, None);
        }
    } else if buddy.active_point_request_id.is_some() {
        // The target was cleared (user pressed the hotkey again): snap back.
        buddy.active_point_request_id = None;
        buddy.mode = BuddyMode::FollowingCursor;
        buddy.bubble_opacity = 0.0;
        buddy.flight_scale = 1.0;
        buddy.rotation_degrees = RESTING_ROTATION_DEGREES;
    }

    let mut finished_point_request = false;
    match &buddy.mode {
        BuddyMode::FollowingCursor => {
            buddy.position = resting_position;
        }
        BuddyMode::Flying {
            start,
            control,
            end,
            started_at,
            duration_seconds,
            after_flight,
            cursor_when_started,
        } => {
            let (start, control, end, after_flight) = (*start, *control, *end, *after_flight);
            let linear_progress =
                (now.duration_since(*started_at).as_secs_f64() / duration_seconds).min(1.0);

            let cursor_moved_away = matches!(after_flight, AfterFlight::ResumeFollowing)
                && match (cursor, cursor_when_started) {
                    (Some((x, y)), Some((start_x, start_y))) => {
                        (x - start_x).hypot(y - start_y) > RETURN_FLIGHT_CANCEL_DISTANCE
                    }
                    _ => false,
                };

            if cursor_moved_away {
                buddy.mode = BuddyMode::FollowingCursor;
                buddy.flight_scale = 1.0;
                buddy.rotation_degrees = RESTING_ROTATION_DEGREES;
                finished_point_request = true;
            } else if linear_progress >= 1.0 {
                buddy.position = end;
                buddy.flight_scale = 1.0;
                match after_flight {
                    AfterFlight::PointAtTarget => {
                        buddy.rotation_degrees = RESTING_ROTATION_DEGREES;
                        buddy.bubble_opacity = 1.0;
                        buddy.mode = BuddyMode::Pointing {
                            streaming_started_at: now,
                            streaming_finished_at: None,
                        };
                    }
                    AfterFlight::ResumeFollowing => {
                        buddy.rotation_degrees = RESTING_ROTATION_DEGREES;
                        buddy.mode = BuddyMode::FollowingCursor;
                        finished_point_request = true;
                    }
                }
            } else {
                // Smoothstep easing, then the quadratic Bézier B(t) and its tangent B'(t).
                let t = linear_progress * linear_progress * (3.0 - 2.0 * linear_progress);
                let one_minus_t = 1.0 - t;
                buddy.position = (
                    one_minus_t * one_minus_t * start.0
                        + 2.0 * one_minus_t * t * control.0
                        + t * t * end.0,
                    one_minus_t * one_minus_t * start.1
                        + 2.0 * one_minus_t * t * control.1
                        + t * t * end.1,
                );
                let tangent_x =
                    2.0 * one_minus_t * (control.0 - start.0) + 2.0 * t * (end.0 - control.0);
                let tangent_y =
                    2.0 * one_minus_t * (control.1 - start.1) + 2.0 * t * (end.1 - control.1);
                // +90° because the triangle's tip points up at 0° rotation.
                buddy.rotation_degrees = tangent_y.atan2(tangent_x).to_degrees() + 90.0;
                buddy.flight_scale = 1.0 + (linear_progress * PI).sin() * 0.3;
            }
        }
        BuddyMode::Pointing {
            streaming_started_at,
            streaming_finished_at,
        } => {
            let (streaming_started_at, streaming_finished_at) =
                (*streaming_started_at, *streaming_finished_at);
            let character_count = buddy.bubble_text.chars().count();
            let streamed = (now.duration_since(streaming_started_at).as_millis()
                / CHARACTER_STREAM_INTERVAL.as_millis()) as usize
                + 1;
            buddy.bubble_visible_characters = streamed.min(character_count);

            match streaming_finished_at {
                None if buddy.bubble_visible_characters >= character_count => {
                    buddy.mode = BuddyMode::Pointing {
                        streaming_started_at,
                        streaming_finished_at: Some(now),
                    };
                }
                Some(finished_at) => {
                    let since_finished = now.duration_since(finished_at);
                    if since_finished >= BUBBLE_HOLD_DURATION {
                        let fade_progress = (since_finished - BUBBLE_HOLD_DURATION).as_secs_f64()
                            / BUBBLE_FADE_DURATION.as_secs_f64();
                        buddy.bubble_opacity = (1.0 - fade_progress).max(0.0);
                        if fade_progress >= 1.0 {
                            if cursor.is_some() {
                                start_flight(
                                    buddy,
                                    resting_position,
                                    AfterFlight::ResumeFollowing,
                                    now,
                                    cursor,
                                );
                            } else {
                                buddy.mode = BuddyMode::FollowingCursor;
                                finished_point_request = true;
                            }
                        }
                    }
                }
                None => {}
            }
        }
    }

    if finished_point_request {
        buddy.bubble_opacity = 0.0;
        if let Some(request_id) = buddy.active_point_request_id.take() {
            let mut state = overlay.shared.lock().unwrap();
            if state
                .point_target
                .as_ref()
                .is_some_and(|target| target.request_id == request_id)
            {
                state.point_target = None;
            }
        }
    }

    // Visibility: always-on mode shows the buddy whenever we know where the
    // cursor is; transient mode only during an interaction (+ a short linger).
    let buddy = &mut overlay.buddy;
    let is_interacting = voice_state != VoiceState::Idle
        || is_tts_playing
        || !matches!(buddy.mode, BuddyMode::FollowingCursor);
    if is_interacting {
        buddy.last_active_at = now;
    }
    let should_show = (show_always && cursor.is_some())
        || is_interacting
        || now.duration_since(buddy.last_active_at) < TRANSIENT_LINGER;
    if hide_for_capture {
        buddy.opacity = 0.0;
    } else {
        let target_opacity = if should_show { 1.0 } else { 0.0 };
        buddy.opacity += (target_opacity - buddy.opacity) * 0.2;
        if (buddy.opacity - target_opacity).abs() < 0.01 {
            buddy.opacity = target_opacity;
        }
    }

    queue_redraw_around_buddy(overlay);
}

fn start_flight(
    buddy: &mut Buddy,
    destination: (f64, f64),
    after_flight: AfterFlight,
    now: Instant,
    cursor_when_started: Option<(f64, f64)>,
) {
    let start = buddy.position;
    let distance = (destination.0 - start.0).hypot(destination.1 - start.1);
    // Short hops are quick, long flights more dramatic.
    let duration_seconds = (distance / 800.0).clamp(0.6, 1.4);
    let arc_height = (distance * 0.2).min(80.0);
    let control = (
        (start.0 + destination.0) / 2.0,
        (start.1 + destination.1) / 2.0 - arc_height,
    );
    buddy.mode = BuddyMode::Flying {
        start,
        control,
        end: destination,
        started_at: now,
        duration_seconds,
        after_flight,
        cursor_when_started,
    };
}

fn surface_size() -> (i32, i32) {
    (
        (DIRTY_HALF_EXTENT * 2.0 + DIRTY_BUBBLE_WIDTH).ceil() as i32,
        (DIRTY_HALF_EXTENT * 2.0 + 24.0).ceil() as i32,
    )
}

/// Moves each surface to the buddy and repaints it, if the buddy is or just was there.
fn queue_redraw_around_buddy(overlay: &mut Overlay) {
    let buddy = &mut overlay.buddy;
    let is_visible = buddy.opacity > 0.0;
    let was_visible = buddy.previous_dirty_rect.is_some();
    if !is_visible && !was_visible {
        return;
    }
    let (width, height) = surface_size();
    let position = buddy.position;
    let previous = buddy.previous_dirty_rect;
    buddy.previous_dirty_rect = is_visible.then_some((position.0, position.1, 0.0, 0.0));

    for surface in &overlay.surfaces {
        let contains = |point: (f64, f64)| surface.geometry.contains(point.0, point.1);
        if !contains(position) && !previous.is_some_and(|rect| contains((rect.0, rect.1))) {
            continue;
        }
        if is_visible && contains(position) {
            let left = (position.0 - surface.geometry.x as f64 - DIRTY_HALF_EXTENT).floor() as i32;
            let top = (position.1 - surface.geometry.y as f64 - DIRTY_HALF_EXTENT).floor() as i32;
            let origin = (
                left.clamp(0, (surface.geometry.width - width).max(0)),
                top.clamp(0, (surface.geometry.height - height).max(0)),
            );
            if origin != surface.origin.get() {
                surface.origin.set(origin);
                surface.window.set_layer_shell_margin(Edge::Left, origin.0);
                surface.window.set_layer_shell_margin(Edge::Top, origin.1);
            }
        }
        surface.window.queue_draw();
    }
}

// ---------------------------------------------------------------- drawing

fn draw_buddy(context: &cairo::Context, buddy: &Buddy, geometry: MonitorGeometry) {
    // Clear whatever region GTK asked us to repaint to full transparency.
    context.set_operator(cairo::Operator::Source);
    context.set_source_rgba(0.0, 0.0, 0.0, 0.0);
    let _ = context.paint();
    context.set_operator(cairo::Operator::Over);

    if buddy.opacity <= 0.0 {
        return;
    }
    let local_x = buddy.position.0 - geometry.x as f64;
    let local_y = buddy.position.1 - geometry.y as f64;
    let opacity = buddy.opacity;
    let (red, green, blue) = BUDDY_BLUE;
    let elapsed_seconds = buddy.started_at.elapsed().as_secs_f64();

    // Soft glow, stronger while flying.
    let glow_radius = 20.0 * buddy.flight_scale;
    let glow = cairo::RadialGradient::new(local_x, local_y, 0.0, local_x, local_y, glow_radius);
    let glow_strength = if matches!(buddy.mode, BuddyMode::Flying { .. }) {
        0.5
    } else {
        0.3
    };
    glow.add_color_stop_rgba(0.0, red, green, blue, glow_strength * opacity);
    glow.add_color_stop_rgba(1.0, red, green, blue, 0.0);
    let _ = context.set_source(&glow);
    context.arc(local_x, local_y, glow_radius, 0.0, 2.0 * PI);
    let _ = context.fill();

    // The triangle itself (tip up at 0°, rotated like the macOS buddy).
    let _ = context.save();
    context.translate(local_x, local_y);
    context.rotate(buddy.rotation_degrees.to_radians());
    context.scale(buddy.flight_scale, buddy.flight_scale);
    context.move_to(0.0, -10.0);
    context.line_to(7.5, 8.0);
    context.line_to(-7.5, 8.0);
    context.close_path();
    context.set_source_rgba(red, green, blue, opacity);
    let _ = context.fill_preserve();
    context.set_source_rgba(1.0, 1.0, 1.0, 0.9 * opacity);
    context.set_line_width(1.5);
    let _ = context.stroke();
    let _ = context.restore();

    let accessory_x = local_x + 18.0;
    match buddy.voice_state {
        VoiceState::Listening => {
            // Live waveform: five bars driven by mic level with a little motion.
            let level = buddy.smoothed_audio_level.max(0.08);
            for bar_index in 0..5 {
                let wobble = ((elapsed_seconds * 9.0) + bar_index as f64 * 1.3).sin() * 0.5 + 0.5;
                let bar_height = 4.0 + 18.0 * level * (0.45 + 0.55 * wobble);
                let bar_x = accessory_x + bar_index as f64 * 5.0;
                rounded_rectangle(
                    context,
                    bar_x,
                    local_y - bar_height / 2.0,
                    3.0,
                    bar_height,
                    1.5,
                );
                context.set_source_rgba(red, green, blue, opacity);
                let _ = context.fill();
            }
        }
        VoiceState::Processing => {
            let start_angle = elapsed_seconds * 2.0 * PI / 0.8;
            context.set_line_width(2.5);
            context.set_line_cap(cairo::LineCap::Round);
            context.set_source_rgba(red, green, blue, opacity);
            context.arc(
                accessory_x + 7.0,
                local_y,
                7.0,
                start_angle,
                start_angle + 1.4 * PI,
            );
            let _ = context.stroke();
        }
        VoiceState::Responding => {
            let pulse = (elapsed_seconds * 4.0).sin() * 0.5 + 0.5;
            context.set_line_width(2.0);
            context.set_source_rgba(red, green, blue, (0.25 + 0.5 * pulse) * opacity);
            context.arc(local_x, local_y, 14.0 + 4.0 * pulse, 0.0, 2.0 * PI);
            let _ = context.stroke();
        }
        VoiceState::Idle => {}
    }

    if buddy.bubble_opacity > 0.0 && buddy.bubble_visible_characters > 0 {
        let visible_text: String = buddy
            .bubble_text
            .chars()
            .take(buddy.bubble_visible_characters)
            .collect();
        context.select_font_face("Sans", cairo::FontSlant::Normal, cairo::FontWeight::Bold);
        context.set_font_size(13.0);
        let text_width = context
            .text_extents(&visible_text)
            .map(|extents| extents.x_advance())
            .unwrap_or(60.0);
        let bubble_x = local_x + 16.0;
        let bubble_y = local_y + 6.0;
        let bubble_alpha = buddy.bubble_opacity * opacity;
        rounded_rectangle(context, bubble_x, bubble_y, text_width + 18.0, 24.0, 12.0);
        context.set_source_rgba(red, green, blue, 0.95 * bubble_alpha);
        let _ = context.fill();
        context.set_source_rgba(1.0, 1.0, 1.0, bubble_alpha);
        context.move_to(bubble_x + 9.0, bubble_y + 16.5);
        let _ = context.show_text(&visible_text);
    }
}

fn rounded_rectangle(
    context: &cairo::Context,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    radius: f64,
) {
    let radius = radius.min(width / 2.0).min(height / 2.0);
    context.new_sub_path();
    context.arc(x + width - radius, y + radius, radius, -PI / 2.0, 0.0);
    context.arc(
        x + width - radius,
        y + height - radius,
        radius,
        0.0,
        PI / 2.0,
    );
    context.arc(x + radius, y + height - radius, radius, PI / 2.0, PI);
    context.arc(x + radius, y + radius, radius, PI, 1.5 * PI);
    context.close_path();
}
