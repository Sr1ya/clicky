//! Multi-monitor screenshots on Wayland.
//!
//! Wayland apps can't read the screen directly, so we ask a privileged helper,
//! in order of speed:
//!
//! 1. KWin's `ScreenShot2` D-Bus API (raw pixels over a pipe, well under 1 s)
//! 2. `spectacle -b -n -f` (KDE's screenshot tool, silent, ~2 s)
//! 3. the XDG Screenshot portal (non-interactive, ~2.5 s; it saves into
//!    ~/Pictures, so we delete the file it creates)
//!
//! The result is one image of the whole desktop, which we crop per monitor,
//! scale to max 1280 px and JPEG-encode — the same shape the macOS app sent.

use crate::state::MonitorGeometry;
use anyhow::{Context, Result, anyhow};
use base64::Engine;
use image::{DynamicImage, GenericImageView, imageops::FilterType};
use std::path::{Path, PathBuf};
use std::time::Duration;

const MAX_SCREENSHOT_DIMENSION: u32 = 1280;
const JPEG_QUALITY: u8 = 80;

#[derive(Clone)]
pub struct ScreenCapture {
    pub jpeg_base64: String,
    pub label: String,
    pub is_cursor_screen: bool,
    pub monitor: MonitorGeometry,
    pub screenshot_width: u32,
    pub screenshot_height: u32,
    pub tiles: ScreenTiles,
}

/// A coarse map of the screenshot. A drawing uses it to choose ink that reads on
/// what's underneath, and to stand a 3D figure on paper over busy content.
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct ScreenTiles {
    pub size: u32,
    pub columns: u32,
    pub rows: u32,
    pub luminance: Vec<u8>,
    pub busy: Vec<bool>,
}

const TILE_SIZE: u32 = 64;
/// A tile whose brightness varies this much holds words or controls.
const BUSY_TILE_DEVIATION: f32 = 14.0;

pub fn screen_tiles(image: &image::RgbImage) -> ScreenTiles {
    let (width, height) = image.dimensions();
    let columns = width.div_ceil(TILE_SIZE).max(1);
    let rows = height.div_ceil(TILE_SIZE).max(1);
    let mut luminance = Vec::with_capacity((columns * rows) as usize);
    let mut busy = Vec::with_capacity((columns * rows) as usize);
    for row in 0..rows {
        for column in 0..columns {
            let (mut sum, mut square_sum, mut count) = (0f32, 0f32, 0f32);
            for y in (row * TILE_SIZE..((row + 1) * TILE_SIZE).min(height)).step_by(2) {
                for x in (column * TILE_SIZE..((column + 1) * TILE_SIZE).min(width)).step_by(2) {
                    let [red, green, blue] = image.get_pixel(x, y).0;
                    let value = 0.299 * red as f32 + 0.587 * green as f32 + 0.114 * blue as f32;
                    sum += value;
                    square_sum += value * value;
                    count += 1.0;
                }
            }
            let mean = sum / count.max(1.0);
            let deviation = (square_sum / count.max(1.0) - mean * mean).max(0.0).sqrt();
            luminance.push(mean.round() as u8);
            busy.push(deviation > BUSY_TILE_DEVIATION);
        }
    }
    ScreenTiles { size: TILE_SIZE, columns, rows, luminance, busy }
}

pub async fn capture_all_screens(
    monitors: &[MonitorGeometry],
    cursor_position: Option<(f64, f64)>,
) -> Result<Vec<ScreenCapture>> {
    if monitors.is_empty() {
        return Err(anyhow!("no monitors detected"));
    }
    let full_desktop = grab_full_desktop().await?;
    let monitors = monitors.to_vec();
    tokio::task::spawn_blocking(move || split_and_encode(full_desktop, &monitors, cursor_position))
        .await?
}

async fn grab_full_desktop() -> Result<DynamicImage> {
    match grab_with_kwin().await {
        Ok(image) => return Ok(image),
        Err(error) => log::warn!("KWin ScreenShot2 failed ({error:#}), trying spectacle"),
    }
    match grab_with_spectacle().await {
        Ok(image) => return Ok(image),
        Err(error) => log::warn!("spectacle capture failed ({error:#}), trying the portal"),
    }
    grab_with_portal().await
}

