# Third-Party Notices

This plugin is derived from and reuses third-party projects. Their licenses are reproduced below as required.

## LocalSend

- Upstream: https://github.com/localsend/localsend (snapshot `v1.18.2`, 2026-08-21)
- Protocol specification: https://github.com/localsend/protocol (v2.2)
- License: **GNU General Public License v3.0** (GPL-3.0)
- Scope: protocol behavior (multicast discovery, register/prepare-upload/upload/cancel/info endpoints) is reimplemented with reference to the upstream Dart sources and the v2.2 specification; the UI is rebuilt for the OTools panel. This entire plugin is therefore distributed under GPL-3.0 — see the root `LICENSE` for the full license text.

## otools-plugin-sdk

- Source: vendored snapshot under `vendor/otools-plugin-sdk/` (from https://github.com/ootools/otools-plugin-sdk)
- License: **MIT License**
- Full license text: [`LICENSES/otools-plugin-sdk-MIT.txt`](LICENSES/otools-plugin-sdk-MIT.txt)

MIT License

Copyright (c) 2026 Jason Young

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Native image stack (v0.5.0 additions)

The native library adds `image` 0.25.10 with only PNG, JPEG, GIF, WebP and BMP format features enabled. The following **22 package versions** are new relative to `8851c43` in `native/Cargo.lock` and belong to its image dependency chain, including codec, color-management, compression and checksum support. Both `miniz_oxide` versions are listed separately. `image-webp` is also a direct test dependency, but is already a runtime dependency through `image` and is attributed only once. Existing Rust dependencies and unrelated test/build dependencies are outside this incremental notice update.

Evidence was taken from the installed Cargo registry copies of these exact versions: `Cargo.toml`, the supplied `LICENSE*` files and embedded source notices. The separately referenced Chromium ARM/NEON source notice and repository BSD-style license were verified from the public upstream source on 2026-11-16 and retained as described below. Where upstream offers alternative licenses, this distribution uses **MIT**, **BSD-3-Clause** or **Zlib** as identified below; the complete selected texts and available copyright notices are retained in the linked files. Authors are copied from upstream package metadata, not inferred as copyright holders. `image`, `fdeflate` and `image-webp` ship an MIT text without a copyright line; no copyright year or holder has been invented. Shared license copies below were confirmed byte-identical, not merely equivalent SPDX identifiers.

| New package version | Upstream license declaration → license used | Attribution from local upstream evidence | Full text / notices |
| --- | --- | --- | --- |
| `adler2` 2.0.1 | `0BSD OR MIT OR Apache-2.0` → MIT | Jonas Schievink; oyvindln (package authors); supplied 0BSD copyright line also retained | [native-adler2-2.0.1.txt](LICENSES/native-adler2-2.0.1.txt) |
| `bytemuck` 1.25.2 | `Zlib OR Apache-2.0 OR MIT` → MIT | Copyright (c) 2019 Daniel "Lokathor" Gee. | [native-bytemuck-1.25.2.txt](LICENSES/native-bytemuck-1.25.2.txt) |
| `byteorder-lite` 0.1.0 | `Unlicense OR MIT` → MIT | Copyright (c) 2015 Andrew Gallant | [native-byteorder-lite-0.1.0.txt](LICENSES/native-byteorder-lite-0.1.0.txt) |
| `color_quant` 1.1.0 | MIT; additional embedded NeuQuant notice retained | Copyright (c) 2016 PistonDevelopers; source: Copyright (c) 2014 The Piston Developers and Copyright (c) 1994 Anthony Dekker | [native-color_quant-1.1.0.txt](LICENSES/native-color_quant-1.1.0.txt) |
| `crc32fast` 1.5.5 | `MIT OR Apache-2.0` → MIT | Copyright (c) 2018 Sam Rijs, Alex Crichton and contributors | [native-crc32fast-1.5.5.txt](LICENSES/native-crc32fast-1.5.5.txt) |
| `fdeflate` 0.3.7 | `MIT OR Apache-2.0` → MIT | The image-rs Developers (package authors) | [native-image-0.25.10.txt](LICENSES/native-image-0.25.10.txt), shared MIT text |
| `flate2` 1.1.11 | `MIT OR Apache-2.0` → MIT | Copyright (c) 2014-2026 Alex Crichton; source: Copyright 2013 The Rust Project Developers | [native-flate2-1.1.11.txt](LICENSES/native-flate2-1.1.11.txt) |
| `gif` 0.14.2 | `MIT OR Apache-2.0` → MIT | Copyright (c) 2015 nwin | [native-gif-0.14.2.txt](LICENSES/native-gif-0.14.2.txt) |
| `image` 0.25.10 | `MIT OR Apache-2.0` → MIT; additional embedded IJG conditions retained | The image-rs Developers (package authors); MIT macro attribution: Copyright (c) 2018 Guillaume Gomez; JPEG: copyright (C) 1991-2014, Thomas G. Lane, Guido Vollbeding | [native-image-0.25.10.txt](LICENSES/native-image-0.25.10.txt) |
| `image-webp` 0.2.4 | `MIT OR Apache-2.0` → MIT | Upstream project: image-rs/image-webp; no package authors or copyright line supplied | [native-image-0.25.10.txt](LICENSES/native-image-0.25.10.txt), shared MIT text |
| `miniz_oxide` 0.8.9 | `MIT OR Zlib OR Apache-2.0` → MIT | Copyright 2013-2014 RAD Game Tools and Valve Software; Copyright 2010-2014 Rich Geldreich and Tenacious Software LLC; Copyright (c) 2017 Frommi; Copyright (c) 2017-2024 oyvindln | [native-miniz_oxide-0.8.9.txt](LICENSES/native-miniz_oxide-0.8.9.txt) |
| `miniz_oxide` 0.9.1 | `MIT OR Zlib OR Apache-2.0` → MIT | Same supplied notices as 0.8.9, reproduced in the shared file | [native-miniz_oxide-0.8.9.txt](LICENSES/native-miniz_oxide-0.8.9.txt), byte-identical `LICENSE` |
| `moxcms` 0.8.1 | `BSD-3-Clause OR Apache-2.0` → BSD-3-Clause | Copyright (c) Radzivon Bartoshyk. All rights reserved.; exact dated source notices also retained | [native-moxcms-0.8.1.txt](LICENSES/native-moxcms-0.8.1.txt) |
| `num-traits` 0.2.19 | `MIT OR Apache-2.0` → MIT | Copyright (c) 2014 The Rust Project Developers; source: Copyright 2013-2014 The Rust Project Developers | [native-num-traits-0.2.19.txt](LICENSES/native-num-traits-0.2.19.txt) |
| `png` 0.18.1 | `MIT OR Apache-2.0` → MIT | Copyright (c) 2015 nwin | [native-png-0.18.1.txt](LICENSES/native-png-0.18.1.txt) |
| `pxfm` 0.1.30 | `BSD-3-Clause OR Apache-2.0` → BSD-3-Clause | Copyright (c) Radzivon Bartoshyk. All rights reserved.; exact dated source notices also retained | [native-moxcms-0.8.1.txt](LICENSES/native-moxcms-0.8.1.txt), shared BSD text |
| `quick-error` 2.0.1 | `MIT/Apache-2.0` (upstream spelling) → MIT | Copyright (c) 2015 The quick-error Developers | [native-quick-error-2.0.1.txt](LICENSES/native-quick-error-2.0.1.txt) |
| `simd-adler32` 0.3.10 | MIT; derived ARM/NEON Chromium BSD-style notice also retained | Copyright (c) [2021] [Marvin Countryman] (brackets retained verbatim); Copyright 2017 The Chromium Authors | [native-simd-adler32-0.3.10.txt](LICENSES/native-simd-adler32-0.3.10.txt) |
| `weezl` 0.1.12 | `MIT OR Apache-2.0` → MIT | Copyright (c) HeroicKatora 2020 | [native-weezl-0.1.12.txt](LICENSES/native-weezl-0.1.12.txt) |
| `zlib-rs` 0.6.8 | Zlib | (C) 2024 Trifecta Tech Foundation | [native-zlib-rs-0.6.8.txt](LICENSES/native-zlib-rs-0.6.8.txt) |
| `zune-core` 0.5.3 | `MIT OR Apache-2.0 OR Zlib` → MIT | Copyright (c) zune-image developers; source year-only notices retained without supplying a missing holder | [native-zune-core-0.5.3.txt](LICENSES/native-zune-core-0.5.3.txt) |
| `zune-jpeg` 0.5.15 | `MIT OR Apache-2.0 OR Zlib` → MIT | Copyright (c) zune-image developers; source year-only notices retained without supplying a missing holder | [native-zune-core-0.5.3.txt](LICENSES/native-zune-core-0.5.3.txt), shared MIT text |

### Embedded codec notices and evidence boundary

- **IJG acknowledgement:** this software is based in part on the work of the Independent JPEG Group. `image`'s JPEG transform is a Rust translation of `jfdctint.c` from libjpeg 9a; its complete embedded distribution conditions are reproduced in `LICENSES/native-image-0.25.10.txt` in addition to the crate's MIT text.
- **NeuQuant:** `color_quant`'s source retains Anthony Dekker's 1994 notice and its notice-preservation requirement. The full source notice is reproduced in `LICENSES/native-color_quant-1.1.0.txt` alongside the crate's MIT license.
- **Chromium ARM/NEON attribution:** `simd-adler32` 0.3.10 converts code from Chromium `third_party/zlib/adler32_simd.c`. The publicly referenced source identifies Copyright 2017 The Chromium Authors and the Chromium repository BSD-style license. Its notice and full referenced license were verified on 2026-11-16 and retained in `LICENSES/native-simd-adler32-0.3.10.txt`, explicitly marking the Rust conversion as a derived version.

### Exact added license-file list (17 files)

- [`LICENSES/native-adler2-2.0.1.txt`](LICENSES/native-adler2-2.0.1.txt)
- [`LICENSES/native-bytemuck-1.25.2.txt`](LICENSES/native-bytemuck-1.25.2.txt)
- [`LICENSES/native-byteorder-lite-0.1.0.txt`](LICENSES/native-byteorder-lite-0.1.0.txt)
- [`LICENSES/native-color_quant-1.1.0.txt`](LICENSES/native-color_quant-1.1.0.txt)
- [`LICENSES/native-crc32fast-1.5.5.txt`](LICENSES/native-crc32fast-1.5.5.txt)
- [`LICENSES/native-flate2-1.1.11.txt`](LICENSES/native-flate2-1.1.11.txt)
- [`LICENSES/native-gif-0.14.2.txt`](LICENSES/native-gif-0.14.2.txt)
- [`LICENSES/native-image-0.25.10.txt`](LICENSES/native-image-0.25.10.txt)
- [`LICENSES/native-miniz_oxide-0.8.9.txt`](LICENSES/native-miniz_oxide-0.8.9.txt)
- [`LICENSES/native-moxcms-0.8.1.txt`](LICENSES/native-moxcms-0.8.1.txt)
- [`LICENSES/native-num-traits-0.2.19.txt`](LICENSES/native-num-traits-0.2.19.txt)
- [`LICENSES/native-png-0.18.1.txt`](LICENSES/native-png-0.18.1.txt)
- [`LICENSES/native-quick-error-2.0.1.txt`](LICENSES/native-quick-error-2.0.1.txt)
- [`LICENSES/native-simd-adler32-0.3.10.txt`](LICENSES/native-simd-adler32-0.3.10.txt)
- [`LICENSES/native-weezl-0.1.12.txt`](LICENSES/native-weezl-0.1.12.txt)
- [`LICENSES/native-zlib-rs-0.6.8.txt`](LICENSES/native-zlib-rs-0.6.8.txt)
- [`LICENSES/native-zune-core-0.5.3.txt`](LICENSES/native-zune-core-0.5.3.txt)
