use crate::file_resources::{dimensions_allowed, MAX_ALLOCATION};
use image::ImageFormat;

type Reason = &'static str;

fn budget(bytes: u64) -> Result<(), Reason> {
    if bytes > MAX_ALLOCATION {
        Err("too-large")
    } else {
        Ok(())
    }
}

pub(super) fn preflight(bytes: &[u8], format: ImageFormat) -> Result<(), Reason> {
    match format {
        ImageFormat::Jpeg => jpeg(bytes),
        ImageFormat::WebP => webp(bytes),
        _ => Ok(()),
    }
}

fn jpeg(bytes: &[u8]) -> Result<(), Reason> {
    if !bytes.starts_with(&[0xff, 0xd8]) {
        return Err("invalid-image");
    }
    let mut offset = 2;
    while offset < bytes.len() {
        if bytes[offset] != 0xff {
            return Err("invalid-image");
        }
        while bytes.get(offset) == Some(&0xff) {
            offset += 1;
        }
        let marker = *bytes.get(offset).ok_or("invalid-image")?;
        offset += 1;
        if marker == 0xda || marker == 0xd9 {
            return Err("invalid-image");
        }
        if marker == 0x01 || (0xd0..=0xd8).contains(&marker) {
            continue;
        }
        let length_bytes = bytes.get(offset..offset + 2).ok_or("invalid-image")?;
        let length = usize::from(u16::from_be_bytes(length_bytes.try_into().unwrap()));
        if length < 2 {
            return Err("invalid-image");
        }
        let body = bytes
            .get(offset + 2..offset + length)
            .ok_or("invalid-image")?;
        offset += length;
        if !matches!(marker, 0xc0..=0xcf) || matches!(marker, 0xc4 | 0xc8 | 0xcc) {
            continue;
        }
        if !matches!(marker, 0xc0..=0xc2) {
            return Err("unsupported");
        }
        if body.len() < 6 || body[0] != 8 {
            return Err("unsupported");
        }
        let height = u32::from(u16::from_be_bytes(body[1..3].try_into().unwrap()));
        let width = u32::from(u16::from_be_bytes(body[3..5].try_into().unwrap()));
        dimensions_allowed(width, height)?;
        let components = usize::from(body[5]);
        if !matches!(components, 1 | 3 | 4) || body.len() != 6 + components * 3 {
            return Err("invalid-image");
        }
        let mut horizontal_max = 1u64;
        let mut vertical_max = 1u64;
        let mut sample_blocks = 0u64;
        let mut seen = [false; 256];
        for component in body[6..].chunks_exact(3) {
            if seen[usize::from(component[0])] {
                return Err("invalid-image");
            }
            seen[usize::from(component[0])] = true;
            let horizontal = u64::from(component[1] >> 4);
            let vertical = u64::from(component[1] & 15);
            if !(1..=4).contains(&horizontal) || !(1..=4).contains(&vertical) {
                return Err("invalid-image");
            }
            horizontal_max = horizontal_max.max(horizontal);
            vertical_max = vertical_max.max(vertical);
            sample_blocks += horizontal * vertical;
        }
        // Budget progressive i16 coefficients, output, upsampling/row scratch and input.
        let pixels = u64::from(width) * u64::from(height);
        let mcu_columns = u64::from(width).div_ceil(horizontal_max * 8);
        let mcu_rows = u64::from(height).div_ceil(vertical_max * 8);
        let coefficients = if marker == 0xc2 {
            mcu_columns * mcu_rows * sample_blocks * 128
        } else {
            0
        };
        let row_scratch = mcu_columns * 8 * sample_blocks * 8 * 16;
        return budget(coefficients + pixels * 6 + row_scratch + bytes.len() as u64 + 1024 * 1024);
    }
    Err("invalid-image")
}

fn le24(bytes: &[u8]) -> u32 {
    u32::from_le_bytes([bytes[0], bytes[1], bytes[2], 0])
}

fn visit_chunks(
    mut bytes: &[u8],
    mut visit: impl FnMut(&[u8], &[u8]) -> Result<(), Reason>,
) -> Result<(), Reason> {
    let mut count = 0;
    while !bytes.is_empty() {
        count += 1;
        if count > 4096 || bytes.len() < 8 {
            return Err("invalid-image");
        }
        let size = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        let end = 8usize.checked_add(size).ok_or("invalid-image")?;
        let body = bytes.get(8..end).ok_or("invalid-image")?;
        visit(&bytes[..4], body)?;
        let next = end.checked_add(size & 1).ok_or("invalid-image")?;
        bytes = bytes.get(next..).ok_or("invalid-image")?;
    }
    Ok(())
}

