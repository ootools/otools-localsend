# Source provenance

This independent OTools plugin ports LocalSend's cross-device local network file and text transfer to the OTools plugin platform.

| Component | Source | Snapshot |
| --- | --- | --- |
| LocalSend | https://github.com/localsend/localsend | `v1.18.2` (2026-08-21, latest release at implementation time) |
| LocalSend protocol specification | https://github.com/localsend/protocol | `v2.2` |
| OTools plugin SDK | https://github.com/ootools/otools-plugin-sdk | `e82c50ae5c1dbb73d1b5eeea1faafd13e6e03de3` (2026-11-10) |

The plugin implements LocalSend protocol v2 compatibility (UDP multicast discovery on `224.0.0.167:53317`, self-signed HTTPS endpoints `register` / `prepare-upload` / `upload` / `cancel` / `info`) with reference to the upstream Dart source at the snapshot above and the `localsend/protocol` v2.2 specification. No upstream code is copied verbatim; the protocol behavior is reimplemented in Rust for the plugin native ABI, and the UI is rebuilt for the OTools panel.

The plugin does not bundle the upstream desktop application or the Flutter runtime. The upstream remote-transfer (download direction) and favorite-device extensions are out of scope for v1. Storage, certificates and transfer history are isolated under the plugin data directory.

Upstream LocalSend is GPL-3.0 licensed and this derivative plugin is distributed under GPL-3.0 as well; see `LICENSE` and `THIRD_PARTY_NOTICES.md`. The vendored OTools plugin SDK is MIT licensed; its full license text is reproduced in `LICENSES/otools-plugin-sdk-MIT.txt`, with the snapshot checked in under `vendor/otools-plugin-sdk` so building the plugin does not depend on neighboring repositories.
