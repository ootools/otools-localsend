/**
 * 宿主文件系统上的「Web 选择树」通用能力。
 *
 * 桌面端走 native 面板 / 宿主原生对话框即可；但在纯浏览器或远程访问时，
 * 那些都弹不出来（原生框开在服务器上，远程用户碰不到）。此时改用一棵
 * 渲染在页面里的 DOM 树，数据全部来自宿主暴露的 `tools_webview_browse_dialog`
 * / `list_dir` / `read_file`，选出来的路径是**宿主侧**路径（不是用户本机）。
 *
 * 这套能力放进 SDK，所有插件都能直接用 `pickFromHostTree`；同时模块加载时把
 * 它挂到 `window.__otoolsHostTree`，让宿主 `dialog.open` 的回落链也能自动复用，
 * 做到「桌面 / web 无缝兼容」。
 *
 * 浏览器安全限制：纯 web 永远拿不到用户本机路径，所以这里选的只能是宿主
 * 文件系统上的路径——虚拟机磁盘 / ISO 本就躺在宿主上，语义正好对得上。
 */

import { invoke } from './runtime';
import type {
  OToolsHostDirEntry,
  OToolsHostReadFilePayload,
  OToolsHostBrowsePayload,
} from './otools-globals';

export type HostDirEntry = OToolsHostDirEntry;
export type HostReadFilePayload = OToolsHostReadFilePayload;
export type HostBrowsePayload = OToolsHostBrowsePayload;

export interface PickFromHostTreeOptions {
  title?: string;
  /** true=选目录，false=选文件。 */
  directory?: boolean;
  multiple?: boolean;
  /** 初始目录；缺省由宿主返回 home。 */
  startPath?: string;
  /** 保存时选择目录及文件名，仅返回路径，不写入文件。 */
  save?: boolean;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}

export type HostPickSource = 'host-tree';

export interface HostPickResult {
  kind: 'picked' | 'cancelled';
  source: HostPickSource;
  paths: string[];
  names: string[];
}

/** 列宿主某目录（含根列表与父路径），对应 `tools_webview_browse_dialog`。 */
export async function browseHostDir(path?: string): Promise<HostBrowsePayload> {
  return invoke<HostBrowsePayload>('browse_dialog', { path: path ?? '' });
}

/** 列宿主目录下的一层条目（对应 `tools_webview_list_dir`）。 */
export async function listHostDir(path: string): Promise<HostDirEntry[]> {
  const target = String(path ?? '').trim();
  if (!target) {
    throw new Error('listHostDir requires path');
  }
  return invoke<HostDirEntry[]>('read_directory_recursive', { path: target });
}

/** 读宿主文件内容（对应 `tools_webview_read_file`）。 */
export async function readHostFile(path: string): Promise<HostReadFilePayload> {
  const target = String(path ?? '').trim();
  if (!target) {
    throw new Error('readHostFile requires path');
  }
  return invoke<HostReadFilePayload>('read_file_content', { filePath: target });
}

const matchesFilter = (
  entry: HostDirEntry,
  filters?: PickFromHostTreeOptions['filters'],
): boolean => {
  if (!filters?.length) {
    return true;
  }
  if (entry.kind === 'directory') {
    return true;
  }
  const ext = entry.name.includes('.')
    ? entry.name.split('.').pop()!.toLowerCase()
    : '';
  return filters.some(
    (filter) =>
      filter.extensions.some((raw) => raw.trim().toLowerCase().replace(/^\./, '') === ext),
  );
};

function injectHostTreeStyle(): void {
  if (document.getElementById('otools-host-tree-style')) {
    return;
  }
  const style = document.createElement('style');
  style.id = 'otools-host-tree-style';
  style.textContent = HOST_TREE_CSS;
  document.head.appendChild(style);
}

/**
 * 弹出一棵宿主文件系统 DOM 树，用户导航后选中目录 / 文件并返回宿主侧路径。
 *
 * 不依赖任何 UI 框架（原生 DOM），所以 Vue / React / 纯 web 都能用。返回结果
 * 带 `source: 'host-tree'`，调用方据此区分「宿主侧路径」与「用户本机路径」。
 */
