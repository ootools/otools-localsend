use base64::{engine::general_purpose::STANDARD, Engine};
use image::{
    codecs::png::PngEncoder, DynamicImage, ImageDecoder, ImageEncoder, ImageError, ImageFormat,
    ImageReader, Limits,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const MAX_INPUT: u64 = 32 * 1024 * 1024;
const MAX_SIDE: u32 = 16_384;
const MAX_PIXELS: u64 = 16 * 1024 * 1024;
pub(crate) const MAX_ALLOCATION: u64 = 128 * 1024 * 1024;
const THUMBNAIL_SIDE: u32 = 384;
const MAX_THUMBNAIL: usize = 512 * 1024;
const MAX_CACHE_BYTES: usize = 8 * 1024 * 1024;
const MAX_CACHE_ENTRIES: usize = 64;
const MAX_DECODERS: usize = 2;
const MAX_COPIES: usize = 4;
const MAX_COPY_OUTPUT: usize = 32 * 1024 * 1024;
type Reason = &'static str;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

impl FilePreview {
    fn unavailable(reason: Reason) -> Self {
        Self {
            status: "unavailable",
            data_url: None,
            width: None,
            height: None,
            version: None,
            reason: Some(reason),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageCopy {
    pub resource_id: String,
    pub path: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Default)]
struct Admission {
    retired: bool,
    in_flight: usize,
    cleaning: bool,
    cleaned: bool,
}

#[derive(Clone, PartialEq, Eq)]
struct FileVersion {
    path: PathBuf,
    size: u64,
    modified: SystemTime,
}

impl FileVersion {
    fn from_metadata(path: PathBuf, metadata: &Metadata) -> Result<Self, Reason> {
        if !metadata.is_file() {
            return Err("unsafe-path");
        }
        Ok(Self {
            path,
            size: metadata.len(),
            modified: metadata.modified().map_err(|_| "unavailable")?,
        })
    }

    fn token(&self) -> String {
        let mut hash = Sha256::new();
        hash.update(self.path.to_string_lossy().as_bytes());
        hash.update([0]);
        hash.update(self.size.to_le_bytes());
        let (before_epoch, duration) = match self.modified.duration_since(UNIX_EPOCH) {
            Ok(duration) => (0u8, duration),
            Err(error) => (1u8, error.duration()),
        };
        hash.update([before_epoch]);
        hash.update(duration.as_secs().to_le_bytes());
        hash.update(duration.subsec_nanos().to_le_bytes());
        format!("{:x}", hash.finalize())
    }
}

struct CacheEntry {
    key: FileVersion,
    preview: FilePreview,
    bytes: usize,
}

#[derive(Default)]
struct PreviewCache {
    entries: VecDeque<CacheEntry>,
    bytes: usize,
}

impl PreviewCache {
    fn discard_path(&mut self, path: &Path, keep: Option<&FileVersion>) {
        self.entries
            .retain(|entry| entry.key.path != path || keep.is_some_and(|key| entry.key == *key));
        self.bytes = self.entries.iter().map(|entry| entry.bytes).sum();
    }

    fn get(&mut self, key: &FileVersion) -> Option<FilePreview> {
        self.discard_path(&key.path, Some(key));
        let index = self.entries.iter().position(|entry| entry.key == *key)?;
        let entry = self.entries.remove(index)?;
        let preview = entry.preview.clone();
        self.entries.push_back(entry);
        Some(preview)
    }

    fn insert(&mut self, key: FileVersion, preview: FilePreview) {
        self.discard_path(&key.path, None);
        let bytes = preview.data_url.as_ref().map_or(0, String::len)
            + preview.version.as_ref().map_or(0, String::len)
            + key.path.as_os_str().len() * 2
            + std::mem::size_of::<CacheEntry>();
        if bytes > MAX_CACHE_BYTES {
            return;
        }
        while self.entries.len() >= MAX_CACHE_ENTRIES || self.bytes + bytes > MAX_CACHE_BYTES {
            if let Some(entry) = self.entries.pop_front() {
                self.bytes -= entry.bytes;
            } else {
                break;
            }
        }
        self.bytes += bytes;
        self.entries.push_back(CacheEntry {
            key,
            preview,
            bytes,
        });
    }
}

#[derive(Default)]
struct CopyState {
    files: HashMap<String, PathBuf>,
    pending: usize,
}

/// Owns admissions, decoder budget, thumbnails, and only its generated clipboard PNGs.
pub struct FileResources {
    directory: PathBuf,
    admission: Mutex<Admission>,
    drained: Condvar,
    decoders: Mutex<usize>,
    decoder_available: Condvar,
    cache: Mutex<PreviewCache>,
    copies: Mutex<CopyState>,
}

pub struct ResourceOperation {
    owner: Arc<FileResources>,
}

struct DecodePermit<'a> {
    owner: &'a FileResources,
}
struct CopyReservation<'a> {
    owner: &'a FileResources,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

impl FileResources {
    pub fn new(data_dir: &Path) -> Result<Self, String> {
        validate_local_path(data_dir).map_err(str::to_owned)?;
        fs::create_dir_all(data_dir).map_err(|_| "unavailable".to_owned())?;
        let data_dir = canonical_local_path(data_dir).map_err(str::to_owned)?;
        for _ in 0..8 {
            let directory = data_dir.join(format!("image-resources-{}", Uuid::new_v4().simple()));
            match fs::create_dir(&directory) {
                Ok(()) => {
                    return Ok(Self {
                        directory,
                        admission: Mutex::new(Admission::default()),
                        drained: Condvar::new(),
                        decoders: Mutex::new(0),
                        decoder_available: Condvar::new(),
                        cache: Mutex::new(PreviewCache::default()),
                        copies: Mutex::new(CopyState::default()),
                    })
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(_) => return Err("unavailable".to_owned()),
            }
        }
        Err("unavailable".to_owned())
    }

    /// Called under Slot: only a short independent mutex and an Arc clone, never disk/decode.
    pub fn enter(self: &Arc<Self>) -> Result<ResourceOperation, String> {
        let mut admission = lock(&self.admission);
        if admission.retired {
            return Err("unavailable".to_owned());
        }
        admission.in_flight += 1;
        Ok(ResourceOperation {
            owner: Arc::clone(self),
        })
    }

    /// Must be called outside Slot. Already admitted operations may finish before cleanup.
    pub fn shutdown(&self) {
        let mut admission = lock(&self.admission);
        admission.retired = true;
        while admission.in_flight != 0 || admission.cleaning {
            admission = self
                .drained
                .wait(admission)
                .unwrap_or_else(|error| error.into_inner());
        }
        if admission.cleaned {
            return;
        }
        admission.cleaning = true;
        drop(admission);
        let files = std::mem::take(&mut lock(&self.copies).files);
        for path in files.into_values() {
            let _ = fs::remove_file(path);
        }
        // Never recursively remove a directory: it could contain a file we did not generate.
        let _ = fs::remove_dir(&self.directory);
        *lock(&self.cache) = PreviewCache::default();
        let mut admission = lock(&self.admission);
        admission.cleaning = false;
        admission.cleaned = true;
        self.drained.notify_all();
    }

    fn acquire_decode(&self) -> DecodePermit<'_> {
        let mut active = lock(&self.decoders);
        while *active >= MAX_DECODERS {
            active = self
                .decoder_available
                .wait(active)
                .unwrap_or_else(|error| error.into_inner());
        }
        *active += 1;
        DecodePermit { owner: self }
    }

    fn reserve_copy(&self) -> Result<CopyReservation<'_>, Reason> {
        let mut copies = lock(&self.copies);
        if copies.files.len() + copies.pending >= MAX_COPIES {
            return Err("unavailable");
        }
        copies.pending += 1;
        Ok(CopyReservation { owner: self })
    }
}

impl Drop for FileResources {
    fn drop(&mut self) {
        self.shutdown();
    }
}
impl Drop for ResourceOperation {
    fn drop(&mut self) {
        let mut admission = lock(&self.owner.admission);
        admission.in_flight -= 1;
        if admission.in_flight == 0 {
            self.owner.drained.notify_all();
        }
    }
}
impl Drop for DecodePermit<'_> {
    fn drop(&mut self) {
        *lock(&self.owner.decoders) -= 1;
        self.owner.decoder_available.notify_one();
    }
}
impl Drop for CopyReservation<'_> {
    fn drop(&mut self) {
        lock(&self.owner.copies).pending -= 1;
    }
}

