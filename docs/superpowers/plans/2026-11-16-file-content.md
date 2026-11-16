# File Content and Image Experience Implementation Plan

> **For agentic workers:** Use the available general-purpose subagent tool for independent file ownership, with the controller implementing shared interfaces and a fresh final reviewer. No branch/worktree or commits/push/publication; project/user constraints override workflow defaults. Steps use checkbox syntax.

**Goal:** Implement image previews, the exact `~/Download/OToolsLocalSend` default, rich transferable content history, clipboard/folder actions and explicit-consent image save targets.

**Architecture:** Preserve React + Rust and LocalSend v2 network DTOs. Native supplies bounded images and verified local resources; React renders content and stages save choices; existing host IPC provides awaited clipboard/reveal. Existing receive worker ownership remains authoritative for final disk writes.

**Tech Stack:** React 18, TypeScript, Vite, Node tests; Rust/Tokio/axum, image crate with only png/jpeg/gif/webp/bmp codecs, base64 and existing serde/uuid.

**Spec:** `docs/superpowers/specs/2026-11-16-file-content-design.md`

**Status (2026-11-16):** Complete. Tasks 1–5 implemented and verified; independent review findings fixed in one RED→GREEN pass. Final Rust 146/146, JS 194/194, strict clippy/typecheck/build; real DLL content 5/5, smoke 11/11, official wire 4/4, complete interop 16/16 with zero skips; light/dark browser-preview pass. Exact rulings/evidence remain in `.superpowers/sdd/2026-11-16-file-content/progress.md`. No commit, push, marketplace publication, installed-host clipboard/file-manager or phone verification performed.

**Final integration additions:** ServiceController receives injected home and resolves persisted settings on every start/restart; `resolve_download_directory` supplies absolute defaults to the self-drawn picker; native `image_budget.rs` preflights JPEG/WebP workspace and embedded frame dimensions; historical resources retain expected file size for opened-handle checks. These correct review-found gaps without changing file transport.

## Global Constraints

- Default exactly `~/Download/OToolsLocalSend`, Download singular; preserve custom paths and old files.
- No acceptance for preview and no remote URLs/HTML/extra private wire fields.
- Image input 32 MiB, maximum 16384 per side / 16 MiPixels / 128 MiB decoder allocation; thumbnail 384px / 512 KiB; thumbnail cache 8 MiB /64 entries; decode concurrency 2; image-copy outstanding resources 4, PNG output 32 MiB.
- `sources?: Record<string,string>` is local history only; `destinations` refers only to actual completed bytes.
- Use existing `pickFromHostTree`, `invokeTauri`, service guards, modal focus and authority merge. Do not patch host/SDK.
- All tests isolate download/home/data. No user file/clipboard/file manager interaction without explicit GUI action.
- Work in current main, do not commit/push/publish; preserve live host, global settings, credentials and unrelated files.

## Review Focus

- A small encoded decompression bomb must not freeze the plugin or host clipboard; pin bounded dimensions/allocation tests in Task 2.
- A terminal record must never expose a same-name old destination while commit is in progress; pin actual-path and mixed failure tests in Task 1.
- Picker completion after hidden/unmounted/session-switched UI must never accept files or change a new request; pin delayed picker tests in Task 4.
- Preview/clipboard errors must not be swallowed or misreported as success; pin await false/reject and cleanup tests in Task 3.
- New default must not cause old smoke/unit fixtures to write the real home; pin isolated defaults and update fixture settings in Tasks 1/5.

---

### Task 1: Default directory and truthful receive commits

**Owner/files:** Receive worker owns `native/src/settings.rs`, `native/src/server.rs` and tests in those files. Controller owns runtime parsing and models/sender.

**Interfaces:**
- settings: `DEFAULT_DOWNLOAD_DIR: &str = "~/Download/OToolsLocalSend"`; `Settings::normalized(self) -> Self`; `resolve_download_dir(value: Option<&str>, home: &Path) -> Result<PathBuf,String>`; `Settings::for_runtime(&self, home: &Path) -> Result<Settings,String>`.
- Keep existing `session_accept(sessions,session_id,file_ids)` wrapper. Add `session_accept_with_destinations(sessions: &Arc<ReceiveSessions>, session_id: &str, file_ids: Option<Vec<String>>, destinations: HashMap<String,String>) -> Result<Vec<String>,String>`.
- `destinations` map is local only. Targets must belong to accepted IDs. Invalid target leaves Pending and does not resolve decision.
- Atomic unique create/copy follows existing retained worker/UploadLease; successful destination is published only after actual commit. Failed or cancelled files never become destination entries; completed files remain available.

