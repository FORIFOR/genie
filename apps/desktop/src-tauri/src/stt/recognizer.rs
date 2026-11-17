//! 手元の認識。正本 §11.1、§23。
//!
//! DeepNote の `stt/sherpa.rs` を donor にしているが、次を変えてある:
//!
//!   - **窓を設定にした。**DeepNote は 6 秒固定で、§23 の
//!     `localSttFirstPartial`（p95 350ms）に構造的に届かない。
//!     窓を縮めれば近づくが認識は落ちる。**どちらも数字で示せるようにする**
//!   - **印を打つ。**decode の開始と最初の途中経過を、単調時計で記録する
//!   - **失敗を型で返す。**panic を握って続けない
//!
//! ReazonSpeech は offline（非ストリーミング）transducer なので、
//! ここでのライブは「窓をずらしながら decode し直す」疑似ライブ。
//! **本物のストリーミングだと言わない。**

use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::path::Path;
use std::ptr;
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use super::ffi;
use super::library::{LibraryProblem, SherpaLibrary};
use super::model::{self, ModelHealth};

/// 文字起こしのドメイン型は genie-core が正本。ここは録音エンジン（sherpa-onnx）
/// だけを持ち、窓・重なり・途中経過/確定の純ロジックは core から使う。
pub use genie_core::{merge_overlap, LiveWindow, TranscriptEvent};

/// 認識できない理由。**「失敗しました」で済ませない。**
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "reason", content = "detail")]
pub enum RecognizerError {
    /// sherpa-onnx that 自体が無い / 開けない。
    LibraryUnavailable(String),
    /// モデルが無い、または壊れている。
    ModelUnavailable(String),
    /// recognizer を作れなかった。
    InitializationFailed(String),
    /// まだ読み込んでいない。
    NotLoaded,
}

impl std::fmt::Display for RecognizerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::LibraryUnavailable(detail) => write!(f, "sherpa-onnx unavailable: {detail}"),
            Self::ModelUnavailable(detail) => write!(f, "model unavailable: {detail}"),
            Self::InitializationFailed(detail) => write!(f, "could not initialise: {detail}"),
            Self::NotLoaded => write!(f, "the recogniser has not been loaded"),
        }
    }
}

struct Loaded {
    library: Arc<SherpaLibrary>,
    recognizer: *const ffi::SherpaOnnxOfflineRecognizer,
    /// 設定が握っているポインタの寿命を保つ。**先に落とすと壊れる。**
    _strings: Vec<CString>,
}

// 呼ぶ側で Mutex を掛ける前提。stream は毎回作り直す。
unsafe impl Send for Loaded {}
unsafe impl Sync for Loaded {}

pub struct LocalRecognizer {
    loaded: Option<Loaded>,
    window: LiveWindow,
    sample_rate: u32,
    /// 未処理の音。窓が埋まるまで貯める。
    buffer: Vec<f32>,
    /// これまでに出した文。重なりを畳んで足していく。
    accumulated: String,
    /// 取り込み開始からの位置。
    consumed_samples: u64,
    /// decode に入った時刻。§23 の `sttDecodeStarted`。
    pub decode_started_at: Option<Instant>,
    /// 最初の途中経過を出した時刻。§23 の `localSttFirstPartial`。
    pub first_partial_at: Option<Instant>,
}

impl LocalRecognizer {
    pub fn new(window: LiveWindow) -> Self {
        Self {
            loaded: None,
            window,
            sample_rate: super::super::audio::frame::SAMPLE_RATE_HZ,
            buffer: Vec::new(),
            accumulated: String::new(),
            consumed_samples: 0,
            decode_started_at: None,
            first_partial_at: None,
        }
    }

    pub fn is_loaded(&self) -> bool {
        self.loaded.is_some()
    }

    pub fn window(&self) -> LiveWindow {
        self.window
    }

