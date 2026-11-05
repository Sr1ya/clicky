//! Incremental parsing of Claude's streamed reply so Clicky can start talking
//! and drawing before the reply is finished.
//!
//! Feed text deltas in as they arrive; out come, in order:
//! - [`ReplyEvent::Speech`] — whole sentences of plain spoken text,
//! - [`ReplyEvent::VisualHeader`] — the `<visual>` object minus its steps, as
//!   soon as the `"steps"` key is reached,
//! - [`ReplyEvent::VisualStep`] — each step object the moment it closes.
//!
//! The `[POINT:...]` tag and any code fences or `</visual>` are never spoken.
//! The tag itself is parsed from the full text at the end, as before.

use serde_json::Value;

/// Don't hand speech over in fragments shorter than this (unless it's the end).
const MIN_SPEECH_CHUNK_CHARACTERS: usize = 24;
const VISUAL_OPEN_TAG: &str = "<visual>";
const VISUAL_CLOSE_TAG: &str = "</visual>";
const POINT_TAG_START: &str = "[POINT";

#[derive(Debug, PartialEq)]
pub enum ReplyEvent {
    Speech(String),
    VisualHeader(Value),
    VisualStep(Value),
    /// The reply is a drawing program (routed by the feeder in `companion.rs`).
    ProgramStart,
    ProgramCode(String),
    ProgramEnd,
}

#[derive(Debug, PartialEq)]
enum Mode {
    /// Plain spoken text.
    Outside,
    /// Inside `<visual>`, scanning the JSON object.
    InVisual,
    /// Reached the `[POINT` tag; nothing after it is spoken.
    Finished,
}

#[derive(Default)]
struct JsonScanner {
    object_start: Option<usize>,
    depth: usize,
    in_string: bool,
    escaped: bool,
    string_start: usize,
    last_depth1_string: Option<(usize, usize)>,
    in_steps: bool,
    step_start: Option<usize>,
}

pub struct StreamingReplyParser {
    text: String,
    mode: Mode,
    /// Next unread byte of `text` (always on a char boundary).
    cursor: usize,
    /// Outside text that has been read but not spoken yet.
    pending_speech: String,
    scanner: JsonScanner,
}

impl StreamingReplyParser {
    pub fn new() -> Self {
        StreamingReplyParser {
            text: String::new(),
            mode: Mode::Outside,
            cursor: 0,
            pending_speech: String::new(),
            scanner: JsonScanner::default(),
        }
    }

    pub fn feed(&mut self, delta: &str) -> Vec<ReplyEvent> {
        self.text.push_str(delta);
        let mut events = Vec::new();
        self.advance(&mut events, false);
        events
    }

    /// Flushes whatever is left once the stream has ended.
    pub fn finish(&mut self) -> Vec<ReplyEvent> {
        let mut events = Vec::new();
        self.advance(&mut events, true);
        let remaining = clean_speech(&self.pending_speech);
        self.pending_speech.clear();
        if !remaining.is_empty() {
            events.push(ReplyEvent::Speech(remaining));
        }
        events
    }

    fn advance(&mut self, events: &mut Vec<ReplyEvent>, is_final: bool) {
        loop {
            match self.mode {
                Mode::Outside => {
                    if !self.advance_outside(events, is_final) {
                        return;
                    }
                }
                Mode::InVisual => {
                    if !self.advance_visual(events) {
                        return;
                    }
                }
                Mode::Finished => return,
            }
        }
    }

    /// Returns true when the mode changed and parsing should continue.
    fn advance_outside(&mut self, events: &mut Vec<ReplyEvent>, is_final: bool) -> bool {
        let unread = &self.text[self.cursor..];
        let visual_at = unread.find(VISUAL_OPEN_TAG);
        let point_at = unread.find(POINT_TAG_START);
        // A visual tag counts only if it comes before the POINT tag.
        let visual_at = visual_at.filter(|visual| point_at.is_none_or(|point| *visual < point));
        match (visual_at, point_at) {
            (Some(visual), _) => {
                self.pending_speech.push_str(&unread[..visual]);
                self.cursor += visual + VISUAL_OPEN_TAG.len();
                // Everything said before the drawing starts is spoken first.
                let intro = clean_speech(&self.pending_speech);
                self.pending_speech.clear();
                if !intro.is_empty() {
                    events.push(ReplyEvent::Speech(intro));
                }
                self.mode = Mode::InVisual;
                self.scanner = JsonScanner::default();
                true
            }
            (_, Some(point)) => {
                self.pending_speech.push_str(&unread[..point]);
                self.cursor = self.text.len();
                self.mode = Mode::Finished;
                false
            }
            (None, None) => {
                // Hold back a trailing fragment that might be the start of a tag.
                let committable = if is_final {
                    unread.len()
                } else {
                    unread.len() - possible_tag_prefix_length(unread)
                };
                self.pending_speech.push_str(&unread[..committable]);
                self.cursor += committable;
                self.emit_complete_sentences(events);
                false
            }
        }
    }