- [ ] Write and run tests proving missing/null/blank default exactness, home expansion/custom preservation/no mkdir, relative/URL/UNC rejection; watch current implementation fail assertions.
- [ ] Implement helper and normalized load/default, preserve settings field compatibility. Fixtures provide isolated explicit directories/home.
- [ ] Write and run invalid-map-before-tokens, staged-target actual receive, existing-name/concurrent-name no-clobber, target directory failure and mixed Failed/Cancelled actual-destination tests against current behavior.
- [ ] Implement per-session targets and create parent only during authorized save; use create_new unique targets and bounded candidate failure. Keep cancellation and unload IO ownership.
- [ ] Run all native tests (after controller shared fields integrated); report RED/GREEN names and any failures faithfully. Do not commit.

### Task 2: Bounded native image resource owner

**Owner/files:** image worker creates `native/src/file_resources.rs`, modifies `native/Cargo.toml`/lock only. Controller adds lib module and runtime wiring.

**Interfaces:**
- `FileResources::new(data_dir: &Path) -> Result<Self,String>`.
- `FileResources::enter(self: &Arc<Self>) -> Result<ResourceOperation,String>`; operation owns a short admission lease that fences unload; `FileResources::shutdown(&self)` retires and drains in-flight native operations outside Slot.
- `ResourceOperation::preview(&self,path: &Path) -> FilePreview`.
- `FilePreview` camelCase serialized `{status:"ready"|"unavailable", dataUrl?, width?, height?, version?, reason?}`; PNG thumbnails only, source dimensions returned. Reasons finite/non-sensitive (missing, unsafe-path, unsupported, too-large, invalid-image, unavailable).
- `ResourceOperation::prepare_image_copy(&self,path: &Path) -> Result<ImageCopy,String>`; `ImageCopy {resourceId,path,width,height}` serialized camelCase, PNG original dimensions. Stable local temp until explicit release; do not delete a live copy merely on another request.
- `ResourceOperation::release_image_copy(&self,resource_id: &str) -> Result<(),String>`; unknown IDs cannot delete arbitrary paths.
- `ResourceOperation::resolve_file(&self,path: &Path) -> Result<String,String>` validates regular, absolute local file and rejects URL/UNC/ADS unsafe forms.

- [ ] Add independent generated PNG/JPEG/GIF/WebP/BMP fixtures, input/magic/oversize/invalid/URL/UNC, dimension and copy release tests; run tests before implementation (compile-stub only to reach failing behavior if needed).
- [ ] Add codec-restricted dependency and minimal bounded read, decoder limits, PNG encode/thumbnail, stable file version cache. Limit concurrency/cache/copy resources and retire ownership.
- [ ] Verify original dimensions for copy, explicit release and no arbitrary deletion, file-change cache invalidation, shutdown fence/drain; run whole native suite when integrated. No real clipboard or global cache modifications.

### Task 3: Shared runtime/API, content actions and preview hook

**Controller/files:** `native/src/lib.rs`, `models.rs`, `sender.rs`, `runtime.rs`; `src/api.ts`; new `src/fileContent.ts`, `src/hooks/useFilePreview.ts`, `src/hooks/fileContent.test.ts`, `src/hooks/fileResources.test.ts`; `usePollEvents.ts` and authority tests.

**Interfaces:**
- `FileResourceQuery = {path:string} | {sessionId:string,fileId:string}`; strict exclusive parse. Native methods file_preview, prepare_image_copy, release_image_copy({resourceId}), resolve_transfer_file({sessionId,fileId}).
- TS `previewFile(query): Promise<FilePreview>`; `prepareImageCopy(query): Promise<ImageCopy>`; `releaseImageCopy(resourceId): Promise<void>`; `resolveTransferFile(sessionId,fileId): Promise<{path:string}>`.
- `acceptSession(sessionId,fileIds="all",destinations?: Record<string,string>): Promise<void>` omits empty maps and preserves old payload.
- `fileContent.ts`: `isImageFile(file:FileEntry):boolean` identifies declared/extension image candidates without trusting them for native decode; `textContent(file:FileEntry):string|null` strict text/plain string preview; `copyTextContent(text:string):Promise<void>`; `copyImageContent(query:FileResourceQuery):Promise<void>`; `openTransferFolder(sessionId,fileId):Promise<void>`; `chooseImageDestination(file:FileEntry,downloadDir?:string|null):Promise<string|null>` uses host-tree.
- `useFilePreview(query:FileResourceQuery|null, enabled=true)` returns FilePreview-compatible state with loading. Identity derives scalar query/path; late responses/unmount cannot overwrite current resource.

