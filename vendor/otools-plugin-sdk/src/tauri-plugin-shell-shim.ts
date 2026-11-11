function resolveOtools() {
  if (typeof window === "undefined") {
    return undefined;
  }
  return window.otools ?? window.utools;
}

export async function open(path: string, openWith?: string): Promise<void> {
  const target = String(path ?? "").trim();
  if (!target) {
    return;
  }

  const otools = resolveOtools();
  if (otools?.shellOpen) {
    await otools.shellOpen(target, openWith);
    return;
  }

  if (otools?.shellOpenExternal && /^https?:\/\//i.test(target)) {
    otools.shellOpenExternal(target);
    return;
  }

  if (otools?.shellOpenPath) {
    otools.shellOpenPath(target);
    return;
  }

  if (typeof window !== "undefined") {
    window.open(target, "_blank", "noopener,noreferrer");
  }
}

export async function openPath(fullPath: string): Promise<void> {
  const target = String(fullPath ?? "").trim();
  if (!target) {
    return;
  }

  const otools = resolveOtools();
  if (otools?.shellOpenPath) {
    otools.shellOpenPath(target);
    return;
  }
}

export async function openExternal(url: string): Promise<void> {
  const target = String(url ?? "").trim();
  if (!target) {
    return;
  }

  const otools = resolveOtools();
  if (otools?.shellOpenExternal) {
    otools.shellOpenExternal(target);
    return;
  }

  if (typeof window !== "undefined") {
    window.open(target, "_blank", "noopener,noreferrer");
  }
}