/// KWin's own screenshot API: raw pixels streamed over a pipe, ~100 ms. KWin
/// only serves apps whose .desktop file lists the interface in
/// `X-KDE-DBUS-Restricted-Interfaces` (installed by desktop_integration).
async fn grab_with_kwin() -> Result<DynamicImage> {
    use std::collections::HashMap;
    use std::io::Read;
    use std::os::fd::AsFd;
    use zbus::zvariant::{Fd, OwnedValue, Value};

    let (mut pipe_reader, pipe_writer) = std::io::pipe()?;
    // KWin writes from its own thread after replying; read concurrently so a
    // full pipe buffer can never stall it.
    let pixel_reader = tokio::task::spawn_blocking(move || {
        let mut pixel_bytes = Vec::new();
        pipe_reader
            .read_to_end(&mut pixel_bytes)
            .map(|_| pixel_bytes)
    });

    let options: HashMap<&str, Value> = HashMap::from([
        ("include-cursor", Value::from(false)),
        ("native-resolution", Value::from(true)),
    ]);
    let connection = zbus::Connection::session().await?;
    let reply = tokio::time::timeout(
        Duration::from_secs(5),
        connection.call_method(
            Some("org.kde.KWin"),
            "/org/kde/KWin/ScreenShot2",
            Some("org.kde.KWin.ScreenShot2"),
            "CaptureWorkspace",
            &(options, Fd::from(pipe_writer.as_fd())),
        ),
    )
    .await
    .context("KWin screenshot timed out")??;
    // Our copy of the write end must close for the reader to see EOF.
    drop(pipe_writer);

    let metadata: HashMap<String, OwnedValue> = reply.body().deserialize()?;
    let read_u32 = |key: &str| -> Result<u32> {
        let value = metadata
            .get(key)
            .ok_or_else(|| anyhow!("KWin reply missing {key}"))?;
        u32::try_from(value).map_err(|_| anyhow!("KWin reply field {key} isn't a uint"))
    };
    let (width, height, stride, qimage_format) = (
        read_u32("width")?,
        read_u32("height")?,
        read_u32("stride")?,
        read_u32("format")?,
    );

    let pixel_bytes = tokio::time::timeout(Duration::from_secs(5), pixel_reader)
        .await
        .context("KWin screenshot data timed out")???;
    raw_qimage_to_rgba(&pixel_bytes, width, height, stride, qimage_format)
}

/// Converts raw QImage memory to RGBA. KWin sends 32-bit formats: the
/// RGB32/ARGB32 family is BGRA byte order on little-endian machines, the
/// RGBA8888 family is already RGBA.
fn raw_qimage_to_rgba(
    pixel_bytes: &[u8],
    width: u32,
    height: u32,
    stride: u32,
    qimage_format: u32,
) -> Result<DynamicImage> {
    const QIMAGE_RGB32: u32 = 4;
    const QIMAGE_ARGB32: u32 = 5;
    const QIMAGE_ARGB32_PREMULTIPLIED: u32 = 6;
    const QIMAGE_RGBX8888: u32 = 16;
    const QIMAGE_RGBA8888: u32 = 17;
    const QIMAGE_RGBA8888_PREMULTIPLIED: u32 = 18;

    let is_bgra = match qimage_format {
        QIMAGE_RGB32 | QIMAGE_ARGB32 | QIMAGE_ARGB32_PREMULTIPLIED => true,
        QIMAGE_RGBX8888 | QIMAGE_RGBA8888 | QIMAGE_RGBA8888_PREMULTIPLIED => false,
        other => return Err(anyhow!("unsupported KWin image format {other}")),
    };
    if pixel_bytes.len() < (stride as usize) * (height as usize) {
        return Err(anyhow!(
            "KWin sent {} bytes, expected {}",
            pixel_bytes.len(),
            stride * height
        ));
    }

    let mut rgba = Vec::with_capacity((width * height * 4) as usize);
    for row in pixel_bytes
        .chunks_exact(stride as usize)
        .take(height as usize)
    {
        for pixel in row[..(width as usize) * 4].as_chunks::<4>().0 {
            if is_bgra {
                rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], 255]);
            } else {
                rgba.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255]);
            }
        }
    }
    let image = image::RgbaImage::from_raw(width, height, rgba)
        .ok_or_else(|| anyhow!("bad KWin image size"))?;
    Ok(DynamicImage::ImageRgba8(image))
}

async fn grab_with_spectacle() -> Result<DynamicImage> {
    let output_path = temporary_screenshot_path();
    let status = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::process::Command::new("spectacle")
            .args(["--background", "--nonotify", "--fullscreen", "--output"])
            .arg(&output_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status(),
    )
    .await
    .context("spectacle timed out")??;
    if !status.success() {
        return Err(anyhow!("spectacle exited with {status}"));
    }
    let image = load_and_delete(&output_path)?;
    Ok(image)
}