    /// 読み込む。**無いものを無いと言う。**
    pub fn load(&mut self, model_dir: &Path) -> Result<(), RecognizerError> {
        let status = model::inspect(model_dir);
        if status.health != ModelHealth::Ready {
            return Err(RecognizerError::ModelUnavailable(format!(
                "{:?} at {} (missing: {:?}, empty: {:?})",
                status.health, status.directory, status.missing, status.empty
            )));
        }

        let library = SherpaLibrary::open().map_err(|problem: LibraryProblem| {
            RecognizerError::LibraryUnavailable(problem.to_string())
        })?;

        self.unload();

        let mut strings = Vec::new();
        let mut keep = |value: String| -> Result<*const c_char, RecognizerError> {
            let c = CString::new(value)
                .map_err(|e| RecognizerError::InitializationFailed(e.to_string()))?;
            let pointer = c.as_ptr();
            strings.push(c);
            Ok(pointer)
        };

        let encoder = keep(
            model_dir
                .join(model::REQUIRED_FILES[0])
                .display()
                .to_string(),
        )?;
        let decoder = keep(
            model_dir
                .join(model::REQUIRED_FILES[1])
                .display()
                .to_string(),
        )?;
        let joiner = keep(
            model_dir
                .join(model::REQUIRED_FILES[2])
                .display()
                .to_string(),
        )?;
        let tokens = keep(
            model_dir
                .join(model::REQUIRED_FILES[3])
                .display()
                .to_string(),
        )?;
        let provider = keep("cpu".to_string())?;
        let decoding = keep("modified_beam_search".to_string())?;

        let threads = std::thread::available_parallelism()
            .map(|n| n.get().min(4) as i32)
            .unwrap_or(2);

        let n = ptr::null::<c_char>();
        let config = ffi::SherpaOnnxOfflineRecognizerConfig {
            feat_config: ffi::SherpaOnnxFeatureConfig {
                sample_rate: self.sample_rate as i32,
                feature_dim: 80,
            },
            model_config: ffi::SherpaOnnxOfflineModelConfig {
                transducer: ffi::SherpaOnnxOfflineTransducerModelConfig {
                    encoder,
                    decoder,
                    joiner,
                },
                paraformer: ffi::SherpaOnnxOfflineParaformerModelConfig { model: n },
                nemo_ctc: ffi::SherpaOnnxOfflineNemoEncDecCtcModelConfig { model: n },
                whisper: ffi::SherpaOnnxOfflineWhisperModelConfig {
                    encoder: n,
                    decoder: n,
                    language: n,
                    task: n,
                    tail_paddings: 0,
                    enable_token_timestamps: 0,
                    enable_segment_timestamps: 0,
                },
                tdnn: ffi::SherpaOnnxOfflineTdnnModelConfig { model: n },
                tokens,
                num_threads: threads,
                debug: 0,
                provider,
                model_type: n,
                modeling_unit: n,
                bpe_vocab: n,
                telespeech_ctc: n,
                sense_voice: ffi::SherpaOnnxOfflineSenseVoiceModelConfig {
                    model: n,
                    language: n,
                    use_itn: 0,
                },
                moonshine: ffi::SherpaOnnxOfflineMoonshineModelConfig {
                    preprocessor: n,
                    encoder: n,
                    uncached_decoder: n,
                    cached_decoder: n,
                    merged_decoder: n,
                },
                fire_red_asr: ffi::SherpaOnnxOfflineFireRedAsrModelConfig {
                    encoder: n,
                    decoder: n,
                },
                dolphin: ffi::SherpaOnnxOfflineDolphinModelConfig { model: n },
                zipformer_ctc: ffi::SherpaOnnxOfflineZipformerCtcModelConfig { model: n },
                canary: ffi::SherpaOnnxOfflineCanaryModelConfig {
                    encoder: n,
                    decoder: n,
                    src_lang: n,
                    tgt_lang: n,
                    use_pnc: 0,
                },
                wenet_ctc: ffi::SherpaOnnxOfflineWenetCtcModelConfig { model: n },
                omnilingual: ffi::SherpaOnnxOfflineOmnilingualAsrCtcModelConfig { model: n },
                medasr: ffi::SherpaOnnxOfflineMedAsrCtcModelConfig { model: n },
                funasr_nano: ffi::SherpaOnnxOfflineFunASRNanoModelConfig {
                    encoder_adaptor: n,
                    llm: n,
                    embedding: n,
                    tokenizer: n,
                    system_prompt: n,
                    user_prompt: n,
                    max_new_tokens: 0,
                    temperature: 0.0,
                    top_p: 0.0,
                    seed: 0,
                    language: n,
                    itn: 0,
                    hotwords: n,
                },
                fire_red_asr_ctc: ffi::SherpaOnnxOfflineFireRedAsrCtcModelConfig { model: n },
                qwen3_asr: ffi::SherpaOnnxOfflineQwen3ASRModelConfig {
                    conv_frontend: n,
                    encoder: n,
                    decoder: n,
                    tokenizer: n,
                    max_total_len: 0,
                    max_new_tokens: 0,
                    temperature: 0.0,
                    top_p: 0.0,
                    seed: 0,
                    hotwords: n,
                },
                cohere_transcribe: ffi::SherpaOnnxOfflineCohereTranscribeModelConfig {
                    encoder: n,
                    decoder: n,
                    language: n,
                    use_punct: 0,
                    use_itn: 0,
                },
            },
            lm_config: ffi::SherpaOnnxOfflineLMConfig {
                model: n,
                scale: 0.0,
            },
            decoding_method: decoding,
            max_active_paths: 4,
            hotwords_file: n,
            hotwords_score: 0.0,
            rule_fsts: n,
            rule_fars: n,
            blank_penalty: 0.0,
            hr: ffi::SherpaOnnxHomophoneReplacerConfig {
                dict_dir: n,
                lexicon: n,
                rule_fsts: n,
            },
        };

        let recognizer = unsafe { (library.create_recognizer)(&config) };
        if recognizer.is_null() {
            return Err(RecognizerError::InitializationFailed(
                "sherpa-onnx returned no recogniser".to_string(),
            ));
        }

        self.loaded = Some(Loaded {
            library,
            recognizer,
            _strings: strings,
        });
        Ok(())
    }

