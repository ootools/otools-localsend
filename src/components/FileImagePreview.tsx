import { useState } from "react";
import type { FileEntry, FileResourceQuery } from "../api";
import { useFilePreview } from "../hooks/useFilePreview";

export interface FileImagePreviewProps {
  file: FileEntry;
  query: FileResourceQuery | null;
  pending?: boolean;
  version?: string;
}

const REASONS: Record<string, string> = {
  missing: "文件已移动或删除",
  "unsafe-path": "文件路径不可用",
  unsupported: "不支持此图片格式",
  "too-large": "图片超出安全预览大小限制",
  "invalid-image": "图片损坏或无法解码",
  busy: "图片预览繁忙，请稍后再试",
  unavailable: "无法读取本机图片",
};

/** Only bounded native PNG thumbnails are rendered; wire preview never supplies an image URL. */
export function FileImagePreview({ file, query, pending = false, version = "" }: FileImagePreviewProps) {
  const preview = useFilePreview(query, query !== null, version);
  const identity = JSON.stringify(query && ("path" in query ? [query.path, version] : [query.sessionId, query.fileId, version]));
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const imageKey = `${identity}:${preview.version ?? ""}:${preview.dataUrl ?? ""}`;
  const safeDataUrl = typeof preview.dataUrl === "string" && preview.dataUrl.length <= 700_000 &&
    /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(preview.dataUrl);

  if (!query) {
    return <p className="file-image-placeholder" role="status">{pending ? "接受后显示预览" : "图片预览不可用：没有本机文件路径"}</p>;
  }
  if (preview.status === "loading") {
    return <p className="file-image-placeholder" role="status" aria-busy="true">正在加载图片预览…</p>;
  }
  if (preview.status !== "ready" || !safeDataUrl || failedImage === imageKey) {
    const reason = REASONS[preview.reason ?? ""] ?? "无法显示本机图片";
    return <p className="file-image-placeholder" role="status">图片预览不可用：{reason}</p>;
  }
  return (
    <figure className="file-image-preview">
      <img src={preview.dataUrl} alt={`${file.fileName || file.id} 的图片预览`} onError={() => setFailedImage(imageKey)} decoding="async" />
      {preview.width && preview.height && <figcaption>{preview.width} × {preview.height}</figcaption>}
    </figure>
  );
}
