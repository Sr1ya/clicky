//! Push-to-talk microphone capture.
//!
//! cpal streams are not `Send`, so the stream lives on a dedicated thread that
//! takes Start/Stop commands. Captured audio is downmixed to mono, resampled to
//! 16 kHz, and forwarded as PCM16 chunks — the format AssemblyAI streaming wants.

use crate::state::Shared;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SizedSample};
use std::sync::mpsc as std_mpsc;
use tokio::sync::mpsc::UnboundedSender;

pub const TARGET_SAMPLE_RATE: u32 = 16_000;

enum RecorderCommand {
    Start {
        pcm16_chunk_sender: UnboundedSender<Vec<i16>>,
        started_result_sender: std_mpsc::Sender<Result<(), String>>,
    },
    Stop,
}

#[derive(Clone)]
pub struct MicrophoneRecorder {
    command_sender: std_mpsc::Sender<RecorderCommand>,
}

impl MicrophoneRecorder {
    pub fn spawn(shared: Shared) -> MicrophoneRecorder {
        let (command_sender, command_receiver) = std_mpsc::channel::<RecorderCommand>();
        std::thread::Builder::new()
            .name("clicky-microphone".into())
            .spawn(move || run_recorder_thread(command_receiver, shared))
            .expect("spawn microphone thread");
        MicrophoneRecorder { command_sender }
    }

    /// Starts recording; resolves once the input stream is actually running.
    pub async fn start(&self, pcm16_chunk_sender: UnboundedSender<Vec<i16>>) -> Result<(), String> {
        let (started_result_sender, started_result_receiver) = std_mpsc::channel();
        self.command_sender
            .send(RecorderCommand::Start {
                pcm16_chunk_sender,
                started_result_sender,
            })
            .map_err(|_| "microphone thread is gone".to_string())?;
        tokio::task::spawn_blocking(move || {
            started_result_receiver
                .recv()
                .unwrap_or_else(|_| Err("microphone thread is gone".into()))
        })
        .await
        .unwrap_or_else(|join_error| Err(join_error.to_string()))
    }

    /// Stops recording. Dropping the stream drops the chunk sender, which is how
    /// the transcription session learns the user released the key.
    pub fn stop(&self) {
        let _ = self.command_sender.send(RecorderCommand::Stop);
    }
}

fn run_recorder_thread(command_receiver: std_mpsc::Receiver<RecorderCommand>, shared: Shared) {
    let mut active_stream: Option<cpal::Stream> = None;

    while let Ok(command) = command_receiver.recv() {
        match command {
            RecorderCommand::Start {
                pcm16_chunk_sender,
                started_result_sender,
            } => {
                active_stream = None;
                match open_input_stream(pcm16_chunk_sender, shared.clone()) {
                    Ok(stream) => {
                        active_stream = Some(stream);
                        let _ = started_result_sender.send(Ok(()));
                    }
                    Err(error) => {
                        let _ = started_result_sender.send(Err(error));
                    }
                }
            }
            RecorderCommand::Stop => {
                active_stream = None;
                if let Ok(mut state) = shared.lock() {
                    state.audio_power_level = 0.0;
                }
            }
        }
    }
    drop(active_stream);
}

fn open_input_stream(
    pcm16_chunk_sender: UnboundedSender<Vec<i16>>,
    shared: Shared,
) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let device = host.default_input_device().ok_or("no microphone found")?;
    let supported_config = device
        .default_input_config()
        .map_err(|error| format!("couldn't read microphone config: {error}"))?;

    let sample_format = supported_config.sample_format();
    let stream_config: cpal::StreamConfig = supported_config.into();
    let input_channel_count = stream_config.channels as usize;
    let input_sample_rate = stream_config.sample_rate;
    log::info!(
        "microphone: {input_channel_count} channel(s) @ {input_sample_rate} Hz, {sample_format:?}"
    );

    let stream = match sample_format {
        cpal::SampleFormat::F32 => {
            build_typed_stream::<f32>(&device, &stream_config, pcm16_chunk_sender, shared)
        }
        cpal::SampleFormat::I16 => {
            build_typed_stream::<i16>(&device, &stream_config, pcm16_chunk_sender, shared)
        }
        cpal::SampleFormat::I32 => {
            build_typed_stream::<i32>(&device, &stream_config, pcm16_chunk_sender, shared)
        }
        cpal::SampleFormat::U16 => {
            build_typed_stream::<u16>(&device, &stream_config, pcm16_chunk_sender, shared)
        }
        other => return Err(format!("unsupported microphone sample format {other:?}")),
    }?;
    stream
        .play()
        .map_err(|error| format!("couldn't start microphone: {error}"))?;
    Ok(stream)
}