impl ResourceOperation {
    pub fn preview(&self, path: &Path) -> FilePreview {
        self.preview_result(path)
            .unwrap_or_else(FilePreview::unavailable)
    }

    fn preview_result(&self, path: &Path) -> Result<FilePreview, Reason> {
        let (mut file, key) = open_local_file(path)?;
        if key.size > MAX_INPUT {
            return Err("too-large");
        }
        if let Some(preview) = lock(&self.owner.cache).get(&key) {
            return Ok(preview);
        }
        let _permit = self.owner.acquire_decode();
        // A request that waited for a decoder can share the preceding worker's thumbnail.
        if let Some(preview) = lock(&self.owner.cache).get(&key) {
            return Ok(preview);
        }
        let bytes = read_source(&mut file, &key)?;
        let image = decode_image(&bytes)?;
        let (width, height) = (image.width(), image.height());
        let encoded = thumbnail_png(&image)?;
        let preview = FilePreview {
            status: "ready",
            data_url: Some(format!(
                "data:image/png;base64,{}",
                STANDARD.encode(encoded)
            )),
            width: Some(width),
            height: Some(height),
            version: Some(key.token()),
            reason: None,
        };
        ensure_version(&file, &key)?;
        lock(&self.owner.cache).insert(key, preview.clone());
        Ok(preview)
    }

    pub fn prepare_image_copy(&self, path: &Path) -> Result<ImageCopy, String> {
        self.prepare_copy_result(path).map_err(str::to_owned)
    }

    fn prepare_copy_result(&self, path: &Path) -> Result<ImageCopy, Reason> {
        let (mut file, key) = open_local_file(path)?;
        if key.size > MAX_INPUT {
            return Err("too-large");
        }
        let _reservation = self.owner.reserve_copy()?;
        let _permit = self.owner.acquire_decode();
        let bytes = read_source(&mut file, &key)?;
        let image = decode_image(&bytes)?;
        ensure_version(&file, &key)?;
        for _ in 0..8 {
            let resource_id = Uuid::new_v4().simple().to_string();
            let path = self.owner.directory.join(format!("{resource_id}.png"));
            let mut output = match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(output) => output,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(_) => return Err("unavailable"),
            };
            let result = encode_png(&image, &mut output, MAX_COPY_OUTPUT)
                .and_then(|_| output.sync_all().map_err(|_| "unavailable"));
            drop(output);
            if let Err(reason) = result {
                let _ = fs::remove_file(&path);
                return Err(reason);
            }
            let copy = ImageCopy {
                resource_id: resource_id.clone(),
                path: path.to_str().ok_or("unsafe-path")?.to_owned(),
                width: image.width(),
                height: image.height(),
            };
            lock(&self.owner.copies).files.insert(resource_id, path);
            return Ok(copy);
        }
        Err("unavailable")
    }

    pub fn release_image_copy(&self, resource_id: &str) -> Result<(), String> {
        let path = {
            let mut copies = lock(&self.owner.copies);
            let path = copies
                .files
                .remove(resource_id)
                .ok_or_else(|| "unavailable".to_owned())?;
            copies.pending += 1;
            path
        };
        let result = fs::remove_file(&path);
        let mut copies = lock(&self.owner.copies);
        copies.pending -= 1;
        match result {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(_) => {
                copies.files.insert(resource_id.to_owned(), path);
                Err("unavailable".to_owned())
            }
        }
    }

    pub fn resolve_file_with_size(
        &self,
        path: &Path,
        expected_size: u64,
    ) -> Result<String, String> {
        let (_, key) = open_local_file(path).map_err(str::to_owned)?;
        if key.size != expected_size {
            return Err("transfer file has changed".into());
        }
        key.path
            .to_str()
            .map(str::to_owned)
            .ok_or_else(|| "unsafe-path".to_owned())
    }

    pub fn resolve_file(&self, path: &Path) -> Result<String, String> {
        let (_, key) = open_local_file(path).map_err(str::to_owned)?;
        key.path
            .to_str()
            .map(str::to_owned)
            .ok_or_else(|| "unsafe-path".to_owned())
    }
}