    /// 1 度に全部を起こす。テストと最終パスで使う。
    pub fn transcribe(&self, samples: &[f32]) -> Result<String, RecognizerError> {
        let loaded = self.loaded.as_ref().ok_or(RecognizerError::NotLoaded)?;
        if samples.is_empty() {
            return Ok(String::new());
        }

        unsafe {
            let stream = (loaded.library.create_stream)(loaded.recognizer);
            if stream.is_null() {
                return Err(RecognizerError::InitializationFailed(
                    "could not open a decoding stream".to_string(),
                ));
            }

            (loaded.library.accept_waveform)(
                stream,
                self.sample_rate as i32,
                samples.as_ptr(),
                samples.len() as i32,
            );
            (loaded.library.decode_stream)(loaded.recognizer, stream);

            let result = (loaded.library.get_result)(stream);
            let text = if !result.is_null() && !(*result).text.is_null() {
                CStr::from_ptr((*result).text)
                    .to_string_lossy()
                    .trim()
                    .to_string()
            } else {
                String::new()
            };
            if !result.is_null() {
                (loaded.library.destroy_result)(result);
            }
            (loaded.library.destroy_stream)(stream);

            Ok(text)
        }
    }

    /// 音を足す。窓が埋まったら decode して、途中経過を返す。
    ///
    /// **窓が埋まるまで何も返らない。**それがこの方式の下限で、
    /// §23 に届くかどうかは窓の長さで決まる。
    pub fn push(&mut self, samples: &[f32]) -> Result<Option<TranscriptEvent>, RecognizerError> {
        if self.loaded.is_none() {
            return Err(RecognizerError::NotLoaded);
        }

        self.buffer.extend_from_slice(samples);
        let window = self.window.window_samples(self.sample_rate);
        let hop = self.window.hop_samples(self.sample_rate);
        let mut updated = false;
        let started_at_ms = (self.consumed_samples * 1000) / self.sample_rate as u64;

        while self.buffer.len() >= window {
            if self.decode_started_at.is_none() {
                self.decode_started_at = Some(Instant::now());
            }
            let chunk: Vec<f32> = self.buffer[..window].to_vec();
            self.buffer.drain(..hop.min(self.buffer.len()));
            self.consumed_samples += hop as u64;

            let text = self.transcribe(&chunk)?;
            let trimmed = text.trim();
            if trimmed.chars().count() >= 2 {
                self.accumulated = merge_overlap(&self.accumulated, trimmed, 12);
                updated = true;
            }
        }

        if !updated {
            return Ok(None);
        }
        if self.first_partial_at.is_none() {
            self.first_partial_at = Some(Instant::now());
        }
        let emitted_at_ms = (self.consumed_samples * 1000) / self.sample_rate as u64;
        Ok(Some(TranscriptEvent::Partial {
            text: self.accumulated.clone(),
            started_at_ms,
            emitted_at_ms,
        }))
    }