fn build_typed_stream<SampleType>(
    device: &cpal::Device,
    stream_config: &cpal::StreamConfig,
    pcm16_chunk_sender: UnboundedSender<Vec<i16>>,
    shared: Shared,
) -> Result<cpal::Stream, String>
where
    SampleType: SizedSample + Send + 'static,
    f32: FromSample<SampleType>,
{
    let input_channel_count = stream_config.channels as usize;
    let mut resampler = LinearMonoResampler::new(stream_config.sample_rate, TARGET_SAMPLE_RATE);

    device
        .build_input_stream::<SampleType, _, _>(
            *stream_config,
            move |interleaved_samples: &[SampleType], _| {
                let mono_samples: Vec<f32> = interleaved_samples
                    .chunks(input_channel_count)
                    .map(|frame| {
                        frame
                            .iter()
                            .map(|sample| sample.to_sample::<f32>())
                            .sum::<f32>()
                            / input_channel_count as f32
                    })
                    .collect();

                let root_mean_square = if mono_samples.is_empty() {
                    0.0
                } else {
                    (mono_samples
                        .iter()
                        .map(|sample| sample * sample)
                        .sum::<f32>()
                        / mono_samples.len() as f32)
                        .sqrt()
                };
                if let Ok(mut state) = shared.lock() {
                    // Speech RMS rarely exceeds ~0.2, so scale it into a usable 0..1 range.
                    state.audio_power_level = (root_mean_square * 6.0).min(1.0);
                }

                let resampled = resampler.process(&mono_samples);
                let pcm16: Vec<i16> = resampled
                    .iter()
                    .map(|sample| (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
                    .collect();
                if !pcm16.is_empty() {
                    let _ = pcm16_chunk_sender.send(pcm16);
                }
            },
            |error| log::error!("microphone stream error: {error}"),
            None,
        )
        .map_err(|error| format!("couldn't open microphone: {error}"))
}

/// Streaming linear-interpolation resampler. Plenty for speech recognition,
/// and keeps state between callbacks so chunk boundaries don't click.
struct LinearMonoResampler {
    input_samples_per_output_sample: f64,
    /// Fractional read position relative to the start of the pending buffer.
    read_position: f64,
    /// Last input sample of the previous callback, for interpolating across the boundary.
    previous_sample: f32,
}

impl LinearMonoResampler {
    fn new(input_sample_rate: u32, output_sample_rate: u32) -> Self {
        LinearMonoResampler {
            input_samples_per_output_sample: input_sample_rate as f64 / output_sample_rate as f64,
            read_position: 0.0,
            previous_sample: 0.0,
        }
    }

    fn process(&mut self, input: &[f32]) -> Vec<f32> {
        let mut output = Vec::with_capacity(
            (input.len() as f64 / self.input_samples_per_output_sample) as usize + 1,
        );
        // Index -1 refers to `previous_sample`, so positions in [-1, len-1) are interpolatable.
        let sample_at = |index: isize| -> f32 {
            if index < 0 {
                self.previous_sample
            } else {
                input[index as usize]
            }
        };
        while self.read_position < input.len() as f64 - 1.0 {
            let lower_index = self.read_position.floor() as isize;
            let fraction = (self.read_position - lower_index as f64) as f32;
            let lower = sample_at(lower_index);
            let upper = sample_at(lower_index + 1);
            output.push(lower + (upper - lower) * fraction);
            self.read_position += self.input_samples_per_output_sample;
        }
        if let Some(&last_sample) = input.last() {
            self.previous_sample = last_sample;
        }
        self.read_position -= input.len() as f64;
        output
    }
}