fn validate_local_path(path: &Path) -> Result<(), Reason> {
    let text = path.to_str().ok_or("unsafe-path")?;
    if !path.is_absolute()
        || text.chars().any(char::is_control)
        || text.starts_with("//")
        || text.starts_with(r"\\")
        || text.contains("://")
    {
        return Err("unsafe-path");
    }
    #[cfg(windows)]
    {
        let bytes = text.as_bytes();
        if bytes.len() < 3
            || !bytes[0].is_ascii_alphabetic()
            || bytes[1] != b':'
            || text[2..].contains(':')
            || text.chars().any(|c| "<>\"|?*".contains(c))
        {
            return Err("unsafe-path");
        }
        for component in text[2..].split(['/', '\\']) {
            let stem = component
                .split('.')
                .next()
                .unwrap_or("")
                .trim_end_matches(' ')
                .to_ascii_uppercase();
            if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || (stem.len() == 4
                    && (stem.starts_with("COM") || stem.starts_with("LPT"))
                    && matches!(stem.as_bytes()[3], b'1'..=b'9'))
            {
                return Err("unsafe-path");
            }
        }
    }
    #[cfg(not(windows))]
    if text.contains(':') || text.contains('\\') {
        return Err("unsafe-path");
    }
    Ok(())
}

fn canonical_local_path(path: &Path) -> Result<PathBuf, Reason> {
    let canonical = fs::canonicalize(path).map_err(io_reason)?;
    #[cfg(windows)]
    let canonical = {
        let text = canonical.to_str().ok_or("unsafe-path")?;
        // std canonicalize uses a verbatim disk prefix; never turn a verbatim UNC into local.
        let text = text.strip_prefix(r"\\?\").unwrap_or(text);
        PathBuf::from(text)
    };
    validate_local_path(&canonical)?;
    Ok(canonical)
}

fn io_reason(error: io::Error) -> Reason {
    if error.kind() == io::ErrorKind::NotFound {
        "missing"
    } else {
        "unavailable"
    }
}

fn open_local_file(path: &Path) -> Result<(File, FileVersion), Reason> {
    validate_local_path(path)?;
    // Check the type before open, so ordinary directories/devices/FIFOs are not read.
    if !fs::metadata(path).map_err(io_reason)?.is_file() {
        return Err("unsafe-path");
    }
    let path = canonical_local_path(path)?;
    let file = File::open(&path).map_err(io_reason)?;
    let key = FileVersion::from_metadata(path, &file.metadata().map_err(io_reason)?)?;
    Ok((file, key))
}

fn ensure_version(file: &File, key: &FileVersion) -> Result<(), Reason> {
    for metadata in [
        file.metadata().map_err(io_reason)?,
        fs::metadata(&key.path).map_err(io_reason)?,
    ] {
        if metadata.len() > MAX_INPUT {
            return Err("too-large");
        }
        if FileVersion::from_metadata(key.path.clone(), &metadata)? != *key {
            return Err("unavailable");
        }
    }
    Ok(())
}

fn read_bounded<R: Read>(reader: R, size: u64) -> Result<Vec<u8>, Reason> {
    if size > MAX_INPUT {
        return Err("too-large");
    }
    let mut bytes = Vec::with_capacity(size as usize);
    reader
        .take(MAX_INPUT + 1)
        .read_to_end(&mut bytes)
        .map_err(io_reason)?;
    if bytes.len() as u64 > MAX_INPUT {
        return Err("too-large");
    }
    Ok(bytes)
}

fn read_source(file: &mut File, key: &FileVersion) -> Result<Vec<u8>, Reason> {
    let bytes = read_bounded(&mut *file, key.size)?;
    ensure_version(file, key)?;
    if bytes.len() as u64 != key.size {
        return Err("unavailable");
    }
    Ok(bytes)
}

pub(crate) fn dimensions_allowed(width: u32, height: u32) -> Result<(), Reason> {
    if width == 0 || height == 0 {
        return Err("invalid-image");
    }
    if width > MAX_SIDE || height > MAX_SIDE || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err("too-large");
    }
    Ok(())
}

fn image_reason(error: ImageError) -> Reason {
    match error {
        ImageError::Limits(_) => "too-large",
        ImageError::Unsupported(_) => "unsupported",
        _ => "invalid-image",
    }
}

fn decode_image(bytes: &[u8]) -> Result<DynamicImage, Reason> {
    let format = image::guess_format(bytes).map_err(|_| "unsupported")?;
    if !matches!(
        format,
        ImageFormat::Png
            | ImageFormat::Jpeg
            | ImageFormat::Gif
            | ImageFormat::WebP
            | ImageFormat::Bmp
    ) {
        return Err("unsupported");
    }
    crate::image_budget::preflight(bytes, format)?;
    // PNG dimensions precede any ancillary chunks: reject tiny encoded bombs before read_info.
    if format == ImageFormat::Png && bytes.len() >= 24 && &bytes[12..16] == b"IHDR" {
        dimensions_allowed(
            u32::from_be_bytes(bytes[16..20].try_into().unwrap()),
            u32::from_be_bytes(bytes[20..24].try_into().unwrap()),
        )?;
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(MAX_ALLOCATION);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits.clone());
    let mut decoder = reader.into_decoder().map_err(image_reason)?;
    let (width, height) = decoder.dimensions();
    dimensions_allowed(width, height)?;
    limits
        .reserve(decoder.total_bytes())
        .map_err(image_reason)?;
    decoder.set_limits(limits).map_err(image_reason)?;
    DynamicImage::from_decoder(decoder).map_err(image_reason)
}