    /// 残りを吐いて確定する。
    pub fn finish(&mut self) -> Result<TranscriptEvent, RecognizerError> {
        if self.loaded.is_none() {
            return Err(RecognizerError::NotLoaded);
        }
        // 100ms 未満の切れ端は起こさない。雑音しか出ない。
        let remainder = std::mem::take(&mut self.buffer);
        if remainder.len() > self.sample_rate as usize / 10 {
            let text = self.transcribe(&remainder)?;
            if !text.trim().is_empty() {
                self.accumulated = merge_overlap(&self.accumulated, text.trim(), 12);
            }
        }
        let ended_at_ms = (self.consumed_samples * 1000) / self.sample_rate as u64;
        let text = std::mem::take(&mut self.accumulated);
        self.consumed_samples = 0;
        Ok(TranscriptEvent::Final {
            text,
            started_at_ms: 0,
            ended_at_ms,
        })
    }

    /// 次の取り込みへ向けて片付ける。**二重に読み込ませない。**
    pub fn reset(&mut self) {
        self.buffer.clear();
        self.accumulated.clear();
        self.consumed_samples = 0;
        self.decode_started_at = None;
        self.first_partial_at = None;
    }

    pub fn unload(&mut self) {
        if let Some(loaded) = self.loaded.take() {
            unsafe { (loaded.library.destroy_recognizer)(loaded.recognizer) };
        }
        self.reset();
    }
}