export async function pickFromHostTree(
  options: PickFromHostTreeOptions,
): Promise<HostPickResult> {
  if (typeof document === 'undefined' || !document.body) {
    throw new Error('pickFromHostTree requires a DOM document');
  }

  const directory = Boolean(options.directory);
  const saving = Boolean(options.save);
  const title = options.title ?? (saving ? '保存文件' : directory ? '选择目录' : '选择文件');
  const defaultPath = options.defaultPath ?? '';
  const splitAt = Math.max(defaultPath.lastIndexOf('/'), defaultPath.lastIndexOf('\\'));
  const defaultDirectory = splitAt < 0 ? '' : defaultPath.slice(0, splitAt === 0 || /^[a-z]:[\\/]$/i.test(defaultPath.slice(0, splitAt + 1)) ? splitAt + 1 : splitAt);
  const defaultName = defaultPath.slice(splitAt + 1);

  return new Promise<HostPickResult>((resolve) => {
    let currentPath = saving ? defaultDirectory : options.startPath ?? '';
    const selected = new Set<string>();
    let loaded = false;
    let closed = false;
    let requestId = 0;
    let pendingOverwrite: string | null = null;

    injectHostTreeStyle();

    const overlay = document.createElement('div');
    overlay.setAttribute('data-host-tree', '');
    overlay.className = 'otools-host-tree-overlay';

    const panel = document.createElement('div');
    panel.className = 'otools-host-tree-panel';
    overlay.appendChild(panel);

    const header = document.createElement('div');
    header.className = 'otools-host-tree-header';
    const titleEl = document.createElement('div');
    titleEl.className = 'otools-host-tree-title';
    titleEl.textContent = title;
    header.appendChild(titleEl);
    const pathEl = document.createElement('div');
    pathEl.className = 'otools-host-tree-path';
    header.appendChild(pathEl);
    panel.appendChild(header);

    const body = document.createElement('div');
    body.className = 'otools-host-tree-body';
    panel.appendChild(body);

    const filename = document.createElement('input');
    filename.type = 'text';
    filename.value = defaultName;
    filename.setAttribute('aria-label', '文件名');
    filename.className = 'otools-host-tree-filename';
    if (saving) panel.appendChild(filename);

    const errorEl = document.createElement('div');
    errorEl.setAttribute('role', 'alert');
    errorEl.className = 'otools-host-tree-error';
    panel.appendChild(errorEl);

    const overwrite = document.createElement('div');
    overwrite.className = 'otools-host-tree-overwrite';
    overwrite.hidden = true;
    const overwriteText = document.createElement('span');
    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.textContent = '返回';
    const overwriteBtn = document.createElement('button');
    overwriteBtn.type = 'button';
    overwriteBtn.textContent = '覆盖';
    overwrite.append(overwriteText, backBtn, overwriteBtn);
    panel.appendChild(overwrite);

    const footer = document.createElement('div');
    footer.className = 'otools-host-tree-footer';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = '取消';
    cancelBtn.className = 'otools-host-tree-btn';
    cancelBtn.setAttribute('data-host-tree-cancel', '');
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.textContent = saving ? '保存' : directory ? '选择此目录' : '选择';
    confirmBtn.className = 'otools-host-tree-btn otools-host-tree-btn-primary';
    confirmBtn.setAttribute('data-host-tree-confirm', '');
    confirmBtn.disabled = true;
    footer.appendChild(cancelBtn);
    footer.appendChild(confirmBtn);
    panel.appendChild(footer);

    const close = (result: HostPickResult) => {
      if (closed) return;
      closed = true;
      requestId += 1;
      window.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(result);
    };
    const picked = (paths: string[]) => close({
      kind: 'picked', source: 'host-tree', paths,
      names: paths.map(path => path.split(/[\\/]/).pop() || path),
    });
    const validName = () => {
      const name = filename.value.trim();
      return Boolean(name && name !== '.' && name !== '..' && !/[\\/:\x00-\x1f]/.test(name));
    };
    const updateConfirm = () => {
      confirmBtn.disabled = !loaded || !currentPath || pendingOverwrite !== null ||
        (saving ? !validName() : !directory && selected.size === 0);
    };
    const resetOverwrite = () => {
      pendingOverwrite = null;
      overwrite.hidden = true;
      filename.disabled = false;
      updateConfirm();
    };
    filename.addEventListener('input', () => { errorEl.textContent = ''; resetOverwrite(); });
    backBtn.addEventListener('click', resetOverwrite);
    overwriteBtn.addEventListener('click', () => {
      if (pendingOverwrite) picked([pendingOverwrite]);
    });

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close({ kind: 'cancelled', source: 'host-tree', paths: [], names: [] });
      }
    };
    window.addEventListener('keydown', onKey, true);

    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) {
        close({ kind: 'cancelled', source: 'host-tree', paths: [], names: [] });
      }
    });

    cancelBtn.addEventListener('click', () =>
      close({ kind: 'cancelled', source: 'host-tree', paths: [], names: [] }),
    );

    confirmBtn.addEventListener('click', () => {
      if (confirmBtn.disabled) return;
      if (!saving) {
        picked(directory ? [currentPath] : [...selected]);
        return;
      }
      let name = filename.value.trim();
      const extension = options.filters?.[0]?.extensions.find(ext => /^\.?[a-z0-9]+$/i.test(ext))?.replace(/^\./, '');
      if (extension && !name.includes('.')) name += `.${extension}`;
      const separator = currentPath.includes('\\') ? '\\' : '/';
      const target = `${currentPath.replace(/[\\/]+$/, '')}${separator}${name}`;
      const directoryAtSave = currentPath;
      const id = ++requestId;
      loaded = false;
      updateConfirm();
      // Re-read immediately before confirming; never overwrite based on a stale listing.
      void browseHostDir(directoryAtSave).then(payload => {
        if (closed || id !== requestId) return;
        loaded = true;
        const windowsPath = /^[a-z]:|^\\\\/i.test(directoryAtSave);
        const existing = payload.entries.find(entry => windowsPath
          ? entry.name.toLowerCase() === name.toLowerCase() : entry.name === name);
        if (existing?.kind === 'directory') {
          errorEl.textContent = '同名目录已存在，请更改文件名。';
          updateConfirm();
        } else if (existing) {
          pendingOverwrite = target;
          overwriteText.textContent = `文件 ${name} 已存在，是否覆盖？`;
          overwrite.hidden = false;
          filename.disabled = true;
          updateConfirm();
        } else {
          picked([target]);
        }
      }).catch(error => {
        if (closed || id !== requestId) return;
        loaded = true;
        errorEl.textContent = error instanceof Error ? error.message : String(error);
        updateConfirm();
      });
    });

    const render = (payload: HostBrowsePayload) => {
      currentPath = payload.currentPath || '';
      loaded = true;
      errorEl.textContent = '';
      updateConfirm();
      pathEl.textContent = currentPath || '（根）';
      body.innerHTML = '';

      if (payload.parentPath) {
        const upRow = document.createElement('div');
        upRow.className = 'otools-host-tree-entry otools-host-tree-up';
        upRow.setAttribute('data-host-tree-up', '');
        upRow.setAttribute('data-path', payload.parentPath);
        upRow.setAttribute('data-kind', 'directory');
        upRow.textContent = '↑ 上一级';
        body.appendChild(upRow);
      }

      for (const root of payload.roots) {
        const row = document.createElement('div');
        row.className = 'otools-host-tree-entry otools-host-tree-root';
        row.setAttribute('data-host-tree-root', '');
        row.setAttribute('data-path', root.path);
        row.setAttribute('data-kind', 'directory');
        row.textContent = `📁 ${root.name}  (${root.path})`;
        body.appendChild(row);
      }

      const visible = payload.entries.filter((entry) =>
        matchesFilter(entry, options.filters),
      );
      for (const entry of visible) {
        const row = document.createElement('div');
        row.className = 'otools-host-tree-entry';
        row.setAttribute('data-host-tree-entry', '');
        row.setAttribute('data-path', entry.path);
        row.setAttribute('data-kind', entry.kind);
        row.textContent =
          entry.kind === 'directory' ? `📁 ${entry.name}` : `📄 ${entry.name}`;
        if (!directory && selected.has(entry.path)) {
          row.classList.add('otools-host-tree-selected');
        }
        body.appendChild(row);
      }

      if (!payload.parentPath && !payload.roots.length && !visible.length) {
        const empty = document.createElement('div');
        empty.className = 'otools-host-tree-empty';
        empty.textContent = '该目录为空';
        body.appendChild(empty);
      }
    };

    const navigate = (path: string) => {
      const id = ++requestId;
      loaded = false;
      selected.clear();
      resetOverwrite();
      errorEl.textContent = '';
      void browseHostDir(path || undefined).then(payload => {
        if (!closed && id === requestId) render(payload);
      }).catch(error => {
        if (closed || id !== requestId) return;
        errorEl.textContent = error instanceof Error ? error.message : String(error);
        updateConfirm();
      });
    };

    // 事件委托：导航（目录/根/上一级）或选择（文件）。
    body.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const row = target.closest(
        '[data-host-tree-entry],[data-host-tree-root],[data-host-tree-up]',
      ) as HTMLElement | null;
      if (!row) {
        return;
      }
      const path = row.getAttribute('data-path') || '';
      const kind = row.getAttribute('data-kind');
      if (
        kind === 'directory' ||
        row.hasAttribute('data-host-tree-root') ||
        row.hasAttribute('data-host-tree-up')
      ) {
        navigate(path);
      } else if (loaded && !directory) {
        if (saving) {
          resetOverwrite();
          filename.value = path.split(/[\\/]/).pop() || '';
        } else {
          if (!options.multiple) selected.clear();
          if (selected.has(path)) selected.delete(path);
          else selected.add(path);
          body.querySelectorAll<HTMLElement>('[data-host-tree-entry]').forEach(node => {
            node.classList.toggle('otools-host-tree-selected', selected.has(node.getAttribute('data-path') || ''));
          });
        }
        updateConfirm();
      }
    });

    document.body.appendChild(overlay);

    navigate(currentPath);
  });
}

