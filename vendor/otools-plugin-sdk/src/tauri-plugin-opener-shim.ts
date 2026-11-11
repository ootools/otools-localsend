function resolveOtools() {
  if (typeof window === "undefined") {
    return undefined;
  }
  return window.otools ?? window.utools;
}

export async function openUrl(url: string) {
  const otools = resolveOtools();
  if (otools?.shellOpenExternal) {
    otools.shellOpenExternal(url);
    return;
  }
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export async function openPath(fullPath: string) {
  const otools = resolveOtools();
  if (otools?.shellOpenPath) {
    otools.shellOpenPath(fullPath);
    return;
  }
}

export async function revealItemInDir(fullPath: string) {
  const otools = resolveOtools();
  if (otools?.shellShowItemInFolder) {
    otools.shellShowItemInFolder(fullPath);
    return;
  }
  await openPath(fullPath);
}
