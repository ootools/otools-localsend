import {
  open,
  save,
  type DialogFilter,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "@tauri-apps/plugin-dialog";

type SingleDialogPath = string | null;

export type {
  DialogFilter,
  OpenDialogOptions,
  SaveDialogOptions,
} from "@tauri-apps/plugin-dialog";

export async function pickDirectory(
  options: Omit<OpenDialogOptions, "directory" | "multiple"> = {},
): Promise<SingleDialogPath> {
  const result = await open({
    ...options,
    directory: true,
    multiple: false,
  });
  return normalizeSinglePath(result);
}

export async function pickFile(
  options: Omit<OpenDialogOptions, "directory" | "multiple"> = {},
): Promise<SingleDialogPath> {
  const result = await open({
    ...options,
    directory: false,
    multiple: false,
  });
  return normalizeSinglePath(result);
}

export async function pickFiles(
  options: Omit<OpenDialogOptions, "directory" | "multiple"> = {},
): Promise<string[]> {
  const result = await open({
    ...options,
    directory: false,
    multiple: true,
  });
  return normalizePathList(result);
}

export async function pickZipFile(
  options: Omit<OpenDialogOptions, "directory" | "multiple" | "filters"> = {},
): Promise<SingleDialogPath> {
  return pickFile({
    ...options,
    filters: [zipFilter],
  });
}

export async function saveFile(
  options: string | SaveDialogOptions,
): Promise<SingleDialogPath> {
  const normalized = typeof options === "string" ? { defaultPath: options } : options;
  const result = await save(normalized);
  return normalizeSinglePath(result);
}

const zipFilter: DialogFilter = {
  name: "Zip",
  extensions: ["zip"],
};

function normalizeSinglePath(result: unknown): SingleDialogPath {
  if (typeof result === "string") {
    const path = result.trim();
    return path ? path : null;
  }

  if (result && typeof result === "object" && "path" in result) {
    const path = (result as { path?: unknown }).path;
    if (typeof path === "string") {
      const normalized = path.trim();
      return normalized ? normalized : null;
    }
  }

  return null;
}

function normalizePathList(result: unknown): string[] {
  if (Array.isArray(result)) {
    return result
      .map((item) => normalizeSinglePath(item))
      .filter((item): item is string => Boolean(item));
  }

  const single = normalizeSinglePath(result);
  return single ? [single] : [];
}
