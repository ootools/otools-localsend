import { invokeTauri } from "otools-plugin-sdk/runtime";
import { pickFromHostTree } from "otools-plugin-sdk/host-file-tree";
import {
  isPreviewMode, prepareImageCopy, releaseImageCopy, resolveDownloadDirectory, resolveTransferFile,
  type FileEntry, type FileResourceQuery,
} from "./api";

export function textContent(file: FileEntry): string | null {
  return file.fileType === "text/plain" && typeof file.preview === "string" ? file.preview : null;
}

export function isImageFile(file: FileEntry): boolean {
  return file.fileType.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif|tiff?|svg)$/i.test(file.fileName);
}

export async function copyTextContent(text: string): Promise<void> {
  if (isPreviewMode()) return;
  if (await invokeTauri<boolean>("otools_copy_text", { text }) !== true) {
    throw new Error("复制文本失败：宿主未确认剪贴板写入");
  }
}

export async function copyImageContent(query: FileResourceQuery): Promise<void> {
  const resource = await prepareImageCopy(query);
  let failed = false;
  try {
    if (!isPreviewMode() && await invokeTauri<boolean>("otools_copy_image", { image: resource.path }) !== true) {
      throw new Error("复制图片失败：宿主未确认剪贴板写入");
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try { await releaseImageCopy(resource.resourceId); }
    catch (error) { if (!failed) throw error; }
  }
}

export async function openTransferFolder(sessionId: string, fileId: string): Promise<void> {
  const { path } = await resolveTransferFile(sessionId, fileId);
  if (!isPreviewMode() && await invokeTauri<void | boolean>("otools_shell_show_item_in_folder", { path }) === false) {
    throw new Error("打开所在文件夹失败：宿主未确认操作");
  }
}

export async function chooseImageDestination(file: FileEntry, downloadDir?: string | null): Promise<string | null> {
  const name = file.fileName.split(/[\\/]/).pop()?.replace(/[<>:"|?*\u0000-\u001f]/g, "_") || "image.png";
  const configuredDirectory = downloadDir?.trim() || "~/Download/OToolsLocalSend";
  if (isPreviewMode()) return `${configuredDirectory.replace(/[\\/]$/, "")}/${name}`;
  const directory = configuredDirectory.startsWith("~") ? (await resolveDownloadDirectory(configuredDirectory)).path : configuredDirectory;
  const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "png";
  const picked = await pickFromHostTree({
    title: "图片另存为（接受后保存，同名文件自动顺延）",
    save: true,
    defaultPath: `${directory.replace(/[\\/]$/, "")}/${name}`,
    filters: [{ name: "图片", extensions: [extension] }],
  });
  return picked.kind === "picked" ? picked.paths[0] ?? null : null;
}
