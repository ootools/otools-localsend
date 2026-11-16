# Open Autostart Implementation Plan

> **For agentic workers:** use executing-plans inline for this small single-hook change; keep current main and do not commit/push/publish. One fresh final review checks the delta only.

**Goal:** Automatically start a stopped service once when a plugin page is opened, without fighting manual stop.
**Architecture:** Hook mount owns one ref-based decision; existing controller/start API stays the sole busy/error/lifecycle owner. Background queries remain passive.
**Tech Stack:** React18/TypeScript/existing Node hook lifecycle tests.
**Spec:** docs/superpowers/specs/2026-11-16-open-autostart-design.md

## Global Constraints

Each App/hook mount is one opening cycle. Consume first ready/valid/bridge-available state, auto-start only stopped. No failed retry loop, no reversal of stopping/manualstop, no new host reopen event guesses. Preserve existing main/uncommitted image work and host autostart. No real-host or user-file operations, commits or publication.

## Review Focus

StrictMode effect replay; bridge recovery after manualstop; stopping→stopped cannot restart; one failed attempt preserves error/manualretry; init promise resolution after unmount cannot start. All pinned below.

### Task1: One-shot mount autostart

Files: src/hooks/usePollEvents.ts, src/hooks/pollService.test.ts, test-only src/hooks/frontendTestModules.ts if needed, App comment/README.
Interface: existing store startService()/stopService(force?) unchanged. New openStartHandledRef consumed before automatic controller.start, not reset bycleanup/generation. Explicitstart/stop consume beforecontrolleroperation.

- [ ] Add behavioral stopped-mount/bridge-recovery/errors/manualstop/newmount/StrictMode/init-cancel tests using actualhook + stubIPC; observe assertion RED against oldpassivehook.
- [ ] Add stable once-ref and independenteffect afterreadiness. Skip unknown/host-unavailable until validfirstdecision. On stopped callcontroller.start; otherknownstatesconsumeonly. Explicitactionsmarkfirst.
- [ ] Extend test-only hookdriver with effect replay preservingrefcells when necessary; no test APIs inproducthook.
- [ ] Update previous tests that expected stoppedmountpassive, keeping pureAPI/controllerquery tests passive and all terminal/historyguards.
- [ ] Update App/README precise openpage/mount vs reusedview semantics.
- [ ] Run fullpnpmtest/typecheck/build; isolatedDLLsmoke unaffected. Freshreview narrowdelta; fixes testfirst. Record outcomes withoutcommit/push.