fn lossless_entropy_budget(body: &[u8]) -> Result<(), Reason> {
    let mut position = 0;
    let mut read = |count: usize| -> Result<u8, Reason> {
        let mut value = 0;
        for bit in 0..count {
            let byte = *body.get(position / 8).ok_or("invalid-image")?;
            value |= ((byte >> (position % 8)) & 1) << bit;
            position += 1;
        }
        Ok(value)
    };
    // Subtract-green has no embedded entropy image. Other transforms require an
    // independently decoded substream, so do not admit them without a bounded parser.
    let mut transformed = false;
    while read(1)? != 0 {
        if read(2)? != 2 || transformed {
            return Err("unsupported");
        }
        transformed = true;
    }
    if read(1)? != 0 {
        let bits = read(4)?;
        if !(1..=11).contains(&bits) {
            return Err("invalid-image");
        }
    }
    // Meta-Huffman can allocate up to 65536 code groups even for a tiny canvas.
    if read(1)? != 0 {
        return Err("unsupported");
    }
    Ok(())
}

fn bitstream_dimensions(kind: &[u8], body: &[u8]) -> Result<(u32, u32), Reason> {
    let dimensions = if kind == b"VP8 " {
        if body.len() < 10 || body[0] & 1 != 0 || body[3..6] != [0x9d, 1, 0x2a] {
            return Err("invalid-image");
        }
        (
            u32::from(u16::from_le_bytes(body[6..8].try_into().unwrap()) & 0x3fff),
            u32::from(u16::from_le_bytes(body[8..10].try_into().unwrap()) & 0x3fff),
        )
    } else {
        if body.len() < 5 || body[0] != 0x2f {
            return Err("invalid-image");
        }
        let bits = u32::from_le_bytes(body[1..5].try_into().unwrap());
        if bits >> 29 != 0 {
            return Err("invalid-image");
        }
        lossless_entropy_budget(&body[5..])?;
        ((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
    };
    dimensions_allowed(dimensions.0, dimensions.1)?;
    Ok(dimensions)
}

fn webp_alpha(body: &[u8]) -> Result<(), Reason> {
    let header = *body.first().ok_or("invalid-image")?;
    // Compressed ALPH embeds a lossless entropy stream without a dimension header.
    if header & 3 != 0 {
        return Err("unsupported");
    }
    Ok(())
}

fn webp(bytes: &[u8]) -> Result<(), Reason> {
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return Err("invalid-image");
    }
    let end = 8usize
        .checked_add(u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize)
        .ok_or("invalid-image")?;
    if end != bytes.len() {
        return Err("invalid-image");
    }
    let mut canvas = None;
    let mut animated = false;
    let mut payload_count = 0;
    visit_chunks(&bytes[12..], |kind, body| {
        if kind == b"VP8X" {
            if body.len() != 10 || canvas.is_some() {
                return Err("invalid-image");
            }
            let width = le24(&body[4..7]) + 1;
            let height = le24(&body[7..10]) + 1;
            dimensions_allowed(width, height)?;
            animated = body[0] & 2 != 0;
            canvas = Some((width, height));
            // Include output, RGBA frame/canvas, YUV/transform workspace and encoded input.
            budget(
                u64::from(width) * u64::from(height) * if animated { 24 } else { 16 }
                    + bytes.len() as u64
                    + 1024 * 1024,
            )?;
        } else if kind == b"VP8 " || kind == b"VP8L" {
            if animated {
                return Err("invalid-image");
            }
            payload_count += 1;
            let dimensions = bitstream_dimensions(kind, body)?;
            if canvas.is_some_and(|size| size != dimensions) {
                return Err("invalid-image");
            }
            canvas = Some(dimensions);
            budget(
                u64::from(dimensions.0) * u64::from(dimensions.1) * 16
                    + bytes.len() as u64
                    + 1024 * 1024,
            )?;
        } else if kind == b"ALPH" {
            webp_alpha(body)?;
        } else if kind == b"ANMF" {
            let (width, height) = canvas.filter(|_| animated).ok_or("invalid-image")?;
            if body.len() < 16 {
                return Err("invalid-image");
            }
            let x = le24(&body[..3]) * 2;
            let y = le24(&body[3..6]) * 2;
            let frame_width = le24(&body[6..9]) + 1;
            let frame_height = le24(&body[9..12]) + 1;
            dimensions_allowed(frame_width, frame_height)?;
            if x + frame_width > width || y + frame_height > height {
                return Err("invalid-image");
            }
            let mut frame_payloads = 0;
            visit_chunks(&body[16..], |kind, frame| {
                if kind == b"ALPH" {
                    webp_alpha(frame)?;
                }
                if kind == b"VP8 " || kind == b"VP8L" {
                    frame_payloads += 1;
                    if bitstream_dimensions(kind, frame)? != (frame_width, frame_height) {
                        return Err("invalid-image");
                    }
                }
                Ok(())
            })?;
            if frame_payloads != 1 {
                return Err("invalid-image");
            }
            payload_count += 1;
        }
        Ok(())
    })?;
    if canvas.is_none() || payload_count == 0 || (!animated && payload_count != 1) {
        return Err("invalid-image");
    }
    Ok(())
}