impl Drop for LocalRecognizer {
    fn drop(&mut self) {
        self.unload();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_to_work_before_it_is_loaded() {
        let mut recognizer = LocalRecognizer::new(LiveWindow::default());
        assert!(!recognizer.is_loaded());
        assert_eq!(
            recognizer.push(&[0.0; 100]).err(),
            Some(RecognizerError::NotLoaded)
        );
        assert_eq!(
            recognizer.transcribe(&[0.0; 100]).err(),
            Some(RecognizerError::NotLoaded)
        );
    }

    #[test]
    fn reports_a_missing_model_rather_than_crashing() {
        let mut recognizer = LocalRecognizer::new(LiveWindow::default());
        let error = recognizer
            .load(Path::new("/nonexistent-astra-model"))
            .expect_err("a missing model must be an error");
        assert!(matches!(error, RecognizerError::ModelUnavailable(_)));
    }
}

// Fixture-only reader: release WAVs may include LIST/JUNK chunks before data.
// Never treat metadata, unsupported audio formats or a truncated file as PCM.
#[cfg(test)]
mod fixture_wav {
    pub(super) fn samples(bytes: &[u8]) -> Result<Vec<f32>, &'static str> {
        if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
            return Err("expected RIFF/WAVE");
        }
        let size = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        if size.checked_add(8) != Some(bytes.len()) {
            return Err("RIFF length mismatch");
        }
        let mut offset = 12usize;
        let mut has_format = false;
        let mut pcm = None;
        while offset < bytes.len() {
            let header_end = offset.checked_add(8).ok_or("chunk overflow")?;
            let header = bytes
                .get(offset..header_end)
                .ok_or("truncated chunk header")?;
            let length = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
            let end = header_end.checked_add(length).ok_or("chunk overflow")?;
            let chunk = bytes.get(header_end..end).ok_or("truncated chunk")?;
            match &header[..4] {
                b"fmt " => {
                    if has_format || chunk.len() < 16 {
                        return Err("missing or duplicate PCM format");
                    }
                    let u16_at = |i| u16::from_le_bytes([chunk[i], chunk[i + 1]]);
                    let u32_at = |i| u32::from_le_bytes(chunk[i..i + 4].try_into().unwrap());
                    if u16_at(0) != 1
                        || u16_at(2) != 1
                        || u32_at(4) != 16_000
                        || u32_at(8) != 32_000
                        || u16_at(12) != 2
                        || u16_at(14) != 16
                    {
                        return Err("fixture must be PCM16 mono 16kHz");
                    }
                    if chunk.len() != 16
                        && (chunk.len() < 18 || usize::from(u16_at(16)) + 18 != chunk.len())
                    {
                        return Err("invalid extended PCM format length");
                    }
                    has_format = true;
                }
                b"data" => {
                    if !has_format || pcm.is_some() || chunk.is_empty() || chunk.len() % 2 != 0 {
                        return Err("missing format, duplicate, empty or partial PCM data");
                    }
                    pcm = Some(chunk);
                }
                _ => {}
            }
            offset = end.checked_add(length % 2).ok_or("padding overflow")?;
            if offset > bytes.len() {
                return Err("missing odd chunk padding");
            }
        }
        let pcm = pcm.ok_or("missing PCM data")?;
        Ok(crate::audio::frame::from_pcm16(pcm))
    }

    fn fixture(chunks: &[(&[u8; 4], &[u8])]) -> Vec<u8> {
        let mut out = b"RIFF\0\0\0\0WAVE".to_vec();
        for (name, bytes) in chunks {
            out.extend_from_slice(*name);
            out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
            out.extend_from_slice(bytes);
            if bytes.len() % 2 != 0 {
                out.push(0);
            }
        }
        let size = (out.len() - 8) as u32;
        out[4..8].copy_from_slice(&size.to_le_bytes());
        out
    }

    const FORMAT: [u8; 16] = [1, 0, 1, 0, 128, 62, 0, 0, 0, 125, 0, 0, 2, 0, 16, 0];
    const PCM: [u8; 4] = [0, 128, 255, 127];

    #[test]
    fn decodes_only_data_after_even_and_odd_metadata_chunks() {
        let plain = fixture(&[(b"fmt ", &FORMAT), (b"data", &PCM)]);
        let metadata = fixture(&[
            (b"fmt ", &FORMAT),
            (b"LIST", &[9; 26]),
            (b"JUNK", &[1, 2, 3]),
            (b"data", &PCM),
            (b"JUNK", &[4]),
        ]);
        let expected = crate::audio::frame::from_pcm16(&PCM);
        assert_eq!(samples(&plain).unwrap(), expected);
        assert_eq!(samples(&metadata).unwrap(), expected);
        assert_eq!(samples(&metadata).unwrap().len(), 2);
    }

    #[test]
    fn rejects_wrong_container_lengths_and_truncated_chunks() {
        let valid = fixture(&[(b"fmt ", &FORMAT), (b"data", &PCM)]);
        for end in 0..valid.len() {
            assert!(samples(&valid[..end]).is_err());
        }
        for index in [0usize, 4, 8, 16, 40] {
            let mut bad = valid.clone();
            bad[index] ^= 255;
            assert!(samples(&bad).is_err(), "offset {index}");
        }
        let mut extra = valid.clone();
        extra.push(0);
        assert!(samples(&extra).is_err());
        let mut no_padding = fixture(&[(b"fmt ", &FORMAT), (b"data", &PCM), (b"JUNK", &[1])]);
        no_padding.pop();
        let size = (no_padding.len() - 8) as u32;
        no_padding[4..8].copy_from_slice(&size.to_le_bytes());
        assert!(samples(&no_padding).is_err());
    }

    #[test]
    fn rejects_unsupported_format_or_inconsistent_pcm_metadata() {
        for index in [0usize, 2, 4, 8, 12, 14] {
            let mut format = FORMAT;
            format[index] ^= 1;
            assert!(samples(&fixture(&[(b"fmt ", &format), (b"data", &PCM)])).is_err());
        }
        let mut extended = FORMAT.to_vec();
        extended.push(0);
        assert!(samples(&fixture(&[(b"fmt ", &extended), (b"data", &PCM)])).is_err());
        extended.push(0);
        assert!(samples(&fixture(&[(b"fmt ", &extended), (b"data", &PCM)])).is_ok());
        extended[16] = 1;
        assert!(samples(&fixture(&[(b"fmt ", &extended), (b"data", &PCM)])).is_err());
    }

    #[test]
    fn rejects_missing_duplicate_empty_or_partial_audio() {
        for chunks in [
            vec![(b"fmt ", FORMAT.as_slice())],
            vec![(b"data", PCM.as_slice())],
            vec![
                (b"fmt ", FORMAT.as_slice()),
                (b"fmt ", FORMAT.as_slice()),
                (b"data", PCM.as_slice()),
            ],
            vec![
                (b"fmt ", FORMAT.as_slice()),
                (b"data", PCM.as_slice()),
                (b"data", PCM.as_slice()),
            ],
            vec![(b"fmt ", FORMAT.as_slice()), (b"data", [].as_slice())],
            vec![(b"fmt ", FORMAT.as_slice()), (b"data", [1].as_slice())],
        ] {
            assert!(samples(&fixture(&chunks)).is_err());
        }
    }
}