async fn grab_with_portal() -> Result<DynamicImage> {
    let response = ashpd::desktop::screenshot::Screenshot::request()
        .interactive(false)
        .modal(false)
        .send()
        .await?
        .response()?;
    let saved_path = url::Url::parse(response.uri().as_str())?
        .to_file_path()
        .map_err(|_| anyhow!("portal returned a non-file uri"))?;
    // The portal always writes a new file for us; remove it so ~/Pictures doesn't fill up.
    load_and_delete(&saved_path)
}

fn temporary_screenshot_path() -> PathBuf {
    let runtime_directory = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    runtime_directory.join(format!("clicky-screenshot-{}.png", std::process::id()))
}

fn load_and_delete(path: &Path) -> Result<DynamicImage> {
    let loaded = image::open(path).with_context(|| format!("reading {}", path.display()));
    let _ = std::fs::remove_file(path);
    loaded
}

fn split_and_encode(
    full_desktop: DynamicImage,
    monitors: &[MonitorGeometry],
    cursor_position: Option<(f64, f64)>,
) -> Result<Vec<ScreenCapture>> {
    // The screenshot is in physical pixels covering the bounding box of all
    // monitors; monitors are in logical units. One ratio maps between them
    // (exact when all monitors share a scale factor).
    let bounding_left = monitors.iter().map(|monitor| monitor.x).min().unwrap_or(0);
    let bounding_top = monitors.iter().map(|monitor| monitor.y).min().unwrap_or(0);
    let bounding_right = monitors
        .iter()
        .map(|monitor| monitor.x + monitor.width)
        .max()
        .unwrap_or(1);
    let bounding_width = (bounding_right - bounding_left).max(1) as f64;
    let pixels_per_logical_unit = full_desktop.width() as f64 / bounding_width;

    let mut ordered_monitors: Vec<(MonitorGeometry, bool)> = monitors
        .iter()
        .map(|monitor| {
            let has_cursor = cursor_position
                .map(|(cursor_x, cursor_y)| monitor.contains(cursor_x, cursor_y))
                .unwrap_or(false);
            (*monitor, has_cursor)
        })
        .collect();
    // Cursor screen first; if we don't know where the cursor is, treat screen 1 as primary.
    ordered_monitors.sort_by_key(|(_, has_cursor)| !*has_cursor);
    if !ordered_monitors.iter().any(|(_, has_cursor)| *has_cursor) {
        ordered_monitors[0].1 = true;
    }

    let screen_count = ordered_monitors.len();
    let mut captures = Vec::with_capacity(screen_count);
    for (screen_index, (monitor, is_cursor_screen)) in ordered_monitors.into_iter().enumerate() {
        let crop_x =
            (((monitor.x - bounding_left) as f64) * pixels_per_logical_unit).round() as u32;
        let crop_y = (((monitor.y - bounding_top) as f64) * pixels_per_logical_unit).round() as u32;
        let crop_width = ((monitor.width as f64) * pixels_per_logical_unit).round() as u32;
        let crop_height = ((monitor.height as f64) * pixels_per_logical_unit).round() as u32;
        let crop_width = crop_width
            .min(full_desktop.width().saturating_sub(crop_x))
            .max(1);
        let crop_height = crop_height
            .min(full_desktop.height().saturating_sub(crop_y))
            .max(1);

        let monitor_image = full_desktop
            .view(crop_x, crop_y, crop_width, crop_height)
            .to_image();
        let scaled = DynamicImage::ImageRgba8(monitor_image).resize(
            MAX_SCREENSHOT_DIMENSION,
            MAX_SCREENSHOT_DIMENSION,
            FilterType::Triangle,
        );
        let (screenshot_width, screenshot_height) = scaled.dimensions();

        let mut jpeg_bytes = Vec::new();
        let encoder =
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_bytes, JPEG_QUALITY);
        let rgb = scaled.to_rgb8();
        let tiles = screen_tiles(&rgb);
        DynamicImage::ImageRgb8(rgb).write_with_encoder(encoder)?;

        let label = if screen_count == 1 {
            "user's screen (cursor is here)".to_string()
        } else if is_cursor_screen {
            format!(
                "screen {} of {screen_count} — cursor is on this screen (primary focus)",
                screen_index + 1
            )
        } else {
            format!(
                "screen {} of {screen_count} — secondary screen",
                screen_index + 1
            )
        };

        captures.push(ScreenCapture {
            jpeg_base64: base64::engine::general_purpose::STANDARD.encode(&jpeg_bytes),
            label: format!(
                "{label} (image dimensions: {screenshot_width}x{screenshot_height} pixels)"
            ),
            is_cursor_screen,
            monitor,
            screenshot_width,
            screenshot_height,
            tiles,
        });
    }
    Ok(captures)
}