// 让宿主 `dialog.open` 的回落链能复用这棵 DOM 树：所有打包了本 SDK 的插件在
// 导入时自动把渲染器挂上去，远程 / 纯浏览器里 `dialog.open` 就会落到这里。
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__otoolsHostTree = pickFromHostTree;
}

const HOST_TREE_CSS = `
.otools-host-tree-filename { margin: 10px 16px; padding: 8px; border: 1px solid #d6d6da; border-radius: 6px; color: inherit; background: #fff; }
.otools-host-tree-error { padding: 0 16px; color: #b42318; font-size: 13px; }
.otools-host-tree-error:empty { display: none; }
.otools-host-tree-overwrite:not([hidden]) { display: flex; gap: 10px; align-items: center; padding: 12px 16px; background: #fff3d6; font-size: 13px; }
.otools-host-tree-overwrite button { border: 1px solid #d6d6da; border-radius: 6px; background: #fff; padding: 5px 10px; cursor: pointer; }
.otools-host-tree-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2147483000;
  font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
.otools-host-tree-panel {
  width: min(560px, 90vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  background: #ffffff;
  border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
  overflow: hidden;
  color: #1d1d1f;
}
.otools-host-tree-header {
  padding: 14px 18px 10px;
  border-bottom: 1px solid #ececec;
}
.otools-host-tree-title {
  font-size: 15px;
  font-weight: 600;
}
.otools-host-tree-path {
  margin-top: 4px;
  font-size: 12px;
  color: #6b6b70;
  word-break: break-all;
}
.otools-host-tree-body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 6px 8px;
  min-height: 220px;
}
.otools-host-tree-entry {
  padding: 7px 10px;
  border-radius: 7px;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.otools-host-tree-entry:hover {
  background: #f2f2f4;
}
.otools-host-tree-up,
.otools-host-tree-root {
  color: #2b6fff;
}
.otools-host-tree-selected {
  background: #e3edff !important;
  color: #1b4fd6;
}
.otools-host-tree-empty {
  padding: 18px 10px;
  text-align: center;
  color: #9a9aa0;
  font-size: 13px;
}
.otools-host-tree-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 16px;
  border-top: 1px solid #ececec;
}
.otools-host-tree-btn {
  padding: 7px 16px;
  border: 1px solid #d6d6da;
  border-radius: 8px;
  background: #f7f7f9;
  font-size: 13px;
  cursor: pointer;
}
.otools-host-tree-btn-primary {
  background: #2b6fff;
  border-color: #2b6fff;
  color: #fff;
}
.otools-host-tree-btn-primary:disabled {
  background: #b9c8ee;
  border-color: #b9c8ee;
  cursor: not-allowed;
}
`;