/// 実物のライブラリとモデルを使う検査。
///
/// **代役では測れないものだけ**をここに置く。
/// ライブラリかモデルが無い環境では skip し、**PASS と偽装しない**。
///
/// 実行:
/// ```text
/// ASTRA_SHERPA_LIB_DIR=... ASTRA_STT_MODEL_DIR=... \
///   cargo test --lib stt::recognizer::real -- --ignored --nocapture --test-threads=1
/// ```
#[cfg(test)]
mod real {
    use super::*;

    fn wav_samples(path: &Path) -> Vec<f32> {
        let bytes = std::fs::read(path).expect("read public fixture wav");
        super::fixture_wav::samples(&bytes).expect("valid PCM16 mono 16kHz fixture WAV")
    }

    fn ready() -> Option<(std::path::PathBuf, Vec<std::path::PathBuf>)> {
        let dir = model::japanese_model_dir();
        if !model::inspect(&dir).is_ready() {
            eprintln!("[real] model not installed at {}; skipping", dir.display());
            return None;
        }
        if SherpaLibrary::open().is_err() {
            eprintln!("[real] sherpa-onnx not installed; skipping");
            return None;
        }
        let mut wavs: Vec<_> = std::fs::read_dir(dir.join("test_wavs"))
            .ok()?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().map(|x| x == "wav").unwrap_or(false))
            .collect();
        wavs.sort();
        if wavs.is_empty() {
            eprintln!("[real] no test wavs; skipping");
            return None;
        }
        Some((dir, wavs))
    }

    #[test]
    #[ignore = "requires the sherpa-onnx library and the Japanese model"]
    fn transcribes_a_real_recording() {
        let Some((dir, wavs)) = ready() else {
            // `--ignored` で明示的に走らせたのに何も無い。**通ったことにしない。**
            panic!("real STT is not installed here — run scripts/install-local-stt.sh (and put test wavs in place)");
        };
        let mut recognizer = LocalRecognizer::new(LiveWindow::default());
        recognizer.load(&dir).expect("load");

        let samples = wav_samples(&wavs[0]);
        let started = Instant::now();
        let text = recognizer.transcribe(&samples).expect("transcribe");
        let elapsed = started.elapsed().as_millis();

        eprintln!(
            "[real] {} ({:.1}s audio) -> {}ms -> {text:?}",
            wavs[0].file_name().unwrap().to_string_lossy(),
            samples.len() as f32 / 16_000.0,
            elapsed
        );
        // 代役ではないので、何か出るはず
        assert!(!text.is_empty(), "a real recording produced no text");
    }

    /// 最初の途中経過までを測る。
    ///
    /// **壁時計だけで測らない。**ファイルから流すと音が実時間より速く届くので、
    /// 壁時計は「decode にかかった時間」しか表さない。
    /// マイクからは音が実時間で届くので、実機での値は
    ///
    ///   最初の途中経過 ≒ 溜めた音の長さ + decode 時間
    ///
    /// になる。両方を出して、足したものを §23 と比べる。
    #[test]
    #[ignore = "requires the sherpa-onnx library and the Japanese model"]
    fn measures_the_first_partial() {
        let Some((dir, wavs)) = ready() else {
            // `--ignored` で明示的に走らせたのに何も無い。**通ったことにしない。**
            panic!("real STT is not installed here — run scripts/install-local-stt.sh (and put test wavs in place)");
        };
        let mut recognizer = LocalRecognizer::new(LiveWindow::default());
        recognizer.load(&dir).expect("load");

        let samples = wav_samples(&wavs[0]);
        let step = 16_000 / 50; // 20ms
        let started = Instant::now();
        let mut fed_samples: usize = 0;
        // 最初の途中経過が出た時点で「何ミリ秒ぶんの音を渡していたか」
        let mut audio_ms_at_first: Option<u64> = None;
        let mut wall_ms_at_first: Option<u128> = None;

        for chunk in samples.chunks(step) {
            fed_samples += chunk.len();
            if let Some(TranscriptEvent::Partial { .. }) = recognizer.push(chunk).expect("push") {
                if audio_ms_at_first.is_none() {
                    audio_ms_at_first = Some((fed_samples as u64 * 1000) / 16_000);
                    wall_ms_at_first = Some(started.elapsed().as_millis());
                }
            }
        }
        let final_event = recognizer.finish().expect("finish");

        let window = recognizer.window();
        let audio_ms = audio_ms_at_first.expect("a partial must appear");
        let wall_ms = wall_ms_at_first.expect("a partial must appear");
        // 実機での見込み。音は実時間で届くので、溜めた分は待ち時間になる。
        let projected = audio_ms as u128 + wall_ms;

        eprintln!(
            "[real] window={}ms hop={}ms | audio_to_first_partial={audio_ms}ms decode={wall_ms}ms \
             projected_first_partial={projected}ms | final={:?}",
            window.window_ms, window.hop_ms, final_event
        );

        // **窓ぶんの音が溜まる前に出ることはあり得ない。**
        assert!(
            audio_ms >= window.window_ms as u64,
            "a partial appeared after {audio_ms}ms of audio, which is less than the {}ms window",
            window.window_ms
        );
        // §23 の目標に届いていないことを、数字で残す（届いたふりをしない）
        eprintln!(
            "[real] §23 localSttFirstPartial budget=350ms projected={projected}ms -> {}",
            if projected <= 350 { "within" } else { "OVER" }
        );
    }

    /// 窓を縮めると、どれだけ認識が落ちるか。
    ///
    /// §23 に近づけるには窓を縮めるしかないが、**縮めた代償を数字で残す。**
    /// 「速いが読めない」を速いと言わないため。
    #[test]
    #[ignore = "requires the sherpa-onnx library and the Japanese model"]
    fn shows_what_a_shorter_window_costs() {
        let Some((dir, wavs)) = ready() else {
            // `--ignored` で明示的に走らせたのに何も無い。**通ったことにしない。**
            panic!("real STT is not installed here — run scripts/install-local-stt.sh (and put test wavs in place)");
        };
        let samples = wav_samples(&wavs[0]);

        for window_ms in [6_000u32, 1_500, 700] {
            let hop = (window_ms as f32 * 0.8) as u32;
            let mut recognizer = LocalRecognizer::new(LiveWindow {
                window_ms,
                hop_ms: hop,
            });
            recognizer.load(&dir).expect("load");

            let started = Instant::now();
            for chunk in samples.chunks(16_000 / 50) {
                let _ = recognizer.push(chunk).expect("push");
            }
            let text = match recognizer.finish().expect("finish") {
                TranscriptEvent::Final { text, .. } => text,
                other => panic!("expected a final event, got {other:?}"),
            };
            eprintln!(
                "[real] window={window_ms}ms decode_total={}ms chars={} -> {text:?}",
                started.elapsed().as_millis(),
                text.chars().count()
            );
        }
    }
}