struct BoundedWriter<W> {
    inner: W,
    limit: usize,
    written: usize,
    overflow: bool,
}

impl<W: Write> Write for BoundedWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.limit - self.written {
            self.overflow = true;
            return Err(io::Error::other("image output limit"));
        }
        let count = self.inner.write(bytes)?;
        self.written += count;
        Ok(count)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

fn encode_png<W: Write>(image: &DynamicImage, output: W, limit: usize) -> Result<(), Reason> {
    let mut writer = BoundedWriter {
        inner: output,
        limit,
        written: 0,
        overflow: false,
    };
    let result = PngEncoder::new(&mut writer).write_image(
        image.as_bytes(),
        image.width(),
        image.height(),
        image.color().into(),
    );
    if writer.overflow {
        return Err("too-large");
    }
    result.map_err(|_| "unavailable")?;
    writer.flush().map_err(|_| "unavailable")
}

fn thumbnail_png(image: &DynamicImage) -> Result<Vec<u8>, Reason> {
    let mut edge = THUMBNAIL_SIDE.min(image.width().max(image.height()));
    loop {
        let thumbnail = image.thumbnail(edge, edge);
        let mut output = Vec::new();
        match encode_png(&thumbnail, &mut output, MAX_THUMBNAIL) {
            Ok(()) => return Ok(output),
            Err("too-large") if edge > 1 => edge = (edge * 3 / 4).max(1),
            Err(reason) => return Err(reason),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use image::{DynamicImage, ImageFormat, Rgb, RgbImage, Rgba, RgbaImage};
    use std::fs::{self, File};
    use std::io::{Cursor, Write};
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant, SystemTime};

    fn fixture(path: &Path, format: ImageFormat, width: u32, height: u32) {
        let image = DynamicImage::ImageRgb8(RgbImage::from_pixel(width, height, Rgb([12, 34, 56])));
        let mut encoded = Cursor::new(Vec::new());
        if format == ImageFormat::WebP {
            let pixels = RgbImage::from_pixel(width, height, Rgb([12, 34, 56]));
            let mut encoder = image_webp::WebPEncoder::new(&mut encoded);
            let mut params = image_webp::EncoderParams::default();
            params.use_predictor_transform = false;
            encoder.set_params(params);
            encoder
                .encode(pixels.as_raw(), width, height, image_webp::ColorType::Rgb8)
                .unwrap();
        } else {
            image.write_to(&mut encoded, format).unwrap();
        }
        fs::write(path, encoded.into_inner()).unwrap();
    }

    fn thumbnail(preview: &FilePreview) -> (DynamicImage, usize) {
        let data = preview
            .data_url
            .as_ref()
            .unwrap()
            .strip_prefix("data:image/png;base64,")
            .unwrap();
        let encoded = STANDARD.decode(data).unwrap();
        assert_eq!(image::guess_format(&encoded).unwrap(), ImageFormat::Png);
        let image = image::load_from_memory(&encoded).unwrap();
        (image, encoded.len())
    }

    fn assert_unavailable(preview: FilePreview, reason: &str) {
        let json = serde_json::to_value(preview).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"status": "unavailable", "reason": reason})
        );
    }

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = !0u32;
        for &byte in bytes {
            crc ^= u32::from(byte);
            for _ in 0..8 {
                crc = (crc >> 1) ^ (0xedb8_8320 & 0u32.wrapping_sub(crc & 1));
            }
        }
        !crc
    }

    fn png_dimension_bomb(path: &Path, width: u32, height: u32) {
        fixture(path, ImageFormat::Png, 1, 1);
        let mut bytes = fs::read(path).unwrap();
        bytes[16..20].copy_from_slice(&width.to_be_bytes());
        bytes[20..24].copy_from_slice(&height.to_be_bytes());
        let crc = crc32(&bytes[12..29]);
        bytes[29..33].copy_from_slice(&crc.to_be_bytes());
        fs::write(path, bytes).unwrap();
    }

    fn jpeg_header(width: u16, height: u16, progressive: bool, sampling: u8) -> Vec<u8> {
        let sof = if progressive { 0xc2 } else { 0xc0 };
        let mut bytes = vec![0xff, 0xd8, 0xff, sof, 0, 17, 8];
        bytes.extend(height.to_be_bytes());
        bytes.extend(width.to_be_bytes());
        bytes.extend([3, 1, sampling, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9]);
        bytes
    }

    fn webp_chunk(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut bytes = kind.to_vec();
        bytes.extend((payload.len() as u32).to_le_bytes());
        bytes.extend(payload);
        if payload.len() % 2 == 1 {
            bytes.push(0);
        }
        bytes
    }

    fn webp_container(chunks: &[Vec<u8>]) -> Vec<u8> {
        let mut bytes = b"RIFF".to_vec();
        bytes.extend((4 + chunks.iter().map(Vec::len).sum::<usize>() as u32).to_le_bytes());
        bytes.extend(b"WEBP");
        for chunk in chunks {
            bytes.extend(chunk);
        }
        bytes
    }

    fn le24(value: u32) -> [u8; 3] {
        let bytes = value.to_le_bytes();
        [bytes[0], bytes[1], bytes[2]]
    }

    #[test]
    fn jpeg_progressive_sampling_workspace_is_budgeted_before_decoder_construction() {
        assert_eq!(
            decode_image(&jpeg_header(4096, 4096, true, 0x11)).err(),
            Some("too-large")
        );
        assert_eq!(
            decode_image(&jpeg_header(16384, 1024, true, 0x44)).err(),
            Some("too-large")
        );
    }

    #[test]
    fn webp_embedded_vp8_dimensions_cannot_hide_behind_small_static_or_animated_canvas() {
        let mut vp8 = vec![0x10, 0, 0, 0x9d, 0x01, 0x2a];
        vp8.extend(16000u16.to_le_bytes());
        vp8.extend(16000u16.to_le_bytes());
        let mut canvas = vec![0; 10];
        canvas[4..7].copy_from_slice(&le24(15));
        canvas[7..10].copy_from_slice(&le24(15));
        let bytes = webp_container(&[webp_chunk(b"VP8X", &canvas), webp_chunk(b"VP8 ", &vp8)]);
        assert_eq!(decode_image(&bytes).err(), Some("too-large"));
        canvas[0] = 0x02;
        let mut frame = vec![0; 16];
        frame[6..9].copy_from_slice(&le24(15));
        frame[9..12].copy_from_slice(&le24(15));
        frame.extend(webp_chunk(b"VP8 ", &vp8));
        let bytes = webp_container(&[
            webp_chunk(b"VP8X", &canvas),
            webp_chunk(b"ANIM", &[0; 6]),
            webp_chunk(b"ANMF", &frame),
        ]);
        assert_eq!(decode_image(&bytes).err(), Some("too-large"));
    }

    #[test]
    fn animated_webp_frame_canvas_and_output_workspace_is_budgeted_before_decode() {
        let mut canvas = vec![0; 10];
        canvas[0] = 0x02;
        canvas[4..7].copy_from_slice(&le24(4095));
        canvas[7..10].copy_from_slice(&le24(4095));
        let mut frame = vec![0; 16];
        frame[6..9].copy_from_slice(&le24(4095));
        frame[9..12].copy_from_slice(&le24(4095));
        frame.extend(webp_chunk(b"VP8L", &[0x2f, 0xff, 0xcf, 0xff, 0x13]));
        let bytes = webp_container(&[
            webp_chunk(b"VP8X", &canvas),
            webp_chunk(b"ANIM", &[0; 6]),
            webp_chunk(b"ANMF", &frame),
        ]);
        assert_eq!(decode_image(&bytes).err(), Some("too-large"));
    }

    #[test]
    fn ordinary_webp_with_small_mismatched_inner_frame_is_rejected_before_pixel_decode() {
        let mut vp8 = vec![0x10, 0, 0, 0x9d, 0x01, 0x2a];
        vp8.extend(64u16.to_le_bytes());
        vp8.extend(64u16.to_le_bytes());
        let mut canvas = vec![0; 10];
        canvas[4..7].copy_from_slice(&le24(15));
        canvas[7..10].copy_from_slice(&le24(15));
        assert_eq!(
            crate::image_budget::preflight(
                &webp_container(&[webp_chunk(b"VP8X", &canvas), webp_chunk(b"VP8 ", &vp8)]),
                ImageFormat::WebP
            ),
            Err("invalid-image")
        );
    }

    #[test]
    fn compressed_webp_alpha_is_refused_when_its_entropy_workspace_is_not_bounded() {
        let mut canvas = vec![0; 10];
        canvas[0] = 0x10;
        canvas[4..7].copy_from_slice(&le24(15));
        canvas[7..10].copy_from_slice(&le24(15));
        let mut vp8 = vec![0x10, 0, 0, 0x9d, 0x01, 0x2a];
        vp8.extend(16u16.to_le_bytes());
        vp8.extend(16u16.to_le_bytes());
        let bytes = webp_container(&[
            webp_chunk(b"VP8X", &canvas),
            webp_chunk(b"ALPH", &[1, 0]),
            webp_chunk(b"VP8 ", &vp8),
        ]);
        assert_eq!(
            crate::image_budget::preflight(&bytes, ImageFormat::WebP),
            Err("unsupported")
        );
    }

    #[test]
    fn lossless_webp_global_entropy_metadata_is_refused_before_unbounded_group_tables() {
        // 1x1 header: no transforms/cache, then meta-Huffman groups present.
        let bytes = webp_container(&[webp_chunk(b"VP8L", &[0x2f, 0, 0, 0, 0, 0b0000_0100])]);
        assert_eq!(
            crate::image_budget::preflight(&bytes, ImageFormat::WebP),
            Err("unsupported")
        );
    }

    #[test]
    fn png_preview_is_a_png_data_url_with_original_dimensions() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("generated.png");
        RgbaImage::from_pixel(16, 8, Rgba([12, 34, 56, 255]))
            .save(&source)
            .unwrap();
        let resources = Arc::new(FileResources::new(temp.path()).unwrap());
        let operation = resources.enter().unwrap();

        let preview = serde_json::to_value(operation.preview(&source)).unwrap();

        assert_eq!(preview["status"], "ready");
        assert_eq!(preview["width"], 16);
        assert_eq!(preview["height"], 8);
        assert!(preview["dataUrl"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert!(preview["version"]
            .as_str()
            .is_some_and(|value| !value.is_empty()));
        assert!(preview.get("reason").is_none());
    }

    #[test]
    fn raster_formats_use_magic_even_when_the_extension_is_disguised() {
        let temp = tempfile::tempdir().unwrap();
        let resources = Arc::new(FileResources::new(temp.path()).unwrap());
        let operation = resources.enter().unwrap();
        for (name, format) in [
            ("png.txt", ImageFormat::Png),
            ("jpeg.png", ImageFormat::Jpeg),
            ("gif.jpeg", ImageFormat::Gif),
            ("webp.svg", ImageFormat::WebP),
            ("bmp.bin", ImageFormat::Bmp),
        ] {
            let source = temp.path().join(name);
            fixture(&source, format, 31, 17);
            let preview = operation.preview(&source);
            assert_eq!(preview.status, "ready", "{name}: {:?}", preview.reason);
            assert_eq!((preview.width, preview.height), (Some(31), Some(17)));
            let (decoded, _) = thumbnail(&preview);
            assert_eq!((decoded.width(), decoded.height()), (31, 17));
        }
    }

    #[test]
    fn missing_nonimage_svg_and_malformed_images_have_only_safe_reasons() {
        let temp = tempfile::tempdir().unwrap();
        let resources = Arc::new(FileResources::new(temp.path()).unwrap());
        let operation = resources.enter().unwrap();
        assert_unavailable(
            operation.preview(&temp.path().join("absent.png")),
            "missing",
        );
        for (name, bytes, reason) in [
            ("not-image.png", b"not an image".as_slice(), "unsupported"),
            ("empty.png", b"".as_slice(), "unsupported"),
            (
                "vector.svg",
                b"<svg xmlns='http://www.w3.org/2000/svg'/>".as_slice(),
                "unsupported",
            ),
            (
                "malformed.png",
                b"\x89PNG\r\n\x1a\ntruncated".as_slice(),
                "invalid-image",
            ),
            (
                "malformed.jpeg",
                b"\xff\xd8\xff\xe0broken".as_slice(),
                "invalid-image",
            ),
        ] {
            let source = temp.path().join(name);
            fs::write(&source, bytes).unwrap();
            assert_unavailable(operation.preview(&source), reason);
        }
    }

    #[test]
    fn resource_paths_reject_relative_urls_unc_ads_controls_and_directories() {
        let temp = tempfile::tempdir().unwrap();
        let resources = Arc::new(FileResources::new(temp.path()).unwrap());
        let operation = resources.enter().unwrap();
        let ads = format!("{}:stream", temp.path().join("source.png").display());
        let controlled = format!("{}/bad\n.png", temp.path().display());
        for value in [
            "",
            "relative.png",
            "https://example.invalid/image.png",
            "file:///C:/image.png",
            "//server/share/image.png",
            r"\\server\share\image.png",
            r"\\?\UNC\server\share\image.png",
            r"\\.\NUL",
            &ads,
            &controlled,
        ] {
            let path = Path::new(value);
            assert_unavailable(operation.preview(path), "unsafe-path");
            assert_eq!(operation.resolve_file(path).unwrap_err(), "unsafe-path");
            assert_eq!(
                operation.prepare_image_copy(path).unwrap_err(),
                "unsafe-path"
            );
        }
        assert_unavailable(operation.preview(temp.path()), "unsafe-path");
        assert_eq!(
            operation.resolve_file(temp.path()).unwrap_err(),
            "unsafe-path"
        );
    }

    #[test]
    fn resolve_file_returns_a_verified_local_regular_file_without_decoding_it() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("regular.txt");
        fs::write(&source, b"local bytes").unwrap();
        let resources = Arc::new(FileResources::new(temp.path()).unwrap());
        let operation = resources.enter().unwrap();
        let resolved = operation.resolve_file(&source).unwrap();
        assert!(Path::new(&resolved).is_absolute());
        assert_eq!(fs::read(&resolved).unwrap(), b"local bytes");
        assert_eq!(
            operation
                .resolve_file(&temp.path().join("missing"))
                .unwrap_err(),
            "missing"
        );
    }

    #[test]
    fn bounded_read_catches_growth_past_metadata_without_reading_an_unbounded_stream() {
        struct GrowingReader {
            bytes_read: Arc<std::sync::atomic::AtomicUsize>,
        }
        impl std::io::Read for GrowingReader {
            fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                bytes.fill(0);
                self.bytes_read
                    .fetch_add(bytes.len(), std::sync::atomic::Ordering::SeqCst);
                Ok(bytes.len())
            }
        }
        assert_eq!(read_bounded(Cursor::new(b"bytes"), 5).unwrap(), b"bytes");
        let bytes_read = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let result = read_bounded(
            GrowingReader {
                bytes_read: Arc::clone(&bytes_read),
            },
            1,
        );
        assert_eq!(result.unwrap_err(), "too-large");
        assert_eq!(
            bytes_read.load(std::sync::atomic::Ordering::SeqCst),
            32 * 1024 * 1024 + 1
        );
    }

    #[test]
    fn encoded_source_above_32_mib_is_rejected_before_decode() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("encoded-oversize.png");
        fixture(&source, ImageFormat::Png, 1, 1);
        let file = File::options().write(true).open(&source).unwrap();
        file.set_len(32 * 1024 * 1024 + 1).unwrap();
        drop(file);
        let resources = Arc::new(FileResources::new(temp.path()).unwrap());
        let operation = resources.enter().unwrap();
        assert_unavailable(operation.preview(&source), "too-large");
        assert_eq!(
            operation.prepare_image_copy(&source).unwrap_err(),
            "too-large"
        );
    }

    #[test]
    fn small_encoded_dimension_bombs_are_rejected_without_pixel_allocation() {
        let temp = tempfile::tempdir().unwrap();
        let resources = Arc::new(FileResources::new(temp.path()).unwrap());
        let operation = resources.enter().unwrap();
        for (width, height) in [(16_385, 1), (8_192, 2_049), (65_535, 65_535)] {
            let source = temp.path().join(format!("bomb-{width}-{height}.png"));
            png_dimension_bomb(&source, width, height);
            assert!(fs::metadata(&source).unwrap().len() < 512);
            let started = Instant::now();
            assert_unavailable(operation.preview(&source), "too-large");
            assert_eq!(
                operation.prepare_image_copy(&source).unwrap_err(),
                "too-large"
            );
            assert!(started.elapsed() < Duration::from_secs(5));
        }
    }

    #[test]
    fn thumbnail_never_upscales_and_bounds_the_longest_side() {
        let temp = tempfile::tempdir().unwrap();
        let resources = Arc::new(FileResources::new(temp.path()).unwrap());
        let operation = resources.enter().unwrap();
        for (width, height, expected) in [
            (1_024, 256, (384, 96)),
            (200, 800, (96, 384)),
            (13, 11, (13, 11)),
        ] {
            let source = temp.path().join(format!("size-{width}-{height}.png"));
            fixture(&source, ImageFormat::Png, width, height);
            let preview = operation.preview(&source);
            assert_eq!(preview.status, "ready");
            assert_eq!((preview.width, preview.height), (Some(width), Some(height)));
            let (decoded, length) = thumbnail(&preview);
            assert_eq!((decoded.width(), decoded.height()), expected);
            assert!(length <= 512 * 1024);
        }
    }

    fn noisy_fixture(path: &Path, width: u32, height: u32) {
        let mut state = 0x1234_5678u32;
        let pixels = RgbaImage::from_fn(width, height, |_, _| {
            let mut pixel = [0; 4];
            for component in &mut pixel {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                *component = state as u8;
            }
            Rgba(pixel)
        });
        pixels.save(path).unwrap();
    }

    #[test]
    fn noisy_thumbnail_png_is_bounded_to_512_kib() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("noise.png");
        noisy_fixture(&source, 384, 384);
        let resources = Arc::new(FileResources::new(temp.path()).unwrap());
        let operation = resources.enter().unwrap();
        let preview = operation.preview(&source);
        assert_eq!(preview.status, "ready");
        let (decoded, length) = thumbnail(&preview);
        assert!(decoded.width() <= 384 && decoded.height() <= 384);
        assert!(length <= 512 * 1024, "encoded thumbnail was {length} bytes");
    }

    #[test]
    fn same_size_source_mutation_invalidates_the_cached_file_version() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("mutable.bmp");
        fixture(&source, ImageFormat::Bmp, 40, 20);
        let resources = Arc::new(FileResources::new(temp.path()).unwrap());
        let operation = resources.enter().unwrap();
        let first = operation.preview(&source);
        assert_eq!(first.status, "ready");
        let size = fs::metadata(&source).unwrap().len();
        DynamicImage::ImageRgb8(RgbImage::from_pixel(40, 20, Rgb([200, 1, 2])))
            .save_with_format(&source, ImageFormat::Bmp)
            .unwrap();
        assert_eq!(fs::metadata(&source).unwrap().len(), size);
        File::options()
            .write(true)
            .open(&source)
            .unwrap()
            .set_times(
                fs::FileTimes::new().set_modified(SystemTime::now() + Duration::from_secs(2)),
            )
            .unwrap();
        let second = operation.preview(&source);
        assert_eq!(second.status, "ready");
        assert_ne!(first.version, second.version);
        assert_ne!(first.data_url, second.data_url);
    }

    fn corrupt_preserving_version(path: &Path) {
        let metadata = fs::metadata(path).unwrap();
        let mut file = File::options().write(true).open(path).unwrap();
        file.write_all(b"\x89PNG\r\n\x1a\ninvalid!").unwrap();
        file.set_len(metadata.len()).unwrap();
        file.set_times(fs::FileTimes::new().set_modified(metadata.modified().unwrap()))
            .unwrap();
    }

    #[test]
    fn thumbnail_cache_evicts_after_64_distinct_files() {
        let temp = tempfile::tempdir().unwrap();
        let resources = Arc::new(FileResources::new(temp.path()).unwrap());
        let operation = resources.enter().unwrap();
        let first = temp.path().join("entry-0.png");
        fixture(&first, ImageFormat::Png, 8, 8);
        assert_eq!(operation.preview(&first).status, "ready");
        for index in 1..=64 {
            let source = temp.path().join(format!("entry-{index}.png"));
            fixture(&source, ImageFormat::Png, 8, 8);
            assert_eq!(operation.preview(&source).status, "ready");
        }
        corrupt_preserving_version(&first);
        assert_unavailable(operation.preview(&first), "invalid-image");
    }

    #[test]
    fn thumbnail_cache_evicts_large_entries_within_8_mib_budget() {
        let temp = tempfile::tempdir().unwrap();
        let resources = Arc::new(FileResources::new(temp.path()).unwrap());
        let operation = resources.enter().unwrap();
        let first = temp.path().join("large-0.png");
        noisy_fixture(&first, 320, 320);
        assert_eq!(operation.preview(&first).status, "ready");
        for index in 1..=22 {
            let source = temp.path().join(format!("large-{index}.png"));
            fs::copy(&first, &source).unwrap();
            assert_eq!(operation.preview(&source).status, "ready");
        }
        corrupt_preserving_version(&first);
        assert_unavailable(operation.preview(&first), "invalid-image");
    }

    #[test]
    fn copy_is_original_size_png_and_stable_until_explicit_release() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.jpeg");
        fixture(&source, ImageFormat::Jpeg, 600, 300);
        let resources = Arc::new(FileResources::new(temp.path()).unwrap());
        let operation = resources.enter().unwrap();
        let copy = operation.prepare_image_copy(&source).unwrap();
        assert_eq!((copy.width, copy.height), (600, 300));
        assert!(Path::new(&copy.path).is_absolute());
        assert_ne!(Path::new(&copy.path), source);
        let encoded = fs::read(&copy.path).unwrap();
        assert_eq!(image::guess_format(&encoded).unwrap(), ImageFormat::Png);
        let decoded = image::load_from_memory(&encoded).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (600, 300));
        assert!(encoded.len() <= 32 * 1024 * 1024);
        let json = serde_json::to_value(&copy).unwrap();
        assert_eq!(json["resourceId"], copy.resource_id);
        assert!(json.get("resource_id").is_none());
        fs::remove_file(&source).unwrap();
        let other = temp.path().join("other.png");
        fixture(&other, ImageFormat::Png, 3, 2);
        let other_copy = operation.prepare_image_copy(&other).unwrap();
        assert_eq!(fs::read(&copy.path).unwrap(), encoded);
        operation
            .release_image_copy(&other_copy.resource_id)
            .unwrap();
        assert!(Path::new(&copy.path).exists());
        operation.release_image_copy(&copy.resource_id).unwrap();
        assert!(!Path::new(&copy.path).exists());
        assert!(operation.release_image_copy(&copy.resource_id).is_err());
    }

    #[test]
    fn image_copy_accepts_all_supported_magic_formats() {
        let temp = tempfile::tempdir().unwrap();
        let resources = Arc::new(FileResources::new(temp.path()).unwrap());
        let operation = resources.enter().unwrap();
        for (index, format) in [
            ImageFormat::Png,
            ImageFormat::Jpeg,
            ImageFormat::Gif,
            ImageFormat::WebP,
            ImageFormat::Bmp,
        ]
        .into_iter()
        .enumerate()
        {
            let source = temp.path().join(format!("copy-{index}.bin"));
            fixture(&source, format, 29, 13);
            let copy = operation.prepare_image_copy(&source).unwrap();
            let encoded = fs::read(&copy.path).unwrap();
            assert_eq!(image::guess_format(&encoded).unwrap(), ImageFormat::Png);
            let decoded = image::load_from_memory(&encoded).unwrap();
            assert_eq!((decoded.width(), decoded.height()), (29, 13));
            operation.release_image_copy(&copy.resource_id).unwrap();
        }
    }

    #[test]
    fn unknown_resource_ids_cannot_delete_user_or_other_owner_files() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("untouched.png");
        fixture(&source, ImageFormat::Png, 8, 8);
        let resources = Arc::new(FileResources::new(temp.path()).unwrap());
        let other_owner = Arc::new(FileResources::new(temp.path()).unwrap());
        let operation = resources.enter().unwrap();
        let other_operation = other_owner.enter().unwrap();
        let copy = operation.prepare_image_copy(&source).unwrap();
        for id in [
            "unknown",
            "../../untouched.png",
            source.to_str().unwrap(),
            copy.path.as_str(),
        ] {
            assert!(operation.release_image_copy(id).is_err());
        }
        assert!(other_operation
            .release_image_copy(&copy.resource_id)
            .is_err());
        assert!(source.is_file());
        assert!(Path::new(&copy.path).is_file());
        operation.release_image_copy(&copy.resource_id).unwrap();
        assert!(source.is_file());
    }

    #[test]
    fn decode_admission_allows_two_workers_and_blocks_a_third_until_release() {
        let temp = tempfile::tempdir().unwrap();
        let resources = Arc::new(FileResources::new(temp.path()).unwrap());
        let first = resources.acquire_decode();
        let second = resources.acquire_decode();
        let (started_tx, started_rx) = mpsc::channel();
        let (admitted_tx, admitted_rx) = mpsc::channel();
        let worker_owner = Arc::clone(&resources);
        let worker = thread::spawn(move || {
            started_tx.send(()).unwrap();
            let _third = worker_owner.acquire_decode();
            admitted_tx.send(()).unwrap();
        });
        started_rx.recv().unwrap();
        let before_release = admitted_rx.recv_timeout(Duration::from_millis(100));
        drop(first);
        if before_release.is_err() {
            admitted_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        }
        worker.join().unwrap();
        drop(second);
        assert!(
            matches!(before_release, Err(mpsc::RecvTimeoutError::Timeout)),
            "a third decoder must not bypass the budget"
        );
    }

    #[test]
    fn only_four_copy_leases_can_exist_and_release_restores_capacity() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.png");
        fixture(&source, ImageFormat::Png, 8, 8);
        let resources = Arc::new(FileResources::new(temp.path()).unwrap());
        let operation = resources.enter().unwrap();
        let copies: Vec<_> = (0..4)
            .map(|_| operation.prepare_image_copy(&source).unwrap())
            .collect();
        assert!(operation.prepare_image_copy(&source).is_err());
        for copy in &copies {
            assert!(Path::new(&copy.path).is_file());
        }
        operation
            .release_image_copy(&copies[0].resource_id)
            .unwrap();
        let replacement = operation.prepare_image_copy(&source).unwrap();
        assert!(Path::new(&replacement.path).is_file());
        for copy in copies
            .into_iter()
            .skip(1)
            .chain(std::iter::once(replacement))
        {
            operation.release_image_copy(&copy.resource_id).unwrap();
        }
    }

    #[test]
    fn shutdown_fences_admission_drains_operations_and_only_removes_owned_copies() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("preserved.png");
        fixture(&source, ImageFormat::Png, 8, 8);
        let sentinel = temp.path().join("not-owned.txt");
        fs::write(&sentinel, b"preserve me").unwrap();
        let resources = Arc::new(FileResources::new(temp.path()).unwrap());
        let operation = resources.enter().unwrap();
        let copies: Vec<_> = (0..4)
            .map(|_| operation.prepare_image_copy(&source).unwrap())
            .collect();
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let shutdown_owner = Arc::clone(&resources);
        let worker = thread::spawn(move || {
            started_tx.send(()).unwrap();
            shutdown_owner.shutdown();
            done_tx.send(()).unwrap();
        });
        started_rx.recv().unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while resources.enter().is_ok() && Instant::now() < deadline {
            thread::yield_now();
        }
        assert!(
            resources.enter().is_err(),
            "shutdown must fence new operations"
        );
        assert!(matches!(
            done_rx.recv_timeout(Duration::from_millis(50)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        for copy in &copies {
            assert!(
                Path::new(&copy.path).is_file(),
                "active operation still owns its resources"
            );
        }
        assert_eq!(
            operation.preview(&source).status,
            "ready",
            "an already admitted native operation can complete"
        );
        drop(operation);
        done_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        worker.join().unwrap();
        for copy in copies {
            assert!(!Path::new(&copy.path).exists());
        }
        assert_eq!(fs::read(&sentinel).unwrap(), b"preserve me");
        assert!(source.is_file());
        assert!(resources.enter().is_err());
        resources.shutdown();
    }
}