    fn emit_complete_sentences(&mut self, events: &mut Vec<ReplyEvent>) {
        while let Some(end) = sentence_boundary(&self.pending_speech, MIN_SPEECH_CHUNK_CHARACTERS) {
            let sentence = clean_speech(&self.pending_speech[..end]);
            self.pending_speech.drain(..end);
            if !sentence.is_empty() {
                events.push(ReplyEvent::Speech(sentence));
            }
        }
    }

    /// Scans JSON bytes; returns true when the visual object closed.
    fn advance_visual(&mut self, events: &mut Vec<ReplyEvent>) -> bool {
        let bytes = self.text.as_bytes();
        let scanner = &mut self.scanner;
        while self.cursor < bytes.len() {
            let index = self.cursor;
            let byte = bytes[index];
            self.cursor += 1;

            if scanner.object_start.is_none() {
                if byte == b'{' {
                    scanner.object_start = Some(index);
                    scanner.depth = 1;
                } else if self.text[index..].starts_with(VISUAL_CLOSE_TAG) {
                    // An empty or malformed block: give up on it.
                    self.cursor = index + VISUAL_CLOSE_TAG.len();
                    self.mode = Mode::Outside;
                    return true;
                }
                continue;
            }

            if scanner.in_string {
                if scanner.escaped {
                    scanner.escaped = false;
                } else if byte == b'\\' {
                    scanner.escaped = true;
                } else if byte == b'"' {
                    scanner.in_string = false;
                    if scanner.depth == 1 {
                        scanner.last_depth1_string = Some((scanner.string_start, index + 1));
                    }
                }
                continue;
            }

            match byte {
                b'"' => {
                    scanner.in_string = true;
                    scanner.string_start = index;
                }
                b'{' | b'[' => {
                    if byte == b'[' && scanner.depth == 1 && !scanner.in_steps {
                        if let Some((key_start, key_end)) = scanner.last_depth1_string
                            && &self.text[key_start..key_end] == "\"steps\""
                        {
                            scanner.in_steps = true;
                            let object_start = scanner.object_start.unwrap_or(0);
                            let header_text = self.text[object_start..key_start]
                                .trim_end()
                                .trim_end_matches(',');
                            let header = serde_json::from_str::<Value>(&format!("{header_text}}}"))
                                .unwrap_or_else(|_| Value::Object(Default::default()));
                            events.push(ReplyEvent::VisualHeader(header));
                        }
                    }
                    if byte == b'{' && scanner.in_steps && scanner.depth == 2 {
                        scanner.step_start = Some(index);
                    }
                    scanner.depth += 1;
                }
                b'}' | b']' => {
                    scanner.depth = scanner.depth.saturating_sub(1);
                    if byte == b'}' && scanner.in_steps && scanner.depth == 2
                        && let Some(step_start) = scanner.step_start.take()
                    {
                        match serde_json::from_str::<Value>(&self.text[step_start..=index]) {
                            Ok(step) => events.push(ReplyEvent::VisualStep(step)),
                            Err(error) => log::warn!("skipping unparseable visual step: {error}"),
                        }
                    }
                    if byte == b']' && scanner.in_steps && scanner.depth == 1 {
                        scanner.in_steps = false;
                    }
                    if scanner.depth == 0 {
                        self.skip_visual_trailer();
                        self.mode = Mode::Outside;
                        return true;
                    }
                }
                _ => {}
            }
        }
        false
    }

    /// Skips a closing code fence and `</visual>` right after the object.
    fn skip_visual_trailer(&mut self) {
        let rest = &self.text[self.cursor..];
        let trimmed = rest.trim_start().trim_start_matches('`').trim_start();
        if let Some(after_close) = trimmed.strip_prefix(VISUAL_CLOSE_TAG) {
            self.cursor = self.text.len() - after_close.len();
        }
    }
}

