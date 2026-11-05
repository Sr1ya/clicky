//! The companion system prompt and the `[POINT:x,y:label:screenN]` tag protocol.
//! Claude never calls a tool to point — it appends a tag, we strip it from the
//! spoken text and map the pixel coordinate back onto the real monitor.

use crate::capture::ScreenCapture;
use regex::Regex;
use std::sync::LazyLock;

/// The system prompt is assembled from skill files in `src/prompts/`: who Clicky is,
/// how a lesson program teaches, and the 2D and 3D drawing languages.
pub const COMPANION_SYSTEM_PROMPT: &str = concat!(
    include_str!("prompts/companion.md"),
    include_str!("prompts/skill_lesson.md"),
    include_str!("prompts/skill_2d_lesson.md"),
    include_str!("prompts/skill_3d_lesson.md"),
);

static POINT_TAG_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\[POINT:(?:none|(\d+)\s*,\s*(\d+)(?::([^\]:\s][^\]:]*?))?(?::screen(\d+))?)\]\s*$")
        .expect("valid point regex")
});

#[derive(Debug, PartialEq)]
pub struct ParsedReply {
    /// Reply text with the tag removed — this is what gets spoken.
    pub spoken_text: String,
    pub pixel_coordinate: Option<(f64, f64)>,
    pub element_label: Option<String>,
    /// 1-based screen number from the tag; None means "the cursor's screen".
    pub screen_number: Option<usize>,
}

pub fn parse_point_tag(reply_text: &str) -> ParsedReply {
    let Some(captures) = POINT_TAG_PATTERN.captures(reply_text) else {
        return ParsedReply {
            spoken_text: reply_text.trim().to_string(),
            pixel_coordinate: None,
            element_label: None,
            screen_number: None,
        };
    };
    let tag_start = captures
        .get(0)
        .map_or(reply_text.len(), |whole| whole.start());
    let spoken_text = reply_text[..tag_start].trim().to_string();

    let coordinate = match (captures.get(1), captures.get(2)) {
        (Some(x), Some(y)) => x
            .as_str()
            .parse::<f64>()
            .ok()
            .zip(y.as_str().parse::<f64>().ok()),
        _ => None,
    };
    ParsedReply {
        spoken_text,
        pixel_coordinate: coordinate,
        element_label: captures
            .get(3)
            .map(|label| label.as_str().trim().to_string()),
        screen_number: captures
            .get(4)
            .and_then(|screen| screen.as_str().parse().ok()),
    }
}

/// Maps a coordinate in a screenshot's pixel space to global logical desktop
/// coordinates. Linux screenshots and the desktop both use a top-left origin,
/// so unlike macOS there's no Y flip — only scale and offset.
pub fn screenshot_pixel_to_global(
    capture: &ScreenCapture,
    pixel_x: f64,
    pixel_y: f64,
) -> (f64, f64) {
    let clamped_x = pixel_x.clamp(0.0, capture.screenshot_width as f64);
    let clamped_y = pixel_y.clamp(0.0, capture.screenshot_height as f64);
    let logical_x = clamped_x * capture.monitor.width as f64 / capture.screenshot_width as f64;
    let logical_y = clamped_y * capture.monitor.height as f64 / capture.screenshot_height as f64;
    (
        logical_x + capture.monitor.x as f64,
        logical_y + capture.monitor.y as f64,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::MonitorGeometry;

    #[test]
    fn parses_coordinate_label_and_screen() {
        let parsed = parse_point_tag("over there. [POINT:400,300:terminal:screen2]");
        assert_eq!(parsed.spoken_text, "over there.");
        assert_eq!(parsed.pixel_coordinate, Some((400.0, 300.0)));
        assert_eq!(parsed.element_label.as_deref(), Some("terminal"));
        assert_eq!(parsed.screen_number, Some(2));
    }

    #[test]
    fn parses_none_and_missing_tags() {
        let parsed = parse_point_tag("html is the skeleton. [POINT:none]");
        assert_eq!(parsed.spoken_text, "html is the skeleton.");
        assert_eq!(parsed.pixel_coordinate, None);

        let untagged = parse_point_tag("no tag here");
        assert_eq!(untagged.spoken_text, "no tag here");
        assert_eq!(untagged.pixel_coordinate, None);
    }

    #[test]
    fn maps_screenshot_pixels_onto_offset_monitor() {
        let capture = ScreenCapture {
            jpeg_base64: String::new(),
            label: String::new(),
            is_cursor_screen: false,
            monitor: MonitorGeometry {
                x: 1745,
                y: 0,
                width: 2560,
                height: 1440,
            },
            screenshot_width: 1280,
            screenshot_height: 720,
            tiles: Default::default(),
        };
        assert_eq!(
            screenshot_pixel_to_global(&capture, 640.0, 360.0),
            (1745.0 + 1280.0, 720.0)
        );
        assert_eq!(
            screenshot_pixel_to_global(&capture, 9999.0, -5.0),
            (1745.0 + 2560.0, 0.0)
        );
    }
}
