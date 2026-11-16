/** Serial incoming request: content inspection never accepts or downloads a file. */
import { useEffect, useRef, useState } from "react";
import { deviceTypeEmoji, formatBytes, formatError } from "../format";
import type { FileEntry, IncomingRequestEvent } from "../api";
import { chooseImageDestination, copyTextContent, isImageFile, textContent } from "../fileContent";

interface IncomingDialogProps {
  request: IncomingRequestEvent;
  busy: boolean;
  error: string | null;
  onAcceptAll: (destinations?: Record<string, string>) => void;
  onAcceptSelected: (fileIds: string[], destinations?: Record<string, string>) => void;
  onDecline: () => void;
  onStopService?: () => void;
  serviceBusy?: boolean;
  hidden?: boolean;
  downloadDir?: string | null;
}

type Draft = { sessionId: string; selected: Set<string>; destinations: Record<string, string> };
type Feedback = { error?: string; success?: string };
type Operation = { sessionId: string; epoch: number; fileId: string };

function initialDraft(request: IncomingRequestEvent): Draft {
  return { sessionId: request.sessionId, selected: new Set(request.files.map((file) => file.id)), destinations: {} };
}

export function IncomingDialog({
  request,
  busy,
  error,
  onAcceptAll,
  onAcceptSelected,
  onDecline,
  onStopService,
  serviceBusy = false,
  hidden = false,
  downloadDir,
}: IncomingDialogProps) {
  const sessionId = request.sessionId;
  const textMode = request.files.length === 1 && textContent(request.files[0]) !== null;
  const [draft, setDraft] = useState(() => initialDraft(request));
  const [feedback, setFeedback] = useState<{ sessionId: string; files: Record<string, Feedback> }>(() => ({ sessionId, files: {} }));
  const [pickingId, setPickingId] = useState<string | null>(null);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const pickerRef = useRef<Operation | null>(null);
  const copyRef = useRef<Operation | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const focusOwnerRef = useRef<Document | null>(null);
  const initiatingRef = useRef<HTMLElement | null>(null);
  const focusControls = useRef({ hidden, busy: busy || serviceBusy, decline: onDecline });
  focusControls.current = { hidden, busy: busy || serviceBusy, decline: onDecline };
  const lifecycle = useRef({ alive: true, sessionId, busy, serviceBusy, hidden, epoch: 0 });
  const previous = lifecycle.current;
  if (previous.sessionId !== sessionId || previous.busy !== busy || previous.serviceBusy !== serviceBusy || previous.hidden !== hidden) {
    lifecycle.current = { alive: previous.alive, sessionId, busy, serviceBusy, hidden, epoch: previous.epoch + 1 };
  }

  useEffect(() => {
    lifecycle.current.alive = true;
    return () => {
      lifecycle.current.alive = false;
      lifecycle.current.epoch++;
      pickerRef.current = null;
      copyRef.current = null;
    };
  }, []);
  useEffect(() => {
    setDraft((current) => current.sessionId === sessionId ? current : initialDraft(request));
    setFeedback((current) => current.sessionId === sessionId ? current : { sessionId, files: {} });
  }, [sessionId]);

  // Only the top visible modal owns keys/focus. The SDK tree is an independent DOM overlay.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || hidden || pickingId !== null) return;
    const owner = root.ownerDocument;
    focusOwnerRef.current = owner;
    if (!initiatingRef.current) initiatingRef.current = owner.activeElement as HTMLElement | null;
    const active = () => !focusControls.current.hidden && !pickerRef.current && !owner.querySelector("[data-host-tree]");
    const focusables = () => Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter((element) => !element.closest("[hidden]") && element.getAttribute("aria-disabled") !== "true");
    const first = () => focusables()[0] ?? root;
    if (active()) first().focus();
    const contain = (event: FocusEvent) => {
      if (active() && !root.contains(event.target as Node | null)) first().focus();
    };
    const keydown = (event: KeyboardEvent) => {
      if (!active()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!focusControls.current.busy) focusControls.current.decline();
        return;
      }
      if (event.key !== "Tab") return;
      event.preventDefault();
      const nodes = focusables();
      if (!nodes.length) { root.focus(); return; }
      const index = nodes.indexOf(owner.activeElement as HTMLElement);
      const next = event.shiftKey ? (index <= 0 ? nodes.length - 1 : index - 1) : (index < 0 || index === nodes.length - 1 ? 0 : index + 1);
      nodes[next].focus();
    };
    owner.addEventListener("keydown", keydown, true);
    owner.addEventListener("focusin", contain, true);
    return () => {
      owner.removeEventListener("keydown", keydown, true);
      owner.removeEventListener("focusin", contain, true);
    };
  }, [sessionId, hidden, pickingId]);
  useEffect(() => () => {
    const owner = focusOwnerRef.current;
    const initiating = initiatingRef.current;
    if (owner && !focusControls.current.hidden && !owner.querySelector("[data-host-tree]") && initiating?.isConnected && !initiating.closest("[hidden]")) {
      initiating.focus();
    }
  }, []);

  // A hidden stop confirmation suspends this request; it must not discard its local draft.
  const currentDraft = draft.sessionId === sessionId ? draft : initialDraft(request);
  const currentFeedback = feedback.sessionId === sessionId ? feedback.files : {};
  const selectedIds = request.files.filter((file) => currentDraft.selected.has(file.id)).map((file) => file.id);
  const allSelected = selectedIds.length === request.files.length;
  const locked = busy || serviceBusy || hidden || pickingId !== null;
  const canInteract = () => {
    const current = lifecycle.current;
    return current.alive && current.sessionId === sessionId && !current.busy && !current.serviceBusy && !current.hidden && !pickerRef.current;
  };
  const isCurrent = (operation: Operation) => {
    const current = lifecycle.current;
    return current.alive && current.sessionId === operation.sessionId && current.epoch === operation.epoch && !current.hidden && !current.busy && !current.serviceBusy;
  };
  const showFeedback = (fileId: string, value: Feedback) => setFeedback((current) => ({
    sessionId,
    files: { ...(current.sessionId === sessionId ? current.files : {}), [fileId]: value },
  }));

  const toggle = (fileId: string) => {
    if (!canInteract()) return;
    setDraft((current) => {
      const value = current.sessionId === sessionId ? current : initialDraft(request);
      const selected = new Set(value.selected);
      if (selected.has(fileId)) selected.delete(fileId);
      else selected.add(fileId);
      return { ...value, selected };
    });
  };
  const toggleAll = () => {
    if (!canInteract()) return;
    setDraft((current) => ({
      ...(current.sessionId === sessionId ? current : initialDraft(request)),
      selected: allSelected ? new Set<string>() : new Set(request.files.map((file) => file.id)),
    }));
  };
  const destinationsFor = (fileIds: string[]) => {
    const entries = fileIds.filter((id) => typeof currentDraft.destinations[id] === "string").map((id) => [id, currentDraft.destinations[id]]);
    return entries.length ? Object.fromEntries(entries) as Record<string, string> : undefined;
  };
  const acceptAll = () => {
    if (canInteract()) onAcceptAll(destinationsFor(request.files.map((file) => file.id)));
  };
  const acceptSelected = () => {
    if (canInteract() && selectedIds.length) onAcceptSelected(selectedIds, destinationsFor(selectedIds));
  };
  const decline = () => { if (canInteract()) onDecline(); };

  const chooseDestination = async (file: FileEntry) => {
    if (!canInteract()) return;
    const operation = { sessionId, fileId: file.id, epoch: lifecycle.current.epoch };
    // The ref locks old event callbacks immediately, before React commits the busy render.
    pickerRef.current = operation;
    setPickingId(file.id);
    showFeedback(file.id, {});
    try {
      const target = await chooseImageDestination(file, downloadDir);
      if (target !== null && isCurrent(operation) && pickerRef.current === operation) {
        setDraft((current) => {
          const value = current.sessionId === sessionId ? current : initialDraft(request);
          return { ...value, destinations: { ...value.destinations, [file.id]: target } };
        });
      }
    } catch (cause) {
      if (isCurrent(operation) && pickerRef.current === operation) showFeedback(file.id, { error: formatError(cause) });
    } finally {
      // Invalidated results still close the local busy state, but never update a draft.
      if (lifecycle.current.alive && pickerRef.current === operation) {
        pickerRef.current = null;
        setPickingId(null);
      }
    }
  };
  const resetDestination = (fileId: string) => {
    if (!canInteract()) return;
    setDraft((current) => {
      if (current.sessionId !== sessionId) return current;
      const destinations = { ...current.destinations };
      delete destinations[fileId];
      return { ...current, destinations };
    });
  };
  const copyText = async (file: FileEntry, body: string) => {
    if (!canInteract() || copyRef.current) return;
    const operation = { sessionId, fileId: file.id, epoch: lifecycle.current.epoch };
    copyRef.current = operation;
    setCopyingId(file.id);
    showFeedback(file.id, {});
    try {
      await copyTextContent(body);
      if (isCurrent(operation) && copyRef.current === operation) showFeedback(file.id, { success: "已复制文本" });
    } catch (cause) {
      if (isCurrent(operation) && copyRef.current === operation) showFeedback(file.id, { error: formatError(cause) });
    } finally {
      if (lifecycle.current.alive && copyRef.current === operation) {
        copyRef.current = null;
        setCopyingId(null);
      }
    }
  };

  const content = (file: FileEntry) => {
    const body = textContent(file);
    const target = currentDraft.destinations[file.id];
    const result = currentFeedback[file.id];
    return (
      <>
        {body !== null ? (
          <div className="incoming-content">
            <div className="msg-bubble">{body}</div>
            <div className="content-actions">
              <button type="button" className="btn btn-sm" disabled={locked || copyingId !== null} onClick={() => void copyText(file, body)}>
                {copyingId === file.id ? "复制中…" : "复制文本"}
              </button>
            </div>
          </div>
        ) : isImageFile(file) ? (
          <div className="incoming-content">
            <p className="file-image-placeholder" role="status">接受后显示预览</p>
            <div className="content-actions">
              <button type="button" className="btn btn-sm" disabled={locked} onClick={() => void chooseDestination(file)}>
                {pickingId === file.id ? "选择中…" : "另存为"}
              </button>
              {target && (
                <button type="button" className="btn btn-sm" disabled={locked} onClick={() => resetDestination(file.id)}>使用默认目录</button>
              )}
            </div>
            {target && <p className="incoming-target" title={target}>接受后保存到：{target}</p>}
          </div>
        ) : null}
        {result?.error && <p className="content-error" role="alert">{result.error}</p>}
        {result?.success && <p className="content-success" role="status">{result.success}</p>}
      </>
    );
  };

  const sender = request.sender;
  return (
    <div ref={rootRef} tabIndex={-1} className="modal-back" role="dialog" aria-modal={hidden || pickingId !== null ? undefined : true} aria-label="传输请求" hidden={hidden}>
      <div className="modal">
        <h3>{sender?.alias || "未知设备"} 请求传输</h3>
        <p className="modal-sub">
          {deviceTypeEmoji(sender?.deviceType)}
          {sender?.deviceModel ? ` ${sender.deviceModel} · ` : ""}
          {textMode ? "文本消息" : `${request.files.length} 个文件`}
        </p>
        {textMode ? (
          <div className="modal-body">{content(request.files[0])}</div>
        ) : (
          <div className="modal-body">
            <div className="file-pick-head">
              <span>选择要接收的文件</span>
              <button type="button" onClick={toggleAll} disabled={locked}>{allSelected ? "全不选" : "全选"}</button>
            </div>
            <ul className="file-list">
              {request.files.map((file) => (
                <li key={file.id} className="incoming-file">
                  <label className="file-row">
                    <input type="checkbox" checked={currentDraft.selected.has(file.id)} onChange={() => toggle(file.id)} disabled={locked} />
                    <span className="name" title={file.fileName}>{file.fileName || file.id}</span>
                    <span className="size">{formatBytes(file.size ?? 0)}</span>
                  </label>
                  {content(file)}
                </li>
              ))}
            </ul>
            {request.files.some((file) => textContent(file) === null && isImageFile(file)) && (
              <p className="content-note">另存为仅选择位置，接受后才保存。同名文件已存在时不覆盖，将自动顺延文件名。</p>
            )}
          </div>
        )}
        {error && <div className="banner banner-error modal-error" role="alert">{error}</div>}
        {onStopService && (
          <div className="incoming-service-action">
            <button type="button" onClick={onStopService} disabled={serviceBusy || pickingId !== null || hidden} className="btn btn-sm btn-danger">
              {serviceBusy ? "处理中…" : "停止服务"}
            </button>
          </div>
        )}
        <div className="modal-actions">
          <button type="button" onClick={decline} disabled={locked} className="btn btn-sm btn-danger">拒绝</button>
          {!textMode && (
            <button type="button" onClick={acceptSelected} disabled={locked || selectedIds.length === 0} className="btn btn-sm">
              接受所选{selectedIds.length > 0 ? `（${selectedIds.length}）` : ""}
            </button>
          )}
          <button type="button" onClick={acceptAll} disabled={locked} className="btn btn-primary btn-sm">{busy ? "处理中…" : "全部接受"}</button>
        </div>
      </div>
    </div>
  );
}