- [ ] Write runtime/API parsing, source-map persistence/not-wire, old history, copy-await/false/reject/release and strict text classification tests; run RED.
- [ ] Add local sources to models/all constructors and sender history only; keep file network JSON unchanged. Wire file owner with enter acquired under Slot, then perform IO unlocked; shutdown fences/drains resources. Resolve history by exact record/file/source or actual successful destination, never raw passed destination.
- [ ] Normalize runtime settings with home path and strict fileIds/destinations payload; update isolated runtime fixtures.
- [ ] Implement API plus preview-mode image/text/resources/accepted destinations; preview operations never call real host.
- [ ] Implement awaited host actions using invokeTauri. copyImage always releases resource in finally after await host. Picker only returns path.
- [ ] Write authority sources/files metadata retention, preview cache/concurrency/stale identity tests, run RED then implement without disturbing lifecycle coalescing/tombstones.
- [ ] Run all JS tests/typecheck and integrated native suite; report failures; no commits.

### Task 4: Rich transfer and receive UI

**Owner/files:** frontend worker owns `src/components/IncomingDialog.tsx`, `TransferCard.tsx`, new `FileImagePreview.tsx`, `src/pages/Devices.tsx`, `Settings.tsx`, `src/styles.css`, new UI test files. Controller owns `App.tsx`, API, fileContent/hook, existing tests.

**Interfaces:**
- Dialog callbacks `onAcceptAll(destinations?:Record<string,string>)`, `onAcceptSelected(fileIds:string[],destinations?:Record<string,string>)`, new optional `downloadDir?:string|null`; other existing props unchanged.
- `FileImagePreview` consumes file/query + new `useFilePreview`, does not read wire preview as image URL; missing pending resources says "接受后显示预览".
- Existing TransferCard props remain; each file row receives record/query and content/host actions. Send source or any actual receive destination enables native resource, not status alone.

- [ ] Write failing render/event tests: text body and copy without acceptance; history image/other-file actions; save picker yields only local draft, cancellation/selection filtering, stop-hidden draft, busy and stale picker handling.
- [ ] Implement shared preview, rich history and per-file feedback, pending image placeholder. Await errors visibly; preserve source/received files after failed/cancelled sessions.
- [ ] Add staged save target display/reset, disables while picker active, mounted/session guard; original accept buttons submit selected target map only.
- [ ] Devices immediately shows the outgoing transfer card (and image preview once native sources appear); preserve picker-after-service revision guard. Settings shows exact default and blank-reset wording.
- [ ] Apply bounded responsive media styles with existing light/dark tokens; no navigation/theme/brand rewrite.
- [ ] Run new tests, then whole JS suite/typecheck/build after shared APIs integrated.

### Task 5: Integration, isolated DLL tests and independent review

**Controller/files:** `App.tsx`, existing UI tests as needed, smoke/interop scripts, new `scripts/file-content-test.py`, README, this plan's `.superpowers/sdd/2026-11-16-file-content/progress.md`.

- [ ] Add DLL test using throwaway local files and independent raw peer: exact default with isolated home/config; staged per-image destination and bytes/no-clobber; file_preview data header/dimensions; sources only history; resource copy/release; Pending gets no preview until consent. Run against old DLL to observe RED then rebuild.
- [ ] Update smoke/interop initial settings so no default writes to true home. Keep all existing official/raw queue assertions intact.
- [ ] Run `pnpm test`, `pnpm typecheck`, build; `cargo test --manifest-path native/Cargo.toml`, `cargo clippy --manifest-path native/Cargo.toml --all-targets -- -D warnings`; actual DLL smoke, new content test, full 16-case interop and 4-case official-wire.
- [ ] Browser check light/dark image/text/history/dialog via preview only; verify save/copy feedback without claiming real host clipboard/phone.
- [ ] Dispatch one fresh independent code reviewer against all uncommitted changes + spec/plan/rulings; fix Important/Critical issues with RED→GREEN and green suites.
- [ ] Record exact counts/boundaries in ledger and README. Leave main working tree changes for user, no automatic commit/push/release.
