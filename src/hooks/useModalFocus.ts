import { useEffect, useRef } from "react";

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Stop confirmation owns focus while mounted; incoming suspension has no focus side effect. */
export function useModalFocus(busy: boolean, onCancel: () => void, returnFocus: HTMLElement | null = null) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const controlsRef = useRef({ busy, onCancel });
  controlsRef.current = { busy, onCancel };
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const owner = root.ownerDocument;
    const initiating = returnFocus ?? owner.activeElement as HTMLElement | null;
    const focusables = () => Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => (
      !element.closest("[hidden]") && element.getAttribute("aria-disabled") !== "true"
    ));
    const first = () => focusables()[0] ?? root;
    first().focus();
    const contain = (event: FocusEvent) => {
      if (!root.contains(event.target as Node | null)) first().focus();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!controlsRef.current.busy) controlsRef.current.onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      event.preventDefault();
      const nodes = focusables();
      if (!nodes.length) { root.focus(); return; }
      const index = nodes.indexOf(owner.activeElement as HTMLElement);
      const next = event.shiftKey
        ? (index <= 0 ? nodes.length - 1 : index - 1)
        : (index < 0 || index === nodes.length - 1 ? 0 : index + 1);
      nodes[next].focus();
    };
    owner.addEventListener("keydown", keydown, true);
    owner.addEventListener("focusin", contain, true);
    return () => {
      owner.removeEventListener("keydown", keydown, true);
      owner.removeEventListener("focusin", contain, true);
      if (initiating?.isConnected && !initiating.closest("[hidden]")) initiating.focus();
    };
  }, []);
  return rootRef;
}