/// Byte length of a trailing fragment that could still grow into a tag.
fn possible_tag_prefix_length(text: &str) -> usize {
    for (index, character) in text.char_indices().rev().take(VISUAL_OPEN_TAG.len()) {
        if character == '<' || character == '[' {
            let tail = &text[index..];
            if VISUAL_OPEN_TAG.starts_with(tail) || POINT_TAG_START.starts_with(tail) {
                return tail.len();
            }
        }
    }
    0
}

/// End (exclusive byte index) of the first sentence at least `min_length` long.
fn sentence_boundary(text: &str, min_length: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    for (index, &byte) in bytes.iter().enumerate() {
        let is_terminator = matches!(byte, b'.' | b'!' | b'?' | b'\n');
        if !is_terminator || index + 1 < min_length.min(bytes.len()) {
            continue;
        }
        // Require following whitespace so "e.g." or "3.5" inside a sentence don't split.
        if byte == b'\n' || bytes.get(index + 1).is_some_and(|next| next.is_ascii_whitespace()) {
            return Some(index + 1);
        }
    }
    None
}

fn clean_speech(text: &str) -> String {
    text.replace(VISUAL_CLOSE_TAG, "")
        .replace("```json", "")
        .replace("```", "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_in_chunks(reply: &str, chunk_size: usize) -> Vec<ReplyEvent> {
        let mut parser = StreamingReplyParser::new();
        let mut events = Vec::new();
        let characters: Vec<char> = reply.chars().collect();
        for chunk in characters.chunks(chunk_size) {
            events.extend(parser.feed(&chunk.iter().collect::<String>()));
        }
        events.extend(parser.finish());
        events
    }

    #[test]
    fn speaks_plain_replies_sentence_by_sentence_without_the_tag() {
        let events = feed_in_chunks(
            "hit the gear icon down in the corner. then pick settings from the menu. [POINT:24,790:settings gear]",
            5,
        );
        assert_eq!(
            events,
            vec![
                ReplyEvent::Speech("hit the gear icon down in the corner.".into()),
                ReplyEvent::Speech("then pick settings from the menu.".into()),
            ]
        );
    }

    #[test]
    fn emits_header_then_each_step_as_it_closes() {
        let reply = r#"quick sketch. <visual>{"title":"a {tricky} \"title\"","card":{"w":600},"steps":[{"say":"one.","draw":[{"type":"box","label":"[x]"}]},{"say":"two.","draw":[]}]}</visual> [POINT:none]"#;
        for chunk_size in [1, 3, 7, 50, 1000] {
            let events = feed_in_chunks(reply, chunk_size);
            assert_eq!(events.len(), 4, "chunk size {chunk_size}: {events:?}");
            assert_eq!(events[0], ReplyEvent::Speech("quick sketch.".into()));
            let ReplyEvent::VisualHeader(header) = &events[1] else { panic!("header expected") };
            assert_eq!(header["title"], "a {tricky} \"title\"");
            assert_eq!(header["card"]["w"], 600);
            assert!(header.get("steps").is_none());
            let ReplyEvent::VisualStep(first) = &events[2] else { panic!("step expected") };
            assert_eq!(first["say"], "one.");
            assert_eq!(first["draw"][0]["label"], "[x]");
            let ReplyEvent::VisualStep(second) = &events[3] else { panic!("step expected") };
            assert_eq!(second["say"], "two.");
        }
    }

    #[test]
    fn steps_arrive_before_the_reply_finishes() {
        let mut parser = StreamingReplyParser::new();
        let events = parser.feed(r#"<visual>{"title":"t","steps":[{"say":"first."},{"say":"sec"#);
        assert!(matches!(events[0], ReplyEvent::VisualHeader(_)));
        assert!(matches!(&events[1], ReplyEvent::VisualStep(step) if step["say"] == "first."));
        assert_eq!(events.len(), 2);
    }

    #[test]
    fn tolerates_code_fences_inside_the_block() {
        let events = feed_in_chunks("<visual>\n```json\n{\"steps\":[{\"say\":\"hi\"}]}\n```\n</visual>", 4);
        assert_eq!(events.len(), 2, "{events:?}");
        assert!(matches!(&events[1], ReplyEvent::VisualStep(step) if step["say"] == "hi"));
    }

    #[test]
    fn short_replies_flush_on_finish() {
        assert_eq!(feed_in_chunks("yep, that's it.", 2), vec![ReplyEvent::Speech("yep, that's it.".into())]);
        assert_eq!(feed_in_chunks("[POINT:none]", 2), vec![]);
    }
}
