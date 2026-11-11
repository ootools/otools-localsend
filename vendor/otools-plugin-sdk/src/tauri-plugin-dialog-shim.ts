import type {
  OToolsDialogAPI,
  OToolsDialogConfirmOptions,
  OToolsDialogFilter,
  OToolsDialogMessageOptions,
  OToolsDialogOpenOptions,
  OToolsDialogSaveOptions,
} from "./otools-globals";
import { invoke, isOtoolsRemoteRuntime } from "./runtime";
import { pickFromHostTree } from "./host-file-tree";

export type DialogFilter = OToolsDialogFilter;
export type OpenDialogOptions = OToolsDialogOpenOptions;
export type SaveDialogOptions = OToolsDialogSaveOptions;
export type MessageDialogOptions = OToolsDialogMessageOptions;
export type ConfirmDialogOptions = OToolsDialogConfirmOptions;

type OpenDialogReturn<T extends OpenDialogOptions> = T["multiple"] extends true
  ? string[] | null
  : string | null;

const normalizeDialogPath = (value: unknown): string | null => {
  if (typeof value === "string") {
    const path = value.trim();
    return path ? path : null;
  }

  if (value && typeof value === "object" && "path" in value) {
    const path = (value as { path?: unknown }).path;
    if (typeof path === "string") {
      const normalized = path.trim();
      return normalized ? normalized : null;
    }
  }

  return null;
};

const normalizeDialogPathList = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeDialogPath(item))
      .filter((item): item is string => Boolean(item));
  }

  const single = normalizeDialogPath(value);
  return single ? [single] : [];
};

const normalizeOpenDialogResult = <T extends OpenDialogOptions>(
  value: unknown,
  options: T,
): OpenDialogReturn<T> => {
  const paths = normalizeDialogPathList(value);
  if (options.multiple) {
    return (paths.length ? paths : null) as OpenDialogReturn<T>;
  }
  return (paths[0] ?? null) as OpenDialogReturn<T>;
};

function resolveDialogApi(): OToolsDialogAPI | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  const otools = window.otools ?? window.utools;
  return otools?.dialog ?? otools?.runtime?.dialog ?? undefined;
}

async function invokeDialogOpen<T extends OpenDialogOptions>(
  options: T,
): Promise<OpenDialogReturn<T> | null> {
  try {
    const result = await invoke<unknown>("plugin:dialog|open", {
      options,
    });
    return normalizeOpenDialogResult(result, options);
  } catch {
    return null;
  }
}

async function invokeDialogSave(
  options: SaveDialogOptions,
): Promise<string | null> {
  try {
    const result = await invoke<unknown>("plugin:dialog|save", { options });
    return normalizeDialogPath(result);
  } catch {
    return null;
  }
}

export async function open<T extends OpenDialogOptions>(
  options: T = {} as T,
): Promise<OpenDialogReturn<T>> {
  const normalizedOptions = options ?? ({} as T);
  if (isOtoolsRemoteRuntime()) {
    const result = await pickFromHostTree({
      ...normalizedOptions,
      startPath: normalizedOptions.defaultPath,
    });
    return normalizeOpenDialogResult(result.paths, normalizedOptions);
  }
  const dialog = resolveDialogApi();
  if (dialog?.open) {
    return normalizeOpenDialogResult(
      await dialog.open(normalizedOptions),
      normalizedOptions,
    );
  }

  const invoked = await invokeDialogOpen(normalizedOptions);
  if (invoked !== null) {
    return invoked as OpenDialogReturn<T>;
  }

  return null as OpenDialogReturn<T>;
}

export async function save(
  options: SaveDialogOptions = {},
): Promise<string | null> {
  if (isOtoolsRemoteRuntime()) {
    const result = await pickFromHostTree({ ...options, save: true });
    return result.paths[0] ?? null;
  }
  const dialog = resolveDialogApi();
  if (dialog?.save) {
    return normalizeDialogPath(await dialog.save(options));
  }

  const invoked = await invokeDialogSave(options);
  if (invoked !== null) {
    return invoked;
  }

  return null;
}

export async function message(
  messageText: string,
  options?: string | MessageDialogOptions,
) {
  const dialog = resolveDialogApi();
  if (dialog?.message) {
    await dialog.message(messageText, options);
    return;
  }

  try {
    await invoke("plugin:dialog|message", {
      message: String(messageText),
      title: typeof options === "string" ? options : options?.title,
      kind: typeof options === "string" ? undefined : options?.kind,
      okButtonLabel:
        typeof options === "string"
          ? undefined
          : options?.okLabel ?? options?.buttons?.ok,
    });
    return;
  } catch {}

  if (typeof window !== "undefined") {
    window.alert(messageText);
  }
}

export async function confirm(
  messageText: string,
  options?: string | ConfirmDialogOptions,
) {
  const dialog = resolveDialogApi();
  if (dialog?.confirm) {
    return dialog.confirm(messageText, options);
  }

  try {
    const result = await invoke<boolean>("plugin:dialog|confirm", {
      message: String(messageText),
      title: typeof options === "string" ? options : options?.title,
      kind: typeof options === "string" ? undefined : options?.kind,
      okButtonLabel: typeof options === "string" ? undefined : options?.okLabel,
      cancelButtonLabel:
        typeof options === "string" ? undefined : options?.cancelLabel,
    });
    return Boolean(result);
  } catch {}

  if (typeof window === "undefined") {
    return false;
  }

  return window.confirm(messageText);
}

export async function ask(
  messageText: string,
  options?: string | ConfirmDialogOptions,
) {
  const dialog = resolveDialogApi();
  if (dialog?.ask) {
    return dialog.ask(messageText, options);
  }

  try {
    const result = await invoke<boolean>("plugin:dialog|ask", {
      message: String(messageText),
      title: typeof options === "string" ? options : options?.title,
      kind: typeof options === "string" ? undefined : options?.kind,
      yesButtonLabel: typeof options === "string" ? undefined : options?.okLabel,
      noButtonLabel:
        typeof options === "string" ? undefined : options?.cancelLabel,
    });
    return Boolean(result);
  } catch {}

  if (typeof window === "undefined") {
    return false;
  }

  return window.confirm(messageText);
}
