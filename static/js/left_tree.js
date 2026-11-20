/**
 * SmartLocalNote - Left Panel (V4 Super-Upgrade)
 * Features:
 *  1. Sticky Pinned Top Header (.left-sticky-top) + In-Folder Instant Filter + Back-to-Top
 *  2. Multi-Criteria File Sorting (name/mtime/ext/size + asc/desc) & Formatted Modified Time
 *  3. 20-File Cross-Format RAG Selection Badges, Privacy Lock Toggles & Full-Format Import Copy
 *  4. Dedicated Left-Panel Right-Click Context Menu (.left-context-menu) for Files & Apps
 *  5. Per-Module Vertical Height Drag Resizer (.module-height-resizer) + 1-Click Reset Default
 *  6. Modular Reordering, Workspaces / Capture Scene, Draggable File Anchors & App Portals,
 *     Virtual Knowledge Tree, Quick Scratch, Recent Files & Mini Pomodoro
 *
 * Strictly decoupled via store EventBus. Zero direct DOM access to Center/Right panels.
 */

import * as storeMod from './store.js';
import { api } from './api_client.js';
import { icon, getFileTypeStyle } from './icons.js';

const {
  store,
  escapeHtml,
  toggleContextPath,
  showToast,
  openSheet,
  closeSheet,
  updateUiLayout,
  setDragPayload,
  clearDragPayload,
  copyInternal,
  nextSequentialName,
  setModuleSizePreset,
  toggleModuleFloat,
  openFocusDurationPopover,
  applyPaneWidths,
} = storeMod;

const MAX_CONTEXT_FILES = Number(storeMod.MAX_CONTEXT_FILES) || 20;
const LEFT_SORT_STORAGE_KEY = 'sln_left_file_sort';
const MODULE_MIN_HEIGHT = 80;
const MODULE_MAX_HEIGHT = 840;

const FOCUS_DURATION_OPTIONS = [
  { label: '15秒演示', seconds: 15 },
  { label: '15分', seconds: 900 },
  { label: '25分', seconds: 1500 },
  { label: '45分', seconds: 2700 },
];

const QUICK_POMODORO_PRESETS = [
  { label: '15s演示', seconds: 15 },
  { label: '15分', seconds: 900 },
  { label: '25分', seconds: 1500 },
  { label: '45分', seconds: 2700 },
];

const MODULE_DESCRIPTIONS = {
  files: '本地文件树（支持联合问答勾选、隐私锁、多维排序与拖拽锚点）',
  workspaces: '打包常用文件+本地软件，一键联启进入学习/办公模式',
  apps: '已注册本地软件快捷直达胶囊（支持拖入笔记生成直达胶囊）',
  tree: '虚拟知识树节点与绑定文件速览',
  quick_scratch: '随时记录灵感片段，支持拖入当前笔记、弹出悬浮便签或 AI 提取待办',
  recent_files: '最近打开文档快捷回跳列表',
  pomodoro_mini: '自定义任务名与专注时长，一键开启灵动岛倒计时',
};

const collapsedGroups = new Set();
const mutating = {
  files: false,
  apps: false,
  workspaces: false,
  tree: false,
};

let containerRef = null;
let isLoadingInitial = true;
let dragModuleId = null;
let dragFileItem = null;
let quickPomodoroTask = '';
let leftFilterQuery = '';
let leftContextMenuEl = null;
let moduleContextMenuEl = null;
let isResizingModule = false;
let globalMenuListenersBound = false;
let moduleMenuListenersBound = false;
const soloRestoreStateByGroup = new Map();

const SORT_FIELD_LABELS = {
  name: '按名称',
  mtime: '按修改时间',
  ext: '按文件类型',
  size: '按文件大小',
};

function getPinnedFilesList() {
  return Array.isArray(store.state.pinnedFiles) ? store.state.pinnedFiles : [];
}

function isCustomSortEnabled() {
  return Boolean(store.state.customSortEnabled);
}

function getCustomFileOrderList() {
  return Array.isArray(store.state.customFileOrder) ? store.state.customFileOrder : [];
}

function renderSortCornerBadgeHtml(by) {
  let inner = '';
  if (by === 'mtime') inner = icon('clock', 9);
  else if (by === 'ext') inner = icon('file-text', 9);
  else if (by === 'size') inner = icon('bar-chart-2', 9);
  else inner = '<span class="left-sort-corner-letter">A</span>';
  return `<span class="left-sort-corner-icon" aria-hidden="true">${inner}</span>`;
}

function renderSortTriggerContentHtml(sortCfg = getLeftFileSort()) {
  const by = sortCfg?.by || 'name';
  return `${icon('arrow-up-down', 14)}${renderSortCornerBadgeHtml(by)}`;
}

function getSortTooltip(sortCfg = getLeftFileSort()) {
  const byLabel = SORT_FIELD_LABELS[sortCfg?.by] || SORT_FIELD_LABELS.name;
  const dirLabel = sortCfg?.dir === 'desc' ? '降序' : '升序';
  return `排序：${byLabel} · ${dirLabel}`;
}

function getLeftFileSort() {
  const raw = store.state.leftFileSort;
  if (raw && typeof raw === 'object') {
    const by = ['name', 'mtime', 'ext', 'size'].includes(raw.by) ? raw.by : 'name';
    const dir = raw.dir === 'desc' ? 'desc' : 'asc';
    return { by, dir };
  }
  try {
    const saved = JSON.parse(localStorage.getItem(LEFT_SORT_STORAGE_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      const by = ['name', 'mtime', 'ext', 'size'].includes(saved.by) ? saved.by : 'name';
      const dir = saved.dir === 'desc' ? 'desc' : 'asc';
      return { by, dir };
    }
  } catch {
    // ignore storage errors
  }
  return { by: 'name', dir: 'asc' };
}

function persistLeftFileSort(patch) {
  if (typeof storeMod.setLeftFileSort === 'function') {
    return storeMod.setLeftFileSort(patch);
  }
  const next = { ...getLeftFileSort(), ...(patch || {}) };
  if (!['name', 'mtime', 'ext', 'size'].includes(next.by)) next.by = 'name';
  next.dir = next.dir === 'desc' ? 'desc' : 'asc';
  store.state.leftFileSort = next;
  try {
    localStorage.setItem(LEFT_SORT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore storage errors
  }
  store.emit('files:sort-changed', next);
  return next;
}

function getModuleHeight(modId) {
  const heights = store.state.uiLayout?.moduleHeights;
  if (heights && typeof heights === 'object') {
    const val = Number(heights[modId]);
    if (Number.isFinite(val) && val >= MODULE_MIN_HEIGHT) {
      return Math.min(MODULE_MAX_HEIGHT, Math.round(val));
    }
  }
  return null;
}

function getModuleSizePreset(panel, modId) {
  const presetKey = `${panel}:${modId}`;
  const raw = store.state.uiLayout?.moduleSizePresets?.[presetKey];
  if (raw === 's' || raw === 'm' || raw === 'l' || raw === 'auto') {
    return raw;
  }
  const h = getModuleHeight(panel === 'right' && !modId.startsWith('right_') ? `right_${modId}` : modId);
  if (!h) return 'auto';
  if (h <= 170) return 's';
  if (h <= 320) return 'm';
  return 'l';
}

function isModuleFloating(modId) {
  return Boolean(store.state.uiLayout?.floatingModules?.[modId]?.open);
}

function renderFileTypeIconHtml(nameOrExt, size = 14) {
  const ft = getFileTypeStyle(nameOrExt);
  return `<span class="ft-icon ${escapeHtml(ft.cssClass)}" style="--ft-color:${ft.color};--ft-bg:${ft.bg};--ft-border:${ft.border}">${icon(ft.iconName, size)}</span>`;
}

function renderFileTypeBadgeHtml(nameOrExt) {
  const ft = getFileTypeStyle(nameOrExt);
  return `<span class="file-ext-badge ft-badge ${escapeHtml(ft.cssClass)}" style="--ft-color:${ft.color};--ft-bg:${ft.bg};--ft-border:${ft.border}">${escapeHtml(ft.label)}</span>`;
}

function persistModuleHeight(modId, px) {
  if (typeof storeMod.setModuleHeight === 'function') {
    return storeMod.setModuleHeight(modId, px);
  }
  const cur = store.state.uiLayout || {};
  const nextHeights = { ...(cur.moduleHeights || {}) };
  if (px === null || px === undefined || !Number.isFinite(Number(px)) || Number(px) <= 0) {
    delete nextHeights[modId];
  } else {
    nextHeights[modId] = Math.max(MODULE_MIN_HEIGHT, Math.min(MODULE_MAX_HEIGHT, Math.round(Number(px))));
  }
  store.state.uiLayout = { ...cur, moduleHeights: nextHeights };
  try {
    localStorage.setItem('sln_ui_layout', JSON.stringify(store.state.uiLayout));
  } catch {
    // ignore storage errors
  }
  return store.state.uiLayout;
}

function resetAllLayout() {
  if (typeof storeMod.resetUiLayout === 'function') {
    storeMod.resetUiLayout();
  }
  if (store.state.uiLayout && typeof store.state.uiLayout === 'object') {
    store.state.uiLayout.moduleHeights = {};
    store.state.uiLayout.moduleSizePresets = {};
  }
  if (typeof applyPaneWidths === 'function') {
    applyPaneWidths(260, 360);
  }
  renderLeftPanel(containerRef);
  showToast('已一键恢复默认三栏宽度与模块尺寸', 'success');
}

function getBasename(filePath) {
  const parts = String(filePath || '').split(/[\\/]/);
  return parts[parts.length - 1] || String(filePath || '');
}

function getFileExt(item) {
  const rawExt = String(item?.ext || '').trim();
  if (rawExt) return rawExt.replace(/^\./, '').toLowerCase();
  const name = item?.name || getBasename(item?.path || '');
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : 'txt';
}

function getFileIconName(ext) {
  switch (String(ext || '').replace(/^\./, '').toLowerCase()) {
    case 'xlsx':
    case 'xls':
    case 'xlsm':
    case 'csv':
      return 'file-spreadsheet';
    case 'pdf':
      return 'book-open';
    case 'zip':
    case 'tar':
    case 'tgz':
    case 'gz':
      return 'layers';
    case 'mp4':
    case 'webm':
    case 'mov':
    case 'mkv':
    case 'avi':
    case 'mp3':
    case 'wav':
    case 'm4a':
    case 'ogg':
    case 'flac':
    case 'aac':
      return 'play';
    case 'md':
    case 'py':
    case 'js':
    case 'ts':
    case 'json':
    case 'html':
    case 'css':
    case 'xml':
    case 'yaml':
    case 'yml':
    case 'sql':
    case 'sh':
    case 'bat':
      return 'file-code';
    case 'docx':
    case 'pptx':
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'webp':
    case 'gif':
    case 'bmp':
    case 'svg':
    case 'txt':
    default:
      return 'file-text';
  }
}

function findFileItemByPath(path) {
  const items = store.state.files?.items || [];
  return items.find((item) => item.path === path) || null;
}

function buildFileAnchorMarkdown(itemOrPath) {
  const path = typeof itemOrPath === 'string' ? itemOrPath : itemOrPath?.path || '';
  const name =
    (typeof itemOrPath === 'object' && itemOrPath?.name) || getBasename(path);
  const ext = getFileExt(
    typeof itemOrPath === 'object' ? itemOrPath : { path, name }
  );
  if (ext === 'pdf') {
    return `[[${name}#page=1]]`;
  }
  if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm') {
    return `[[${name}#A2]]`;
  }
  if (['zip', 'tar', 'tgz', 'gz'].includes(ext)) {
    return `[[${name}]]`;
  }
  if (['mp4', 'mp3', 'wav', 'm4a', 'webm', 'mov', 'mkv', 'ogg', 'flac', 'aac'].includes(ext)) {
    return `[[${name}#t=00:00]]`;
  }
  return `[[${name}]]`;
}

function parseMtimeMs(raw) {
  if (raw === null || raw === undefined || raw === '') return 0;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return raw > 1e12 ? raw : raw * 1000;
  }
  const str = String(raw).trim();
  if (!str) return 0;
  const num = Number(str);
  if (Number.isFinite(num) && num > 0) {
    return num > 1e12 ? num : num * 1000;
  }
  const parsed = Date.parse(str);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatMtime(raw) {
  const ms = parseMtimeMs(raw);
  if (!ms) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';

  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startYesterday = startToday - 86400000;

  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');

  if (
    ms >= startToday &&
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  ) {
    return `今天 ${hh}:${min}`;
  }
  if (ms >= startYesterday && ms < startToday) {
    return `昨天 ${hh}:${min}`;
  }
  if (d.getFullYear() === now.getFullYear()) {
    return `${mm}-${dd} ${hh}:${min}`;
  }
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function sortFileItems(items, sortCfg = getLeftFileSort()) {
  const list = Array.isArray(items) ? [...items] : [];
  const by = sortCfg?.by || 'name';
  const mult = sortCfg?.dir === 'desc' ? -1 : 1;

  const pinnedOrder = new Map(getPinnedFilesList().map((p, idx) => [p, idx]));
  const customEnabled = isCustomSortEnabled();
  const customOrder = new Map(getCustomFileOrderList().map((p, idx) => [p, idx]));

  const pinnedItems = [];
  const manualItems = [];
  const autoItems = [];

  for (const item of list) {
    const path = item?.path || '';
    if (pinnedOrder.has(path)) {
      pinnedItems.push(item);
    } else if (customEnabled && customOrder.has(path)) {
      manualItems.push(item);
    } else {
      autoItems.push(item);
    }
  }

  pinnedItems.sort((a, b) => (pinnedOrder.get(a?.path || '') ?? 0) - (pinnedOrder.get(b?.path || '') ?? 0));
  manualItems.sort((a, b) => (customOrder.get(a?.path || '') ?? 0) - (customOrder.get(b?.path || '') ?? 0));

  autoItems.sort((a, b) => {
    const nameA = String(a?.name || getBasename(a?.path || ''));
    const nameB = String(b?.name || getBasename(b?.path || ''));
    let cmp = 0;

    if (by === 'mtime') {
      cmp = parseMtimeMs(a?.mtime) - parseMtimeMs(b?.mtime);
    } else if (by === 'size') {
      cmp = (Number(a?.size) || 0) - (Number(b?.size) || 0);
    } else if (by === 'ext') {
      const extA = getFileExt(a);
      const extB = getFileExt(b);
      cmp = extA.localeCompare(extB, 'zh-CN', { numeric: true, sensitivity: 'base' });
    } else {
      cmp = nameA.localeCompare(nameB, 'zh-CN', { numeric: true, sensitivity: 'base' });
    }

    if (cmp === 0 && by !== 'name') {
      cmp = nameA.localeCompare(nameB, 'zh-CN', { numeric: true, sensitivity: 'base' });
    }
    return cmp * mult;
  });

  return [...pinnedItems, ...manualItems, ...autoItems];
}

function filterFileItems(items, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return Array.isArray(items) ? items : [];
  return (items || []).filter((item) => {
    const name = String(item?.name || getBasename(item?.path || '')).toLowerCase();
    const ext = getFileExt(item).toLowerCase();
    const path = String(item?.path || '').toLowerCase();
    const group = String(item?.group || '').toLowerCase();
    return name.includes(q) || ext.includes(q) || path.includes(q) || group.includes(q);
  });
}

function getLeftModules() {
  const mods = store.state.uiLayout?.leftModules;
  if (Array.isArray(mods) && mods.length > 0) {
    return mods.map((m) =>
      m.id === 'workspaces' && m.title === '场景工作区'
        ? { ...m, title: '一键场景包' }
        : m
    );
  }
  return [
    { id: 'files', title: '本地文件', visible: true, collapsed: false },
    { id: 'workspaces', title: '一键场景包', visible: true, collapsed: false },
    { id: 'apps', title: '办公软件直达', visible: true, collapsed: false },
    { id: 'tree', title: '虚拟知识树', visible: true, collapsed: false },
    { id: 'quick_scratch', title: '灵感便签（可拖入笔记）', visible: false, collapsed: false },
    { id: 'recent_files', title: '最近打开', visible: false, collapsed: false },
    { id: 'pomodoro_mini', title: '快捷专注', visible: false, collapsed: false },
  ];
}

function groupFiles(items, sortCfg = getLeftFileSort()) {
  const groups = new Map();

  for (const item of items) {
    const source = item.source || '';
    let key = '';
    let label = '';

    if (source === 'notes') {
      key = 'source:notes';
      label = '默认笔记';
    } else if (source === 'imported') {
      key = 'source:imported';
      label = '已导入文件';
    } else {
      const folderName = item.group || '挂载目录';
      key = `dir:${folderName}`;
      label = folderName;
    }

    if (!groups.has(key)) {
      groups.set(key, { key, label, items: [] });
    }
    groups.get(key).items.push(item);
  }

  return Array.from(groups.values()).map((grp) => ({
    ...grp,
    items: sortFileItems(grp.items, sortCfg),
  }));
}

async function loadFiles() {
  try {
    const data = await api.get('/api/files/list');
    const folders = Array.isArray(data?.folders) ? data.folders : [];
    store.state.files = {
      items: Array.isArray(data?.items) ? data.items : [],
      dirs: Array.isArray(data?.dirs) ? data.dirs : [],
      folders,
      private_files: Array.isArray(data?.private_files) ? data.private_files : [],
    };
    store.state.folders = folders;
  } catch (err) {
    showToast(`加载文件列表失败：${err.message}`, 'error');
  }
}

async function loadApps() {
  try {
    const data = await api.get('/api/apps');
    store.state.apps = Array.isArray(data) ? data : [];
  } catch (err) {
    showToast(`加载软件列表失败：${err.message}`, 'error');
  }
}

async function loadWorkspaces() {
  try {
    const data = await api.get('/api/workspaces');
    store.state.workspaces = Array.isArray(data) ? data : [];
  } catch (err) {
    showToast(`加载工作区失败：${err.message}`, 'error');
  }
}

async function loadTree() {
  try {
    const data = await api.get('/api/tree');
    store.state.tree = {
      nodes: Array.isArray(data?.nodes) ? data.nodes : [],
      table_rows: Array.isArray(data?.table_rows) ? data.table_rows : [],
    };
  } catch (err) {
    showToast(`加载知识树失败：${err.message}`, 'error');
  }
}

async function loadAllData() {
  await Promise.allSettled([loadFiles(), loadApps(), loadWorkspaces(), loadTree()]);
  isLoadingInitial = false;
}

function emitWithGuard(channel, payload) {
  mutating[channel] = true;
  try {
    store.emit(`${channel}:updated`, payload);
  } finally {
    mutating[channel] = false;
  }
}

function syncContextCheckboxes(containerEl) {
  if (!containerEl) return;
  const selected = new Set(store.state.selectedContextPaths || []);

  containerEl.querySelectorAll('[data-role="ctx-count-badge"]').forEach((badge) => {
    badge.textContent = `${selected.size}/${MAX_CONTEXT_FILES}`;
    badge.title = `已勾选参与联合问答文件数 (${selected.size}/${MAX_CONTEXT_FILES})`;
  });

  containerEl.querySelectorAll('.tree-file-item').forEach((row) => {
    const path = row.dataset.path || '';
    const cb = row.querySelector('.file-check');
    if (cb) {
      cb.checked = selected.has(path);
    }
  });
}

function syncActiveFileHighlight(containerEl, explicitPath) {
  if (!containerEl) return;
  const activePath = explicitPath !== undefined ? explicitPath : store.state.activeFile?.path || '';
  containerEl.querySelectorAll('.tree-file-item').forEach((row) => {
    row.classList.toggle('is-selected', Boolean(activePath) && row.dataset.path === activePath);
  });
}

function renderFilesSection(items, selectedSet, activePath) {
  if (isLoadingInitial && items.length === 0) {
    return `<div class="empty-state" style="padding: 14px 8px;"><p class="empty-desc">正在扫描本地工作区…</p></div>`;
  }

  if (items.length === 0) {
    return `
      <div class="empty-state" style="padding: 14px 8px;">
        <p class="empty-desc">暂无本地文档，点击上方「+ 笔记」或「导入」添加资料</p>
      </div>
    `;
  }

  const trimmedQuery = leftFilterQuery.trim();
  const visibleItems = filterFileItems(items, trimmedQuery);

  if (trimmedQuery && visibleItems.length === 0) {
    return `
      <div class="empty-state" style="padding: 16px 8px;">
        <p class="empty-desc">未找到匹配「${escapeHtml(trimmedQuery)}」的本地文件</p>
        <button type="button" class="pill-btn pill-btn-sm" data-action="clear-filter">清空筛选</button>
      </div>
    `;
  }

  const sortCfg = getLeftFileSort();
  const groups = groupFiles(visibleItems, sortCfg);
  const forceExpand = Boolean(trimmedQuery);
  const pinnedSet = new Set(getPinnedFilesList());

  return groups
    .map((grp) => {
      const isCollapsed = !forceExpand && collapsedGroups.has(grp.key);
      return `
        <div class="tree-group" data-group-key="${escapeHtml(grp.key)}">
          <div class="tree-folder-row" data-action="toggle-group" data-group-key="${escapeHtml(grp.key)}" role="button" tabindex="0" aria-expanded="${!isCollapsed}">
            ${icon(isCollapsed ? 'chevron-right' : 'chevron-down', 13)}
            ${icon(isCollapsed ? 'folder' : 'folder-open', 14)}
            <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(grp.label)}</span>
            <span class="file-ext-badge">${grp.items.length}</span>
          </div>
          ${
            isCollapsed
              ? ''
              : grp.items
                  .map((item) => {
                    const path = item.path || '';
                    const name = item.name || getBasename(path);
                    const ext = getFileExt(item);
                    const isChecked = selectedSet.has(path);
                    const isActive = Boolean(activePath) && activePath === path;
                    const isPriv = Boolean(item.is_private);
                    const isPinned = pinnedSet.has(path);
                    const mtimeText = formatMtime(item.mtime);
                    return `
                      <div
                        class="tree-file-item ${isActive ? 'is-selected' : ''} ${isPinned ? 'is-pinned' : ''}"
                        data-action="open-file"
                        data-path="${escapeHtml(path)}"
                        data-name="${escapeHtml(name)}"
                        data-ext="${escapeHtml(ext)}"
                        data-pinned="${isPinned ? '1' : '0'}"
                        data-group-key="${escapeHtml(grp.key)}"
                        draggable="true"
                        role="button"
                        tabindex="0"
                      >
                        <input
                          type="checkbox"
                          class="file-check"
                          data-path="${escapeHtml(path)}"
                          ${isChecked ? 'checked' : ''}
                          title="勾选参与右侧联合问答（最多 ${MAX_CONTEXT_FILES} 份）"
                          aria-label="勾选 ${escapeHtml(name)} 参与联合问答"
                        />
                        ${renderFileTypeIconHtml(name, 14)}
                        <span style="flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;">
                          <span style="display:flex;align-items:center;gap:4px;min-width:0;">
                            <span class="file-name" title="${escapeHtml(path)}（支持拖拽至中间笔记生成锚点 · 右键更多操作）">${escapeHtml(name)}</span>
                            ${isPinned ? `<span class="file-pin-badge" title="已置顶" aria-label="已置顶">${icon('pin', 10)}</span>` : ''}
                          </span>
                          <span style="display:flex;align-items:center;gap:5px;min-width:0;">
                            ${renderFileTypeBadgeHtml(name)}
                            ${mtimeText ? `<span class="file-meta-time" style="font-size:10px;color:var(--text-tertiary);line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(mtimeText)}</span>` : ''}
                          </span>
                        </span>
                        <button
                          type="button"
                          class="lock-toggle-btn ${isPriv ? 'lock-badge' : ''}"
                          data-action="toggle-privacy"
                          data-path="${escapeHtml(path)}"
                          title="${isPriv ? '隐私锁已开启（严禁发往外部AI），点击解除' : '点击开启隐私锁'}"
                          aria-label="${isPriv ? '解除隐私锁' : '开启隐私锁'}"
                          style="${isPriv ? '' : 'width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;border-radius:9999px;color:var(--text-tertiary);flex-shrink:0;'}"
                        >
                          ${icon(isPriv ? 'lock' : 'unlock', 12)}
                        </button>
                      </div>
                    `;
                  })
                  .join('')
          }
        </div>
      `;
    })
    .join('');
}

function renderAppsSection(apps) {
  if (apps.length === 0) {
    return `<p class="empty-desc" style="margin:4px 0;">暂无已注册软件，可点击「捕获现场」或「+ 软件」快速添加</p>`;
  }
  return `
    <div class="app-pill-grid">
      ${apps
        .map(
          (app) => `
          <button
            type="button"
            class="app-launcher-pill"
            draggable="true"
            data-action="launch-app"
            data-app-id="${escapeHtml(app.id)}"
            data-app-name="${escapeHtml(app.name)}"
            title="点击启动，拖进笔记生成直达胶囊，或右键查看更多操作"
          >
            ${icon('rocket', 12)}
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(app.name)}</span>
          </button>
        `
        )
        .join('')}
    </div>
  `;
}

function renderWorkspacesSection(workspaces) {
  if (workspaces.length === 0) {
    return `<p class="empty-desc" style="margin:2px 0;">暂无一键场景包，点击「捕获现场」一键打包</p>`;
  }
  return workspaces
    .map((ws) => {
      const appCount = Array.isArray(ws.app_ids) ? ws.app_ids.length : 0;
      const fileCount = Array.isArray(ws.file_paths) ? ws.file_paths.length : 0;
      const badgeLabel = `${appCount}软件${fileCount ? `·${fileCount}档` : ''}`;
      return `
        <div class="workspace-card workspace-row-compact" draggable="true" data-workspace-id="${escapeHtml(ws.id)}" title="按住拖入中间笔记生成工作区锚点，或拖入下方垃圾桶移除">
          <div class="workspace-row-main" style="display:flex;align-items:center;gap:6px;min-width:0;flex:1;">
            <span class="workspace-name" title="${escapeHtml(ws.name)}" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(ws.name)}</span>
            <span class="file-ext-badge workspace-count-badge" title="${appCount} 个软件 · ${fileCount} 份文档">${escapeHtml(badgeLabel)}</span>
          </div>
          <div class="workspace-row-actions" style="display:inline-flex;align-items:center;gap:4px;flex-shrink:0;">
            <button
              type="button"
              class="pill-btn pill-btn-sm pill-btn-primary"
              data-action="launch-workspace"
              data-ws-id="${escapeHtml(ws.id)}"
              title="一键联启关联软件与文档"
              style="height:24px;padding:0 8px;font-size:11px;"
            >
              🚀 联启
            </button>
            <button
              type="button"
              class="pill-btn pill-btn-sm"
              data-action="focus-workspace"
              data-ws-id="${escapeHtml(ws.id)}"
              title="选择专注时长并开启灵动岛专注"
              style="height:24px;padding:0 8px;font-size:11px;"
            >
              ⏱ 专注
            </button>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderKnowledgeTreeSection(treeNodes, activePath) {
  const topNodes = (treeNodes || []).filter((n) => !n.parent_id);
  if (topNodes.length === 0) {
    return `<p class="empty-desc" style="margin:4px 0;">暂无知识树节点，点击「管理」创建分类</p>`;
  }

  return topNodes
    .map((node) => {
      const boundFiles = Array.isArray(node.files) ? node.files : [];
      return `
        <div class="tree-group" style="margin-bottom:6px;">
          <div class="tree-folder-row" style="cursor:default;">
            ${icon('git-branch', 13)}
            <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(node.name)}</span>
            <span class="file-ext-badge">${boundFiles.length}</span>
          </div>
          ${boundFiles
            .map((bf) => {
              const path = bf.path || '';
              const name = getBasename(path);
              const ext = getFileExt({ path, name });
              const status = bf.status || '';
              const isActive = Boolean(activePath) && activePath === path;
              return `
                <div
                  class="tree-file-item ${isActive ? 'is-selected' : ''}"
                  data-action="open-tree-file"
                  data-path="${escapeHtml(path)}"
                  data-name="${escapeHtml(name)}"
                  data-ext="${escapeHtml(ext)}"
                  draggable="true"
                  role="button"
                  tabindex="0"
                  style="padding-left:20px;"
                >
                  ${renderFileTypeIconHtml(name, 14)}
                  <span class="file-name" title="${escapeHtml(path)}">${escapeHtml(name)}</span>
                  ${renderFileTypeBadgeHtml(name)}
                  ${status ? `<span class="file-ext-badge">${escapeHtml(status)}</span>` : ''}
                </div>
              `;
            })
            .join('')}
        </div>
      `;
    })
    .join('');
}

function renderQuickScratchSection() {
  const scratchText = store.state.uiLayout?.scratchpadText || '';
  return `
    <div style="display:flex;flex-direction:column;gap:8px;">
      <textarea
        class="apple-textarea"
        data-role="quick-scratch-input"
        rows="4"
        placeholder="随手记下碎片想法，可拖拽下方胶囊直接插入当前笔记…"
        style="min-height:84px;font-size:12.5px;padding:8px 10px;"
      >${escapeHtml(scratchText)}</textarea>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;">
        <span
          class="drag-pill-hint draggable-card"
          data-drag-source="quick-scratch"
          draggable="true"
          title="按住拖入中间笔记或 PDF 伴生笔记"
          style="padding:4px 9px;font-size:11.5px;color:var(--accent);background:var(--accent-soft);"
        >
          ⠿ 拖入笔记
        </span>
        <button
          type="button"
          class="pill-btn pill-btn-sm"
          data-action="spawn-sticky-note"
          title="弹出悬浮便签（快捷键 Alt+N，也可随时在任意位置右键菜单召唤）"
          style="height:26px;padding:0 10px;font-size:11.5px;"
        >
          📌 弹出悬浮便签 (Alt+N)
        </button>
        <button
          type="button"
          class="pill-btn pill-btn-sm"
          data-action="scratch-ai-extract"
          style="height:26px;padding:0 10px;font-size:11.5px;"
        >
          ${icon('sparkles', 12)} AI 提取待办
        </button>
      </div>
    </div>
  `;
}

function renderRecentFilesSection(recentFiles, activePath) {
  const list = Array.isArray(recentFiles) ? recentFiles : [];
  if (list.length === 0) {
    return `<p class="empty-desc" style="margin:4px 0;">暂无最近打开记录，点击任意文档后将自动收录</p>`;
  }
  return list
    .map((rf) => {
      const path = rf.path || '';
      const name = rf.name || getBasename(path);
      const ext = getFileExt(rf);
      const isActive = Boolean(activePath) && activePath === path;
      return `
        <div
          class="tree-file-item ${isActive ? 'is-selected' : ''}"
          data-action="open-file"
          data-path="${escapeHtml(path)}"
          data-name="${escapeHtml(name)}"
          data-ext="${escapeHtml(ext)}"
          draggable="true"
          role="button"
          tabindex="0"
        >
          ${renderFileTypeIconHtml(name, 14)}
          <span class="file-name" title="${escapeHtml(path)}">${escapeHtml(name)}</span>
          ${renderFileTypeBadgeHtml(name)}
        </div>
      `;
    })
    .join('');
}

function renderPomodoroMiniSection() {
  return `
    <div style="display:flex;flex-direction:column;gap:8px;">
      <input
        type="text"
        class="apple-input"
        data-role="mini-pomodoro-task"
        value="${escapeHtml(quickPomodoroTask)}"
        placeholder="专注任务名（如：高数错题复盘）"
        style="height:30px;padding:4px 10px;font-size:12px;"
      />
      <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
        ${QUICK_POMODORO_PRESETS.map(
          (preset) => `
            <button
              type="button"
              class="pill-btn pill-btn-sm"
              data-action="mini-pomodoro-start"
              data-seconds="${preset.seconds}"
              style="height:26px;padding:0 9px;font-size:11.5px;"
            >
              ${icon('play', 11)} ${escapeHtml(preset.label)}
            </button>
          `
        ).join('')}
      </div>
    </div>
  `;
}

function getModuleQuickActionsHtml(modId, _selectedCount, itemsCount) {
  if (modId === 'files') {
    return `
      <button type="button" class="pill-btn pill-btn-sm left-root-back-btn" data-action="back-to-notes-root" title="清除筛选并回到默认笔记主文件夹顶部" style="height:20px;padding:0 6px;font-size:10.5px;">⌂ 主目录顶部</button>
      <span data-role="files-count-label" style="font-size:11px;color:var(--text-tertiary);">${itemsCount}</span>
    `;
  }
  if (modId === 'workspaces') {
    return `
      <button type="button" class="left-icon-btn is-xs" data-action="capture-scene" title="捕获当前桌面现场，生成一键场景包" aria-label="捕获现场">
        ${icon('camera', 13)}
      </button>
    `;
  }
  if (modId === 'apps') {
    return `
      <button type="button" class="left-icon-btn is-xs" data-action="add-app" title="添加本地软件" aria-label="添加软件">
        ${icon('plus', 13)}
      </button>
    `;
  }
  if (modId === 'tree') {
    return `
      <button type="button" class="left-icon-btn is-xs" data-action="manage-tree" title="管理虚拟知识树" aria-label="管理知识树">
        ${icon('settings', 13)}
      </button>
    `;
  }
  return '';
}

function isModuleBodyEmpty(modId, ctx) {
  switch (modId) {
    case 'files':
      return !isLoadingInitial && (ctx.items || []).length === 0;
    case 'workspaces':
      return (ctx.workspaces || []).length === 0;
    case 'apps':
      return (ctx.apps || []).length === 0;
    case 'tree':
      return (ctx.treeNodes || []).filter((n) => !n.parent_id).length === 0;
    case 'recent_files':
      return (ctx.recentFiles || []).length === 0;
    default:
      return false;
  }
}

function renderLeftModuleHeaderControlsHtml(mod) {
  const curPreset = getModuleSizePreset('left', mod.id);
  const floated = isModuleFloating(mod.id);
  const presets = [
    { key: 's', label: 'S', title: '小尺寸 (150px)' },
    { key: 'm', label: 'M', title: '中尺寸 (280px)' },
    { key: 'l', label: 'L', title: '大尺寸 (460px)' },
    { key: 'auto', label: 'Auto', title: '自适应高度' },
  ];
  return `
    <span class="module-size-controls" role="group" aria-label="模块高度">
      ${presets
        .map(
          (p) => `<button type="button" class="module-size-pill ${curPreset === p.key ? 'is-active' : ''}" data-action="set-module-size" data-panel="left" data-mod-id="${escapeHtml(mod.id)}" data-preset="${p.key}" title="${p.title}">${p.label}</button>`
        )
        .join('')}
    </span>
    <button type="button" class="left-icon-btn is-xs module-float-btn ${floated ? 'is-active' : ''}" data-action="toggle-module-float" data-panel="left" data-mod-id="${escapeHtml(mod.id)}" data-mod-title="${escapeHtml(mod.title)}" title="${floated ? '吸回侧栏' : '弹出为独立浮窗'}" aria-label="${floated ? '吸回侧栏' : '弹出为独立浮窗'}">⧉</button>
  `;
}

function renderModuleBodyHtml(modId, ctx) {
  switch (modId) {
    case 'files':
      return `<div class="left-files-list">${renderFilesSection(ctx.items, ctx.selectedSet, ctx.activePath)}</div>`;
    case 'workspaces':
      return `<div class="left-workspaces-list">${renderWorkspacesSection(ctx.workspaces)}</div>`;
    case 'apps':
      return `<div class="left-apps-list">${renderAppsSection(ctx.apps)}</div>`;
    case 'tree':
      return `<div class="left-tree-quick">${renderKnowledgeTreeSection(ctx.treeNodes, ctx.activePath)}</div>`;
    case 'quick_scratch':
      return renderQuickScratchSection();
    case 'recent_files':
      return renderRecentFilesSection(ctx.recentFiles, ctx.activePath);
    case 'pomodoro_mini':
      return renderPomodoroMiniSection();
    default:
      return '';
  }
}

const SORT_FIELD_OPTIONS = [
  { by: 'name', label: '按名称' },
  { by: 'mtime', label: '按修改时间' },
  { by: 'ext', label: '按文件类型' },
  { by: 'size', label: '按文件大小' },
];

function renderSortPopoverContentHtml(sortCfg = getLeftFileSort()) {
  const by = sortCfg?.by || 'name';
  const dir = sortCfg?.dir === 'desc' ? 'desc' : 'asc';
  const customEnabled = isCustomSortEnabled();
  const customOrderCount = getCustomFileOrderList().length;
  return `
    <div class="left-sort-group">
      ${SORT_FIELD_OPTIONS.map(
        (opt) => `
          <button
            type="button"
            class="left-sort-option ${by === opt.by ? 'is-active' : ''}"
            data-action="sort-by-opt"
            data-sort-by="${opt.by}"
            role="menuitemradio"
            aria-checked="${by === opt.by ? 'true' : 'false'}"
          >
            <span>${opt.label}</span>
            ${by === opt.by ? icon('check', 12) : ''}
          </button>
        `
      ).join('')}
    </div>
    <div class="left-sort-divider" role="separator"></div>
    <div class="left-sort-dir-row">
      <button
        type="button"
        class="left-sort-dir-btn ${dir === 'asc' ? 'is-active' : ''}"
        data-action="sort-dir-opt"
        data-sort-dir="asc"
        aria-pressed="${dir === 'asc' ? 'true' : 'false'}"
      >
        ${icon('arrow-up', 12)} 升序 (A→Z / 旧→新)
      </button>
      <button
        type="button"
        class="left-sort-dir-btn ${dir === 'desc' ? 'is-active' : ''}"
        data-action="sort-dir-opt"
        data-sort-dir="desc"
        aria-pressed="${dir === 'desc' ? 'true' : 'false'}"
      >
        ${icon('arrow-down', 12)} 降序 (Z→A / 新→旧)
      </button>
    </div>
    <div class="left-sort-divider" role="separator"></div>
    <div class="left-sort-group">
      <button
        type="button"
        class="left-sort-option ${customEnabled ? 'is-active' : ''}"
        data-action="toggle-custom-sort"
        role="menuitemcheckbox"
        aria-checked="${customEnabled ? 'true' : 'false'}"
      >
        <span>✋ 自定义拖拽排序</span>
        ${customEnabled ? icon('check', 12) : ''}
      </button>
      <button
        type="button"
        class="left-sort-option"
        data-action="tidy-custom-sort"
        ${customOrderCount === 0 ? 'disabled style="opacity:0.45;cursor:not-allowed;"' : ''}
        role="menuitem"
      >
        <span style="display:inline-flex;align-items:center;gap:5px;">${icon('list-restart', 12)} 🧹 一键整理（按默认排序归位）</span>
      </button>
    </div>
  `;
}

function renderStickyTopHtml(selectedCount) {
  const hasFilter = Boolean(leftFilterQuery);
  const sort = getLeftFileSort();
  const sortTooltip = getSortTooltip(sort);
  return `
    <div class="left-sticky-top">
      <div class="left-header-row">
        <div class="left-header-title-wrap">
          <span class="panel-title">工作区</span>
          <span class="file-ext-badge" data-role="ctx-count-badge" title="已勾选参与联合问答文件数 (${selectedCount}/${MAX_CONTEXT_FILES})">${selectedCount}/${MAX_CONTEXT_FILES}</span>
        </div>
        <div class="left-header-icons">
          <button type="button" class="left-icon-btn" data-action="new-note" title="新建笔记 (Ctrl+N)" aria-label="新建笔记 (Ctrl+N)">
            ${icon('plus', 14)}
          </button>
          <button type="button" class="left-icon-btn" data-action="new-folder" title="新建文件夹" aria-label="新建文件夹">
            ${icon('folder-plus', 14)}
          </button>
          <button type="button" class="left-icon-btn" data-action="import-open" title="导入文件 / 挂载目录" aria-label="导入文件 / 挂载目录">
            ${icon('download', 14)}
          </button>
          <button type="button" class="left-icon-btn" data-action="spawn-sticky-note" title="召唤闪念便签 (Alt+N)" aria-label="召唤闪念便签 (Alt+N)">
            ${icon('pin', 14)}
          </button>
          <button type="button" class="left-icon-btn" data-action="customize-modules" title="自定义模块" aria-label="自定义模块">
            ${icon('settings', 14)}
          </button>
          <button type="button" class="left-icon-btn" data-action="reset-layout" title="恢复默认布局" aria-label="恢复默认布局">
            ${icon('rotate-ccw', 14)}
          </button>
        </div>
      </div>
      <div class="left-filter-row">
        <div class="left-filter-wrap">
          <span class="left-filter-icon" aria-hidden="true">${icon('search', 13)}</span>
          <input
            type="text"
            class="apple-input left-filter-input"
            data-role="left-filter-input"
            value="${escapeHtml(leftFilterQuery)}"
            placeholder="筛选文件…"
            autocomplete="off"
            spellcheck="false"
          />
          <button
            type="button"
            class="left-filter-clear"
            data-action="clear-filter"
            title="清空筛选"
            aria-label="清空筛选"
            ${hasFilter ? '' : 'hidden'}
          >×</button>
        </div>
        <div class="left-sort-wrap">
          <button
            type="button"
            class="left-icon-btn left-sort-trigger"
            data-action="toggle-sort-popover"
            title="${escapeHtml(sortTooltip)}"
            aria-label="${escapeHtml(sortTooltip)}"
            aria-expanded="false"
            aria-haspopup="menu"
          >
            ${renderSortTriggerContentHtml(sort)}
          </button>
          <div class="left-sort-popover" data-role="left-sort-popover" role="menu" hidden>
            ${renderSortPopoverContentHtml(sort)}
          </div>
        </div>
        <button
          type="button"
          class="left-icon-btn"
          data-action="scroll-top"
          title="回到顶部"
          aria-label="回到顶部"
        >
          ${icon('arrow-up', 14)}
        </button>
      </div>
      <div class="left-quick-bar" style="display:flex;align-items:center;gap:5px;margin-top:6px;flex-wrap:wrap;">
        <button type="button" class="pill-btn pill-btn-sm" data-action="new-note" title="新建笔记 (Ctrl+N)" style="height:24px;padding:0 8px;font-size:11px;">+ 笔记</button>
        <button type="button" class="pill-btn pill-btn-sm" data-action="new-folder" title="新建文件夹" style="height:24px;padding:0 8px;font-size:11px;">+ 文件夹</button>
        <button type="button" class="pill-btn pill-btn-sm" data-action="back-to-notes-root" title="清除筛选并回到默认笔记主文件夹顶部" style="height:24px;padding:0 8px;font-size:11px;margin-left:auto;">⌂ 主目录顶部</button>
      </div>
    </div>
  `;
}

function buildModulesHtml() {
  const items = store.state.files?.items || [];
  const selectedSet = new Set(store.state.selectedContextPaths || []);
  const activePath = store.state.activeFile?.path || '';
  const apps = store.state.apps || [];
  const workspaces = store.state.workspaces || [];
  const treeNodes = store.state.tree?.nodes || [];
  const recentFiles = store.state.recentFiles || [];
  const leftModules = getLeftModules();
  const visibleModules = leftModules.filter((m) => m.visible !== false);

  const ctx = { items, selectedSet, activePath, apps, workspaces, treeNodes, recentFiles };

  if (visibleModules.length === 0) {
    return `
      <div class="empty-state" style="padding:28px 12px;">
        <p class="empty-title">左侧模块已全部隐藏</p>
        <p class="empty-desc">点击上方「⚙ 模块」可重新勾选显示或恢复默认布局</p>
        <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-action="customize-modules">
          ${icon('settings', 12)} 自定义左侧模块
        </button>
      </div>
    `;
  }

  return visibleModules
    .map((mod) => {
      const collapsed = Boolean(mod.collapsed);
      const customH = getModuleHeight(mod.id);
      const isAuto = !customH;
      const isEmpty = isModuleBodyEmpty(mod.id, ctx);
      const scrollStyle = customH
        ? `height:${customH}px;max-height:${customH}px;overflow-y:auto;`
        : isEmpty
          ? 'min-height:0;'
          : '';

      return `
        <section
          class="module-block ${collapsed ? 'is-collapsed' : ''}"
          data-module-id="${escapeHtml(mod.id)}"
        >
          <div class="module-header">
            <div style="display:flex;align-items:center;gap:4px;min-width:0;flex:1;">
              <span
                class="module-drag-handle"
                draggable="true"
                data-drag-module="${escapeHtml(mod.id)}"
                title="拖拽调整模块顺序"
                aria-label="拖拽调整 ${escapeHtml(mod.title)} 顺序"
              >
                ${icon('grip-vertical', 12)}
              </span>
              <button
                type="button"
                data-action="toggle-module-collapse"
                data-module-id="${escapeHtml(mod.id)}"
                aria-expanded="${!collapsed}"
                style="display:inline-flex;align-items:center;gap:4px;min-width:0;flex:1;text-align:left;font-size:12px;font-weight:600;color:var(--text-primary);"
              >
                ${icon(collapsed ? 'chevron-right' : 'chevron-down', 12)}
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(mod.title)}</span>
              </button>
            </div>
            <div class="module-header-right" style="display:inline-flex;align-items:center;gap:3px;flex-shrink:0;">
              ${getModuleQuickActionsHtml(mod.id, selectedSet.size, items.length)}
              <span class="module-hover-controls" style="display:inline-flex;align-items:center;gap:3px;">
                ${renderLeftModuleHeaderControlsHtml(mod)}
              </span>
            </div>
          </div>
          <div class="module-content">
            <div
              class="module-scroll-body${isAuto ? ' is-auto-height' : ''}${isEmpty ? ' is-empty-compact' : ''}"
              data-scroll-module="${escapeHtml(mod.id)}"
              ${scrollStyle ? `style="${scrollStyle}"` : ''}
            >
              ${renderModuleBodyHtml(mod.id, ctx)}
            </div>
            ${
              collapsed
                ? ''
                : `<div class="module-height-resizer" data-resize-module="${escapeHtml(mod.id)}" title="上下拖动调节模块高度（双击恢复自动）" role="separator" aria-orientation="horizontal"></div>`
            }
          </div>
        </section>
      `;
    })
    .join('');
}

function syncSortPopoverUi(containerEl) {
  if (!containerEl) return;
  const sort = getLeftFileSort();
  const sortTooltip = getSortTooltip(sort);
  const trigger = containerEl.querySelector('[data-action="toggle-sort-popover"]');
  if (trigger) {
    trigger.classList.remove('has-active-sort');
    trigger.innerHTML = renderSortTriggerContentHtml(sort);
    trigger.title = sortTooltip;
    trigger.setAttribute('aria-label', sortTooltip);
  }
  const popover = containerEl.querySelector('[data-role="left-sort-popover"]');
  if (popover) {
    popover.innerHTML = renderSortPopoverContentHtml(sort);
  }
}

function setSortPopoverOpen(containerEl, open) {
  if (!containerEl) return;
  const trigger = containerEl.querySelector('[data-action="toggle-sort-popover"]');
  const popover = containerEl.querySelector('[data-role="left-sort-popover"]');
  if (!popover) return;
  if (open) {
    syncSortPopoverUi(containerEl);
    popover.hidden = false;
    popover.classList.add('is-open');
    trigger?.setAttribute('aria-expanded', 'true');
  } else {
    popover.classList.remove('is-open');
    popover.hidden = true;
    trigger?.setAttribute('aria-expanded', 'false');
  }
}

function updateFilterUiState(containerEl) {
  if (!containerEl) return;
  const clearBtn = containerEl.querySelector('[data-action="clear-filter"]');
  const hasFilter = Boolean(leftFilterQuery);
  if (clearBtn) {
    clearBtn.hidden = !hasFilter;
    clearBtn.style.display = hasFilter ? 'inline-flex' : 'none';
  }
}

function updateFilesSectionOnly(containerEl) {
  if (!containerEl) return;
  const filesListEl = containerEl.querySelector('.left-files-list');
  if (!filesListEl) {
    renderPanelBody(containerEl);
    return;
  }

  const items = store.state.files?.items || [];
  const selectedSet = new Set(store.state.selectedContextPaths || []);
  const activePath = store.state.activeFile?.path || '';
  filesListEl.innerHTML = renderFilesSection(items, selectedSet, activePath);

  // If searching while files module is collapsed, temporarily reveal its content
  const filesBlock = containerEl.querySelector('.module-block[data-module-id="files"]');
  if (filesBlock && leftFilterQuery.trim() && filesBlock.classList.contains('is-collapsed')) {
    filesBlock.classList.remove('is-collapsed');
  }

  const countLabel = containerEl.querySelector('[data-role="files-count-label"]');
  if (countLabel) {
    const filteredCount = leftFilterQuery.trim()
      ? filterFileItems(items, leftFilterQuery).length
      : items.length;
    countLabel.textContent = leftFilterQuery.trim() ? `${filteredCount}/${items.length}` : `${items.length}`;
  }

  syncSortPopoverUi(containerEl);
}

function renderPanelBody(containerEl) {
  if (!containerEl) return;
  const bodyEl = containerEl.querySelector('.panel-body');
  if (!bodyEl) {
    renderLeftPanel(containerEl);
    return;
  }
  const prevScrollTop = bodyEl.scrollTop || 0;
  bodyEl.innerHTML = buildModulesHtml();
  if (prevScrollTop > 0) {
    bodyEl.scrollTop = prevScrollTop;
  }
  syncContextCheckboxes(containerEl);
  updateFilterUiState(containerEl);
}

function renderLeftPanel(containerEl) {
  if (!containerEl) return;

  // Preserve mounted .left-sticky-top so .left-filter-input never loses focus on data updates
  const existingSticky = containerEl.querySelector('.left-sticky-top');
  const existingBody = containerEl.querySelector('.panel-body');
  if (existingSticky && existingBody) {
    renderPanelBody(containerEl);
    return;
  }

  const selectedCount = (store.state.selectedContextPaths || []).length;
  containerEl.innerHTML = `
    ${renderStickyTopHtml(selectedCount)}
    <div class="panel-body">
      ${buildModulesHtml()}
    </div>
  `;
  updateFilterUiState(containerEl);
}

function openCustomizeModulesSheet() {
  openSheet({
    title: '自定义左侧模块',
    bodyHtml: `
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div id="left-pane-width-box"></div>
        <div id="left-modules-manager" style="display:flex;flex-direction:column;gap:8px;"></div>
      </div>
    `,
    footerHtml: `
      <button type="button" class="pill-btn pill-btn-ghost" id="left-modules-reset">恢复默认尺寸与布局</button>
      <button type="button" class="pill-btn pill-btn-primary" id="left-modules-done">完成</button>
    `,
    onMount(card) {
      const widthBoxEl = card.querySelector('#left-pane-width-box');
      const listEl = card.querySelector('#left-modules-manager');

      const renderWidthControls = () => {
        if (!widthBoxEl) return;
        const curLeftW = Math.round(Number(store.state.paneWidths?.left) || 260);
        widthBoxEl.innerHTML = `
          <div class="glass-card" style="padding:10px 12px;display:flex;flex-direction:column;gap:8px;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
              <span style="font-size:12.5px;font-weight:600;color:var(--text-primary);">左侧栏整体宽度 (200~480px)</span>
              <span id="left-pane-width-val" style="font-size:12px;font-weight:600;color:var(--accent);">${curLeftW}px</span>
            </div>
            <input type="range" id="left-pane-width-range" min="200" max="480" step="2" value="${curLeftW}" style="width:100%;" />
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
              <button type="button" class="pill-btn pill-btn-sm ${Math.abs(curLeftW - 230) <= 10 ? 'pill-btn-primary' : ''}" data-left-w="230">窄 230</button>
              <button type="button" class="pill-btn pill-btn-sm ${Math.abs(curLeftW - 270) <= 15 ? 'pill-btn-primary' : ''}" data-left-w="270">标准 270</button>
              <button type="button" class="pill-btn pill-btn-sm ${Math.abs(curLeftW - 360) <= 20 ? 'pill-btn-primary' : ''}" data-left-w="360">宽 360</button>
            </div>
          </div>
        `;
      };

      const renderManagerRows = () => {
        if (!listEl) return;
        const modules = getLeftModules();
        listEl.innerHTML = modules
          .map((mod, idx) => {
            const desc = MODULE_DESCRIPTIONS[mod.id] || '';
            const isFirst = idx === 0;
            const isLast = idx === modules.length - 1;
            const curPreset = getModuleSizePreset('left', mod.id);
            const floated = isModuleFloating(mod.id);
            return `
              <div
                class="glass-card"
                data-mod-row="${escapeHtml(mod.id)}"
                style="display:flex;flex-direction:column;gap:8px;padding:10px 12px;"
              >
                <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
                  <label style="display:flex;align-items:flex-start;gap:10px;flex:1;min-width:0;cursor:pointer;">
                    <input
                      type="checkbox"
                      class="file-check"
                      data-mod-toggle="${escapeHtml(mod.id)}"
                      ${mod.visible !== false ? 'checked' : ''}
                      style="margin-top:2px;"
                    />
                    <div style="min-width:0;">
                      <div style="font-size:13px;font-weight:600;color:var(--text-primary);">${escapeHtml(mod.title)}</div>
                      ${desc ? `<div style="font-size:11.5px;color:var(--text-secondary);margin-top:2px;">${escapeHtml(desc)}</div>` : ''}
                    </div>
                  </label>
                  <div style="display:inline-flex;align-items:center;gap:4px;flex-shrink:0;">
                    <button
                      type="button"
                      class="pill-btn pill-btn-sm"
                      data-mod-move="up"
                      data-mod-id="${escapeHtml(mod.id)}"
                      ${isFirst ? 'disabled' : ''}
                      title="上移"
                      style="height:26px;padding:0 8px;font-size:12px;"
                    >↑</button>
                    <button
                      type="button"
                      class="pill-btn pill-btn-sm"
                      data-mod-move="down"
                      data-mod-id="${escapeHtml(mod.id)}"
                      ${isLast ? 'disabled' : ''}
                      title="下移"
                      style="height:26px;padding:0 8px;font-size:12px;"
                    >↓</button>
                  </div>
                </div>
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding-left:24px;flex-wrap:wrap;">
                  <div style="display:inline-flex;align-items:center;gap:4px;">
                    <span style="font-size:11px;color:var(--text-tertiary);margin-right:2px;">高度：</span>
                    ${[
                      { key: 's', label: 'S' },
                      { key: 'm', label: 'M' },
                      { key: 'l', label: 'L' },
                      { key: 'auto', label: 'Auto' },
                    ]
                      .map(
                        (p) => `<button type="button" class="pill-btn pill-btn-sm ${curPreset === p.key ? 'pill-btn-primary' : ''}" data-mod-size="${p.key}" data-mod-id="${escapeHtml(mod.id)}" style="height:22px;padding:0 8px;font-size:11px;">${p.label}</button>`
                      )
                      .join('')}
                  </div>
                  <button
                    type="button"
                    class="pill-btn pill-btn-sm ${floated ? 'pill-btn-primary' : ''}"
                    data-mod-float="${escapeHtml(mod.id)}"
                    data-mod-title="${escapeHtml(mod.title)}"
                    style="height:22px;padding:0 9px;font-size:11px;"
                  >
                    ⧉ ${floated ? '已浮窗（点此吸回）' : '弹出浮窗'}
                  </button>
                </div>
              </div>
            `;
          })
          .join('');
      };

      renderWidthControls();
      renderManagerRows();

      widthBoxEl?.addEventListener('input', (e) => {
        const range = e.target.closest('#left-pane-width-range');
        if (!range) return;
        const nextW = Number(range.value) || 260;
        applyPaneWidths?.(nextW, store.state.paneWidths?.right ?? 360);
        const valEl = widthBoxEl.querySelector('#left-pane-width-val');
        if (valEl) valEl.textContent = `${nextW}px`;
      });

      widthBoxEl?.addEventListener('change', (e) => {
        if (e.target.closest('#left-pane-width-range')) {
          renderWidthControls();
        }
      });

      widthBoxEl?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-left-w]');
        if (!btn) return;
        const w = Number(btn.dataset.leftW) || 270;
        applyPaneWidths?.(w, store.state.paneWidths?.right ?? 360);
        renderWidthControls();
      });

      listEl?.addEventListener('change', (e) => {
        const cb = e.target.closest('[data-mod-toggle]');
        if (!cb) return;
        const modId = cb.dataset.modToggle;
        const nextModules = getLeftModules().map((m) =>
          m.id === modId ? { ...m, visible: Boolean(cb.checked) } : { ...m }
        );
        updateUiLayout({ leftModules: nextModules });
      });

      listEl?.addEventListener('click', (e) => {
        const sizeBtn = e.target.closest('[data-mod-size]');
        if (sizeBtn) {
          const modId = sizeBtn.dataset.modId;
          const preset = sizeBtn.dataset.modSize;
          if (modId && preset) {
            setModuleSizePreset?.('left', modId, preset);
            renderManagerRows();
          }
          return;
        }

        const floatBtn = e.target.closest('[data-mod-float]');
        if (floatBtn) {
          const modId = floatBtn.dataset.modFloat;
          const modTitle = floatBtn.dataset.modTitle || modId;
          if (modId) {
            toggleModuleFloat?.(modId, { title: modTitle, panel: 'left' });
            renderManagerRows();
          }
          return;
        }

        const btn = e.target.closest('[data-mod-move]');
        if (!btn) return;
        const modId = btn.dataset.modId;
        const dir = btn.dataset.modMove;
        const nextModules = getLeftModules().map((m) => ({ ...m }));
        const idx = nextModules.findIndex((m) => m.id === modId);
        if (idx < 0) return;
        const targetIdx = dir === 'up' ? idx - 1 : idx + 1;
        if (targetIdx < 0 || targetIdx >= nextModules.length) return;
        const [moved] = nextModules.splice(idx, 1);
        nextModules.splice(targetIdx, 0, moved);
        updateUiLayout({ leftModules: nextModules });
        renderManagerRows();
      });

      card.querySelector('#left-modules-reset')?.addEventListener('click', () => {
        resetAllLayout();
        renderWidthControls();
        renderManagerRows();
      });

      card.querySelector('#left-modules-done')?.addEventListener('click', closeSheet);
    },
  });
}

function openCreateNoteSheet() {
  const nodes = store.state.tree?.nodes || [];
  const nodeOptions = nodes
    .map((n) => `<option value="${escapeHtml(n.id)}">${escapeHtml(n.name)}</option>`)
    .join('');
  const existingNotes = (store.state.files?.items || []).map((f) => f.name || getBasename(f.path));
  const defaultTitle = nextSequentialName('新建笔记', existingNotes);

  openSheet({
    title: '新建本地笔记',
    bodyHtml: `
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div>
          <label for="new-note-title" style="display:block;font-size:12.5px;font-weight:600;margin-bottom:6px;color:var(--text-secondary);">笔记标题</label>
          <input id="new-note-title" type="text" class="apple-input" placeholder="留空直接创建：${escapeHtml(defaultTitle)}" />
        </div>
        <div>
          <label for="new-note-node" style="display:block;font-size:12.5px;font-weight:600;margin-bottom:6px;color:var(--text-secondary);">关联知识树节点（可选）</label>
          <select id="new-note-node" class="apple-select">
            <option value="">不绑定知识树节点</option>
            ${nodeOptions}
          </select>
        </div>
        <div>
          <label for="new-note-content" style="display:block;font-size:12.5px;font-weight:600;margin-bottom:6px;color:var(--text-secondary);">初始正文（可选，支持 Markdown 与 [[锚点]]）</label>
          <textarea id="new-note-content" class="apple-textarea" rows="5" placeholder="# 笔记标题&#10;&#10;- 待办事项或参考 [[讲义.pdf#page=1]]"></textarea>
        </div>
      </div>
    `,
    footerHtml: `
      <button type="button" class="pill-btn pill-btn-ghost" id="note-sheet-cancel">取消</button>
      <button type="button" class="pill-btn pill-btn-primary" id="note-sheet-submit">${icon('check', 14)} 创建并打开</button>
    `,
    onMount(card) {
      const titleInput = card.querySelector('#new-note-title');
      const nodeSelect = card.querySelector('#new-note-node');
      const contentInput = card.querySelector('#new-note-content');
      const submitBtn = card.querySelector('#note-sheet-submit');

      titleInput?.focus();
      card.querySelector('#note-sheet-cancel')?.addEventListener('click', closeSheet);

      const doSubmit = async () => {
        const title = titleInput?.value?.trim() || defaultTitle;
        const content = contentInput?.value ?? '';
        const nodeId = nodeSelect?.value?.trim() || null;

        if (submitBtn) submitBtn.disabled = true;
        try {
          const created = await api.post('/api/files/create-note', {
            title,
            content,
            node_id: nodeId,
          });
          await loadFiles();
          emitWithGuard('files', store.state.files);
          if (nodeId) {
            await loadTree();
            emitWithGuard('tree', store.state.tree);
          }
          renderLeftPanel(containerRef);

          const fileItem = findFileItemByPath(created?.path) || {
            path: created?.path,
            name: created?.name || `${title}.md`,
            ext: created?.ext || '.md',
            is_private: false,
            source: 'notes',
          };
          store.state.activeFile = fileItem;
          syncActiveFileHighlight(containerRef, fileItem.path);
          store.emit('file:open', fileItem);

          closeSheet();
          showToast(`已创建笔记：${fileItem.name}`, 'success');
        } catch (err) {
          showToast(`创建笔记失败：${err.message}`, 'error');
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      };

      submitBtn?.addEventListener('click', doSubmit);
      titleInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          doSubmit();
        }
      });
    },
  });
}

function openImportSheet() {
  openSheet({
    title: '导入本地文件或挂载目录',
    bodyHtml: `
      <div style="display:flex;flex-direction:column;gap:14px;">
        <div class="glass-card">
          <div style="font-size:12.5px;font-weight:600;margin-bottom:8px;color:var(--text-primary);">方式一：桌面原生选择器（仅登记本地路径，不复制原文件）</div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;">
            <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" id="pick-file-btn">
              ${icon('file-text', 13)} 选择本地文件
            </button>
            <button type="button" class="pill-btn pill-btn-sm" id="pick-folder-btn">
              ${icon('folder-open', 13)} 选择本地目录
            </button>
          </div>
          <p id="pick-path-hint" style="margin:8px 0 0;font-size:12px;color:var(--text-secondary);line-height:1.5;">支持所有常见本地文件：Markdown / TXT / 代码 / Excel / PDF / ZIP·TAR 压缩包（免解压预览）/ 图片 / 音视频 / Word·PPT 速览，任何本地文件均可原位登记直达，零复制、不搬家。</p>
        </div>

        <div class="glass-card">
          <div style="font-size:12.5px;font-weight:600;margin-bottom:8px;color:var(--text-primary);">方式二：手动输入本地绝对路径</div>
          <input id="manual-import-path" type="text" class="apple-input" placeholder="例如：D:\\Study\\高数讲义.pdf 或 /home/user/notes" />
          <label style="display:inline-flex;align-items:center;gap:8px;margin-top:10px;font-size:12.5px;color:var(--text-secondary);cursor:pointer;">
            <input id="manual-import-isdir" type="checkbox" class="file-check" />
            <span>作为目录挂载（自动扫描目录下所有支持格式）</span>
          </label>
        </div>

        <div class="glass-card" style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;flex-wrap:wrap;">
          <span style="font-size:12px;color:var(--text-secondary);">想快速体验全格式预览与跨模态跳转？</span>
          <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" id="import-seed-test-btn">
            🧪 一键加载 V6 全格式实测流程包
          </button>
        </div>
      </div>
    `,
    footerHtml: `
      <button type="button" class="pill-btn pill-btn-ghost" id="import-cancel-btn">取消</button>
      <button type="button" class="pill-btn pill-btn-primary" id="import-manual-submit">${icon('check', 14)} 确认导入</button>
    `,
    onMount(card) {
      const hintEl = card.querySelector('#pick-path-hint');
      const pickFileBtn = card.querySelector('#pick-file-btn');
      const pickFolderBtn = card.querySelector('#pick-folder-btn');
      const pathInput = card.querySelector('#manual-import-path');
      const isDirCheckbox = card.querySelector('#manual-import-isdir');
      const manualSubmitBtn = card.querySelector('#import-manual-submit');

      card.querySelector('#import-cancel-btn')?.addEventListener('click', closeSheet);

      const submitImportPaths = async (paths, isDir) => {
        const res = await api.post('/api/files/import', { paths, is_dir: Boolean(isDir) });
        await loadFiles();
        emitWithGuard('files', store.state.files);
        renderLeftPanel(containerRef);
        closeSheet();
        const count = (res?.added_files?.length || 0) + (res?.added_dirs?.length || 0);
        showToast(count > 0 ? `已成功导入 ${count} 项本地路径` : '路径已更新至工作区', 'success');
      };

      const handlePick = async (mode) => {
        if (pickFileBtn) pickFileBtn.disabled = true;
        if (pickFolderBtn) pickFolderBtn.disabled = true;
        if (hintEl) hintEl.textContent = '正在调起系统文件选择器…';

        try {
          const picked = await api.post('/api/system/pick-path', { mode });
          const chosenPaths = Array.isArray(picked?.paths) && picked.paths.length
            ? picked.paths
            : picked?.path
              ? [picked.path]
              : [];

          if (!picked?.cancelled && chosenPaths.length > 0) {
            await submitImportPaths(chosenPaths, mode === 'folder');
            return;
          }

          const msg =
            picked?.message ||
            (picked?.headless
              ? '当前为无桌面环境，请使用下方手动路径导入'
              : '已取消选择，可重试或使用下方手动路径导入');
          if (hintEl) {
            hintEl.textContent = msg;
            hintEl.style.color = 'var(--warning)';
          }
          showToast(msg, 'info');
        } catch (err) {
          if (hintEl) {
            hintEl.textContent = `选择器调用失败：${err.message}`;
            hintEl.style.color = 'var(--danger)';
          }
          showToast(`选择路径失败：${err.message}`, 'error');
        } finally {
          if (pickFileBtn) pickFileBtn.disabled = false;
          if (pickFolderBtn) pickFolderBtn.disabled = false;
        }
      };

      pickFileBtn?.addEventListener('click', () => handlePick('file'));
      pickFolderBtn?.addEventListener('click', () => handlePick('folder'));

      const doManualSubmit = async () => {
        const rawPath = pathInput?.value?.trim();
        if (!rawPath) {
          showToast('请输入有效的本地文件或目录路径', 'warning');
          pathInput?.focus();
          return;
        }
        if (manualSubmitBtn) manualSubmitBtn.disabled = true;
        try {
          await submitImportPaths([rawPath], Boolean(isDirCheckbox?.checked));
        } catch (err) {
          showToast(`导入失败：${err.message}`, 'error');
        } finally {
          if (manualSubmitBtn) manualSubmitBtn.disabled = false;
        }
      };

      manualSubmitBtn?.addEventListener('click', doManualSubmit);
      pathInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          doManualSubmit();
        }
      });

      const seedBtn = card.querySelector('#import-seed-test-btn');
      seedBtn?.addEventListener('click', async () => {
        seedBtn.disabled = true;
        try {
          const res = await api.seedTestSuite({ reset: true });
          await loadFiles();
          emitWithGuard('files', store.state.files);
          renderLeftPanel(containerRef);
          closeSheet();
          const checklist =
            (store.state.files?.items || []).find(
              (f) => f.name === '00_V5全流程实测清单.md' || String(f.path || '').endsWith('00_V5全流程实测清单.md')
            ) ||
            (res?.checklist_path
              ? { path: res.checklist_path, name: '00_V5全流程实测清单.md', ext: '.md' }
              : null);
          if (checklist?.path) {
            handleOpenFilePath(checklist.path);
          }
          showToast('已加载 V6 全格式实测流程包', 'success');
        } catch (err) {
          showToast(`加载实测流程包失败：${err?.message || '未知错误'}`, 'error');
        } finally {
          seedBtn.disabled = false;
        }
      });
    },
  });
}

function openRenameFileSheet(item) {
  if (!item?.path) return;
  const oldName = item.name || getBasename(item.path);

  openSheet({
    title: '重命名文件',
    bodyHtml: `
      <div style="display:flex;flex-direction:column;gap:10px;">
        <div style="font-size:12px;color:var(--text-tertiary);word-break:break-all;">原路径：${escapeHtml(item.path)}</div>
        <label for="rename-file-input" style="font-size:12.5px;font-weight:600;color:var(--text-secondary);">新文件名（含扩展名）</label>
        <input id="rename-file-input" type="text" class="apple-input" value="${escapeHtml(oldName)}" autocomplete="off" />
      </div>
    `,
    footerHtml: `
      <button type="button" class="pill-btn pill-btn-ghost" id="rename-cancel-btn">取消</button>
      <button type="button" class="pill-btn pill-btn-primary" id="rename-submit-btn">${icon('check', 14)} 确认重命名</button>
    `,
    onMount(card) {
      const input = card.querySelector('#rename-file-input');
      const submitBtn = card.querySelector('#rename-submit-btn');
      card.querySelector('#rename-cancel-btn')?.addEventListener('click', closeSheet);

      window.requestAnimationFrame(() => {
        if (!input) return;
        input.focus();
        const dotIdx = oldName.lastIndexOf('.');
        if (dotIdx > 0) {
          input.setSelectionRange(0, dotIdx);
        } else {
          input.select();
        }
      });

      const doRename = async () => {
        const newName = input?.value?.trim();
        if (!newName) {
          showToast('请输入新文件名', 'warning');
          input?.focus();
          return;
        }
        if (newName === oldName) {
          closeSheet();
          return;
        }

        if (submitBtn) submitBtn.disabled = true;
        try {
          const res = await api.post('/api/files/rename', {
            path: item.path,
            new_name: newName,
          });
          const nextPath = res?.path || item.path;
          const nextName = res?.name || newName;
          const nextExt = res?.ext || item.ext;

          if (Array.isArray(store.state.selectedContextPaths)) {
            const idx = store.state.selectedContextPaths.indexOf(item.path);
            if (idx >= 0) {
              const nextCtx = [...store.state.selectedContextPaths];
              nextCtx[idx] = nextPath;
              store.state.selectedContextPaths = nextCtx;
              store.emit('context:changed', nextCtx);
            }
          }

          const wasActive = store.state.activeFile?.path === item.path;
          await loadFiles();
          emitWithGuard('files', store.state.files);
          renderLeftPanel(containerRef);

          if (wasActive) {
            const updatedItem = findFileItemByPath(nextPath) || {
              ...store.state.activeFile,
              path: nextPath,
              name: nextName,
              ext: nextExt,
            };
            store.state.activeFile = updatedItem;
            syncActiveFileHighlight(containerRef, updatedItem.path);
            store.emit('file:open', updatedItem);
          }

          closeSheet();
          showToast(`已重命名为：${nextName}`, 'success');
        } catch (err) {
          showToast(`重命名失败：${err.message}`, 'error');
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      };

      submitBtn?.addEventListener('click', doRename);
      input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          doRename();
        }
      });
    },
  });
}

function openAddAppSheet() {
  const defaultAppName = nextSequentialName('新建软件', (store.state.apps || []).map((a) => a?.name || ''));
  openSheet({
    title: '添加本地软件直达',
    bodyHtml: `
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div class="glass-card" style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
          <div style="min-width:0;">
            <div style="font-size:12.5px;font-weight:600;">选取 .exe 或 .lnk 快捷方式</div>
            <div id="add-app-pick-hint" style="font-size:11.5px;color:var(--text-secondary);">支持自动解析 Windows .lnk 目标路径与参数</div>
          </div>
          <button type="button" class="pill-btn pill-btn-sm" id="add-app-pick-btn">
            ${icon('folder-open', 13)} 浏览程序
          </button>
        </div>

        <div>
          <label for="add-app-name" style="display:block;font-size:12.5px;font-weight:600;margin-bottom:6px;color:var(--text-secondary);">软件名称（可留空）</label>
          <input id="add-app-name" type="text" class="apple-input" placeholder="留空自动取程序文件名或 ${escapeHtml(defaultAppName)}" />
        </div>
        <div>
          <label for="add-app-aliases" style="display:block;font-size:12.5px;font-weight:600;margin-bottom:6px;color:var(--text-secondary);">别名关键词（逗号分隔，供 AI 自动匹配）</label>
          <input id="add-app-aliases" type="text" class="apple-input" placeholder="例如：WPS, 文档, 表格" />
        </div>
        <div>
          <label for="add-app-path" style="display:block;font-size:12.5px;font-weight:600;margin-bottom:6px;color:var(--text-secondary);">可执行路径</label>
          <input id="add-app-path" type="text" class="apple-input" placeholder="例如：C:\\Program Files\\...\\app.exe" />
        </div>
        <div>
          <label for="add-app-args" style="display:block;font-size:12.5px;font-weight:600;margin-bottom:6px;color:var(--text-secondary);">启动参数（可选）</label>
          <input id="add-app-args" type="text" class="apple-input" placeholder="例如：--new-window" />
        </div>
      </div>
    `,
    footerHtml: `
      <button type="button" class="pill-btn pill-btn-ghost" id="add-app-cancel">取消</button>
      <button type="button" class="pill-btn pill-btn-primary" id="add-app-save">${icon('check', 14)} 保存软件</button>
    `,
    onMount(card) {
      const pickBtn = card.querySelector('#add-app-pick-btn');
      const hintEl = card.querySelector('#add-app-pick-hint');
      const nameInput = card.querySelector('#add-app-name');
      const aliasesInput = card.querySelector('#add-app-aliases');
      const pathInput = card.querySelector('#add-app-path');
      const argsInput = card.querySelector('#add-app-args');
      const saveBtn = card.querySelector('#add-app-save');

      card.querySelector('#add-app-cancel')?.addEventListener('click', closeSheet);

      pickBtn?.addEventListener('click', async () => {
        pickBtn.disabled = true;
        try {
          const picked = await api.post('/api/system/pick-path', { mode: 'app' });
          if (!picked?.cancelled && picked?.path) {
            if (pathInput) pathInput.value = picked.path;
            if (nameInput && !nameInput.value.trim()) {
              const base = getBasename(picked.path).replace(/\.(exe|lnk)$/i, '');
              nameInput.value = base;
            }
            if (hintEl) {
              hintEl.textContent = '已自动填充可执行路径';
              hintEl.style.color = 'var(--success)';
            }
          } else {
            const msg = picked?.message || '已取消选择，可手动填写路径';
            if (hintEl) {
              hintEl.textContent = msg;
              hintEl.style.color = 'var(--warning)';
            }
          }
        } catch (err) {
          showToast(`选择程序失败：${err.message}`, 'error');
        } finally {
          pickBtn.disabled = false;
        }
      });

      saveBtn?.addEventListener('click', async () => {
        const path = pathInput?.value?.trim();
        const derivedName = path ? getBasename(path).replace(/\.(exe|lnk|bat|cmd)$/i, '').trim() : '';
        const name = nameInput?.value?.trim() || derivedName || defaultAppName;
        const aliasesRaw = aliasesInput?.value || '';
        const args = argsInput?.value?.trim() || '';

        if (!path) {
          showToast('请输入或选择软件可执行路径', 'warning');
          pathInput?.focus();
          return;
        }

        const aliases = aliasesRaw
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean);

        saveBtn.disabled = true;
        try {
          await api.post('/api/apps', { name, aliases, path, args });
          await loadApps();
          emitWithGuard('apps', store.state.apps);
          renderLeftPanel(containerRef);
          closeSheet();
          showToast(`已添加本地软件：${name}`, 'success');
        } catch (err) {
          showToast(`添加软件失败：${err.message}`, 'error');
        } finally {
          saveBtn.disabled = false;
        }
      });
    },
  });
}

/**
 * Innovation 1: Capture current desktop running windows and save as a Workspace.
 */
function openCaptureSceneSheet() {
  const files = store.state.files?.items || [];
  const registeredApps = store.state.apps || [];
  const activePath = store.state.activeFile?.path || '';
  const defaultWsName = nextSequentialName('新建场景', (store.state.workspaces || []).map((w) => w?.name || ''));

  const filesCheckHtml =
    files.length === 0
      ? `<p class="empty-desc" style="margin:0;">暂无已导入本地文档</p>`
      : files
          .map((item) => {
            const checked = Boolean(activePath) && item.path === activePath;
            return `
              <label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:var(--radius-control);background:var(--bg-island);border:1px solid var(--border-hairline);cursor:pointer;">
                <input type="checkbox" class="file-check capture-file-check" value="${escapeHtml(item.path)}" ${checked ? 'checked' : ''} />
                <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;" title="${escapeHtml(item.path)}">${escapeHtml(item.name || getBasename(item.path))}</span>
                <span class="file-ext-badge">${escapeHtml(getFileExt(item))}</span>
              </label>
            `;
          })
          .join('');

  const registeredAppsHtml =
    registeredApps.length === 0
      ? ''
      : `
        <div style="margin-top:8px;">
          <div style="font-size:11.5px;color:var(--text-tertiary);margin-bottom:6px;">或从已注册软件中选择：</div>
          <div style="display:flex;flex-direction:column;gap:6px;">
            ${registeredApps
              .map(
                (app) => `
                <label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:var(--radius-control);background:var(--bg-island);border:1px solid var(--border-hairline);cursor:pointer;">
                  <input type="checkbox" class="file-check capture-registered-app" value="${escapeHtml(app.id)}" />
                  <span style="font-size:12.5px;font-weight:500;">${escapeHtml(app.name)}</span>
                  <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--text-tertiary);">${escapeHtml(app.path || '')}</span>
                </label>
              `
              )
              .join('')}
          </div>
        </div>
      `;

  openSheet({
    title: '捕获当前桌面现场',
    bodyHtml: `
      <div style="display:flex;flex-direction:column;gap:14px;">
        <div>
          <label for="capture-ws-name" style="display:block;font-size:12.5px;font-weight:600;margin-bottom:6px;color:var(--text-secondary);">一键场景包名称</label>
          <input id="capture-ws-name" type="text" class="apple-input" value="${escapeHtml(defaultWsName)}" placeholder="留空自动命名：${escapeHtml(defaultWsName)}" />
        </div>

        <div class="glass-card">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">
            <span style="font-size:12.5px;font-weight:600;">1. 勾选桌面运行中的软件</span>
            <button type="button" class="pill-btn pill-btn-sm" id="capture-rescan-btn" style="height:24px;padding:0 9px;font-size:11px;">
              ${icon('rotate-ccw', 11)} 重新扫描
            </button>
          </div>
          <div id="capture-windows-container" style="display:flex;flex-direction:column;gap:6px;">
            <p class="empty-desc" style="margin:4px 0;">正在扫描当前桌面可见窗口…</p>
          </div>
          ${registeredAppsHtml}
          <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border-hairline);">
            <div style="font-size:11.5px;color:var(--text-tertiary);margin-bottom:6px;">或行内补充一个软件路径（保存时自动注册）：</div>
            <div style="display:grid;grid-template-columns:1fr 1.5fr;gap:6px;">
              <input id="capture-inline-app-name" type="text" class="apple-input" placeholder="软件名（如 WPS）" style="padding:6px 10px;font-size:12.5px;" />
              <input id="capture-inline-app-path" type="text" class="apple-input" placeholder="可执行路径（可选）" style="padding:6px 10px;font-size:12.5px;" />
            </div>
          </div>
        </div>

        <div class="glass-card">
          <div style="font-size:12.5px;font-weight:600;margin-bottom:8px;">2. 勾选关联的本地文档</div>
          <div style="display:flex;flex-direction:column;gap:6px;max-height:180px;overflow-y:auto;">
            ${filesCheckHtml}
          </div>
        </div>
      </div>
    `,
    footerHtml: `
      <button type="button" class="pill-btn pill-btn-ghost" id="capture-cancel-btn">取消</button>
      <button type="button" class="pill-btn pill-btn-primary" id="capture-save-btn">${icon('camera', 14)} 保存为一键场景包</button>
    `,
    onMount(card) {
      const wsNameInput = card.querySelector('#capture-ws-name');
      const windowsContainer = card.querySelector('#capture-windows-container');
      const rescanBtn = card.querySelector('#capture-rescan-btn');
      const saveBtn = card.querySelector('#capture-save-btn');
      let capturedWindows = [];

      card.querySelector('#capture-cancel-btn')?.addEventListener('click', closeSheet);

      const scanRunningWindows = async () => {
        if (windowsContainer) {
          windowsContainer.innerHTML = `<p class="empty-desc" style="margin:4px 0;">正在扫描当前桌面可见窗口…</p>`;
        }
        try {
          const res = await api.get('/api/apps/running-windows');
          capturedWindows = Array.isArray(res?.windows) ? res.windows : [];
          if (!windowsContainer) return;

          if (capturedWindows.length === 0) {
            const hint =
              res?.message ||
              '未检测到可捕获的可见桌面窗口，可勾选下方已注册软件或手动补充软件路径。';
            windowsContainer.innerHTML = `
              <div style="padding:8px 10px;border-radius:var(--radius-control);background:var(--warning-soft);color:var(--warning);font-size:12px;">
                ${escapeHtml(hint)}
              </div>
            `;
            return;
          }

          windowsContainer.innerHTML = capturedWindows
            .map(
              (win, idx) => `
              <label style="display:flex;align-items:flex-start;gap:8px;padding:7px 9px;border-radius:var(--radius-control);background:var(--bg-island);border:1px solid var(--border-hairline);cursor:pointer;">
                <input type="checkbox" class="file-check capture-win-check" data-win-idx="${idx}" checked style="margin-top:2px;" />
                <div style="flex:1;min-width:0;">
                  <div style="font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                    ${escapeHtml(win.title || win.process_name)}
                  </div>
                  <div style="font-size:11px;color:var(--text-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(win.path)}">
                    ${escapeHtml(win.process_name)} · ${escapeHtml(win.path)}
                  </div>
                </div>
              </label>
            `
            )
            .join('');
        } catch (err) {
          if (windowsContainer) {
            windowsContainer.innerHTML = `
              <div style="padding:8px 10px;border-radius:var(--radius-control);background:var(--danger-soft);color:var(--danger);font-size:12px;">
                扫描桌面窗口失败：${escapeHtml(err.message)}
              </div>
            `;
          }
        }
      };

      rescanBtn?.addEventListener('click', scanRunningWindows);
      scanRunningWindows();
      wsNameInput?.focus();
      wsNameInput?.select();

      saveBtn?.addEventListener('click', async () => {
        const name = wsNameInput?.value?.trim() || defaultWsName;

        const appIds = Array.from(card.querySelectorAll('.capture-registered-app:checked'))
          .map((cb) => cb.value)
          .filter(Boolean);

        const capturedApps = Array.from(card.querySelectorAll('.capture-win-check:checked'))
          .map((cb) => capturedWindows[Number(cb.dataset.winIdx)])
          .filter(Boolean)
          .map((win) => ({
            process_name: win.process_name,
            title: win.title,
            name: win.process_name || win.title,
            path: win.path,
          }));

        const inlineName = card.querySelector('#capture-inline-app-name')?.value?.trim();
        const inlinePath = card.querySelector('#capture-inline-app-path')?.value?.trim();
        if (inlinePath) {
          capturedApps.push({
            name: inlineName || getBasename(inlinePath).replace(/\.(exe|lnk)$/i, ''),
            path: inlinePath,
          });
        }

        const filePaths = Array.from(card.querySelectorAll('.capture-file-check:checked'))
          .map((cb) => cb.value)
          .filter(Boolean);

        saveBtn.disabled = true;
        try {
          await api.post('/api/workspaces', {
            name,
            app_ids: appIds,
            file_paths: filePaths,
            captured_apps: capturedApps,
          });
          await Promise.allSettled([loadApps(), loadWorkspaces()]);
          emitWithGuard('apps', store.state.apps);
          emitWithGuard('workspaces', store.state.workspaces);
          renderLeftPanel(containerRef);
          closeSheet();
          showToast(`已保存一键场景包「${name}」`, 'success');
        } catch (err) {
          showToast(`保存场景包失败：${err.message}`, 'error');
        } finally {
          saveBtn.disabled = false;
        }
      });
    },
  });
}

async function handleTogglePrivacy(path) {
  const item = findFileItemByPath(path);
  const nextPrivate = !item?.is_private;
  try {
    await api.post('/api/files/privacy', { path, private: nextPrivate });
    await loadFiles();
    emitWithGuard('files', store.state.files);
    renderLeftPanel(containerRef);
    showToast(
      nextPrivate ? '已开启隐私锁（AI 将硬拦截此文件）' : '已解除隐私锁',
      nextPrivate ? 'warning' : 'info'
    );
  } catch (err) {
    showToast(`隐私锁切换失败：${err.message}`, 'error');
  }
}

async function handleLaunchApp(appId, fallbackName) {
  try {
    const res = await api.post('/api/apps/launch', { app_id: appId });
    const launched = res?.launched || [];
    const failed = res?.failed || [];
    if (launched.length > 0 && failed.length === 0) {
      showToast(`已启动：${launched.map((a) => a.name).join('、')}`, 'success');
    } else if (failed.length > 0) {
      const first = failed[0];
      showToast(`启动失败（${first.name || fallbackName}）：${first.reason || '未知错误'}`, 'warning');
    } else {
      showToast(`已触发启动：${fallbackName || appId}`, 'info');
    }
  } catch (err) {
    showToast(`启动软件失败：${err.message}`, 'error');
  }
}

function handleOpenFilePath(filePath) {
  if (!filePath) return;
  const item = findFileItemByPath(filePath) || {
    path: filePath,
    name: getBasename(filePath),
    ext: `.${getFileExt({ path: filePath })}`,
  };
  store.emit('file:open', item);
}

async function handleLaunchWorkspace(ws) {
  if (!ws) return;
  try {
    const res = await api.post('/api/apps/launch', { workspace_id: ws.id });
    const launched = res?.launched || [];
    const failed = res?.failed || [];
    const filePaths = Array.isArray(res?.file_paths) && res.file_paths.length
      ? res.file_paths
      : ws.file_paths || [];

    if (filePaths.length > 0) {
      handleOpenFilePath(filePaths[0]);
    }

    if (failed.length > 0 && launched.length === 0) {
      showToast(`工作区「${ws.name}」软件启动失败：${failed[0].reason || '未找到可执行文件'}`, 'warning');
    } else if (failed.length > 0) {
      showToast(
        `工作区「${ws.name}」已启动 ${launched.length} 个软件（${failed.length} 个未找到）`,
        'warning'
      );
    } else {
      showToast(`已联启工作区「${ws.name}」`, 'success');
    }
  } catch (err) {
    showToast(`工作区联启失败：${err.message}`, 'error');
  }
}

function handleStartWorkspaceFocus(ws, seconds) {
  if (!ws) return;
  const sec = Number(seconds) > 0 ? Number(seconds) : 1500;
  store.emit('focus:start', {
    title: ws.name,
    seconds: sec,
    workspace_id: ws.id,
    file_paths: Array.isArray(ws.file_paths) ? ws.file_paths : [],
  });
}

function handleOpenTreeTools() {
  store.emit('right:mode', 'tools');
  if (typeof window !== 'undefined' && window.innerWidth <= 767) {
    store.setState({ mobileTab: 'ai' });
    store.emit('layout:changed');
  }
}

async function handleOpenExternal(path, revealFolder) {
  if (!path) return;
  try {
    await api.post('/api/files/open-external', {
      path,
      reveal_folder: Boolean(revealFolder),
    });
    showToast(revealFolder ? '已打开所在文件夹' : '已调用系统默认程序打开', 'success');
  } catch (err) {
    showToast(`打开失败：${err.message}`, 'error');
  }
}

async function handleRemoveFileFromWorkspace(item) {
  if (!item?.path) return;
  try {
    await api.post('/api/files/remove', { path: item.path });
    if (Array.isArray(store.state.selectedContextPaths)) {
      const filtered = store.state.selectedContextPaths.filter((p) => p !== item.path);
      if (filtered.length !== store.state.selectedContextPaths.length) {
        store.state.selectedContextPaths = filtered;
        store.emit('context:changed', filtered);
      }
    }
    await loadFiles();
    emitWithGuard('files', store.state.files);
    renderLeftPanel(containerRef);
    showToast(`已从工作台列表移除：${item.name || getBasename(item.path)}（原文件保留）`, 'info');
  } catch (err) {
    showToast(`移除失败：${err.message}`, 'error');
  }
}

async function handleTrashFile(item) {
  if (!item?.path) return;
  try {
    if (Array.isArray(store.state.selectedContextPaths)) {
      const filtered = store.state.selectedContextPaths.filter((p) => p !== item.path);
      if (filtered.length !== store.state.selectedContextPaths.length) {
        store.state.selectedContextPaths = filtered;
        store.emit('context:changed', filtered);
      }
    }
    if (typeof store.trashFile === 'function') {
      await store.trashFile(item.path);
    } else {
      await api.post('/api/files/trash', { path: item.path });
      await loadFiles();
      emitWithGuard('files', store.state.files);
    }
    renderPanelBody(containerRef);
  } catch (err) {
    showToast(`移入回收站失败：${err.message}`, 'error');
  }
}

function handleBackToNotesRoot(containerEl = containerRef) {
  if (!containerEl) return;
  leftFilterQuery = '';
  store.state.leftFileFilter = '';
  const filterInput = containerEl.querySelector('.left-filter-input');
  if (filterInput) {
    filterInput.value = '';
  }
  updateFilterUiState(containerEl);

  const mods = getLeftModules();
  const filesMod = mods.find((m) => m.id === 'files');
  if (filesMod && (filesMod.visible === false || filesMod.collapsed)) {
    const nextModules = mods.map((m) =>
      m.id === 'files' ? { ...m, visible: true, collapsed: false } : { ...m }
    );
    updateUiLayout({ leftModules: nextModules });
  }

  collapsedGroups.delete('source:notes');
  updateFilesSectionOnly(containerEl);

  const bodyEl = containerEl.querySelector('.panel-body');
  const filesBlock = containerEl.querySelector('.module-block[data-module-id="files"]');
  const filesScroll = filesBlock?.querySelector('.module-scroll-body');
  const targetTop = filesBlock ? Math.max(0, filesBlock.offsetTop - 6) : 0;
  bodyEl?.scrollTo({ top: targetTop, behavior: 'smooth' });
  filesScroll?.scrollTo({ top: 0, behavior: 'smooth' });

  const notesGroup = filesBlock?.querySelector('.tree-group[data-group-key="source:notes"] .tree-folder-row');
  if (notesGroup) {
    notesGroup.classList.add('is-root-highlight');
    notesGroup.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    window.setTimeout(() => {
      notesGroup.classList.remove('is-root-highlight');
    }, 1200);
  }
}

async function handleRemoveApp(appId, appName) {
  if (!appId) return;
  try {
    await api.del(`/api/apps?app_id=${encodeURIComponent(appId)}`);
    await loadApps();
    emitWithGuard('apps', store.state.apps);
    renderLeftPanel(containerRef);
    showToast(`已从软件库移除：${appName || appId}`, 'info');
  } catch (err) {
    showToast(`移除软件失败：${err.message}`, 'error');
  }
}

function hideLeftContextMenu() {
  if (!leftContextMenuEl) return;
  leftContextMenuEl.classList.remove('is-open');
  leftContextMenuEl.remove();
  leftContextMenuEl = null;
}

function ensureGlobalContextMenuDismissListeners() {
  if (globalMenuListenersBound || typeof document === 'undefined') return;
  globalMenuListenersBound = true;

  document.addEventListener('pointerdown', (e) => {
    if (leftContextMenuEl && !e.target.closest('.left-context-menu')) {
      hideLeftContextMenu();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && leftContextMenuEl) {
      hideLeftContextMenu();
    }
  });
  window.addEventListener('scroll', hideLeftContextMenu, { capture: true, passive: true });
  window.addEventListener('resize', hideLeftContextMenu, { passive: true });
  window.addEventListener('blur', hideLeftContextMenu);
}

function showLeftContextMenu(clientX, clientY, headerLabel, items, onSelect) {
  if (typeof document === 'undefined') return;
  ensureGlobalContextMenuDismissListeners();
  hideLeftContextMenu();

  // Hide global stickies menu if currently open
  const globalMenu = document.getElementById('context-menu');
  if (globalMenu && !globalMenu.classList.contains('hidden')) {
    globalMenu.classList.add('hidden');
    globalMenu.classList.remove('is-open');
    globalMenu.setAttribute('aria-hidden', 'true');
  }

  const menu = document.createElement('div');
  menu.className = 'context-menu left-context-menu';
  menu.setAttribute('role', 'menu');
  menu.style.zIndex = '96';

  menu.innerHTML = `
    ${headerLabel ? `<div class="context-menu-label">${escapeHtml(headerLabel)}</div>` : ''}
    ${items
      .map((entry) => {
        if (entry.sep) {
          return `<div class="context-menu-sep" role="separator"></div>`;
        }
        return `
          <button
            type="button"
            class="context-menu-item"
            data-lctx-id="${escapeHtml(entry.id)}"
            data-file-act="${escapeHtml(entry.id)}"
            role="menuitem"
            style="${entry.danger ? 'color:var(--danger);' : ''}"
          >
            <span class="ctx-item-left">
              <span>${escapeHtml(entry.icon)}</span>
              <span>${escapeHtml(entry.label)}</span>
            </span>
          </button>
        `;
      })
      .join('')}
  `;

  document.body.appendChild(menu);
  leftContextMenuEl = menu;

  const rect = menu.getBoundingClientRect();
  const vw = window.innerWidth || 1280;
  const vh = window.innerHeight || 800;
  const left = Math.max(8, Math.min(clientX, vw - rect.width - 8));
  const top = Math.max(8, Math.min(clientY, vh - rect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  window.requestAnimationFrame(() => {
    menu.classList.add('is-open');
  });

  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-lctx-id]');
    if (!btn) return;
    const id = btn.dataset.lctxId;
    hideLeftContextMenu();
    onSelect?.(id);
  });
}

function findTreeFileRowByPath(rootEl, filePath) {
  if (!rootEl || !filePath) return null;
  const rows = rootEl.querySelectorAll('.left-files-list .tree-file-item[data-path]');
  for (const row of rows) {
    if (row.dataset.path === filePath) return row;
  }
  return null;
}

function startInlineFileRename(path) {
  if (!path) return;
  const item = findFileItemByPath(path) || { path, name: getBasename(path), ext: '' };
  const row = findTreeFileRowByPath(containerRef, path);
  const nameSpan = row?.querySelector('.file-name');
  if (!row || !nameSpan) {
    openRenameFileSheet(item);
    return;
  }

  const existingInput = row.querySelector('.inline-rename-input');
  if (existingInput) {
    existingInput.focus();
    return;
  }

  const oldName = item.name || row.dataset.name || getBasename(path);
  const origClass = nameSpan.className;
  const origTitle = nameSpan.getAttribute('title') || '';

  row.setAttribute('draggable', 'false');

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'inline-rename-input';
  input.value = oldName;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', `重命名 ${oldName}`);

  nameSpan.replaceWith(input);

  window.requestAnimationFrame(() => {
    input.focus();
    const dotIdx = oldName.lastIndexOf('.');
    if (dotIdx > 0) {
      input.setSelectionRange(0, dotIdx);
    } else {
      input.select();
    }
  });

  let finished = false;
  const restoreSpan = (displayName = oldName) => {
    const span = document.createElement('span');
    span.className = origClass || 'file-name';
    if (origTitle) span.setAttribute('title', origTitle);
    span.textContent = displayName;
    if (input.isConnected) {
      input.replaceWith(span);
    }
    row.setAttribute('draggable', 'true');
  };

  const cancel = () => {
    if (finished) return;
    finished = true;
    restoreSpan(oldName);
  };

  const commit = async () => {
    if (finished) return;
    finished = true;
    const newName = input.value.trim();
    if (!newName || newName === oldName) {
      restoreSpan(oldName);
      return;
    }

    input.disabled = true;
    try {
      const res = await api.post('/api/files/rename', {
        path: item.path,
        new_name: newName,
      });
      const nextPath = res?.path || item.path;
      const nextName = res?.name || newName;
      const nextExt = res?.ext || item.ext;

      if (Array.isArray(store.state.selectedContextPaths)) {
        const idx = store.state.selectedContextPaths.indexOf(item.path);
        if (idx >= 0) {
          const nextCtx = [...store.state.selectedContextPaths];
          nextCtx[idx] = nextPath;
          store.state.selectedContextPaths = nextCtx;
          store.emit('context:changed', nextCtx);
        }
      }
      if (Array.isArray(store.state.pinnedFiles) && store.state.pinnedFiles.includes(item.path)) {
        store.state.pinnedFiles = store.state.pinnedFiles.map((p) => (p === item.path ? nextPath : p));
      }
      if (Array.isArray(store.state.customFileOrder) && store.state.customFileOrder.includes(item.path)) {
        store.state.customFileOrder = store.state.customFileOrder.map((p) => (p === item.path ? nextPath : p));
      }

      const wasActive = store.state.activeFile?.path === item.path;
      await loadFiles();
      emitWithGuard('files', store.state.files);
      renderLeftPanel(containerRef);

      if (wasActive) {
        const updatedItem = findFileItemByPath(nextPath) || {
          ...store.state.activeFile,
          path: nextPath,
          name: nextName,
          ext: nextExt,
        };
        store.state.activeFile = updatedItem;
        syncActiveFileHighlight(containerRef, updatedItem.path);
        store.emit('file:open', updatedItem);
      }

      showToast(`已重命名为：${nextName}`, 'success');
    } catch (err) {
      restoreSpan(oldName);
      showToast(`重命名失败：${err.message}`, 'error');
    }
  };

  ['click', 'pointerdown', 'mousedown'].forEach((evtName) => {
    input.addEventListener(evtName, (ev) => ev.stopPropagation());
  });

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });

  input.addEventListener('blur', () => {
    commit();
  });
}

function startInlineNewNote() {
  if (!containerRef) {
    openCreateNoteSheet();
    return;
  }

  const mods = getLeftModules();
  const filesMod = mods.find((m) => m.id === 'files');
  if (filesMod && (filesMod.visible === false || filesMod.collapsed)) {
    const nextModules = mods.map((m) =>
      m.id === 'files' ? { ...m, visible: true, collapsed: false } : { ...m }
    );
    updateUiLayout({ leftModules: nextModules });
  }

  const filesListEl = containerRef.querySelector('.left-files-list');
  if (!filesListEl) {
    openCreateNoteSheet();
    return;
  }

  const existingRow = filesListEl.querySelector('.inline-quick-create-row[data-create-kind="note"]');
  if (existingRow) {
    const inp = existingRow.querySelector('.inline-rename-input');
    inp?.focus();
    inp?.select();
    return;
  }
  filesListEl.querySelectorAll('.inline-quick-create-row').forEach((el) => el.remove());

  const existingNotes = (store.state.files?.items || []).map((f) => f.name || getBasename(f.path));
  const defaultTitle = nextSequentialName('新建笔记', existingNotes);

  const row = document.createElement('div');
  row.className = 'inline-quick-create-row';
  row.dataset.createKind = 'note';
  row.innerHTML = `
    ${renderFileTypeIconHtml(`${defaultTitle}.md`, 14)}
    <input type="text" class="inline-rename-input" placeholder="笔记名（留空回车：${escapeHtml(defaultTitle)}）" autocomplete="off" spellcheck="false" />
    <button type="button" class="icon-pill" data-role="inline-create-ok" title="创建" aria-label="确认创建" style="width:22px;height:22px;flex-shrink:0;">
      ${icon('check', 12)}
    </button>
    <button type="button" class="icon-pill" data-role="inline-create-cancel" title="取消" aria-label="取消" style="width:22px;height:22px;flex-shrink:0;">
      ${icon('x', 12)}
    </button>
  `;

  filesListEl.prepend(row);
  const input = row.querySelector('.inline-rename-input');
  const okBtn = row.querySelector('[data-role="inline-create-ok"]');
  const cancelBtn = row.querySelector('[data-role="inline-create-cancel"]');

  window.requestAnimationFrame(() => {
    input?.focus();
  });

  let busy = false;
  const cleanup = () => {
    row.remove();
  };

  const submit = async () => {
    if (busy) return;
    const raw = input?.value?.trim() || '';
    const title = (raw ? raw.replace(/\.md$/i, '').trim() : '') || defaultTitle;
    busy = true;
    if (input) input.disabled = true;
    if (okBtn) okBtn.disabled = true;

    try {
      const created = await api.post('/api/files/create-note', {
        title,
        content: '',
      });
      cleanup();
      await loadFiles();
      emitWithGuard('files', store.state.files);
      renderLeftPanel(containerRef);

      const fileItem = findFileItemByPath(created?.path) || {
        path: created?.path,
        name: created?.name || `${title}.md`,
        ext: created?.ext || '.md',
        is_private: false,
        source: 'notes',
      };
      store.state.activeFile = fileItem;
      syncActiveFileHighlight(containerRef, fileItem.path);
      store.emit('file:open', fileItem);
      showToast(`已创建笔记：${fileItem.name}`, 'success');
    } catch (err) {
      busy = false;
      if (input) input.disabled = false;
      if (okBtn) okBtn.disabled = false;
      showToast(`创建笔记失败：${err.message}`, 'error');
      input?.focus();
    }
  };

  okBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    submit();
  });

  cancelBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    cleanup();
  });

  input?.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cleanup();
    }
  });
}

function startInlineNewFolder() {
  const existingFolders = [
    ...(store.state.folders || []),
    ...(store.state.files?.folders || []),
  ].map((f) => (typeof f === 'string' ? f : f?.name || f?.rel_dir || f?.path || ''));
  const defaultFolderName = nextSequentialName('新建文件夹', existingFolders);

  if (!containerRef) {
    store.createFolder?.('', defaultFolderName).catch((err) => {
      showToast(`创建文件夹失败：${err?.message || '未知错误'}`, 'error');
    });
    return;
  }

  const mods = getLeftModules();
  const filesMod = mods.find((m) => m.id === 'files');
  if (filesMod && (filesMod.visible === false || filesMod.collapsed)) {
    const nextModules = mods.map((m) =>
      m.id === 'files' ? { ...m, visible: true, collapsed: false } : { ...m }
    );
    updateUiLayout({ leftModules: nextModules });
  }

  const filesListEl = containerRef.querySelector('.left-files-list');
  if (!filesListEl) {
    store.createFolder?.('', defaultFolderName).then((res) => {
      renderPanelBody(containerRef);
      showToast(`已创建文件夹：${res?.name || defaultFolderName}`, 'success');
    }).catch((err) => {
      showToast(`创建文件夹失败：${err?.message || '未知错误'}`, 'error');
    });
    return;
  }

  const existingRow = filesListEl.querySelector('.inline-quick-create-row[data-create-kind="folder"]');
  if (existingRow) {
    const inp = existingRow.querySelector('.inline-rename-input');
    inp?.focus();
    inp?.select();
    return;
  }
  filesListEl.querySelectorAll('.inline-quick-create-row').forEach((el) => el.remove());

  const row = document.createElement('div');
  row.className = 'inline-quick-create-row';
  row.dataset.createKind = 'folder';
  row.innerHTML = `
    <span style="display:inline-flex;flex-shrink:0;color:#D97706;">${icon('folder-plus', 14)}</span>
    <input type="text" class="inline-rename-input" placeholder="文件夹名（留空回车：${escapeHtml(defaultFolderName)}）" autocomplete="off" spellcheck="false" />
    <button type="button" class="icon-pill" data-role="inline-folder-ok" title="创建文件夹" aria-label="确认创建文件夹" style="width:22px;height:22px;flex-shrink:0;">
      ${icon('check', 12)}
    </button>
    <button type="button" class="icon-pill" data-role="inline-folder-cancel" title="取消" aria-label="取消" style="width:22px;height:22px;flex-shrink:0;">
      ${icon('x', 12)}
    </button>
  `;

  filesListEl.prepend(row);
  const input = row.querySelector('.inline-rename-input');
  const okBtn = row.querySelector('[data-role="inline-folder-ok"]');
  const cancelBtn = row.querySelector('[data-role="inline-folder-cancel"]');

  window.requestAnimationFrame(() => {
    input?.focus();
  });

  let busy = false;
  const cleanup = () => {
    row.remove();
  };

  const submit = async () => {
    if (busy) return;
    const raw = input?.value?.trim() || '';
    const folderName = raw || defaultFolderName;
    busy = true;
    if (input) input.disabled = true;
    if (okBtn) okBtn.disabled = true;

    try {
      const res = typeof store.createFolder === 'function'
        ? await store.createFolder('', folderName)
        : await api.post('/api/files/create-folder', { parent_dir: '', name: folderName });
      cleanup();
      await loadFiles();
      renderLeftPanel(containerRef);
      showToast(`已创建文件夹：${res?.name || folderName}`, 'success');
    } catch (err) {
      busy = false;
      if (input) input.disabled = false;
      if (okBtn) okBtn.disabled = false;
      showToast(`创建文件夹失败：${err.message}`, 'error');
      input?.focus();
    }
  };

  okBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    submit();
  });

  cancelBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    cleanup();
  });

  input?.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cleanup();
    }
  });
}

export function triggerInlineNewNote() {
  startInlineNewNote();
}

function openFileContextMenu(clientX, clientY, rowEl) {
  const path = rowEl?.dataset?.path || '';
  if (!path) return;
  const name = rowEl.dataset.name || getBasename(path);
  const ext = rowEl.dataset.ext || getFileExt({ path, name });
  const item = findFileItemByPath(path) || { path, name, ext, is_private: false };
  const isInContext = (store.state.selectedContextPaths || []).includes(path);
  const isPrivate = Boolean(item.is_private);
  const isPinned = getPinnedFilesList().includes(path);
  const trashMode = store.state.trash?.settings?.mode === 'app' ? 'app' : 'system';
  const trashLabel = trashMode === 'app' ? '移入内置回收站' : '移入系统回收站';

  const menuItems = [
    { id: 'open', icon: '📖', label: '打开文件' },
    { id: 'open-split', icon: '◫', label: '在右侧分屏打开' },
    { id: 'toggle-pin', icon: '📌', label: isPinned ? '取消置顶' : '置顶到顶部' },
    { id: 'rename', icon: '✏', label: '重命名 (F2)' },
    { id: 'copy-anchor', icon: '🔗', label: '复制直达胶囊' },
    { id: 'toggle-context', icon: '☑', label: isInContext ? '移出联合问答' : '加入联合问答' },
    { id: 'toggle-privacy', icon: '🔒', label: isPrivate ? '关闭隐私锁' : '开启隐私锁' },
    { sep: true },
    { id: 'open-external', icon: '🚀', label: '用系统默认程序打开' },
    { id: 'reveal-folder', icon: '📂', label: '打开所在文件夹' },
    { sep: true },
    { id: 'remove', icon: '➖', label: '从工作台列表移除（不删原文件）' },
    { id: 'trash-file', icon: '🗑', label: trashLabel, danger: true },
  ];

  showLeftContextMenu(clientX, clientY, item.name || name, menuItems, (actionId) => {
    switch (actionId) {
      case 'open':
        handleOpenFilePath(item.path);
        break;
      case 'open-split':
        if (typeof storeMod.openSplitDoc === 'function') {
          storeMod.openSplitDoc({ path: item.path, name: item.name || name, ext: item.ext || ext });
        } else {
          store.emit('doc:open-split', { path: item.path, name: item.name || name, ext: item.ext || ext });
        }
        break;
      case 'toggle-pin':
        if (typeof storeMod.togglePinFile === 'function') {
          storeMod.togglePinFile(item.path);
        } else {
          const cur = getPinnedFilesList();
          store.state.pinnedFiles = cur.includes(item.path)
            ? cur.filter((p) => p !== item.path)
            : [item.path, ...cur];
        }
        updateFilesSectionOnly(containerRef);
        showToast(isPinned ? '已取消置顶' : '已置顶到顶部', 'info');
        break;
      case 'rename':
        startInlineFileRename(item.path);
        break;
      case 'copy-anchor': {
        const md = buildFileAnchorMarkdown(item);
        copyInternal?.(md, `已复制直达胶囊：${md}`);
        break;
      }
      case 'toggle-context':
        toggleContextPath(item.path);
        break;
      case 'toggle-privacy':
        handleTogglePrivacy(item.path);
        break;
      case 'open-external':
        handleOpenExternal(item.path, false);
        break;
      case 'reveal-folder':
        handleOpenExternal(item.path, true);
        break;
      case 'remove':
        handleRemoveFileFromWorkspace(item);
        break;
      case 'trash-file':
        handleTrashFile(item);
        break;
      default:
        break;
    }
  });
}

function getOrCreateModuleContextMenuEl() {
  if (typeof document === 'undefined') return null;
  let el = document.getElementById('module-context-menu');
  if (!el) {
    el = document.createElement('div');
    el.id = 'module-context-menu';
    el.className = 'context-menu module-context-menu';
    el.hidden = true;
    document.body.appendChild(el);
  }
  moduleContextMenuEl = el;
  return el;
}

function hideModuleContextMenu() {
  const el = moduleContextMenuEl || (typeof document !== 'undefined' ? document.getElementById('module-context-menu') : null);
  if (!el) return;
  el.classList.remove('is-open');
  el.hidden = true;
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '';
}

function ensureModuleContextMenuDismissListeners() {
  if (moduleMenuListenersBound || typeof document === 'undefined') return;
  moduleMenuListenersBound = true;

  document.addEventListener('pointerdown', (e) => {
    const el = document.getElementById('module-context-menu');
    if (el && !el.hidden && !e.target.closest('#module-context-menu')) {
      hideModuleContextMenu();
    }
  });
  document.addEventListener('keydown', (e) => {
    const el = document.getElementById('module-context-menu');
    if (e.key === 'Escape' && el && !el.hidden) {
      hideModuleContextMenu();
    }
  });
  window.addEventListener('scroll', hideModuleContextMenu, { capture: true, passive: true });
  window.addEventListener('resize', hideModuleContextMenu, { passive: true });
  window.addEventListener('blur', hideModuleContextMenu);
}

function getNamedLayoutPresets() {
  if (Array.isArray(store.state.layoutMemory?.presets)) return store.state.layoutMemory.presets;
  if (Array.isArray(store.state.layoutPresets)) return store.state.layoutPresets;
  if (Array.isArray(store.state.uiLayout?.layoutPresets)) return store.state.uiLayout.layoutPresets;
  if (Array.isArray(store.state.uiLayout?.presets)) return store.state.uiLayout.presets;
  return [];
}

function resolveModuleGroupContext({ side = 'left', group = '', moduleId = '', heightKey = '' }) {
  const ui = store.state.uiLayout || {};
  if (side === 'right') {
    const listKey = group === 'tools' ? 'rightToolModules' : 'rightSummaryModules';
    const rawList = Array.isArray(ui[listKey]) ? ui[listKey] : [];
    const titleFallback =
      group === 'tools'
        ? {
            quick_excel: '快捷表单填表与表格操作',
            knowledge_tree: '虚拟知识树分类与总览',
            apps_workspaces: '本地软件库与一键场景包',
            ai_templates: 'AI 常用指令模板',
          }
        : {
            input: '速记与智能提炼',
            summary_card: 'AI 摘要与待办',
            reminders: '定时提醒',
            ai_templates: 'AI 常用指令模板',
          };
    const list = rawList.map((m) => ({
      ...m,
      title: m.title || titleFallback[m.id] || m.id,
    }));
    const resolvedHeightKey =
      heightKey || (group === 'summary' && moduleId === 'ai_templates' ? 'right_ai_templates_summary' : `right_${moduleId}`);
    return {
      side: 'right',
      group: group || 'summary',
      listKey,
      list,
      heightKey: resolvedHeightKey,
      soloKey: `${side}:${group || 'summary'}`,
    };
  }

  return {
    side: 'left',
    group: 'left',
    listKey: 'leftModules',
    list: getLeftModules().map((m) => ({ ...m })),
    heightKey: heightKey || moduleId,
    soloKey: 'left',
  };
}

function openModuleContextMenu(opts = {}) {
  const menu = getOrCreateModuleContextMenuEl();
  if (!menu) return;
  ensureModuleContextMenuDismissListeners();
  hideLeftContextMenu();

  const clientX = Number.isFinite(opts.clientX) ? opts.clientX : Number(opts.x) || 120;
  const clientY = Number.isFinite(opts.clientY) ? opts.clientY : Number(opts.y) || 120;
  const moduleId = String(opts.moduleId || '').trim();
  if (!moduleId) return;

  const ctx = resolveModuleGroupContext(opts);
  const targetMod = ctx.list.find((m) => m.id === moduleId);
  const modTitle = targetMod?.title || moduleId;
  const visibleSiblings = ctx.list.filter((m) => m.visible !== false && m.id !== moduleId);
  const isAlreadySoloed =
    visibleSiblings.length > 0 &&
    visibleSiblings.every((m) => Boolean(m.collapsed)) &&
    !targetMod?.collapsed;

  const renderMenuContent = (showPresetInput = false) => {
    const presets = getNamedLayoutPresets();
    const presetsHtml = presets.length
      ? `
        <div class="context-menu-label" style="font-size:10.5px;padding-top:4px;">已保存预设</div>
        ${presets
          .map(
            (p) => `
          <div class="context-menu-item" style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:4px 8px;">
            <button
              type="button"
              data-mctx-act="apply-preset"
              data-preset-id="${escapeHtml(p.id)}"
              data-preset-name="${escapeHtml(p.name)}"
              style="flex:1;min-width:0;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:inherit;"
            >
              📑 ${escapeHtml(p.name)}
            </button>
            <button
              type="button"
              data-mctx-act="delete-preset"
              data-preset-id="${escapeHtml(p.id)}"
              title="删除预设"
              aria-label="删除预设 ${escapeHtml(p.name)}"
              style="width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;border-radius:9999px;color:var(--text-tertiary);flex-shrink:0;"
            >×</button>
          </div>
        `
          )
          .join('')}
      `
      : '';

    const defaultPresetName = nextSequentialName('新建布局', presets.map((p) => p?.name || ''));
    const presetInputHtml = showPresetInput
      ? `
        <div class="inline-quick-create-row" data-role="mctx-preset-row" style="margin:4px 6px;">
          <input type="text" class="inline-rename-input" data-role="mctx-preset-input" placeholder="预设名（留空：${escapeHtml(defaultPresetName)}）" autocomplete="off" />
          <button type="button" class="icon-pill" data-mctx-act="confirm-save-preset" title="保存" style="width:22px;height:22px;flex-shrink:0;">${icon('check', 11)}</button>
          <button type="button" class="icon-pill" data-mctx-act="cancel-save-preset" title="取消" style="width:22px;height:22px;flex-shrink:0;">${icon('x', 11)}</button>
        </div>
      `
      : '';

    menu.innerHTML = `
      <div class="context-menu-label">${escapeHtml(modTitle)}</div>
      <button type="button" class="context-menu-item" data-mctx-act="save-default-layout" role="menuitem">
        <span class="ctx-item-left"><span>💾</span><span>保存当前布局设定</span></span>
      </button>
      <button type="button" class="context-menu-item" data-mctx-act="restore-default-layout" role="menuitem">
        <span class="ctx-item-left"><span>↺</span><span>恢复已记忆布局</span></span>
      </button>
      <button type="button" class="context-menu-item" data-mctx-act="show-preset-input" role="menuitem">
        <span class="ctx-item-left"><span>📑</span><span>另存为命名预设…</span></span>
      </button>
      ${presetInputHtml}
      ${presetsHtml}
      <div class="context-menu-sep" role="separator"></div>
      <button type="button" class="context-menu-item" data-mctx-act="solo-module" role="menuitem">
        <span class="ctx-item-left"><span>🎯</span><span>${isAlreadySoloed ? '还原其余模块' : '独享整栏（最大化此模块）'}</span></span>
      </button>
      <button type="button" class="context-menu-item" data-mctx-act="move-top" role="menuitem">
        <span class="ctx-item-left"><span>⬆</span><span>置顶此模块</span></span>
      </button>
      <button type="button" class="context-menu-item" data-mctx-act="move-bottom" role="menuitem">
        <span class="ctx-item-left"><span>⬇</span><span>置底此模块</span></span>
      </button>
      <button type="button" class="context-menu-item" data-mctx-act="reset-height" role="menuitem">
        <span class="ctx-item-left"><span>↕</span><span>重置此模块高度</span></span>
      </button>
      <button type="button" class="context-menu-item" data-mctx-act="hide-module" role="menuitem" style="color:var(--danger);">
        <span class="ctx-item-left"><span>👁</span><span>隐藏此模块</span></span>
      </button>
    `;

    if (showPresetInput) {
      window.requestAnimationFrame(() => {
        menu.querySelector('[data-role="mctx-preset-input"]')?.focus();
      });
    }
  };

  renderMenuContent(false);
  menu.hidden = false;
  menu.setAttribute('aria-hidden', 'false');
  menu.style.zIndex = '98';

  const rect = menu.getBoundingClientRect();
  const vw = window.innerWidth || 1280;
  const vh = window.innerHeight || 800;
  const left = Math.max(8, Math.min(clientX, vw - rect.width - 8));
  const top = Math.max(8, Math.min(clientY, vh - rect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  window.requestAnimationFrame(() => {
    menu.classList.add('is-open');
  });

  const commitPreset = () => {
    const inp = menu.querySelector('[data-role="mctx-preset-input"]');
    const fallbackName = nextSequentialName('新建布局', getNamedLayoutPresets().map((p) => p?.name || ''));
    const name = inp?.value?.trim() || fallbackName;
    storeMod.saveNamedLayoutPreset?.(name);
    store.emit('layout:persist-backend');
    hideModuleContextMenu();
    showToast(`已保存布局预设「${name}」`, 'success');
  };

  menu.onkeydown = (e) => {
    if (e.target?.matches?.('[data-role="mctx-preset-input"]')) {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        commitPreset();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        renderMenuContent(false);
      }
    }
  };

  menu.onclick = (e) => {
    const actEl = e.target.closest('[data-mctx-act]');
    if (!actEl) return;
    const act = actEl.dataset.mctxAct;

    if (act === 'save-default-layout') {
      storeMod.saveLayoutAsDefault?.();
      store.emit('layout:persist-backend');
      hideModuleContextMenu();
      showToast('已记住当前布局设定', 'success');
      return;
    }

    if (act === 'restore-default-layout') {
      storeMod.restoreDefaultLayout?.();
      hideModuleContextMenu();
      showToast('已恢复已记忆的布局设定', 'info');
      return;
    }

    if (act === 'show-preset-input') {
      renderMenuContent(true);
      return;
    }

    if (act === 'confirm-save-preset') {
      commitPreset();
      return;
    }

    if (act === 'cancel-save-preset') {
      renderMenuContent(false);
      return;
    }

    if (act === 'apply-preset') {
      const pid = actEl.dataset.presetId;
      const pname = actEl.dataset.presetName || '预设';
      if (pid) {
        storeMod.applyLayoutPreset?.(pid);
        hideModuleContextMenu();
        showToast(`已切换至预设「${pname}」`, 'success');
      }
      return;
    }

    if (act === 'delete-preset') {
      e.stopPropagation();
      const pid = actEl.dataset.presetId;
      if (pid) {
        storeMod.deleteLayoutPreset?.(pid);
        store.emit('layout:persist-backend');
        renderMenuContent(false);
        showToast('已删除布局预设', 'info');
      }
      return;
    }

    if (act === 'solo-module') {
      const nextHeights = { ...(store.state.uiLayout?.moduleHeights || {}) };
      if (!isAlreadySoloed) {
        const prevMap = {};
        for (const m of ctx.list) {
          prevMap[m.id] = Boolean(m.collapsed);
        }
        soloRestoreStateByGroup.set(ctx.soloKey, {
          collapsedById: prevMap,
          prevHeight: nextHeights[ctx.heightKey] ?? null,
        });
        const nextList = ctx.list.map((m) => ({
          ...m,
          collapsed: m.id !== moduleId,
        }));
        nextHeights[ctx.heightKey] = 520;
        updateUiLayout({ [ctx.listKey]: nextList, moduleHeights: nextHeights });
        if (ctx.side === 'right' && ctx.group === 'tools') {
          store.emit('right:tool-collapse-sync', nextList);
        }
        showToast(`已独享「${modTitle}」`, 'info');
      } else {
        const saved = soloRestoreStateByGroup.get(ctx.soloKey);
        const nextList = ctx.list.map((m) => ({
          ...m,
          collapsed: saved?.collapsedById ? Boolean(saved.collapsedById[m.id]) : false,
        }));
        if (saved && saved.prevHeight != null) {
          nextHeights[ctx.heightKey] = saved.prevHeight;
        } else {
          delete nextHeights[ctx.heightKey];
        }
        soloRestoreStateByGroup.delete(ctx.soloKey);
        updateUiLayout({ [ctx.listKey]: nextList, moduleHeights: nextHeights });
        if (ctx.side === 'right' && ctx.group === 'tools') {
          store.emit('right:tool-collapse-sync', nextList);
        }
        showToast('已还原其余模块', 'info');
      }
      hideModuleContextMenu();
      return;
    }

    if (act === 'move-top' || act === 'move-bottom') {
      const nextList = ctx.list.map((m) => ({ ...m }));
      const idx = nextList.findIndex((m) => m.id === moduleId);
      if (idx >= 0) {
        const [moved] = nextList.splice(idx, 1);
        if (act === 'move-top') nextList.unshift(moved);
        else nextList.push(moved);
        updateUiLayout({ [ctx.listKey]: nextList });
        showToast(act === 'move-top' ? `已置顶「${modTitle}」` : `已置底「${modTitle}」`, 'info');
      }
      hideModuleContextMenu();
      return;
    }

    if (act === 'reset-height') {
      const nextHeights = { ...(store.state.uiLayout?.moduleHeights || {}) };
      delete nextHeights[ctx.heightKey];
      updateUiLayout({ moduleHeights: nextHeights });
      hideModuleContextMenu();
      showToast(`已重置「${modTitle}」高度`, 'info');
      return;
    }

    if (act === 'hide-module') {
      const nextList = ctx.list.map((m) =>
        m.id === moduleId ? { ...m, visible: false } : { ...m }
      );
      updateUiLayout({ [ctx.listKey]: nextList });
      hideModuleContextMenu();
      showToast(`已隐藏「${modTitle}」（可在自定义模块中恢复）`, 'info');
    }
  };
}

function openAppContextMenu(clientX, clientY, pillEl) {
  const appId = pillEl?.dataset?.appId || '';
  if (!appId) return;
  const appName = pillEl.dataset.appName || pillEl.textContent?.trim() || appId;

  const menuItems = [
    { id: 'launch', icon: '🚀', label: '立即启动' },
    { id: 'copy-app-anchor', icon: '📌', label: '复制软件胶囊' },
    { sep: true },
    { id: 'delete-app', icon: '🗑', label: '从软件库移除', danger: true },
  ];

  showLeftContextMenu(clientX, clientY, appName, menuItems, (actionId) => {
    switch (actionId) {
      case 'launch':
        handleLaunchApp(appId, appName);
        break;
      case 'copy-app-anchor': {
        const md = `[[app:${appName}]]`;
        copyInternal?.(md, `已复制软件胶囊：${md}`);
        break;
      }
      case 'delete-app':
        handleRemoveApp(appId, appName);
        break;
      default:
        break;
    }
  });
}

function bindModuleHeightResizers(containerEl) {
  let activeDrag = null;
  let tooltipEl = null;

  const showResizeTooltip = (x, y, px) => {
    if (typeof document === 'undefined') return;
    if (!tooltipEl) {
      tooltipEl = document.createElement('div');
      tooltipEl.className = 'resize-pixel-tooltip';
      tooltipEl.style.cssText =
        'position:fixed;z-index:1600;pointer-events:none;padding:3px 8px;border-radius:9999px;font-size:11px;font-weight:600;color:#fff;background:rgba(28,28,30,0.88);backdrop-filter:blur(8px);box-shadow:0 4px 12px rgba(0,0,0,0.18);white-space:nowrap;';
      document.body.appendChild(tooltipEl);
    }
    tooltipEl.textContent = `高 ${px}px`;
    tooltipEl.style.left = `${Math.min(window.innerWidth - 90, Math.round(x + 12))}px`;
    tooltipEl.style.top = `${Math.max(8, Math.round(y - 14))}px`;
    tooltipEl.hidden = false;
  };

  const hideResizeTooltip = () => {
    if (tooltipEl) {
      tooltipEl.remove();
      tooltipEl = null;
    }
  };

  const stopResize = (e) => {
    if (!activeDrag) return;
    const { resizer, modId, currentH } = activeDrag;
    activeDrag = null;
    hideResizeTooltip();
    resizer.classList.remove('is-dragging');
    document.body.style.cursor = '';
    if (e?.pointerId != null) {
      try {
        resizer.releasePointerCapture?.(e.pointerId);
      } catch {
        // ignore
      }
    }
    isResizingModule = true;
    try {
      persistModuleHeight(modId, currentH);
    } finally {
      isResizingModule = false;
    }
  };

  containerEl.addEventListener('pointerdown', (e) => {
    const resizer = e.target.closest('.module-height-resizer[data-resize-module]');
    if (!resizer) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    const modId = resizer.dataset.resizeModule;
    const block = resizer.closest('.module-block');
    const scrollBody = block?.querySelector('.module-scroll-body');
    if (!modId || !scrollBody) return;

    e.preventDefault();
    e.stopPropagation();

    const rect = scrollBody.getBoundingClientRect();
    const startH = Math.max(MODULE_MIN_HEIGHT, Math.round(rect.height || 160));
    activeDrag = {
      resizer,
      modId,
      scrollBody,
      startY: e.clientY,
      startH,
      currentH: startH,
    };

    resizer.classList.add('is-dragging');
    document.body.style.cursor = 'row-resize';
    showResizeTooltip(e.clientX, e.clientY, startH);
    try {
      resizer.setPointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }
  });

  window.addEventListener('pointermove', (e) => {
    if (!activeDrag) return;
    const dy = e.clientY - activeDrag.startY;
    const nextH = Math.max(MODULE_MIN_HEIGHT, Math.min(MODULE_MAX_HEIGHT, Math.round(activeDrag.startH + dy)));
    activeDrag.currentH = nextH;
    activeDrag.scrollBody.classList.remove('is-auto-height');
    activeDrag.scrollBody.style.height = `${nextH}px`;
    activeDrag.scrollBody.style.maxHeight = `${nextH}px`;
    activeDrag.scrollBody.style.overflowY = 'auto';
    showResizeTooltip(e.clientX, e.clientY, nextH);
  });

  window.addEventListener('pointerup', stopResize);
  window.addEventListener('pointercancel', stopResize);

  containerEl.addEventListener('dblclick', (e) => {
    const resizer = e.target.closest('.module-height-resizer[data-resize-module]');
    if (!resizer) return;
    e.preventDefault();
    e.stopPropagation();
    hideResizeTooltip();
    const modId = resizer.dataset.resizeModule;
    const block = resizer.closest('.module-block');
    const scrollBody = block?.querySelector('.module-scroll-body');
    if (scrollBody) {
      scrollBody.classList.add('is-auto-height');
      scrollBody.style.height = '';
      scrollBody.style.maxHeight = '';
      scrollBody.style.overflowY = '';
    }
    if (modId) {
      isResizingModule = true;
      try {
        if (typeof setModuleSizePreset === 'function') {
          setModuleSizePreset('left', modId, 'auto');
        } else {
          persistModuleHeight(modId, null);
        }
      } finally {
        isResizingModule = false;
      }
      showToast('已恢复模块自适应高度', 'info', { duration: 1600 });
    }
  });
}

/**
 * Initialize Left Panel (V4 Super-Upgrade).
 * @param {HTMLElement} containerEl
 */
export function initLeftTree(containerEl) {
  if (!containerEl) return;
  containerRef = containerEl;

  renderLeftPanel(containerEl);
  bindModuleHeightResizers(containerEl);

  const clearFileReorderClasses = () => {
    containerEl.querySelectorAll('.tree-file-item.is-reorder-over-top, .tree-file-item.is-reorder-over-bottom').forEach((el) => {
      el.classList.remove('is-reorder-over-top', 'is-reorder-over-bottom');
    });
  };

  // Sync checkboxes & active highlight cleanly without full re-render flicker
  store.on('context:changed', () => syncContextCheckboxes(containerEl));
  store.on('file:opened', (file) => syncActiveFileHighlight(containerEl, file?.path));
  store.on('capture:open', () => openCaptureSceneSheet());
  store.on('files:sort-changed', () => updateFilesSectionOnly(containerEl));
  store.on('files:pin-changed', () => updateFilesSectionOnly(containerEl));
  store.on('files:pinned-changed', () => updateFilesSectionOnly(containerEl));
  store.on('left:inline-new-note', () => startInlineNewNote());
  store.on('module:context-menu', (payload) => {
    if (payload) openModuleContextMenu(payload);
  });
  store.on('layout:applied', () => {
    renderPanelBody(containerEl);
    syncSortPopoverUi(containerEl);
  });
  store.on('ui:layout-changed', () => {
    if (isResizingModule) return;
    const activeEl = document.activeElement;
    if (activeEl && containerEl.contains(activeEl) && activeEl.matches('[data-role="quick-scratch-input"]')) {
      return;
    }
    renderPanelBody(containerEl);
  });
  store.on('recent:changed', () => {
    const hasRecentMod = getLeftModules().some((m) => m.id === 'recent_files' && m.visible !== false);
    if (hasRecentMod) {
      renderPanelBody(containerEl);
    }
  });

  // Refresh data when mutated elsewhere via EventBus
  store.on('files:updated', async () => {
    if (mutating.files) return;
    await loadFiles();
    renderPanelBody(containerEl);
  });
  store.on('apps:updated', async () => {
    if (mutating.apps) return;
    await loadApps();
    renderPanelBody(containerEl);
  });
  store.on('workspaces:updated', async () => {
    if (mutating.workspaces) return;
    await loadWorkspaces();
    renderPanelBody(containerEl);
  });
  store.on('tree:updated', async () => {
    if (mutating.tree) return;
    await loadTree();
    renderPanelBody(containerEl);
  });

  store.on('trash:consumed-drag', async (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const kind = String(payload.kind || payload.type || '');
    if (kind === 'workspace') {
      const wsId =
        payload.workspaceId ||
        payload.id ||
        (store.state.workspaces || []).find((w) => w.name === payload.label)?.id;
      if (!wsId) return;
      try {
        await api.del(`/api/workspaces?workspace_id=${encodeURIComponent(wsId)}`);
        await loadWorkspaces();
        emitWithGuard('workspaces', store.state.workspaces);
        renderPanelBody(containerEl);
      } catch (err) {
        showToast(`移除场景包失败：${err?.message || '未知错误'}`, 'error');
      }
    } else if (kind === 'app-portal' || kind === 'app') {
      const appId =
        payload.appId ||
        payload.id ||
        (store.state.apps || []).find((a) => a.name === payload.label)?.id;
      if (!appId) return;
      try {
        await api.del(`/api/apps?app_id=${encodeURIComponent(appId)}`);
        await loadApps();
        emitWithGuard('apps', store.state.apps);
        renderPanelBody(containerEl);
      } catch (err) {
        showToast(`移除软件失败：${err?.message || '未知错误'}`, 'error');
      }
    }
  });

  store.on('trash:restore-virtual', async (res) => {
    if (!res || typeof res !== 'object') return;
    const kind = String(res.kind || res.item?.kind || '');
    const p = res.payload || res.item?.payload || {};
    const title = res.title || res.item?.title || p.label || '';
    if (kind === 'workspace') {
      const wsData = p.workspace || p;
      const wsName = wsData.name || title || nextSequentialName('新建场景', (store.state.workspaces || []).map((w) => w?.name || ''));
      try {
        await api.post('/api/workspaces', {
          name: wsName,
          app_ids: Array.isArray(wsData.app_ids) ? wsData.app_ids : [],
          file_paths: Array.isArray(wsData.file_paths) ? wsData.file_paths : [],
          captured_apps: [],
        });
        await loadWorkspaces();
        emitWithGuard('workspaces', store.state.workspaces);
        renderPanelBody(containerEl);
        showToast(`已还原一键场景包「${wsName}」`, 'success');
      } catch (err) {
        showToast(`还原场景包失败：${err?.message || '未知错误'}`, 'error');
      }
    } else if (kind === 'app-portal' || kind === 'app') {
      const appData = p.app || p;
      const appName = appData.name || title || nextSequentialName('新建软件', (store.state.apps || []).map((a) => a?.name || ''));
      if (!appData.path) {
        showToast(`「${appName}」缺少可执行路径，请重新添加`, 'warning');
        return;
      }
      try {
        await api.post('/api/apps', {
          name: appName,
          path: appData.path,
          aliases: Array.isArray(appData.aliases) ? appData.aliases : [],
          args: appData.args || '',
        });
        await loadApps();
        emitWithGuard('apps', store.state.apps);
        renderPanelBody(containerEl);
        showToast(`已还原本地软件「${appName}」`, 'success');
      } catch (err) {
        showToast(`还原软件失败：${err?.message || '未知错误'}`, 'error');
      }
    }
  });

  // Dedicated Left-Panel Right-Click Context Menu (#8 & #11)
  containerEl.addEventListener('contextmenu', (e) => {
    const fileRow = e.target.closest('.tree-file-item[data-path]');
    if (fileRow) {
      e.preventDefault();
      e.stopPropagation();
      openFileContextMenu(e.clientX, e.clientY, fileRow);
      return;
    }
    const appPill = e.target.closest('.app-launcher-pill[data-app-id]');
    if (appPill) {
      e.preventDefault();
      e.stopPropagation();
      openAppContextMenu(e.clientX, e.clientY, appPill);
      return;
    }
    const modHeader = e.target.closest('.module-header');
    if (modHeader) {
      const modBlock = modHeader.closest('.module-block[data-module-id]');
      const moduleId = modBlock?.dataset?.moduleId;
      if (moduleId) {
        e.preventDefault();
        e.stopPropagation();
        openModuleContextMenu({
          side: 'left',
          moduleId,
          clientX: e.clientX,
          clientY: e.clientY,
        });
      }
    }
  });

  // Live input syncing for in-folder filter, quick_scratch, and pomodoro_mini
  containerEl.addEventListener('input', (e) => {
    const target = e.target;
    if (target.matches('.left-filter-input')) {
      leftFilterQuery = target.value;
      updateFilterUiState(containerEl);
      updateFilesSectionOnly(containerEl);
      return;
    }
    if (target.matches('[data-role="quick-scratch-input"]')) {
      updateUiLayout({ scratchpadText: target.value });
      return;
    }
    if (target.matches('[data-role="mini-pomodoro-task"]')) {
      quickPomodoroTask = target.value;
    }
  });

  // Cross-panel file/scratchpad drags + left-panel module reordering
  containerEl.addEventListener('dragstart', (e) => {
    const handle = e.target.closest('.module-drag-handle[data-drag-module]');
    if (handle) {
      const modId = handle.dataset.dragModule;
      const block = handle.closest('.module-block');
      dragModuleId = modId;
      block?.classList.add('is-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
      }
      setDragPayload(e, { type: 'module-reorder', moduleId: modId });
      return;
    }

    const scratchPill = e.target.closest('[data-drag-source="quick-scratch"]');
    if (scratchPill) {
      const ta = containerEl.querySelector('[data-role="quick-scratch-input"]');
      const text = (ta?.value ?? store.state.uiLayout?.scratchpadText ?? '').trim();
      if (!text) {
        e.preventDefault();
        showToast('灵感便签为空，请先输入内容后再拖入笔记', 'warning');
        return;
      }
      setDragPayload(e, {
        type: 'scratchpad',
        label: '灵感便签',
        markdown: text,
      });
      store.emit('drag:active', true);
      return;
    }

    const appPill = e.target.closest('.app-launcher-pill[data-app-id]');
    if (appPill) {
      const appId = appPill.dataset.appId || '';
      const appName = (appPill.dataset.appName || appPill.textContent || '').trim();
      const appObj = (store.state.apps || []).find((a) => String(a.id) === String(appId)) || null;
      if (appName) {
        setDragPayload(e, {
          type: 'app-portal',
          appId,
          id: appId,
          label: appName,
          app: appObj ? { name: appObj.name, path: appObj.path, aliases: appObj.aliases || [], args: appObj.args || '' } : null,
          markdown: '[[app:' + appName + ']]',
        });
        store.emit('drag:active', true);
      }
      return;
    }

    const wsCard = e.target.closest('.workspace-card[data-workspace-id]');
    if (wsCard) {
      if (e.target.closest('button, select, input, a')) {
        e.preventDefault();
        return;
      }
      const wsId = wsCard.dataset.workspaceId;
      const ws = (store.state.workspaces || []).find((w) => String(w.id) === String(wsId));
      if (!ws) return;
      const appMap = new Map((store.state.apps || []).map((a) => [String(a.id), a.name]));
      const appLinks = (ws.app_ids || []).map((id) => `[[app:${appMap.get(String(id)) || id}]]`);
      const fileLinks = (ws.file_paths || []).map((fp) => buildFileAnchorMarkdown(fp));
      const parts = [`### 工作区：${ws.name}`, ...appLinks, ...fileLinks].filter(Boolean);
      setDragPayload(e, {
        type: 'workspace',
        label: ws.name,
        workspaceId: ws.id,
        id: ws.id,
        workspace: {
          name: ws.name,
          app_ids: Array.isArray(ws.app_ids) ? ws.app_ids : [],
          file_paths: Array.isArray(ws.file_paths) ? ws.file_paths : [],
        },
        markdown: parts.join('\n'),
      });
      store.emit('drag:active', true);
      return;
    }

    const fileRow = e.target.closest('.tree-file-item[data-path]');
    if (fileRow) {
      if (e.target.closest('.file-check, .lock-toggle-btn, .inline-rename-input')) {
        e.preventDefault();
        return;
      }
      const path = fileRow.dataset.path || '';
      const name = fileRow.dataset.name || getBasename(path);
      const ext = fileRow.dataset.ext || getFileExt({ path, name });
      const markdown = buildFileAnchorMarkdown({ path, name, ext });

      if (fileRow.closest('.left-files-list') && fileRow.dataset.groupKey) {
        dragFileItem = {
          path,
          groupKey: fileRow.dataset.groupKey,
          isPinned: fileRow.dataset.pinned === '1',
        };
      } else {
        dragFileItem = null;
      }

      setDragPayload(e, {
        type: 'file-anchor',
        label: name,
        path,
        markdown,
      });
      store.emit('drag:active', true);
    }
  });

  containerEl.addEventListener('dragover', (e) => {
    if (dragFileItem) {
      const targetRow = e.target.closest('.left-files-list .tree-file-item[data-path]');
      containerEl.querySelectorAll('.tree-file-item.is-reorder-over-top, .tree-file-item.is-reorder-over-bottom').forEach((el) => {
        if (el !== targetRow) {
          el.classList.remove('is-reorder-over-top', 'is-reorder-over-bottom');
        }
      });
      if (
        targetRow &&
        targetRow.dataset.path !== dragFileItem.path &&
        targetRow.dataset.groupKey === dragFileItem.groupKey
      ) {
        const targetPinned = targetRow.dataset.pinned === '1';
        const canReorder =
          (dragFileItem.isPinned && targetPinned) ||
          (!dragFileItem.isPinned && !targetPinned && isCustomSortEnabled());
        if (canReorder) {
          e.preventDefault();
          if (e.dataTransfer) {
            e.dataTransfer.dropEffect = 'move';
          }
          const rect = targetRow.getBoundingClientRect();
          const pos = e.clientY - rect.top < rect.height / 2 ? 'before' : 'after';
          targetRow.classList.toggle('is-reorder-over-top', pos === 'before');
          targetRow.classList.toggle('is-reorder-over-bottom', pos === 'after');
        }
      }
      return;
    }

    if (!dragModuleId) return;
    const targetBlock = e.target.closest('.module-block[data-module-id]');
    if (!targetBlock) return;
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
    containerEl.querySelectorAll('.module-block.is-drag-over').forEach((el) => {
      if (el !== targetBlock) el.classList.remove('is-drag-over');
    });
    if (targetBlock.dataset.moduleId !== dragModuleId) {
      targetBlock.classList.add('is-drag-over');
    }
  });

  containerEl.addEventListener('dragleave', (e) => {
    if (dragFileItem) {
      const targetRow = e.target.closest('.left-files-list .tree-file-item[data-path]');
      if (targetRow && !targetRow.contains(e.relatedTarget)) {
        targetRow.classList.remove('is-reorder-over-top', 'is-reorder-over-bottom');
      }
      return;
    }

    const targetBlock = e.target.closest('.module-block[data-module-id]');
    if (!targetBlock) return;
    if (!targetBlock.contains(e.relatedTarget)) {
      targetBlock.classList.remove('is-drag-over');
    }
  });

  containerEl.addEventListener('drop', (e) => {
    if (dragFileItem) {
      clearFileReorderClasses();
      const targetRow = e.target.closest('.left-files-list .tree-file-item[data-path]');
      const src = dragFileItem;
      dragFileItem = null;

      if (
        targetRow &&
        targetRow.dataset.path !== src.path &&
        targetRow.dataset.groupKey === src.groupKey
      ) {
        const targetPinned = targetRow.dataset.pinned === '1';
        const rect = targetRow.getBoundingClientRect();
        const pos = e.clientY - rect.top < rect.height / 2 ? 'before' : 'after';

        if (src.isPinned && targetPinned) {
          e.preventDefault();
          e.stopPropagation();
          if (typeof storeMod.reorderPinnedFiles === 'function') {
            storeMod.reorderPinnedFiles(src.path, targetRow.dataset.path, pos);
          }
          clearDragPayload();
          store.emit('drag:active', false);
          updateFilesSectionOnly(containerEl);
          return;
        }

        if (!src.isPinned && !targetPinned && isCustomSortEnabled()) {
          e.preventDefault();
          e.stopPropagation();
          const groupEl = targetRow.closest('.tree-group');
          const visibleUnpinnedPaths = Array.from(
            groupEl?.querySelectorAll('.tree-file-item[data-path][data-pinned="0"]') || []
          )
            .map((el) => el.dataset.path)
            .filter(Boolean);
          if (typeof storeMod.moveCustomFileOrder === 'function') {
            storeMod.moveCustomFileOrder(src.path, targetRow.dataset.path, pos, visibleUnpinnedPaths);
          }
          clearDragPayload();
          store.emit('drag:active', false);
          updateFilesSectionOnly(containerEl);
          return;
        }
      }
      return;
    }

    if (!dragModuleId) return;
    const targetBlock = e.target.closest('.module-block[data-module-id]');
    containerEl.querySelectorAll('.module-block.is-drag-over, .module-block.is-dragging').forEach((el) => {
      el.classList.remove('is-drag-over', 'is-dragging');
    });

    const sourceId = dragModuleId;
    dragModuleId = null;
    clearDragPayload();

    if (!targetBlock) return;
    e.preventDefault();
    const targetId = targetBlock.dataset.moduleId;
    if (!targetId || targetId === sourceId) return;

    const nextModules = getLeftModules().map((m) => ({ ...m }));
    const fromIdx = nextModules.findIndex((m) => m.id === sourceId);
    const toIdx = nextModules.findIndex((m) => m.id === targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = nextModules.splice(fromIdx, 1);
    nextModules.splice(toIdx, 0, moved);
    updateUiLayout({ leftModules: nextModules });
  });

  containerEl.addEventListener('dragend', () => {
    dragModuleId = null;
    dragFileItem = null;
    clearFileReorderClasses();
    containerEl.querySelectorAll('.module-block.is-drag-over, .module-block.is-dragging').forEach((el) => {
      el.classList.remove('is-drag-over', 'is-dragging');
    });
    clearDragPayload();
    store.emit('drag:active', false);
  });

  if (!containerEl.dataset.sortDismissBound) {
    containerEl.dataset.sortDismissBound = '1';
    document.addEventListener('pointerdown', (e) => {
      const pop = containerEl.querySelector('[data-role="left-sort-popover"]');
      if (!pop || pop.hidden) return;
      if (!e.target.closest('.left-sort-wrap')) {
        setSortPopoverOpen(containerEl, false);
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const pop = containerEl.querySelector('[data-role="left-sort-popover"]');
      if (pop && !pop.hidden) {
        setSortPopoverOpen(containerEl, false);
      }
    });
  }

  // Prevent checkbox clicks from triggering row file:open
  containerEl.addEventListener('click', (e) => {
    const cb = e.target.closest('.file-check');
    if (cb) {
      e.stopPropagation();
      return;
    }

    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;

    if (action === 'toggle-sort-popover') {
      e.stopPropagation();
      const pop = containerEl.querySelector('[data-role="left-sort-popover"]');
      const shouldOpen = pop ? pop.hidden : false;
      setSortPopoverOpen(containerEl, shouldOpen);
      return;
    }

    if (action === 'sort-by-opt') {
      const nextBy = actionEl.dataset.sortBy;
      if (nextBy) {
        persistLeftFileSort({ by: nextBy });
        updateFilesSectionOnly(containerEl);
      }
      return;
    }

    if (action === 'sort-dir-opt') {
      const nextDir = actionEl.dataset.sortDir === 'desc' ? 'desc' : 'asc';
      persistLeftFileSort({ dir: nextDir });
      updateFilesSectionOnly(containerEl);
      return;
    }

    if (action === 'toggle-custom-sort') {
      const nextEnabled = !isCustomSortEnabled();
      if (typeof storeMod.setCustomSortEnabled === 'function') {
        storeMod.setCustomSortEnabled(nextEnabled);
      } else {
        store.state.customSortEnabled = nextEnabled;
      }
      updateFilesSectionOnly(containerEl);
      showToast(
        nextEnabled ? '已开启自定义拖拽排序（可上下拖拽调整顺序）' : '已关闭自定义拖拽排序',
        'info'
      );
      return;
    }

    if (action === 'tidy-custom-sort') {
      if (getCustomFileOrderList().length === 0) return;
      if (typeof storeMod.tidyCustomFileOrder === 'function') {
        storeMod.tidyCustomFileOrder();
      } else {
        store.state.customFileOrder = [];
      }
      updateFilesSectionOnly(containerEl);
      setSortPopoverOpen(containerEl, false);
      showToast('已整理非置顶文件，恢复默认排序', 'success');
      return;
    }

    if (action === 'sort-by') {
      return;
    }

    if (action === 'sort-dir') {
      const cur = getLeftFileSort();
      const nextDir = cur.dir === 'asc' ? 'desc' : 'asc';
      persistLeftFileSort({ dir: nextDir });
      updateFilesSectionOnly(containerEl);
      return;
    }

    if (action === 'clear-filter') {
      leftFilterQuery = '';
      const filterInput = containerEl.querySelector('.left-filter-input');
      if (filterInput) {
        filterInput.value = '';
        filterInput.focus();
      }
      updateFilterUiState(containerEl);
      updateFilesSectionOnly(containerEl);
      return;
    }

    if (action === 'scroll-top') {
      const bodyEl = containerEl.querySelector('.panel-body');
      bodyEl?.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    if (action === 'back-to-notes-root') {
      e.stopPropagation();
      handleBackToNotesRoot(containerEl);
      return;
    }

    if (action === 'set-module-size') {
      e.stopPropagation();
      const modId = actionEl.dataset.modId;
      const preset = actionEl.dataset.preset || 'auto';
      if (modId) {
        setModuleSizePreset?.('left', modId, preset);
      }
      return;
    }

    if (action === 'toggle-module-float') {
      e.stopPropagation();
      const modId = actionEl.dataset.modId;
      const modTitle = actionEl.dataset.modTitle || modId;
      if (modId) {
        toggleModuleFloat?.(modId, { title: modTitle, panel: 'left' });
      }
      return;
    }

    if (action === 'reset-layout') {
      resetAllLayout();
      return;
    }

    if (action === 'customize-modules') {
      openCustomizeModulesSheet();
      return;
    }

    if (action === 'toggle-module-collapse') {
      const modId = actionEl.dataset.moduleId;
      if (modId) {
        const nextModules = getLeftModules().map((m) =>
          m.id === modId ? { ...m, collapsed: !m.collapsed } : { ...m }
        );
        updateUiLayout({ leftModules: nextModules });
      }
      return;
    }

    if (action === 'spawn-sticky-note') {
      store.emit('sticky:spawn', {});
      return;
    }

    if (action === 'scratch-ai-extract') {
      const ta = containerEl.querySelector('[data-role="quick-scratch-input"]');
      const text = (ta?.value ?? store.state.uiLayout?.scratchpadText ?? '').trim();
      if (!text) {
        showToast('请先在灵感便签输入内容', 'warning');
        ta?.focus();
        return;
      }
      if (typeof window !== 'undefined' && window.innerWidth <= 767) {
        store.setState({ mobileTab: 'ai' });
        store.emit('layout:changed');
      }
      store.emit('ai:summarize-request', { text, autoRun: true });
      return;
    }

    if (action === 'mini-pomodoro-start') {
      const sec = Number(actionEl.dataset.seconds) || 1500;
      const taskInput = containerEl.querySelector('[data-role="mini-pomodoro-task"]');
      const taskTitle = (taskInput?.value || quickPomodoroTask || '').trim() || '快捷专注';
      quickPomodoroTask = taskTitle;
      store.emit('focus:start', {
        title: taskTitle,
        seconds: sec,
      });
      return;
    }

    if (action === 'toggle-privacy') {
      e.stopPropagation();
      handleTogglePrivacy(actionEl.dataset.path);
      return;
    }

    if (action === 'toggle-group') {
      const key = actionEl.dataset.groupKey;
      if (key) {
        if (collapsedGroups.has(key)) collapsedGroups.delete(key);
        else collapsedGroups.add(key);
        updateFilesSectionOnly(containerEl);
      }
      return;
    }

    if (action === 'open-file' || action === 'open-tree-file') {
      if (e.target.closest('.inline-rename-input')) return;
      handleOpenFilePath(actionEl.dataset.path);
      return;
    }

    if (action === 'new-note') {
      startInlineNewNote();
      return;
    }

    if (action === 'new-folder') {
      startInlineNewFolder();
      return;
    }

    if (action === 'import-open') {
      openImportSheet();
      return;
    }

    if (action === 'capture-scene') {
      openCaptureSceneSheet();
      return;
    }

    if (action === 'add-app') {
      openAddAppSheet();
      return;
    }

    if (action === 'launch-app') {
      handleLaunchApp(actionEl.dataset.appId, actionEl.textContent?.trim());
      return;
    }

    if (action === 'launch-workspace') {
      const wsId = actionEl.dataset.wsId;
      const ws = (store.state.workspaces || []).find((w) => w.id === wsId);
      handleLaunchWorkspace(ws);
      return;
    }

    if (action === 'focus-workspace') {
      e.stopPropagation();
      const wsId = actionEl.dataset.wsId;
      const ws = (store.state.workspaces || []).find((w) => String(w.id) === String(wsId));
      openFocusDurationPopover?.(actionEl, {
        title: ws?.name || '工作区专注',
        workspaceId: ws?.id || wsId,
        filePath: Array.isArray(ws?.file_paths) ? ws.file_paths[0] || '' : '',
      });
      return;
    }

    if (action === 'manage-tree') {
      handleOpenTreeTools();
    }
  });

  // Handle RAG context checkbox toggle & sort-by select change
  containerEl.addEventListener('change', (e) => {
    const sortSelect = e.target.closest('[data-action="sort-by"]');
    if (sortSelect) {
      persistLeftFileSort({ by: sortSelect.value });
      updateFilesSectionOnly(containerEl);
      return;
    }

    const cb = e.target.closest('.file-check');
    if (!cb) return;
    const path = cb.dataset.path;
    toggleContextPath(path);
    cb.checked = (store.state.selectedContextPaths || []).includes(path);
  });

  // Keyboard accessibility for row items & F2 inline file rename
  containerEl.addEventListener('keydown', (e) => {
    if (e.key === 'F2' && !e.target.closest('input, textarea, select')) {
      const targetRow =
        e.target.closest('.left-files-list .tree-file-item[data-path]') ||
        containerEl.querySelector('.left-files-list .tree-file-item.is-selected[data-path]');
      if (targetRow?.dataset?.path) {
        e.preventDefault();
        startInlineFileRename(targetRow.dataset.path);
      }
      return;
    }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target.closest('.file-check, button, select, input, textarea')) return;
    const actionEl = e.target.closest('[data-action="open-file"], [data-action="open-tree-file"], [data-action="toggle-group"]');
    if (!actionEl) return;
    e.preventDefault();
    actionEl.click();
  });

  // Initial backend hydration
  loadAllData().then(() => {
    renderPanelBody(containerEl);
  });
}
