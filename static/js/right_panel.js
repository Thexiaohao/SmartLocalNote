/**
 * SmartLocalNote - Right Copilot Panel (V2)
 * Features:
 *  - Mode 1 (`summary`, default): AI Summarize + Structured Todos + Reminders + Focus (15s/15m/25m/45m) + Local App Launchers
 *  - Mode 2 (`chat`): Innovation 4 Zero-Vector Cross-Format Multi-File RAG Streaming Chat + Privacy Lock Guard + 1-Click Note/Doc/Excel Actions
 *  - Mode 3 (`tools`): Local Tools Workbench (Quick Excel Form & Structure, Virtual Knowledge Tree & Table Overview + AI Classify, Apps & Workspaces)
 *  - V2 Pain Point #4: Modular Right Panel Customization (reorder tabs, toggle/reorder summary & tool modules, drag-reorder tool cards, AI Prompt Templates)
 *  - V2 Pain Point #6B: Live Free Basic AI / Custom Model / Local Engine clickable status pill
 *  - V2 Pain Point #7: Draggable AI Summary cards, Todo items, and Chat replies -> drop straight into Center Note
 *
 * Strictly decoupled via `store` EventBus — never touches left/center DOM.
 */

import * as storeMod from './store.js';
import { api, streamPostSSE } from './api_client.js';
import { icon, getFileTypeStyle } from './icons.js';

const {
  store,
  escapeHtml,
  toggleContextPath,
  showToast,
  openSheet,
  closeSheet,
  renderMarkdownSafe,
  copyInternal,
  setModuleHeight,
  resetUiLayout,
  updateUiLayout,
  nextSequentialName,
  setModuleSizePreset,
  toggleModuleFloat,
  openFocusDurationPopover,
  setCenterView,
  applyPaneWidths,
} = storeMod;

const UI_LAYOUT_STORAGE_KEY = 'sln_ui_layout';
const RIGHT_TOOLS_V73_STORAGE_KEY = 'sln_right_tool_modules_v73';
const MD_SNIPPETS_STORAGE_KEY = 'sln_md_snippets_v1';

const TAB_META = {
  summary: { id: 'summary', label: 'AI总结' },
  chat: { id: 'chat', label: '联网问答' },
  tools: { id: 'tools', label: '工具台' },
};

const SUMMARY_MODULE_META = {
  input: { id: 'input', label: '随手速记区' },
  summary_card: { id: 'summary_card', label: 'AI 摘要与待办' },
  reminders: { id: 'reminders', label: '定时提醒' },
  ai_templates: { id: 'ai_templates', label: 'AI 常用指令模板' },
};

const TOOL_MODULE_META = {
  quick_excel: { id: 'quick_excel', label: '快捷表单填表与表格操作' },
  clipboard_snippets: { id: 'clipboard_snippets', label: '剪贴板历史与常用模板片段' },
  doc_outline: { id: 'doc_outline', label: '文档大纲与高亮速览' },
  text_studio: { id: 'text_studio', label: '极简文本排版工坊' },
  focus_pulse: { id: 'focus_pulse', label: '今日专注脉搏与关系微图谱' },
  // Legacy compatibility entries
  knowledge_tree: { id: 'knowledge_tree', label: '虚拟知识树分类与总览' },
  apps_workspaces: { id: 'apps_workspaces', label: '本地软件库与一键场景包' },
  ai_templates: { id: 'ai_templates', label: 'AI 常用指令模板' },
};

const LEGACY_TOOL_ID_MAP = {
  knowledge_tree: 'doc_outline',
  apps_workspaces: 'clipboard_snippets',
  ai_templates: 'text_studio',
};

const DEFAULT_TABS_ORDER = ['summary', 'chat', 'tools'];
const DEFAULT_SUMMARY_MODULES = [
  { id: 'input', visible: true },
  { id: 'summary_card', visible: true },
  { id: 'reminders', visible: true },
  { id: 'ai_templates', visible: false },
];
const DEFAULT_TOOL_MODULES = [
  { id: 'quick_excel', visible: true },
  { id: 'clipboard_snippets', visible: true },
  { id: 'doc_outline', visible: true },
  { id: 'text_studio', visible: true },
  { id: 'focus_pulse', visible: true },
];

const BUILTIN_MD_SNIPPETS = [
  {
    id: 'builtin_meeting',
    icon: '📅',
    title: '会议纪要',
    content: '## 📅 会议纪要 ({{DATE}})\n- **参会人**：\n- **核心结论**：\n  1. \n- **行动待办**：\n  - [ ] ',
    custom: false,
  },
  {
    id: 'builtin_review',
    icon: '🌙',
    title: '每日复盘',
    content: '## 🌙 每日复盘 ({{DATE}})\n- **今日完成**：\n  - [x] \n- **核心收获**：\n  - \n- **明日计划**：\n  - [ ] ',
    custom: false,
  },
  {
    id: 'builtin_table',
    icon: '📊',
    title: '标准表格',
    content: '| 项目 | 状态 | 关键说明 |\n| :--- | :---: | :--- |\n| 示例项 A | 进行中 | 补充详情 |\n| 示例项 B | 待开始 | 补充详情 |',
    custom: false,
  },
  {
    id: 'builtin_paper',
    icon: '📄',
    title: '论文摘录卡',
    content: '> [!NOTE] 📄 论文/资料摘录卡\n> - **来源**：[[讲义.pdf#page=1]]\n> - **核心观点**：\n> - **个人批注**：#阅读笔记',
    custom: false,
  },
];

function loadCustomMdSnippets() {
  try {
    const raw = localStorage.getItem(MD_SNIPPETS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s) => s && typeof s === 'object' && s.title && s.content)
      .map((s) => ({
        id: String(s.id || `snip_${Date.now().toString(36)}`),
        icon: String(s.icon || '📌'),
        title: String(s.title).trim(),
        content: String(s.content),
        custom: true,
      }));
  } catch {
    return [];
  }
}

function saveCustomMdSnippets(list) {
  const clean = Array.isArray(list) ? list : [];
  try {
    localStorage.setItem(MD_SNIPPETS_STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // ignore storage errors
  }
  return clean;
}

function getAllMdSnippets() {
  return [...BUILTIN_MD_SNIPPETS, ...loadCustomMdSnippets()];
}

function resolveSnippetMarkdown(rawContent) {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return String(rawContent || '').replace(/\{\{DATE\}\}/g, today);
}

const AI_PROMPT_TEMPLATES = [
  {
    id: 'tpl-distill',
    label: '✨ 精简提炼要点',
    prompt: '请精简提炼当前文档或参考资料的核心要点、关键结论与对应页码/单元格位置（分条输出）。',
  },
  {
    id: 'tpl-polish',
    label: '📝 润色改写当前笔记',
    prompt: '请帮我润色并改写当前笔记内容，保留原意的同时让结构更清晰、表达更精炼，直接输出 Markdown。',
  },
  {
    id: 'tpl-quiz',
    label: '❓ 出 5 道巩固测验题',
    prompt: '请基于当前文档内容出 5 道由浅入深的巩固测验题，并在末尾附带简要答案与解析。',
  },
  {
    id: 'tpl-translate',
    label: '🌐 中英互译',
    prompt: '请将当前文档的核心内容进行高质量中英互译（中文译为地道英文，英文译为流畅中文）。',
  },
];

const TREE_STATUS_OPTIONS = ['待开始', '复习中', '已完成'];

function setDragPayload(e, payload) {
  if (typeof storeMod.setDragPayload === 'function') {
    return storeMod.setDragPayload(e, payload);
  }
  store.state.activeDragPayload = payload || null;
  if (e?.dataTransfer && payload) {
    try {
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('application/x-sln-block', JSON.stringify(payload));
      e.dataTransfer.setData('text/plain', String(payload.markdown || payload.label || ''));
    } catch {
      // ignore dataTransfer errors
    }
  }
}

function clearDragPayload() {
  if (typeof storeMod.clearDragPayload === 'function') {
    return storeMod.clearDragPayload();
  }
  store.state.activeDragPayload = null;
}

function readDragPayload(e) {
  if (typeof storeMod.readDragPayload === 'function') {
    return storeMod.readDragPayload(e);
  }
  const dt = e?.dataTransfer;
  if (dt) {
    try {
      const raw = dt.getData('application/x-sln-block');
      if (raw) return JSON.parse(raw);
    } catch {
      // ignore
    }
  }
  if (store.state.activeDragPayload) {
    return store.state.activeDragPayload;
  }
  if (dt) {
    try {
      const text = dt.getData('text/plain');
      if (text) return { type: 'text', markdown: text, text };
    } catch {
      // ignore
    }
  }
  return null;
}

function normalizeTabsOrder(rawOrder) {
  const valid = ['summary', 'chat', 'tools'];
  const result = [];
  if (Array.isArray(rawOrder)) {
    for (const id of rawOrder) {
      if (valid.includes(id) && !result.includes(id)) {
        result.push(id);
      }
    }
  }
  for (const id of valid) {
    if (!result.includes(id)) result.push(id);
  }
  return result;
}

function normalizeModuleList(rawList, defaults, { isTools = false } = {}) {
  const allowed = defaults.map((d) => d.id);
  const seen = new Set();
  const result = [];

  const hasV73ToolId =
    isTools &&
    Array.isArray(rawList) &&
    rawList.some((entry) => {
      const rawId = typeof entry === 'string' ? entry : entry?.id;
      return ['clipboard_snippets', 'doc_outline', 'text_studio', 'focus_pulse'].includes(rawId);
    });

  if (Array.isArray(rawList)) {
    for (const entry of rawList) {
      let id = typeof entry === 'string' ? entry : entry?.id;
      const wasLegacyAiTpl = isTools && id === 'ai_templates';
      if (isTools && id && LEGACY_TOOL_ID_MAP[id]) {
        id = LEGACY_TOOL_ID_MAP[id];
      }
      if (!id || !allowed.includes(id) || seen.has(id)) continue;
      seen.add(id);
      const visible =
        wasLegacyAiTpl && !hasV73ToolId
          ? true
          : typeof entry === 'object' && entry !== null
            ? entry.visible !== false
            : true;
      const collapsed = typeof entry === 'object' && entry !== null ? Boolean(entry.collapsed) : false;
      result.push({ id, visible, collapsed });
    }
  } else if (rawList && typeof rawList === 'object' && Array.isArray(rawList.order)) {
    const hiddenSet = new Set(Array.isArray(rawList.hidden) ? rawList.hidden : []);
    for (let id of rawList.order) {
      if (isTools && id && LEGACY_TOOL_ID_MAP[id]) {
        id = LEGACY_TOOL_ID_MAP[id];
      }
      if (!allowed.includes(id) || seen.has(id)) continue;
      seen.add(id);
      result.push({ id, visible: !hiddenSet.has(id), collapsed: false });
    }
  }

  for (const def of defaults) {
    if (!seen.has(def.id)) {
      seen.add(def.id);
      result.push({ id: def.id, visible: def.visible !== false, collapsed: Boolean(def.collapsed) });
    }
  }
  return result;
}

const RIGHT_MODULE_MIN_HEIGHT = 100;
const RIGHT_MODULE_MAX_HEIGHT = 640;

function getModuleHeight(moduleKey) {
  const raw = store.state.uiLayout?.moduleHeights?.[moduleKey];
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.min(RIGHT_MODULE_MAX_HEIGHT, Math.max(RIGHT_MODULE_MIN_HEIGHT, Math.round(num)));
}

function clearModuleHeight(moduleKey) {
  const curLayout =
    store.state.uiLayout && typeof store.state.uiLayout === 'object' ? store.state.uiLayout : {};
  const nextHeights = { ...(curLayout.moduleHeights || {}) };
  delete nextHeights[moduleKey];
  if (typeof updateUiLayout === 'function') {
    return updateUiLayout({ moduleHeights: nextHeights });
  }
  const nextLayout = { ...curLayout, moduleHeights: nextHeights };
  store.state.uiLayout = nextLayout;
  try {
    localStorage.setItem(UI_LAYOUT_STORAGE_KEY, JSON.stringify(nextLayout));
  } catch {
    // ignore storage errors
  }
  store.emit('ui:layout-changed', nextLayout);
  return nextLayout;
}

function setModuleHeightSafe(moduleKey, px) {
  if (px === null || px === undefined || px === '') {
    return clearModuleHeight(moduleKey);
  }
  const nextPx = Math.min(RIGHT_MODULE_MAX_HEIGHT, Math.max(RIGHT_MODULE_MIN_HEIGHT, Math.round(Number(px))));
  if (typeof setModuleHeight === 'function') {
    return setModuleHeight(moduleKey, nextPx);
  }
  const curLayout =
    store.state.uiLayout && typeof store.state.uiLayout === 'object' ? store.state.uiLayout : {};
  const nextHeights = { ...(curLayout.moduleHeights || {}), [moduleKey]: nextPx };
  const nextLayout = { ...curLayout, moduleHeights: nextHeights };
  store.state.uiLayout = nextLayout;
  try {
    localStorage.setItem(UI_LAYOUT_STORAGE_KEY, JSON.stringify(nextLayout));
  } catch {
    // ignore storage errors
  }
  store.emit('ui:layout-changed', nextLayout);
  return nextLayout;
}

function isMobileRightViewport() {
  if (typeof window === 'undefined') return false;
  return window.innerWidth <= 768 || Boolean(document.body?.classList?.contains('is-android-app'));
}

function renderModuleResizerHtml(id) {
  if (isMobileRightViewport()) return '';
  return `<div class="module-height-resizer" data-resize-module="right_${escapeHtml(id)}" title="上下拖动调节卡片高度（双击恢复自动）" role="separator" aria-orientation="horizontal"></div>`;
}

function buildScrollBodyStyle(id, isEmpty = false) {
  if (isMobileRightViewport()) return isEmpty ? 'min-height:0;' : '';
  const savedH = getModuleHeight(`right_${id}`);
  if (savedH) return `height:${savedH}px;max-height:${savedH}px;overflow-y:auto;`;
  return isEmpty ? 'min-height:0;' : '';
}

function buildScrollBodyClasses(id, isEmpty = false, baseClass = 'module-scroll-body') {
  const savedH = isMobileRightViewport() ? null : getModuleHeight(`right_${id}`);
  const parts = [baseClass];
  if (!savedH) parts.push('is-auto-height');
  if (isEmpty) parts.push('is-empty-compact');
  return parts.join(' ');
}

function getRightModuleSizePreset(modId) {
  const presetKey = `right:${modId}`;
  const raw = store.state.uiLayout?.moduleSizePresets?.[presetKey];
  if (raw === 's' || raw === 'm' || raw === 'l' || raw === 'auto') {
    return raw;
  }
  const h = getModuleHeight(`right_${modId}`);
  if (!h) return 'auto';
  if (h <= 170) return 's';
  if (h <= 320) return 'm';
  return 'l';
}

function isRightModuleFloating(modId) {
  return Boolean(store.state.uiLayout?.floatingModules?.[modId]?.open);
}

function renderRightModuleControlsHtml(modId, title) {
  if (isMobileRightViewport()) return '';
  const curPreset = getRightModuleSizePreset(modId);
  const floated = isRightModuleFloating(modId);
  const labelMap = { s: 'S', m: 'M', l: 'L', auto: 'Auto' };
  const activeLabel = labelMap[curPreset] || 'Auto';
  return `
    <span class="module-hover-controls">
      <button
        type="button"
        class="module-size-pill is-dropdown-trigger"
        data-action="open-module-size-menu"
        data-panel="right"
        data-module-id="${escapeHtml(modId)}"
        data-mod-id="${escapeHtml(modId)}"
        title="调整模块高度档位 (S/M/L/Auto)"
      >${activeLabel} ▾</button>
      <button
        type="button"
        class="left-icon-btn is-xs module-float-btn ${floated ? 'is-active' : ''}"
        data-action="toggle-module-float"
        data-panel="right"
        data-module-id="${escapeHtml(modId)}"
        data-mod-id="${escapeHtml(modId)}"
        data-mod-title="${escapeHtml(title)}"
        title="${floated ? '吸回侧栏' : '弹出为独立浮窗'}"
        aria-label="${floated ? '吸回侧栏' : '弹出为独立浮窗'}"
      >⧉</button>
    </span>
  `;
}

function toggleRightModuleSizePopover(triggerEl, panel, modId) {
  if (typeof document === 'undefined' || !triggerEl || !modId) return;
  let popEl = document.getElementById('module-size-popover');
  if (!popEl) {
    popEl = document.createElement('div');
    popEl.id = 'module-size-popover';
    popEl.className = 'module-size-popover';
    popEl.setAttribute('role', 'menu');
    popEl.hidden = true;
    document.body.appendChild(popEl);
  }

  const triggerKey = `${panel}:${modId}`;
  if (!popEl.hidden && popEl.dataset.triggerKey === triggerKey) {
    popEl.hidden = true;
    popEl.dataset.triggerKey = '';
    triggerEl.setAttribute('aria-expanded', 'false');
    return;
  }

  document.querySelectorAll('.module-size-pill.is-dropdown-trigger[aria-expanded="true"]').forEach((btn) => {
    btn.setAttribute('aria-expanded', 'false');
  });

  const curPreset = getRightModuleSizePreset(modId);
  const options = [
    { key: 's', label: 'S · 紧凑 (150px)' },
    { key: 'm', label: 'M · 标准 (280px)' },
    { key: 'l', label: 'L · 展开 (460px)' },
    { key: 'auto', label: 'Auto · 自适应' },
  ];

  popEl.dataset.triggerKey = triggerKey;
  popEl.innerHTML = options
    .map(
      (opt) => `
        <button
          type="button"
          class="module-size-option module-size-popover-item ${curPreset === opt.key ? 'is-active' : ''}"
          data-size-preset="${opt.key}"
          role="menuitemradio"
          aria-checked="${curPreset === opt.key ? 'true' : 'false'}"
        >
          <span>${escapeHtml(opt.label)}</span>
          <span class="module-size-option-check">✓</span>
        </button>
      `
    )
    .join('');

  popEl.hidden = false;
  triggerEl.setAttribute('aria-expanded', 'true');

  const rect = triggerEl.getBoundingClientRect();
  const popW = popEl.offsetWidth || 148;
  const popH = popEl.offsetHeight || 132;
  const left = Math.max(8, Math.min(window.innerWidth - popW - 8, Math.round(rect.right - popW)));
  const belowTop = Math.round(rect.bottom + 6);
  const aboveTop = Math.round(rect.top - popH - 6);
  const top = belowTop + popH <= window.innerHeight - 8 ? belowTop : Math.max(8, aboveTop);
  popEl.style.left = `${left}px`;
  popEl.style.top = `${top}px`;

  popEl.onclick = (ev) => {
    const optBtn = ev.target.closest('[data-size-preset]');
    if (!optBtn) return;
    ev.stopPropagation();
    const nextPreset = optBtn.dataset.sizePreset || 'auto';
    popEl.hidden = true;
    popEl.dataset.triggerKey = '';
    triggerEl.setAttribute('aria-expanded', 'false');
    setModuleSizePreset?.(panel, modId, nextPreset);
  };

  if (!popEl.dataset.dismissBound) {
    popEl.dataset.dismissBound = '1';
    document.addEventListener('pointerdown', (ev) => {
      if (popEl.hidden) return;
      if (popEl.contains(ev.target)) return;
      if (ev.target.closest?.('[data-action="open-module-size-menu"]')) return;
      popEl.hidden = true;
      popEl.dataset.triggerKey = '';
      document.querySelectorAll('.module-size-pill.is-dropdown-trigger[aria-expanded="true"]').forEach((btn) => {
        btn.setAttribute('aria-expanded', 'false');
      });
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !popEl.hidden) {
        popEl.hidden = true;
        popEl.dataset.triggerKey = '';
        document.querySelectorAll('.module-size-pill.is-dropdown-trigger[aria-expanded="true"]').forEach((btn) => {
          btn.setAttribute('aria-expanded', 'false');
        });
      }
    });
  }
}

function renderFileTypeIconHtml(nameOrExt, size = 14) {
  const ft = getFileTypeStyle(nameOrExt);
  return `<span class="ft-icon ${escapeHtml(ft.cssClass)}" style="--ft-color:${ft.color};--ft-bg:${ft.bg};--ft-border:${ft.border}">${icon(ft.iconName, size)}</span>`;
}

function renderFileTypeBadgeHtml(nameOrExt) {
  const ft = getFileTypeStyle(nameOrExt);
  return `<span class="file-ext-badge ft-badge ${escapeHtml(ft.cssClass)}" style="--ft-color:${ft.color};--ft-bg:${ft.bg};--ft-border:${ft.border}">${escapeHtml(ft.label)}</span>`;
}

function loadSavedV73ToolModules() {
  try {
    const raw = localStorage.getItem(RIGHT_TOOLS_V73_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getUiLayout() {
  const raw = store.state.uiLayout || {};
  const rawTools = Array.isArray(raw.rightToolModules) ? raw.rightToolModules : [];
  const hasV73InStore = rawTools.some((m) =>
    ['clipboard_snippets', 'doc_outline', 'text_studio', 'focus_pulse'].includes(m?.id || m)
  );
  const sourceTools = hasV73InStore ? rawTools : (loadSavedV73ToolModules() || rawTools);
  const normalizedTools = normalizeModuleList(sourceTools, DEFAULT_TOOL_MODULES, { isTools: true });
  if (store.state.uiLayout && typeof store.state.uiLayout === 'object') {
    store.state.uiLayout.rightToolModules = normalizedTools;
  }
  return {
    rightTabsOrder: normalizeTabsOrder(raw.rightTabsOrder || DEFAULT_TABS_ORDER),
    rightSummaryModules: normalizeModuleList(raw.rightSummaryModules, DEFAULT_SUMMARY_MODULES),
    rightToolModules: normalizedTools,
    moduleHeights:
      raw.moduleHeights && typeof raw.moduleHeights === 'object' ? { ...raw.moduleHeights } : {},
  };
}

function commitUiLayout(patch) {
  const prevHeights =
    store.state.uiLayout?.moduleHeights && typeof store.state.uiLayout.moduleHeights === 'object'
      ? { ...store.state.uiLayout.moduleHeights }
      : null;
  const nextToolMods = patch?.rightToolModules
    ? normalizeModuleList(patch.rightToolModules, DEFAULT_TOOL_MODULES, { isTools: true })
    : getUiLayout().rightToolModules;

  if (patch?.rightToolModules) {
    try {
      localStorage.setItem(RIGHT_TOOLS_V73_STORAGE_KEY, JSON.stringify(nextToolMods));
    } catch {
      // ignore storage errors
    }
  }

  if (typeof storeMod.updateUiLayout === 'function') {
    const res = storeMod.updateUiLayout(patch);
    if (res && typeof res === 'object') {
      res.rightToolModules = nextToolMods;
      if (prevHeights && !res.moduleHeights) {
        res.moduleHeights = prevHeights;
      }
      store.state.uiLayout = res;
      try {
        localStorage.setItem(UI_LAYOUT_STORAGE_KEY, JSON.stringify(res));
      } catch {
        // ignore storage errors
      }
    }
    return res;
  }
  const current = getUiLayout();
  const next = {
    rightTabsOrder: patch.rightTabsOrder ? normalizeTabsOrder(patch.rightTabsOrder) : current.rightTabsOrder,
    rightSummaryModules: patch.rightSummaryModules
      ? normalizeModuleList(patch.rightSummaryModules, DEFAULT_SUMMARY_MODULES)
      : current.rightSummaryModules,
    rightToolModules: nextToolMods,
    moduleHeights: patch.moduleHeights || current.moduleHeights || {},
  };
  store.state.uiLayout = next;
  try {
    localStorage.setItem(UI_LAYOUT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore storage errors
  }
  store.emit('ui:layout-changed', next);
  return next;
}

function resetUiLayoutState() {
  try {
    localStorage.removeItem(RIGHT_TOOLS_V73_STORAGE_KEY);
  } catch {
    // ignore
  }
  if (typeof resetUiLayout === 'function') {
    const res = resetUiLayout();
    if (res && typeof res === 'object') {
      res.rightToolModules = DEFAULT_TOOL_MODULES.map((m) => ({ ...m }));
      store.state.uiLayout = res;
    }
    return res;
  }
  if (typeof storeMod.applyPaneWidths === 'function') {
    storeMod.applyPaneWidths(260, 360);
  } else {
    store.state.paneWidths = { left: 260, right: 360 };
  }
  const next = {
    rightTabsOrder: [...DEFAULT_TABS_ORDER],
    rightSummaryModules: DEFAULT_SUMMARY_MODULES.map((m) => ({ ...m })),
    rightToolModules: DEFAULT_TOOL_MODULES.map((m) => ({ ...m })),
    moduleHeights: {},
  };
  store.state.uiLayout = next;
  try {
    localStorage.removeItem(UI_LAYOUT_STORAGE_KEY);
  } catch {
    // ignore
  }
  store.emit('ui:layout-changed', next);
  return next;
}

function getBaseName(pathStr) {
  const s = String(pathStr || '');
  const parts = s.split(/[/\\]/);
  return parts[parts.length - 1] || s;
}

function getFileExt(pathStr) {
  const name = getBaseName(pathStr);
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

function getFormatEmoji(pathStr) {
  const ext = getFileExt(pathStr);
  if (ext === '.pdf') return '📕';
  if (ext === '.xlsx' || ext === '.xlsm' || ext === '.csv') return '📊';
  if (ext === '.md' || ext === '.txt') return '📝';
  return '📄';
}

function buildFileAnchorMarkdown(pathStr, nameStr) {
  const name = nameStr || getBaseName(pathStr);
  const ext = getFileExt(name || pathStr).replace(/^\./, '');
  if (ext === 'pdf') return `[[${name}#page=1]]`;
  if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm') return `[[${name}#A2]]`;
  if (['mp4', 'mp3', 'wav', 'm4a', 'webm', 'mov', 'mkv', 'ogg', 'flac', 'aac'].includes(ext)) {
    return `[[${name}#t=00:00]]`;
  }
  return `[[${name}]]`;
}

function getExcelFiles() {
  const items = store.state.files?.items || [];
  return items.filter((item) => {
    const p = String(item?.path || item?.name || '').toLowerCase();
    return p.endsWith('.xlsx');
  });
}

function formatTriggerTime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return String(isoStr);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${mo}-${da} ${hh}:${mm}:${ss}`;
}

function formatSummaryAsMarkdown(res) {
  if (!res) return '';
  const lines = ['## AI 核心总结', '', res.summary || ''];
  if (Array.isArray(res.tags) && res.tags.length) {
    lines.push('', `**标签**：${res.tags.map((t) => `#${t}`).join(' ')}`);
  }
  if (Array.isArray(res.todos) && res.todos.length) {
    lines.push('', '### 需要做什么');
    for (const td of res.todos) {
      const timeHint = td.suggested_time ? ` *(${td.suggested_time})*` : '';
      lines.push(`- [ ] ${td.title}${timeHint}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function buildTreeRenderList(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const byId = new Map(list.map((n) => [String(n.id), n]));
  const childrenMap = new Map();
  const roots = [];

  for (const node of list) {
    const pid = node.parent_id ? String(node.parent_id) : null;
    if (pid && byId.has(pid) && pid !== String(node.id)) {
      if (!childrenMap.has(pid)) childrenMap.set(pid, []);
      childrenMap.get(pid).push(node);
    } else {
      roots.push(node);
    }
  }

  const ordered = [];
  const visited = new Set();
  const visit = (node, depth) => {
    const id = String(node.id);
    if (visited.has(id)) return;
    visited.add(id);
    ordered.push({ node, depth: Math.min(depth, 4) });
    for (const child of childrenMap.get(id) || []) {
      visit(child, depth + 1);
    }
  };
  for (const r of roots) visit(r, 0);
  for (const n of list) {
    if (!visited.has(String(n.id))) visit(n, 0);
  }
  return ordered;
}

function moveArrayItem(arr, index, delta) {
  const next = [...arr];
  const target = index + delta;
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) {
    return next;
  }
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

/**
 * Initialize Right Copilot Panel (V2).
 * @param {HTMLElement} containerEl
 */
export function initRightPanel(containerEl) {
  if (!containerEl) return;

  const state = {
    mode: store.state.rightMode || 'summary',
    summaryInputText: '',
    summaryLoading: false,
    summaryError: '',
    summaryResult: null,
    liveProviderLabel: '',

    reminders: Array.isArray(store.state.reminders) ? store.state.reminders : [],

    chatMessages: [],
    chatDraft: '',
    webSearch: false,
    chatStreaming: false,
    chatAbort: null,

    selectedExcelPath: '',
    excelSheets: [],
    selectedSheet: '',
    excelLoading: false,
    excelSubmitting: false,

    treeViewMode: 'tree', // 'tree' | 'table'
    treeData: {
      nodes: Array.isArray(store.state.tree?.nodes) ? store.state.tree.nodes : [],
      table_rows: [],
    },
    inlineTreeCreateOpen: false,
    inlineTreeCreateDraft: '',
    classifyResult: null,
    classifyLoading: false,
    classifyTargetPath: '',

    inlineSnippetCreateOpen: false,
    inlineSnippetTitleDraft: '',
    inlineSnippetContentDraft: '',
    studioText: '',
  };

  function setBgAiTaskSafe(task) {
    const fn = storeMod.setBgAiTask || store.setBgAiTask;
    if (typeof fn === 'function') {
      return fn(task);
    }
    store.state.bgAiTask = task || null;
    store.emit('ai:bg-task', task || null);
    return task;
  }

  let msgSeq = 1;
  let draggedToolModuleId = null;
  let isResizingRightModule = false;
  const toolOpenStateById = new Map([
    ['quick_excel', true],
    ['clipboard_snippets', true],
    ['doc_outline', true],
    ['text_studio', false],
    ['focus_pulse', true],
    ['knowledge_tree', false],
    ['apps_workspaces', false],
    ['ai_templates', false],
  ]);

  function getTabsOrder() {
    return getUiLayout().rightTabsOrder;
  }

  function getModeIndex(mode) {
    const order = getTabsOrder();
    const idx = order.indexOf(mode);
    return idx >= 0 ? idx : 0;
  }

  function getAiStatusInfo() {
    const aiCfg = store.state.config?.ai || {};
    const sysInfo = store.state.systemInfo || {};
    const hasKey = Boolean(String(aiCfg.api_key || '').trim() || sysInfo.ai_configured);
    const freeAiEnabled =
      aiCfg.enable_free_ai !== undefined
        ? Boolean(aiCfg.enable_free_ai)
        : sysInfo.free_ai_enabled !== false;
    const model = String(aiCfg.model || 'qwen-plus').trim() || 'qwen-plus';
    const live = String(state.liveProviderLabel || '').trim();

    if (live) {
      if (live.includes('本地规则') || live.includes('离线')) {
        return {
          dot: '⚪',
          tone: 'neutral',
          label: live,
          title: '当前使用本地规则引擎 · 点击配置模型或开启免费基础 AI',
        };
      }
      if (live.includes('免费')) {
        return {
          dot: '🟢',
          tone: 'success',
          label: live,
          title: '免费基础 AI 运行中（免 Key） · 点击切换自定义模型或预设',
        };
      }
      return {
        dot: '🔵',
        tone: 'accent',
        label: live,
        title: '自定义大模型已激活 · 点击调整 AI 设置',
      };
    }

    if (hasKey) {
      return {
        dot: '🔵',
        tone: 'accent',
        label: `自定义模型 (${model})`,
        title: `已配置 API Key · 当前模型 ${model}（点击修改）`,
      };
    }
    if (freeAiEnabled) {
      return {
        dot: '🟢',
        tone: 'success',
        label: '免费基础 AI',
        title: '免 Key 免费基础 AI 已开启 · 点击配置自定义模型',
      };
    }
    return {
      dot: '⚪',
      tone: 'neutral',
      label: '本地规则引擎',
      title: '当前为本地规则引擎 · 点击开启免费基础 AI 或填写 API Key',
    };
  }

  function renderAiStatusPillHtml() {
    const info = getAiStatusInfo();
    const toneStyle =
      info.tone === 'success'
        ? 'background:var(--success-soft);color:var(--success);border-color:transparent;'
        : info.tone === 'accent'
        ? 'background:var(--accent-soft);color:var(--accent);border-color:transparent;'
        : 'background:var(--bg-subtle);color:var(--text-secondary);border-color:var(--border-hairline);';

    return `
      <button
        type="button"
        class="pill-btn pill-btn-sm ai-status-pill"
        data-action="open-ai-settings"
        title="${escapeHtml(info.title)}"
        style="height:24px;padding:0 10px;font-size:11.5px;max-width:100%;overflow:hidden;${toneStyle}"
      >
        <span aria-hidden="true">${info.dot}</span>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(info.label)}</span>
      </button>
    `;
  }

  function renderAiStatusBannerHtml(extraRightHtml = '') {
    return `
      <div class="ai-status-header-bar" style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
        ${renderAiStatusPillHtml()}
        ${extraRightHtml}
      </div>
    `;
  }

  function renderAiTemplatesCardContentHtml() {
    const activeName = store.state.activeFile?.name || '';
    const ctxCount = (store.state.selectedContextPaths || []).length;
    const hintText = activeName
      ? `将结合「${activeName}」切换至问答发送，或直接执行脑图/润色`
      : ctxCount > 0
      ? `将结合已勾选的 ${ctxCount} 份文档发送`
      : '点击即自动切换问答并发送指令';

    return `
      <div style="font-size:11.5px;color:var(--text-tertiary);margin-bottom:8px;">
        ${escapeHtml(hintText)}
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">
        <button
          type="button"
          class="pill-btn pill-btn-sm pill-btn-primary"
          data-action="ai-generate-mindmap"
          title="基于当前文档生成结构化脑图大纲，并可保存或切换脑图视图"
          style="height:28px;font-size:12px;"
        >
          🧠 AI 生成当前文档脑图
        </button>
        <button
          type="button"
          class="pill-btn pill-btn-sm"
          data-action="ai-polish-fragments"
          title="将当前笔记中的零散碎片智能润色整理为连贯文章（保留 [[...]] 锚点）"
          style="height:28px;font-size:12px;"
        >
          ✨ AI 碎片润色成文
        </button>
        ${AI_PROMPT_TEMPLATES.map(
          (tpl) => `
          <button
            type="button"
            class="pill-btn pill-btn-sm"
            data-action="use-ai-template"
            data-template-id="${escapeHtml(tpl.id)}"
            title="${escapeHtml(tpl.prompt)}"
            style="height:28px;font-size:12px;"
          >
            ${escapeHtml(tpl.label)}
          </button>
        `
        ).join('')}
      </div>
    `;
  }

  // Mark right panel as drop zone for cross-panel file & text blocks
  containerEl.setAttribute('data-drop-zone', 'right-ai');

  // Build persistent shell so .right-mode-header & .segmented-thumb animate smoothly without DOM destruction
  containerEl.innerHTML = `
    <div class="right-mode-header" style="gap:8px;">
      <div class="segmented-pill" data-seg="right-mode" role="tablist" aria-label="AI 副驾驶模式" style="flex:1 1 auto;min-width:0;">
        <div class="segmented-thumb" style="width: calc((100% - 6px) / 3); transform: translateX(${getModeIndex(state.mode) * 100}%);"></div>
      </div>
      <button
        type="button"
        class="icon-pill right-customize-btn"
        data-action="open-right-customize"
        title="自定义右侧模块"
        aria-label="自定义右侧模块"
        style="width:32px;height:32px;flex-shrink:0;"
      >
        ${icon('settings', 15)}
      </button>
    </div>
    <div class="right-panels-stage" style="flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden;">
      <div class="panel-body" data-mode-panel="summary"></div>
      <div class="chat-layout" data-mode-panel="chat" hidden></div>
      <div class="panel-body" data-mode-panel="tools" hidden></div>
    </div>
  `;

  const segPill = containerEl.querySelector('.segmented-pill[data-seg="right-mode"]');
  const summaryEl = containerEl.querySelector('[data-mode-panel="summary"]');
  const chatEl = containerEl.querySelector('[data-mode-panel="chat"]');
  const toolsEl = containerEl.querySelector('[data-mode-panel="tools"]');

  function renderTabsHeader() {
    if (!segPill) return;
    const order = getTabsOrder();
    const activeIdx = getModeIndex(state.mode);
    segPill.innerHTML = `
      <div class="segmented-thumb" style="width: calc((100% - 6px) / ${order.length}); transform: translateX(${activeIdx * 100}%);"></div>
      ${order
        .map((tabId) => {
          const meta = TAB_META[tabId] || { id: tabId, label: tabId };
          const isActive = state.mode === meta.id;
          return `
            <button
              type="button"
              class="segmented-btn ${isActive ? 'is-active' : ''}"
              data-mode="${escapeHtml(meta.id)}"
              role="tab"
              aria-selected="${isActive ? 'true' : 'false'}"
            >${escapeHtml(meta.label)}</button>
          `;
        })
        .join('')}
    `;
  }

  function syncModeHeader() {
    const segThumb = segPill?.querySelector('.segmented-thumb');
    const idx = getModeIndex(state.mode);
    if (segThumb) {
      segThumb.style.transform = `translateX(${idx * 100}%)`;
    }
    segPill?.querySelectorAll('.segmented-btn').forEach((btn) => {
      const active = btn.dataset.mode === state.mode;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (summaryEl) summaryEl.hidden = state.mode !== 'summary';
    if (chatEl) chatEl.hidden = state.mode !== 'chat';
    if (toolsEl) toolsEl.hidden = state.mode !== 'tools';
  }

  function ensureVisibleOnMobileOrCollapsed() {
    let changed = false;
    const patch = {};
    if (isMobileRightViewport() && store.state.mobileTab !== 'ai') {
      patch.mobileTab = 'ai';
      changed = true;
    }
    if (store.state.rightCollapsed) {
      patch.rightCollapsed = false;
      changed = true;
    }
    if (changed) {
      store.setState(patch, 'layout:changed');
    }
  }

  function switchMode(nextMode, { emitEvent = true } = {}) {
    const valid = Boolean(TAB_META[nextMode]) ? nextMode : 'summary';
    const changed = valid !== state.mode;
    state.mode = valid;
    store.state.rightMode = valid;
    syncModeHeader();
    if (valid === 'chat') {
      scrollChatToBottom();
    } else if (valid === 'tools') {
      syncExcelSelection();
    }
    if (changed && emitEvent) {
      store.emit('right:mode', valid);
    }
  }

  // ---------------------------------------------------------------------------
  // Pain Point #4: Right Panel Modular Customization Sheet
  // ---------------------------------------------------------------------------

  function openRightCustomizeSheet() {
    openSheet({
      title: '自定义右侧模块',
      bodyHtml: `<div id="right-customize-root" style="display:flex;flex-direction:column;gap:14px;"></div>`,
      footerHtml: `
        <button type="button" class="pill-btn" id="customize-reset-btn">
          ↺ 恢复默认尺寸与布局
        </button>
        <button type="button" class="pill-btn pill-btn-primary" id="customize-done-btn">完成</button>
      `,
      onMount(card) {
        const root = card.querySelector('#right-customize-root');

        const renderCustomizeBody = () => {
          if (!root) return;
          const layout = getUiLayout();
          const curRightW = Math.round(Number(store.state.paneWidths?.right) || 360);

          const widthHtml = `
            <div class="glass-card" style="padding:10px 12px;display:flex;flex-direction:column;gap:8px;">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                <span style="font-size:12.5px;font-weight:600;color:var(--text-primary);">右侧栏整体宽度 (280~560px)</span>
                <span id="right-pane-width-val" style="font-size:12px;font-weight:600;color:var(--accent);">${curRightW}px</span>
              </div>
              <input type="range" id="right-pane-width-range" min="280" max="560" step="2" value="${curRightW}" style="width:100%;" />
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <button type="button" class="pill-btn pill-btn-sm ${Math.abs(curRightW - 300) <= 15 ? 'pill-btn-primary' : ''}" data-right-w="300">窄 300</button>
                <button type="button" class="pill-btn pill-btn-sm ${Math.abs(curRightW - 360) <= 20 ? 'pill-btn-primary' : ''}" data-right-w="360">标准 360</button>
                <button type="button" class="pill-btn pill-btn-sm ${Math.abs(curRightW - 460) <= 25 ? 'pill-btn-primary' : ''}" data-right-w="460">宽 460</button>
              </div>
            </div>
          `;

          const tabsHtml = layout.rightTabsOrder
            .map((tabId, idx) => {
              const meta = TAB_META[tabId] || { label: tabId };
              return `
                <div class="glass-card" style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 11px;">
                  <span style="font-size:13px;font-weight:500;">${escapeHtml(meta.label)}</span>
                  <div style="display:inline-flex;gap:4px;">
                    <button type="button" class="icon-pill" data-cust-tab-move="${idx}" data-delta="-1" ${idx === 0 ? 'disabled' : ''} title="上移" style="width:26px;height:26px;font-size:12px;">↑</button>
                    <button type="button" class="icon-pill" data-cust-tab-move="${idx}" data-delta="1" ${idx === layout.rightTabsOrder.length - 1 ? 'disabled' : ''} title="下移" style="width:26px;height:26px;font-size:12px;">↓</button>
                  </div>
                </div>
              `;
            })
            .join('');

          const renderModuleSection = (list, metaMap, groupKey) =>
            list
              .map((mod, idx) => {
                const label = metaMap[mod.id]?.label || mod.id;
                const runtimeModId =
                  groupKey === 'rightSummaryModules' && mod.id === 'ai_templates'
                    ? 'ai_templates_summary'
                    : mod.id;
                const curPreset = getRightModuleSizePreset(runtimeModId);
                const floated = isRightModuleFloating(runtimeModId);
                return `
                  <div class="glass-card" style="display:flex;flex-direction:column;gap:8px;padding:8px 11px;">
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                      <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;min-width:0;flex:1;">
                        <input type="checkbox" class="file-check" data-cust-toggle="${groupKey}" data-idx="${idx}" ${mod.visible ? 'checked' : ''} />
                        <span style="font-size:13px;font-weight:500;${mod.visible ? '' : 'color:var(--text-tertiary);text-decoration:line-through;'}">${escapeHtml(label)}</span>
                      </label>
                      <div style="display:inline-flex;gap:4px;flex-shrink:0;">
                        <button type="button" class="icon-pill" data-cust-mod-move="${groupKey}" data-idx="${idx}" data-delta="-1" ${idx === 0 ? 'disabled' : ''} title="上移" style="width:26px;height:26px;font-size:12px;">↑</button>
                        <button type="button" class="icon-pill" data-cust-mod-move="${groupKey}" data-idx="${idx}" data-delta="1" ${idx === list.length - 1 ? 'disabled' : ''} title="下移" style="width:26px;height:26px;font-size:12px;">↓</button>
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
                            (p) => `<button type="button" class="pill-btn pill-btn-sm ${curPreset === p.key ? 'pill-btn-primary' : ''}" data-cust-mod-size="${p.key}" data-runtime-mod-id="${escapeHtml(runtimeModId)}" style="height:22px;padding:0 8px;font-size:11px;">${p.label}</button>`
                          )
                          .join('')}
                      </div>
                      <button
                        type="button"
                        class="pill-btn pill-btn-sm ${floated ? 'pill-btn-primary' : ''}"
                        data-cust-mod-float="${escapeHtml(runtimeModId)}"
                        data-cust-mod-title="${escapeHtml(label)}"
                        style="height:22px;padding:0 9px;font-size:11px;"
                      >
                        ⧉ ${floated ? '已浮窗（点此吸回）' : '弹出浮窗'}
                      </button>
                    </div>
                  </div>
                `;
              })
              .join('');

          root.innerHTML = `
            ${widthHtml}
            <div>
              <div class="section-heading" style="margin-top:0;">顶部 3 个标签页顺序</div>
              <div style="display:flex;flex-direction:column;gap:6px;">${tabsHtml}</div>
            </div>
            <div>
              <div class="section-heading">AI 总结页子模块（显隐与顺序）</div>
              <div style="display:flex;flex-direction:column;gap:6px;">
                ${renderModuleSection(layout.rightSummaryModules, SUMMARY_MODULE_META, 'rightSummaryModules')}
              </div>
            </div>
            <div>
              <div class="section-heading">工具台模块卡片（显隐与顺序）</div>
              <div style="display:flex;flex-direction:column;gap:6px;">
                ${renderModuleSection(layout.rightToolModules, TOOL_MODULE_META, 'rightToolModules')}
              </div>
            </div>
          `;
        };

        renderCustomizeBody();

        root?.addEventListener('input', (e) => {
          const range = e.target.closest('#right-pane-width-range');
          if (!range) return;
          const nextW = Number(range.value) || 360;
          applyPaneWidths?.(store.state.paneWidths?.left ?? 260, nextW);
          const valEl = root.querySelector('#right-pane-width-val');
          if (valEl) valEl.textContent = `${nextW}px`;
        });

        root?.addEventListener('change', (e) => {
          if (e.target.closest('#right-pane-width-range')) {
            renderCustomizeBody();
            return;
          }
          const chk = e.target.closest('[data-cust-toggle]');
          if (!chk) return;
          const groupKey = chk.dataset.custToggle;
          const idx = Number(chk.dataset.idx);
          const layout = getUiLayout();
          const list = [...(layout[groupKey] || [])];
          if (!list[idx]) return;
          list[idx] = { ...list[idx], visible: chk.checked };
          commitUiLayout({ [groupKey]: list });
          renderCustomizeBody();
        });

        root?.addEventListener('click', (e) => {
          const widthBtn = e.target.closest('[data-right-w]');
          if (widthBtn) {
            const w = Number(widthBtn.dataset.rightW) || 360;
            applyPaneWidths?.(store.state.paneWidths?.left ?? 260, w);
            renderCustomizeBody();
            return;
          }

          const sizeBtn = e.target.closest('[data-cust-mod-size]');
          if (sizeBtn) {
            const modId = sizeBtn.dataset.runtimeModId;
            const preset = sizeBtn.dataset.custModSize;
            if (modId && preset) {
              setModuleSizePreset?.('right', modId, preset);
              renderCustomizeBody();
            }
            return;
          }

          const floatBtn = e.target.closest('[data-cust-mod-float]');
          if (floatBtn) {
            const modId = floatBtn.dataset.custModFloat;
            const title = floatBtn.dataset.custModTitle || modId;
            if (modId) {
              toggleModuleFloat?.(modId, { title, panel: 'right' });
              renderCustomizeBody();
            }
            return;
          }

          const tabBtn = e.target.closest('[data-cust-tab-move]');
          if (tabBtn) {
            const idx = Number(tabBtn.dataset.custTabMove);
            const delta = Number(tabBtn.dataset.delta);
            const layout = getUiLayout();
            const nextTabs = moveArrayItem(layout.rightTabsOrder, idx, delta);
            commitUiLayout({ rightTabsOrder: nextTabs });
            renderCustomizeBody();
            return;
          }

          const modBtn = e.target.closest('[data-cust-mod-move]');
          if (modBtn) {
            const groupKey = modBtn.dataset.custModMove;
            const idx = Number(modBtn.dataset.idx);
            const delta = Number(modBtn.dataset.delta);
            const layout = getUiLayout();
            const nextList = moveArrayItem(layout[groupKey] || [], idx, delta);
            commitUiLayout({ [groupKey]: nextList });
            renderCustomizeBody();
          }
        });

        card.querySelector('#customize-reset-btn')?.addEventListener('click', () => {
          resetUiLayoutState();
          renderCustomizeBody();
          showToast('已恢复默认三栏宽度与模块尺寸', 'success');
        });

        card.querySelector('#customize-done-btn')?.addEventListener('click', closeSheet);
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Data Loaders
  // ---------------------------------------------------------------------------

  async function fetchReminders() {
    try {
      const list = await api.get('/api/reminders');
      state.reminders = Array.isArray(list) ? list : [];
      store.setState({ reminders: state.reminders });
      renderSummaryMode();
    } catch {
      // ignore initial fetch failure
    }
  }

  async function fetchTree() {
    try {
      const data = await api.get('/api/tree');
      const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
      const tableRows = Array.isArray(data?.table_rows) ? data.table_rows : [];
      state.treeData = { nodes, table_rows: tableRows };
      store.setState({ tree: { nodes } });
      renderToolsMode();
    } catch {
      // ignore
    }
  }

  async function fetchAppsAndWorkspaces() {
    try {
      const [apps, workspaces] = await Promise.all([
        api.get('/api/apps').catch(() => store.state.apps || []),
        api.get('/api/workspaces').catch(() => store.state.workspaces || []),
      ]);
      store.setState({
        apps: Array.isArray(apps) ? apps : [],
        workspaces: Array.isArray(workspaces) ? workspaces : [],
      });
      renderSummaryMode();
      renderToolsMode();
    } catch {
      // ignore
    }
  }

  async function fetchFilesIfNeeded() {
    if ((store.state.files?.items || []).length > 0) return;
    try {
      const data = await api.get('/api/files/list');
      if (data && typeof data === 'object') {
        store.setState({ files: data });
      }
    } catch {
      // ignore
    }
  }

  async function loadExcelSheets(pathStr) {
    if (!pathStr) {
      state.excelSheets = [];
      state.selectedSheet = '';
      renderToolsMode();
      return;
    }
    state.excelLoading = true;
    renderToolsMode();
    try {
      const data = await api.get(`/api/excel/sheets?path=${encodeURIComponent(pathStr)}`);
      const sheets = Array.isArray(data?.sheets) ? data.sheets : [];
      state.excelSheets = sheets;
      if (!sheets.some((s) => s.name === state.selectedSheet)) {
        state.selectedSheet = sheets[0]?.name || '';
      }
    } catch (err) {
      state.excelSheets = [];
      state.selectedSheet = '';
      showToast(err.message || '读取 Excel 工作表失败', 'error');
    } finally {
      state.excelLoading = false;
      renderToolsMode();
    }
  }

  function syncExcelSelection() {
    const excelFiles = getExcelFiles();
    if (excelFiles.length === 0) {
      state.selectedExcelPath = '';
      state.excelSheets = [];
      state.selectedSheet = '';
      renderToolsMode();
      return;
    }
    const activePath = store.state.activeFile?.path || '';
    const activeIsExcel = excelFiles.some((f) => f.path === activePath);
    const currentValid = excelFiles.some((f) => f.path === state.selectedExcelPath);

    let nextPath = state.selectedExcelPath;
    if (!currentValid) {
      nextPath = activeIsExcel ? activePath : excelFiles[0].path;
    }
    if (nextPath && (nextPath !== state.selectedExcelPath || state.excelSheets.length === 0)) {
      state.selectedExcelPath = nextPath;
      loadExcelSheets(nextPath);
    } else {
      renderToolsMode();
    }
  }

  // ---------------------------------------------------------------------------
  // MODE 1: AI Summary Renderer & Actions
  // ---------------------------------------------------------------------------

  function resolveMatchedApps(res) {
    if (Array.isArray(res?.matched_apps) && res.matched_apps.length > 0) {
      return res.matched_apps;
    }
    const ids = Array.isArray(res?.matched_app_ids) ? res.matched_app_ids : [];
    const allApps = store.state.apps || [];
    return ids.map((id) => allApps.find((a) => a.id === id)).filter(Boolean);
  }

  function renderSummaryMode() {
    if (!summaryEl) return;
    const activeFile = store.state.activeFile;
    const activeLabel = activeFile?.name ? `当前文档：${activeFile.name}` : '当前为草稿正文';
    const res = state.summaryResult;
    const matchedApps = resolveMatchedApps(res);
    const matchedFiles = Array.isArray(res?.matched_files) ? res.matched_files : [];
    const pendingAndFired = [...(state.reminders || [])].reverse();

    const summaryModulesMap = new Map(getUiLayout().rightSummaryModules.map((m) => [m.id, m]));
    const isCollapsedMod = (id) => Boolean(summaryModulesMap.get(id)?.collapsed);

    const inputScrollCls = buildScrollBodyClasses('input', false);
    const inputScrollStyle = buildScrollBodyStyle('input', false);
    const inputHtml = `
      <div class="glass-card module-block ${isCollapsedMod('input') ? 'is-collapsed' : ''}" data-module-id="input" data-summary-module-id="input" style="margin-bottom:10px;padding:10px 12px 4px;">
        <div class="module-header" style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:6px;">
          <span style="font-size:11.5px;font-weight:600;color:var(--text-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">速记与智能提炼</span>
          <div style="display:inline-flex;align-items:center;gap:4px;flex-shrink:0;">
            <span style="font-size:10.5px;color:var(--text-tertiary);max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(activeLabel)}">${escapeHtml(activeFile?.name || '草稿')}</span>
            ${renderRightModuleControlsHtml('input', '速记与智能提炼')}
          </div>
        </div>
        <div class="module-content">
          <div class="${inputScrollCls}" data-scroll-module="right_input" ${inputScrollStyle ? `style="${inputScrollStyle}"` : 'style="min-height:0;"'}>
            <textarea
              id="right-summary-input"
              class="apple-textarea"
              rows="3"
              style="min-height:68px;font-size:13px;"
              placeholder="随时记下一段想法、会议记录或复习安排，点击 AI 自动提炼待办与软件直达..."
            >${escapeHtml(state.summaryInputText)}</textarea>
            <div style="display:flex;gap:6px;margin-top:8px;">
              <button type="button" class="pill-btn pill-btn-primary pill-btn-sm" data-action="summarize-doc" style="flex:1;justify-content:center;" ${state.summaryLoading ? 'disabled' : ''}>
                ${icon('sparkles', 13)} ${state.summaryLoading ? '提炼中...' : '总结当前文档'}
              </button>
              <button type="button" class="pill-btn pill-btn-sm" data-action="summarize-text" style="flex:1;justify-content:center;" ${state.summaryLoading ? 'disabled' : ''}>
                提炼上方文本
              </button>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;">
              <button type="button" class="pill-btn pill-btn-sm right-micro-chip" data-action="ai-generate-mindmap" title="生成当前文档脑图或切换脑图视图" style="height:24px;padding:0 9px;font-size:11px;">
                🧠 生成脑图
              </button>
              <button type="button" class="pill-btn pill-btn-sm right-micro-chip" data-action="ai-polish-fragments" title="将碎片内容智能润色成文（保留 [[...]] 锚点）" style="height:24px;padding:0 9px;font-size:11px;">
                🪄 润色成文
              </button>
            </div>
          </div>
          ${renderModuleResizerHtml('input')}
        </div>
      </div>
    `;

    let resultHtml = '';
    const isSummaryEmpty = !state.summaryError && !res;
    if (state.summaryError) {
      resultHtml = `
        <div class="summary-card" style="border-color: var(--warning); background: var(--warning-soft);">
          <div style="display:flex;align-items:center;gap:6px;font-weight:600;color:var(--warning);margin-bottom:4px;">
            ${icon('lock', 14)} <span>安全拦截 / 总结失败</span>
          </div>
          <p style="margin:0;font-size:12.5px;color:var(--text-primary);">${escapeHtml(state.summaryError)}</p>
        </div>
      `;
    } else if (res) {
      const todos = Array.isArray(res.todos) ? res.todos : [];
      const tags = Array.isArray(res.tags) ? res.tags : [];
      const providerBadgeText = res.provider_label
        ? res.provider_label
        : res.offline_mode
        ? '离线规则提取'
        : '大模型增强';
      const isOfflineBadge = res.offline_mode && !String(res.provider_label || '').includes('免费');

      resultHtml = `
        <div class="summary-card draggable-card" draggable="true" data-drag-type="ai-summary">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
            <span style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:600;color:var(--accent);">
              ${icon('sparkles', 14)} AI 结构化摘要
            </span>
            <div style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;">
              <span class="drag-pill-hint" title="按住直接拖进中间笔记栏" style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:9999px;font-size:11px;color:var(--text-secondary);background:var(--bg-island);border:1px dashed var(--border-hairline);cursor:grab;">
                ${icon('layers', 11)} 拖入笔记
              </span>
              ${
                isOfflineBadge
                  ? `<span class="pill-btn pill-btn-sm" title="离线规则提取模式 · 配置 API Key 或开启免费基础 AI 升级" style="height:22px;padding:0 8px;font-size:11px;background:var(--warning-soft);color:var(--warning);border-color:transparent;cursor:help;">${escapeHtml(providerBadgeText)}</span>`
                  : `<span class="pill-btn pill-btn-sm" style="height:22px;padding:0 8px;font-size:11px;background:var(--success-soft);color:var(--success);border-color:transparent;">${escapeHtml(providerBadgeText)}</span>`
              }
              <button type="button" class="pill-btn pill-btn-sm" data-action="insert-summary-doc">
                ${icon('plus', 12)} 插入当前文档
              </button>
            </div>
          </div>

          <div class="md-preview" style="padding:0;font-size:13.5px;line-height:1.6;">
            ${renderMarkdownSafe(res.summary || '', { compactMedia: true })}
          </div>

          ${
            tags.length
              ? `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:8px;">
                  ${tags
                    .map(
                      (t) =>
                        `<span style="padding:2px 8px;border-radius:9999px;background:var(--accent-soft);color:var(--accent);font-size:11.5px;font-weight:500;">#${escapeHtml(t)}</span>`
                    )
                    .join('')}
                </div>`
              : ''
          }
          ${
            res.trigger_time
              ? `<div style="margin-top:8px;font-size:11.5px;color:var(--text-secondary);display:flex;align-items:center;gap:5px;">
                  ${icon('clock', 12)} <span>识别到时间线索：<strong>${escapeHtml(res.trigger_time)}</strong></span>
                </div>`
              : ''
          }
        </div>

        <div class="section-heading" style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
          <span>需要做什么 (${todos.length})</span>
          <button type="button" class="pill-btn pill-btn-sm pill-btn-ghost" data-action="open-global-todos" title="前往中心全库待办整理面板" style="height:22px;padding:0 7px;font-size:11px;">
            ↗ 全局待办
          </button>
        </div>

        ${
          todos.length
            ? todos
                .map((td, idx) => {
                  const prioBadge =
                    td.priority === 'high'
                      ? `<span class="todo-prio-badge" style="padding:0 6px;border-radius:9999px;background:var(--danger-soft);color:var(--danger);font-size:10px;font-weight:600;flex-shrink:0;">优先</span>`
                      : '';
                  const timeBadge = td.suggested_time
                    ? `<span class="todo-time-badge" style="font-size:10.5px;color:var(--text-tertiary);white-space:nowrap;">${escapeHtml(td.suggested_time)}</span>`
                    : '';
                  return `
                    <div class="todo-item todo-item-compact draggable-card" draggable="true" data-drag-type="ai-todo" data-todo-idx="${idx}">
                      <span class="todo-drag-grip" title="按住拖进中间笔记栏" aria-hidden="true" style="color:var(--text-tertiary);display:inline-flex;flex-shrink:0;cursor:grab;">
                        ${icon('grip-vertical', 12)}
                      </span>
                      <div class="todo-compact-main" style="min-width:0;flex:1 1 auto;">
                        <div class="todo-title">${escapeHtml(td.title)}</div>
                        ${
                          prioBadge || timeBadge
                            ? `<div class="todo-compact-meta" style="display:flex;align-items:center;gap:5px;margin-top:2px;">${prioBadge}${timeBadge}</div>`
                            : ''
                        }
                      </div>
                      <div class="todo-hover-actions" style="display:inline-flex;align-items:center;gap:3px;flex-shrink:0;">
                        <button type="button" class="left-icon-btn is-xs" data-action="todo-insert-note" data-todo-idx="${idx}" title="插入当前笔记" aria-label="插入当前笔记">
                          ${icon('plus', 12)}
                        </button>
                        <button type="button" class="left-icon-btn is-xs" data-action="open-reminder-sheet" data-todo-idx="${idx}" title="设提醒" aria-label="设提醒">
                          ${icon('bell', 12)}
                        </button>
                        <button type="button" class="left-icon-btn is-xs" data-action="start-todo-focus" data-todo-idx="${idx}" title="选择专注时长" aria-label="选择专注时长">
                          ${icon('clock', 12)}
                        </button>
                      </div>
                    </div>
                  `;
                })
                .join('')
            : `<div style="font-size:12px;color:var(--text-tertiary);padding:4px 2px;">暂无具体待办项</div>`
        }

        ${
          matchedApps.length || matchedFiles.length
            ? `
            <div class="summary-card" style="margin-top:10px;">
              <div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:8px;display:flex;align-items:center;gap:5px;">
                ${icon('rocket', 13)} <span>识别到的本地办公软件与关联资料直达</span>
              </div>
              <div class="app-pill-grid">
                ${matchedApps
                  .map(
                    (app) => `
                    <button type="button" class="app-launcher-pill" draggable="true" data-action="launch-app" data-app-id="${escapeHtml(app.id)}" data-name="${escapeHtml(app.name)}" title="点击启动，或直接拖进中间笔记生成直达胶囊">
                      ${icon('external-link', 12)}
                      <span>${escapeHtml(app.name)}</span>
                    </button>
                  `
                  )
                  .join('')}
                ${matchedFiles
                  .map(
                    (fp) => `
                    <button type="button" class="app-launcher-pill matched-file-pill" draggable="true" data-action="open-matched-file" data-path="${escapeHtml(fp)}" data-name="${escapeHtml(getBaseName(fp))}" title="点击打开，或直接拖进中间笔记生成锚点" style="background:var(--accent-soft);color:var(--accent);border-color:transparent;">
                      ${renderFileTypeIconHtml(getBaseName(fp), 13)}
                      <span>${escapeHtml(getBaseName(fp))}</span>
                    </button>
                  `
                  )
                  .join('')}
              </div>
            </div>
          `
            : ''
        }
      `;
    } else {
      resultHtml = `<div class="compact-empty-hint" style="font-size:12px;color:var(--text-tertiary);padding:4px 2px;">暂无 AI 摘要与待办，点击上方「总结当前文档」或「提炼上方文本」即可生成</div>`;
    }

    const sumCardCls = buildScrollBodyClasses('summary_card', isSummaryEmpty);
    const sumCardStyle = buildScrollBodyStyle('summary_card', isSummaryEmpty);
    const summaryCardModuleHtml = `
      <div class="module-block ${isCollapsedMod('summary_card') ? 'is-collapsed' : ''}" data-module-id="summary_card" data-summary-module-id="summary_card" style="padding:0;background:transparent;border:none;margin-bottom:10px;">
        <div class="module-header" style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:2px 2px 6px;">
          <span style="font-size:11.5px;font-weight:600;color:var(--text-secondary);">AI 摘要与待办</span>
          ${renderRightModuleControlsHtml('summary_card', 'AI 摘要与待办')}
        </div>
        <div class="module-content">
          <div class="${sumCardCls}" data-scroll-module="right_summary_card" style="${sumCardStyle}min-height:0;">
            ${resultHtml}
          </div>
          ${renderModuleResizerHtml('summary_card')}
        </div>
      </div>
    `;

    const isRemEmpty = pendingAndFired.length === 0;
    const remCls = buildScrollBodyClasses('reminders', isRemEmpty);
    const remStyle = buildScrollBodyStyle('reminders', isRemEmpty);
    const remindersHtml = `
      <div class="module-block ${isCollapsedMod('reminders') ? 'is-collapsed' : ''}" data-module-id="reminders" data-summary-module-id="reminders" style="padding:0;background:transparent;border:none;margin-bottom:10px;">
        <div class="section-heading module-header" style="margin-top:8px;">
          <span>定时提醒 (${pendingAndFired.length})</span>
          <div style="display:inline-flex;align-items:center;gap:4px;">
            <button type="button" class="pill-btn pill-btn-ghost pill-btn-sm" data-action="refresh-reminders" style="height:22px;padding:0 8px;font-size:11px;">
              ${icon('rotate-ccw', 11)} 刷新
            </button>
            ${renderRightModuleControlsHtml('reminders', '定时提醒')}
          </div>
        </div>
        <div class="module-content">
          <div class="${remCls}" data-scroll-module="right_reminders" style="${remStyle}min-height:0;">
            ${
              pendingAndFired.length
                ? pendingAndFired
                    .map((rem) => {
                      const isFired = rem.status === 'fired';
                      return `
                        <div class="glass-card" style="padding:9px 11px;margin-bottom:6px;display:flex;align-items:center;justify-content:space-between;gap:8px;">
                          <div style="min-width:0;flex:1 1 auto;">
                            <div style="display:flex;align-items:center;gap:6px;">
                              <span style="width:7px;height:7px;border-radius:9999px;flex-shrink:0;background:${isFired ? 'var(--warning)' : 'var(--success)'};"></span>
                              <span style="font-size:12.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(rem.title)}</span>
                            </div>
                            <div style="font-size:11px;color:var(--text-tertiary);margin-top:2px;padding-left:13px;">
                              ${isFired ? '已触发' : '待触发'} · ${escapeHtml(formatTriggerTime(rem.trigger_at))}
                            </div>
                          </div>
                          <button type="button" class="icon-pill" data-action="delete-reminder" data-reminder-id="${escapeHtml(rem.id)}" title="取消/删除提醒" aria-label="删除提醒" style="width:26px;height:26px;">
                            ${icon('x', 12)}
                          </button>
                        </div>
                      `;
                    })
                    .join('')
                : `<div class="compact-empty-hint" style="font-size:12px;color:var(--text-tertiary);padding:4px 2px;">暂无定时提醒，可在待办中点击「⏰」设置</div>`
            }
          </div>
          ${renderModuleResizerHtml('reminders')}
        </div>
      </div>
    `;

    const tplSumCls = buildScrollBodyClasses('ai_templates_summary', false);
    const tplSumStyle = buildScrollBodyStyle('ai_templates_summary', false);
    const aiTemplatesSummaryHtml = `
      <div class="glass-card module-block ${isCollapsedMod('ai_templates') ? 'is-collapsed' : ''}" data-module-id="ai_templates_summary" data-summary-module-id="ai_templates" style="margin-top:10px;padding:10px 12px 4px;">
        <div class="module-header" style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:6px;">
          <span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;color:var(--text-primary);">
            ${icon('zap', 13)} AI 常用指令模板
          </span>
          ${renderRightModuleControlsHtml('ai_templates_summary', 'AI 常用指令模板')}
        </div>
        <div class="module-content">
          <div class="${tplSumCls}" data-scroll-module="right_ai_templates_summary" style="${tplSumStyle}min-height:0;">
            ${renderAiTemplatesCardContentHtml()}
          </div>
          ${renderModuleResizerHtml('ai_templates_summary')}
        </div>
      </div>
    `;

    const moduleHtmlById = {
      input: inputHtml,
      summary_card: summaryCardModuleHtml,
      reminders: remindersHtml,
      ai_templates: aiTemplatesSummaryHtml,
    };

    const visibleModules = getUiLayout().rightSummaryModules.filter((m) => m.visible);
    const bodyContent = visibleModules.length
      ? visibleModules.map((m) => moduleHtmlById[m.id] || '').join('')
      : `
        <div class="empty-state" style="padding:28px 12px;">
          <p class="empty-title">所有 AI 总结模块已隐藏</p>
          <p class="empty-desc">点击右上角 ⚙ 自定义右侧模块重新开启需要的功能卡片。</p>
          <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-action="open-right-customize">
            ${icon('settings', 13)} 自定义模块
          </button>
        </div>
      `;

    summaryEl.innerHTML = `
      ${renderAiStatusBannerHtml()}
      ${bodyContent}
    `;
  }

  async function runSummarize({ text = '', filePath = null } = {}) {
    if (state.summaryLoading) return;
    state.summaryLoading = true;
    state.summaryError = '';
    const taskId = `ai_sum_${Date.now()}`;
    setBgAiTaskSafe({
      id: taskId,
      label: filePath ? 'AI 正在总结当前文档…' : 'AI 正在提炼文本与待办…',
      status: 'running',
    });
    renderSummaryMode();

    try {
      const payload = {
        text: String(text || ''),
        file_path: filePath || null,
      };
      const data = await api.post('/api/ai/summarize', payload);
      state.summaryResult = data;
      state.summaryError = '';
      if (data?.provider_label) {
        state.liveProviderLabel = String(data.provider_label);
      }
      const toastMsg = data?.provider_label
        ? `已完成提炼（${data.provider_label}）`
        : data?.offline_mode
        ? '已完成离线规则提炼（可配 API Key 升级大模型）'
        : 'AI 智能提炼完成';
      showToast(toastMsg, 'success');
      setBgAiTaskSafe({
        id: taskId,
        label: '✓ AI 总结已完成',
        status: 'done',
        onView() {
          if (typeof store.setState === 'function') {
            store.setState({ rightCollapsed: false }, 'layout:changed');
          } else {
            store.state.rightCollapsed = false;
            store.emit('layout:changed');
          }
          state.mode = 'summary';
          renderAll();
          window.requestAnimationFrame(() => {
            containerEl?.querySelector('[data-module-id="summary_card"]')?.scrollIntoView({
              behavior: 'smooth',
              block: 'nearest',
            });
          });
        },
      });
    } catch (err) {
      state.summaryError = err?.message || 'AI 总结失败';
      showToast(state.summaryError, 'error');
      setBgAiTaskSafe({
        id: taskId,
        label: `AI 总结失败：${state.summaryError}`,
        status: 'error',
      });
    } finally {
      state.summaryLoading = false;
      renderSummaryMode();
      renderChatHeaderStatus();
    }
  }

  function openReminderSheet(todo) {
    const res = state.summaryResult;
    const matchedApps = resolveMatchedApps(res);
    const matchedFiles = Array.isArray(res?.matched_files) ? res.matched_files : [];
    const defaultRemTitle = nextSequentialName('新建提醒', (state.reminders || []).map((r) => r?.title || ''));

    const defaultDt = new Date(Date.now() + 15 * 60 * 1000);
    const localIso = new Date(defaultDt.getTime() - defaultDt.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);

    openSheet({
      title: '创建定时提醒',
      bodyHtml: `
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div>
            <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:5px;">提醒内容</label>
            <input type="text" class="apple-input" id="rem-title-input" value="${escapeHtml(todo?.title || '')}" placeholder="留空自动命名：${escapeHtml(defaultRemTitle)}" />
          </div>

          <div>
            <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:5px;">快捷倒计时（分钟）</label>
            <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
              <button type="button" class="pill-btn pill-btn-sm" data-rem-min="1">1 分钟</button>
              <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-rem-min="15">15 分钟</button>
              <button type="button" class="pill-btn pill-btn-sm" data-rem-min="30">30 分钟</button>
              <button type="button" class="pill-btn pill-btn-sm" data-rem-min="60">1 小时</button>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              <input type="number" class="apple-input" id="rem-minutes-input" min="1" max="10080" value="15" style="width:110px;" />
              <span style="font-size:12.5px;color:var(--text-secondary);">分钟后提醒</span>
            </div>
          </div>

          <div>
            <label style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:5px;cursor:pointer;">
              <input type="checkbox" id="rem-use-exact" />
              <span>改为指定日期时间</span>
            </label>
            <input type="datetime-local" class="apple-input" id="rem-exact-input" value="${escapeHtml(localIso)}" disabled />
          </div>

          ${
            matchedApps.length || matchedFiles.length
              ? `<div class="glass-card" style="padding:9px 11px;font-size:12px;color:var(--text-secondary);">
                  到点将关联提醒：${[
                    ...matchedApps.map((a) => `软件「${a.name}」`),
                    ...matchedFiles.map((f) => `文档「${getBaseName(f)}」`),
                  ].map(escapeHtml).join('、')}
                </div>`
              : ''
          }
        </div>
      `,
      footerHtml: `
        <button type="button" class="pill-btn" id="rem-cancel-btn">取消</button>
        <button type="button" class="pill-btn pill-btn-primary" id="rem-submit-btn">确认设提醒</button>
      `,
      onMount(card) {
        const minInput = card.querySelector('#rem-minutes-input');
        const exactChk = card.querySelector('#rem-use-exact');
        const exactInput = card.querySelector('#rem-exact-input');
        const quickBtns = card.querySelectorAll('[data-rem-min]');

        quickBtns.forEach((btn) => {
          btn.addEventListener('click', () => {
            if (minInput) minInput.value = btn.dataset.remMin;
            if (exactChk) exactChk.checked = false;
            if (exactInput) exactInput.disabled = true;
            quickBtns.forEach((b) => b.classList.toggle('pill-btn-primary', b === btn));
          });
        });

        exactChk?.addEventListener('change', () => {
          if (exactInput) exactInput.disabled = !exactChk.checked;
        });

        card.querySelector('#rem-cancel-btn')?.addEventListener('click', closeSheet);
        card.querySelector('#rem-submit-btn')?.addEventListener('click', async () => {
          const title = card.querySelector('#rem-title-input')?.value?.trim() || defaultRemTitle;
          const body = {
            title,
            app_ids: res?.matched_app_ids || [],
            file_paths: matchedFiles,
          };
          if (exactChk?.checked) {
            const dtVal = exactInput?.value;
            if (!dtVal) {
              showToast('请选择提醒日期时间', 'warning');
              return;
            }
            body.trigger_at = dtVal;
          } else {
            const mins = Math.max(1, Number(minInput?.value) || 15);
            body.delay_seconds = Math.round(mins * 60);
          }

          try {
            await api.post('/api/reminders', body);
            closeSheet();
            await fetchReminders();
            store.emit('reminders:updated');
            showToast('已创建定时提醒', 'success');
          } catch (err) {
            showToast(err?.message || '创建提醒失败', 'error');
          }
        });
      },
    });
  }

  async function trigger10sTestReminder(todo) {
    const res = state.summaryResult;
    try {
      await api.post('/api/reminders', {
        title: todo?.title || '演示定时提醒',
        delay_seconds: 10,
        app_ids: res?.matched_app_ids || [],
        file_paths: Array.isArray(res?.matched_files) ? res.matched_files : [],
      });
      await fetchReminders();
      store.emit('reminders:updated');
      showToast('10 秒后将触发桌面通知与灵动岛提醒', 'success');
    } catch (err) {
      showToast(err?.message || '创建 10 秒测试提醒失败', 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // MODE 2: Cross-Format RAG Streaming Chat Renderer & Actions
  // ---------------------------------------------------------------------------

  function scrollChatToBottom() {
    if (!chatEl) return;
    const box = chatEl.querySelector('.chat-messages');
    if (box) {
      window.requestAnimationFrame(() => {
        box.scrollTop = box.scrollHeight;
      });
    }
  }

  function renderContextPillsHtml() {
    const paths = store.state.selectedContextPaths || [];
    if (!paths.length) {
      return `<div style="font-size:11.5px;color:var(--text-tertiary);">在左侧勾选文件（最多 20 份）即可跨格式联合问答</div>`;
    }
    return paths
      .map((p) => {
        const name = getBaseName(p);
        return `
          <span class="context-file-pill" title="${escapeHtml(p)}">
            ${renderFileTypeIconHtml(name, 12)}
            <span>${escapeHtml(name)}</span>
            <button type="button" data-action="remove-context" data-path="${escapeHtml(p)}" aria-label="移除 ${escapeHtml(name)}" style="display:inline-flex;align-items:center;color:inherit;">
              ${icon('x', 11)}
            </button>
          </span>
        `;
      })
      .join('');
  }

  function renderSingleChatMessageHtml(msg) {
    if (msg.role === 'user') {
      return `
        <div class="chat-bubble is-user" data-msg-id="${escapeHtml(msg.id)}">
          <div style="white-space:pre-wrap;">${escapeHtml(msg.content)}</div>
        </div>
      `;
    }

    if (msg.isError) {
      return `
        <div class="chat-bubble is-assistant" data-msg-id="${escapeHtml(msg.id)}" style="border-color:var(--warning);background:var(--warning-soft);">
          <div style="display:flex;align-items:center;gap:6px;font-weight:600;color:var(--warning);margin-bottom:4px;">
            ${icon('lock', 14)} <span>隐私锁拦截 / 请求未发送</span>
          </div>
          <div style="font-size:13px;color:var(--text-primary);">${escapeHtml(msg.content)}</div>
          <div style="font-size:11.5px;color:var(--text-secondary);margin-top:4px;">请先在左侧取消勾选该隐私文件，或解除隐私锁后再发起联合问答。</div>
        </div>
      `;
    }

    const isCompleted = !msg.streaming && Boolean(msg.content.trim());
    const bodyHtml = msg.content
      ? renderMarkdownSafe(msg.content, { compactMedia: true })
      : `<span style="color:var(--text-tertiary);">正在抽取跨格式上下文并思考...</span>`;

    const actionsHtml = isCompleted
      ? `
          <div class="chat-quick-actions">
            <span class="drag-pill-hint" title="按住直接拖进中间笔记栏" style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:9999px;font-size:11px;color:var(--text-secondary);background:var(--bg-island);border:1px dashed var(--border-hairline);cursor:grab;">
              ⠿ 拖入笔记
            </span>
            <button type="button" class="pill-btn pill-btn-sm" data-action="chat-save-note" data-msg-id="${escapeHtml(msg.id)}">
              ${icon('file-text', 12)} 存入笔记
            </button>
            <button type="button" class="pill-btn pill-btn-sm" data-action="chat-append-doc" data-msg-id="${escapeHtml(msg.id)}">
              ${icon('plus', 12)} 追加文档
            </button>
            <button type="button" class="pill-btn pill-btn-sm" data-action="chat-extract-table" data-msg-id="${escapeHtml(msg.id)}">
              ${icon('table', 12)} 提取填入表格
            </button>
          </div>
        `
      : '';

    return `
      <div
        class="chat-bubble is-assistant ${isCompleted ? 'draggable-card' : ''}"
        ${isCompleted ? 'draggable="true" data-drag-type="ai-chat"' : ''}
        data-msg-id="${escapeHtml(msg.id)}"
      >
        <div class="chat-bubble-body md-preview" style="padding:0;font-size:13.5px;line-height:1.6;">
          ${bodyHtml}
        </div>
        ${
          !msg.streaming && msg.offlineMode
            ? `<div style="margin-top:6px;font-size:11px;color:var(--text-tertiary);">离线智能检索模式 · 支持点击上方蓝色锚点直达定位</div>`
            : ''
        }
        ${actionsHtml}
      </div>
    `;
  }

  function renderChatMessagesOnly() {
    const box = chatEl?.querySelector('.chat-messages');
    if (!box) {
      renderChatMode();
      return;
    }
    if (!state.chatMessages.length) {
      box.innerHTML = `
        <div class="empty-state" style="padding:26px 14px;">
          <div style="color:var(--accent);">${icon('sparkles', 24)}</div>
          <p class="empty-title">跨格式联合问答（零向量库）</p>
          <p class="empty-desc">在左侧勾选最多 20 份 PDF / Excel / Markdown / TXT，直接融合提问并生成可点击的页码与单元格锚点。</p>
          <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:6px;margin-top:8px;">
            <button type="button" class="pill-btn pill-btn-sm" data-action="chat-quick-prompt" data-prompt="请综合我勾选的资料，提炼核心要点与对应页码/单元格位置。">综合提炼要点</button>
            <button type="button" class="pill-btn pill-btn-sm" data-action="chat-quick-prompt" data-prompt="请把这些内容整理成一份学习任务进度清单。">整理进度清单</button>
          </div>
        </div>
      `;
    } else {
      box.innerHTML = state.chatMessages.map(renderSingleChatMessageHtml).join('');
    }
    scrollChatToBottom();
  }

  function updateStreamingBubbleDom(msg) {
    const bubble = chatEl?.querySelector(`.chat-bubble[data-msg-id="${CSS.escape(msg.id)}"]`);
    if (!bubble) {
      renderChatMessagesOnly();
      return;
    }
    const bodyEl = bubble.querySelector('.chat-bubble-body');
    if (bodyEl) {
      bodyEl.innerHTML = renderMarkdownSafe(msg.content, { compactMedia: true });
    }
    scrollChatToBottom();
  }

  function renderContextBarOnly() {
    const bar = chatEl?.querySelector('.context-pills-bar');
    if (bar) {
      bar.innerHTML = renderContextPillsHtml();
    } else {
      renderChatMode();
    }
  }

  function renderChatHeaderStatus() {
    const slot = chatEl?.querySelector('[data-role="chat-ai-status-bar"]');
    if (slot) {
      slot.innerHTML = renderAiStatusPillHtml();
    }
  }

  function renderChatMode() {
    if (!chatEl) return;
    chatEl.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 14px 4px;flex-shrink:0;" data-role="chat-ai-status-bar">
        ${renderAiStatusPillHtml()}
      </div>
      <div class="chat-messages"></div>
      <div class="chat-composer">
        <div class="context-pills-bar">${renderContextPillsHtml()}</div>
        <div style="display:flex;align-items:flex-end;gap:8px;">
          <textarea
            id="chat-input"
            class="apple-textarea"
            rows="2"
            style="min-height:42px;max-height:130px;padding:9px 12px;font-size:13px;"
            placeholder="输入问题（Enter 发送，Shift+Enter 换行）..."
          >${escapeHtml(state.chatDraft)}</textarea>
          ${
            state.chatStreaming
              ? `<button type="button" class="icon-pill" data-action="stop-chat" title="停止生成" aria-label="停止生成" style="background:var(--danger-soft);color:var(--danger);border-color:transparent;">
                  ${icon('square', 14)}
                </button>`
              : `<button type="button" class="icon-pill is-active" data-action="send-chat" title="发送" aria-label="发送" style="background:var(--accent);color:#FFFFFF;">
                  ${icon('send', 15)}
                </button>`
          }
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <div style="display:flex;align-items:center;gap:6px;">
            <button
              type="button"
              class="pill-btn pill-btn-sm ${state.webSearch ? 'pill-btn-primary is-active' : ''}"
              data-action="toggle-web-search"
              aria-pressed="${state.webSearch ? 'true' : 'false'}"
            >
              ${icon('globe', 13)} 联网搜索
            </button>
            <button type="button" class="pill-btn pill-btn-sm pill-btn-ghost" data-action="clear-chat">
              ${icon('trash', 12)} 清空
            </button>
          </div>
          <span data-role="chat-ctx-count" style="font-size:11px;color:var(--text-tertiary);">
            ${(store.state.selectedContextPaths || []).length}/20 文件
          </span>
        </div>
      </div>
    `;
    renderChatMessagesOnly();
  }

  async function sendChatMessage(overridePrompt) {
    if (state.chatStreaming) return;
    const text = String(overridePrompt !== undefined ? overridePrompt : state.chatDraft || '').trim();
    if (!text) {
      showToast('请输入提问内容', 'warning');
      return;
    }

    if (overridePrompt === undefined) {
      state.chatDraft = '';
      const inputEl = chatEl?.querySelector('#chat-input');
      if (inputEl) inputEl.value = '';
    }

    const userMsg = { id: `u_${msgSeq++}`, role: 'user', content: text };
    const assistantMsg = {
      id: `a_${msgSeq++}`,
      role: 'assistant',
      content: '',
      streaming: true,
      offlineMode: false,
      isError: false,
    };

    const historyForApi = [...state.chatMessages, userMsg]
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.isError && m.content)
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content }));

    state.chatMessages.push(userMsg, assistantMsg);
    state.chatStreaming = true;
    const controller = new AbortController();
    state.chatAbort = controller;

    renderChatMode();

    await streamPostSSE(
      '/api/ai/chat',
      {
        messages: historyForApi,
        web_search: state.webSearch,
        context_paths: store.state.selectedContextPaths || [],
      },
      {
        signal: controller.signal,
        onChunk(chunk) {
          if (chunk && typeof chunk === 'object') {
            if (chunk.type === 'delta' && chunk.content) {
              assistantMsg.content += String(chunk.content);
              updateStreamingBubbleDom(assistantMsg);
            } else if (chunk.type === 'done' && chunk.meta) {
              assistantMsg.offlineMode = Boolean(chunk.meta.offline_mode);
              if (chunk.meta.provider_label) {
                state.liveProviderLabel = String(chunk.meta.provider_label);
              }
            }
          } else if (typeof chunk === 'string') {
            assistantMsg.content += chunk;
            updateStreamingBubbleDom(assistantMsg);
          }
        },
        onDone(info) {
          assistantMsg.streaming = false;
          if (info?.aborted && !assistantMsg.content) {
            assistantMsg.content = '*(已停止生成)*';
          }
          state.chatStreaming = false;
          state.chatAbort = null;
          renderChatMode();
          renderSummaryMode();
        },
        onError(err) {
          const errMsg = err?.message || '流式问答请求失败';
          assistantMsg.streaming = false;
          assistantMsg.isError = true;
          assistantMsg.content = errMsg;
          state.chatStreaming = false;
          state.chatAbort = null;
          showToast(errMsg, 'error', { duration: 4800 });
          renderChatMode();
        },
      }
    );
  }

  async function triggerTemplatePrompt(tpl) {
    if (!tpl) return;
    if (state.chatStreaming) {
      showToast('当前问答正在生成中，请稍候或停止后再试', 'warning');
      return;
    }

    const activeFile = store.state.activeFile;
    if (activeFile?.path) {
      const selected = store.state.selectedContextPaths || [];
      if (!selected.includes(activeFile.path) && selected.length < 20) {
        toggleContextPath(activeFile.path);
      }
    }

    ensureVisibleOnMobileOrCollapsed();
    switchMode('chat', { emitEvent: true });

    let finalPrompt = tpl.prompt;
    const selectedNow = store.state.selectedContextPaths || [];
    const activeText = String(store.state.activeDocumentText || state.summaryInputText || '').trim();
    if (!activeFile?.path && selectedNow.length === 0 && activeText) {
      finalPrompt = `${tpl.prompt}\n\n【当前笔记内容参考】\n${activeText.slice(0, 3000)}`;
    }

    await sendChatMessage(finalPrompt);
  }

  function showMindmapResultSheet({ activeFile, activeName, isMarkdown, suggestedTitle, outline, providerLabel }) {
    openSheet({
      title: `🧠 AI 生成脑图大纲 · ${activeName}`,
      bodyHtml: `
        <div style="display:flex;flex-direction:column;gap:10px;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
            <span style="font-size:12px;color:var(--text-secondary);">主题：<strong>${escapeHtml(suggestedTitle)}</strong></span>
            ${providerLabel ? `<span class="file-ext-badge">${escapeHtml(providerLabel)}</span>` : ''}
          </div>
          <div class="glass-card md-preview" style="padding:12px 14px;max-height:46vh;overflow-y:auto;">
            ${renderMarkdownSafe(outline, { compactMedia: true })}
          </div>
        </div>
      `,
      footerHtml: `
        <button type="button" class="pill-btn" id="rp-mm-close">关闭</button>
        <button type="button" class="pill-btn" id="rp-mm-copy">${icon('copy', 13)} 复制大纲</button>
        <button type="button" class="pill-btn" id="rp-mm-save-new">${icon('file-text', 13)} 另存为脑图笔记</button>
        ${
          isMarkdown
            ? `<button type="button" class="pill-btn pill-btn-primary" id="rp-mm-open-view">🧠 保存并切换脑图视图</button>`
            : `<button type="button" class="pill-btn pill-btn-primary" id="rp-mm-append">${icon('plus', 13)} 追加到当前笔记</button>`
        }
      `,
      onMount(card) {
        card.querySelector('#rp-mm-close')?.addEventListener('click', closeSheet);
        card.querySelector('#rp-mm-copy')?.addEventListener('click', () => {
          copyInternal?.(outline, '已复制脑图 Markdown 大纲');
        });

        card.querySelector('#rp-mm-save-new')?.addEventListener('click', async () => {
          try {
            const title = `${suggestedTitle}_脑图`;
            const created = await api.post('/api/files/create-note', {
              title,
              content: outline,
            });
            closeSheet();
            store.emit('files:updated', created);
            if (created?.path) {
              store.emit('center:toggle-mindmap', { path: created.path });
            }
            showToast(`已保存并打开脑图笔记：${created?.name || title}`, 'success');
          } catch (err) {
            showToast(err?.message || '保存脑图笔记失败', 'error');
          }
        });

        card.querySelector('#rp-mm-open-view')?.addEventListener('click', async () => {
          if (!activeFile?.path) return;
          try {
            await api.put('/api/files/write', { path: activeFile.path, content: outline });
            closeSheet();
            store.state.activeDocumentText = outline;
            store.emit('center:toggle-mindmap', { path: activeFile.path });
            store.emit('file:open', { path: activeFile.path, name: activeFile.name, mode: 'mindmap', forceReload: true, skipUnsavedGuard: true });
            showToast('已更新当前笔记并切换至脑图视图', 'success');
          } catch (err) {
            showToast(err?.message || '写入脑图大纲失败', 'error');
          }
        });

        card.querySelector('#rp-mm-append')?.addEventListener('click', () => {
          closeSheet();
          store.emit('doc:append', { content: outline, path: activeFile?.path });
        });
      },
    });
  }

  async function handleAiGenerateMindmap() {
    const activeFile = store.state.activeFile;
    const activeText = String(store.state.activeDocumentText || state.summaryInputText || '').trim();
    if (!activeFile?.path && !activeText) {
      showToast('请先在左侧打开一篇文档或输入内容', 'warning');
      return;
    }

    const activeName = activeFile?.name || '当前文档';
    const isMarkdown =
      activeFile?.type === 'markdown' || String(activeName).toLowerCase().endsWith('.md');
    const taskId = `bg_mindmap_${Date.now()}`;

    setBgAiTaskSafe({ id: taskId, label: 'AI 正在生成脑图大纲…', status: 'running' });
    showToast('AI 已在后台生成，可继续操作', 'info');

    try {
      const res = await api.post('/api/ai/mindmap', {
        text: activeText,
        file_path: activeFile?.path || null,
      });
      if (res?.provider_label) {
        state.liveProviderLabel = String(res.provider_label);
        renderSummaryMode();
        renderChatHeaderStatus();
      }
      const outline = String(res?.markdown || res?.outline || res?.content || '').trim();
      const suggestedTitle = String(res?.title || `${activeName.replace(/\.[^.]+$/, '')} 脑图`).trim();
      if (!outline) {
        setBgAiTaskSafe({ id: taskId, label: 'AI 未返回有效脑图大纲', status: 'error' });
        showToast('AI 未返回有效脑图大纲', 'warning');
        return;
      }

      const openResult = () =>
        showMindmapResultSheet({
          activeFile,
          activeName,
          isMarkdown,
          suggestedTitle,
          outline,
          providerLabel: res?.provider_label || '',
        });

      setBgAiTaskSafe({
        id: taskId,
        label: 'AI 脑图大纲已就绪',
        status: 'done',
        onOpen: openResult,
      });
      showToast('AI 脑图大纲已就绪', 'success', {
        duration: 5000,
        actionLabel: '查看结果',
        onAction: openResult,
      });
    } catch (err) {
      const errMsg = err?.message || '请稍后重试';
      setBgAiTaskSafe({ id: taskId, label: `生成脑图失败：${errMsg}`, status: 'error' });
      showToast(`生成脑图失败：${errMsg}`, 'error');
    }
  }

  function showPolishResultSheet({ activeFile, activeName, rawText, polished, canReplaceDoc }) {
    openSheet({
      title: `✨ AI 碎片润色成文 · ${activeName}`,
      bodyHtml: `
        <div style="display:flex;flex-direction:column;gap:10px;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
            <span style="font-size:12px;color:var(--text-secondary);">原文 ${rawText.length} 字 → 润色后 ${polished.length} 字</span>
            <div class="segmented-pill" role="tablist">
              <div class="segmented-thumb" data-role="rp-pol-thumb" style="width:calc(50% - 3px);transform:translateX(0%);"></div>
              <button type="button" class="segmented-btn is-active" data-rp-pol-view="preview" style="height:24px;font-size:11.5px;">预览效果</button>
              <button type="button" class="segmented-btn" data-rp-pol-view="raw" style="height:24px;font-size:11.5px;">Markdown 源码</button>
            </div>
          </div>
          <div data-role="rp-pol-preview" class="glass-card md-preview" style="padding:12px 14px;max-height:46vh;overflow-y:auto;">
            ${renderMarkdownSafe(polished, { compactMedia: true })}
          </div>
          <textarea data-role="rp-pol-raw" class="apple-textarea" rows="12" style="display:none;font-family:var(--font-mono);font-size:12.5px;">${escapeHtml(polished)}</textarea>
        </div>
      `,
      footerHtml: `
        <button type="button" class="pill-btn" id="rp-pol-close">取消</button>
        <button type="button" class="pill-btn" id="rp-pol-copy">${icon('copy', 13)} 复制</button>
        <button type="button" class="pill-btn" id="rp-pol-append">${icon('plus', 13)} 追加到笔记</button>
        ${
          canReplaceDoc
            ? `<button type="button" class="pill-btn pill-btn-primary" id="rp-pol-replace">${icon('check', 13)} 确认替换当前文档</button>`
            : `<button type="button" class="pill-btn pill-btn-primary" id="rp-pol-save-new">${icon('file-text', 13)} 存为新笔记</button>`
        }
      `,
      onMount(card) {
        const thumb = card.querySelector('[data-role="rp-pol-thumb"]');
        const prevBox = card.querySelector('[data-role="rp-pol-preview"]');
        const rawBox = card.querySelector('[data-role="rp-pol-raw"]');
        card.querySelectorAll('[data-rp-pol-view]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const isRaw = btn.dataset.rpPolView === 'raw';
            card.querySelectorAll('[data-rp-pol-view]').forEach((b) => b.classList.toggle('is-active', b === btn));
            if (thumb) thumb.style.transform = `translateX(${isRaw ? '100%' : '0%'})`;
            if (prevBox) prevBox.style.display = isRaw ? 'none' : 'block';
            if (rawBox) rawBox.style.display = isRaw ? 'block' : 'none';
          });
        });

        const getLatestPolished = () => card.querySelector('[data-role="rp-pol-raw"]')?.value ?? polished;

        card.querySelector('#rp-pol-close')?.addEventListener('click', closeSheet);
        card.querySelector('#rp-pol-copy')?.addEventListener('click', () => {
          copyInternal?.(getLatestPolished(), '已复制润色成文结果');
        });

        card.querySelector('#rp-pol-append')?.addEventListener('click', () => {
          const latest = getLatestPolished();
          closeSheet();
          store.emit('doc:append', { content: latest, path: activeFile?.path });
        });

        card.querySelector('#rp-pol-replace')?.addEventListener('click', async () => {
          const latest = getLatestPolished();
          if (!activeFile?.path) return;
          try {
            const writeRes = await api.put('/api/files/write', {
              path: activeFile.path,
              content: latest,
            });
            store.state.activeDocumentText = latest;
            closeSheet();
            store.emit('file:saved', { path: activeFile.path, snapshot_id: writeRes?.snapshot_id || null });
            store.emit('file:open', {
              path: activeFile.path,
              name: activeFile.name,
              forceReload: true,
              skipUnsavedGuard: true,
            });
            showToast('已润色替换当前文档（已自动生成写前快照）', 'success');
          } catch (err) {
            showToast(err?.message || '替换文档失败', 'error');
          }
        });

        card.querySelector('#rp-pol-save-new')?.addEventListener('click', async () => {
          const latest = getLatestPolished();
          try {
            const title = `润色成文_${activeName.replace(/\.[^.]+$/, '')}`;
            const created = await api.post('/api/files/create-note', { title, content: latest });
            closeSheet();
            store.emit('files:updated', created);
            if (created?.path) {
              store.emit('file:open', created);
            }
            showToast(`已存为新笔记：${created?.name || title}`, 'success');
          } catch (err) {
            showToast(err?.message || '保存新笔记失败', 'error');
          }
        });
      },
    });
  }

  async function handleAiPolishFragments() {
    const activeFile = store.state.activeFile;
    const rawText = String(store.state.activeDocumentText || state.summaryInputText || '').trim();
    if (!rawText) {
      showToast('当前没有可润色的笔记内容，请先打开笔记或在速记区输入碎片', 'warning');
      return;
    }

    const activeName = activeFile?.name || '随手碎片';
    const canReplaceDoc = Boolean(
      activeFile?.path &&
        (activeFile?.type === 'markdown' ||
          activeFile?.type === 'text' ||
          /\.(md|txt)$/i.test(activeName))
    );
    const taskId = `bg_polish_${Date.now()}`;

    setBgAiTaskSafe({ id: taskId, label: 'AI 正在润色碎片成文…', status: 'running' });
    showToast('AI 已在后台生成，可继续操作', 'info');

    try {
      const res = await api.post('/api/ai/polish', {
        text: rawText,
        style: 'article',
      });
      if (res?.provider_label) {
        state.liveProviderLabel = String(res.provider_label);
        renderSummaryMode();
        renderChatHeaderStatus();
      }
      const polished = String(res?.markdown || res?.polished || res?.content || '').trim();
      if (!polished) {
        setBgAiTaskSafe({ id: taskId, label: 'AI 未返回有效润色内容', status: 'error' });
        showToast('AI 未返回有效润色内容', 'warning');
        return;
      }

      const openResult = () =>
        showPolishResultSheet({
          activeFile,
          activeName,
          rawText,
          polished,
          canReplaceDoc,
        });

      setBgAiTaskSafe({
        id: taskId,
        label: 'AI 润色成文已就绪',
        status: 'done',
        onOpen: openResult,
      });
      showToast('AI 润色成文已就绪', 'success', {
        duration: 5000,
        actionLabel: '查看结果',
        onAction: openResult,
      });
    } catch (err) {
      const errMsg = err?.message || '请稍后重试';
      setBgAiTaskSafe({ id: taskId, label: `碎片润色失败：${errMsg}`, status: 'error' });
      showToast(`碎片润色失败：${errMsg}`, 'error');
    }
  }

  async function openSaveNoteSheet(msg) {
    if (!state.treeData.nodes.length) {
      await fetchTree();
    }
    const nodes = state.treeData.nodes || [];
    const existingNotes = (store.state.files?.items || []).map((f) => f.name || getBaseName(f.path));
    const fallbackTitle = nextSequentialName('新建笔记', existingNotes);
    const firstLine = String(msg.content || '')
      .split('\n')
      .map((l) => l.replace(/^[#>\s*-]+/, '').trim())
      .find((l) => l.length >= 2);
    const defaultTitle = (firstLine || fallbackTitle).slice(0, 28);

    openSheet({
      title: '存入本地 Markdown 笔记',
      bodyHtml: `
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div>
            <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:5px;">笔记标题</label>
            <input type="text" class="apple-input" id="note-save-title" value="${escapeHtml(defaultTitle)}" placeholder="留空自动命名：${escapeHtml(fallbackTitle)}" />
          </div>
          <div>
            <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:5px;">挂载到虚拟知识树节点（可选）</label>
            <select class="apple-select" id="note-save-node">
              <option value="">不挂载（仅保存在默认笔记目录）</option>
              ${nodes
                .map((n) => `<option value="${escapeHtml(n.id)}">${escapeHtml(n.name)}</option>`)
                .join('')}
            </select>
          </div>
          <div class="glass-card" style="max-height:140px;overflow:auto;font-size:12px;color:var(--text-secondary);white-space:pre-wrap;">${escapeHtml(msg.content.slice(0, 400))}${msg.content.length > 400 ? '...' : ''}</div>
        </div>
      `,
      footerHtml: `
        <button type="button" class="pill-btn" id="note-save-cancel">取消</button>
        <button type="button" class="pill-btn pill-btn-primary" id="note-save-ok">保存笔记</button>
      `,
      onMount(card) {
        card.querySelector('#note-save-cancel')?.addEventListener('click', closeSheet);
        card.querySelector('#note-save-ok')?.addEventListener('click', async () => {
          const title = card.querySelector('#note-save-title')?.value?.trim() || fallbackTitle;
          const nodeId = card.querySelector('#note-save-node')?.value || null;
          try {
            const created = await api.post('/api/files/create-note', {
              title,
              content: `# ${title}\n\n${msg.content}\n`,
              node_id: nodeId,
            });
            closeSheet();
            store.emit('files:updated', created);
            store.emit('tree:updated');
            showToast(`已创建笔记：${created?.name || title}`, 'success');
          } catch (err) {
            showToast(err?.message || '保存笔记失败', 'error');
          }
        });
      },
    });
  }

  async function openExtractTableSheet(msg) {
    await fetchFilesIfNeeded();
    const excelFiles = getExcelFiles();
    if (!excelFiles.length) {
      showToast('请先在左侧导入至少一份 .xlsx 表格文件', 'warning');
      return;
    }

    const defaultPath =
      (state.selectedExcelPath && excelFiles.some((f) => f.path === state.selectedExcelPath)
        ? state.selectedExcelPath
        : null) ||
      (store.state.activeFile?.path && excelFiles.some((f) => f.path === store.state.activeFile.path)
        ? store.state.activeFile.path
        : excelFiles[0].path);

    openSheet({
      title: 'AI 提取并写入原位 Excel',
      bodyHtml: `
        <div style="display:flex;flex-direction:column;gap:10px;">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            <div>
              <label style="display:block;font-size:11.5px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">目标表格 (.xlsx)</label>
              <select class="apple-select" id="ext-xlsx-select">
                ${excelFiles
                  .map(
                    (f) =>
                      `<option value="${escapeHtml(f.path)}" ${f.path === defaultPath ? 'selected' : ''}>${escapeHtml(f.name || getBaseName(f.path))}</option>`
                  )
                  .join('')}
              </select>
            </div>
            <div>
              <label style="display:block;font-size:11.5px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">工作表 (Sheet)</label>
              <select class="apple-select" id="ext-sheet-select"></select>
            </div>
          </div>

          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <span id="ext-headers-hint" style="font-size:11.5px;color:var(--text-secondary);">正在读取表头...</span>
            <button type="button" class="pill-btn pill-btn-sm" id="ext-run-btn">
              ${icon('sparkles', 12)} AI 重新提取
            </button>
          </div>

          <div id="ext-preview-wrap" class="glass-card" style="padding:8px;overflow:auto;max-height:240px;">
            <div style="font-size:12px;color:var(--text-tertiary);text-align:center;padding:16px 0;">正在准备提取预览...</div>
          </div>
        </div>
      `,
      footerHtml: `
        <button type="button" class="pill-btn" id="ext-cancel-btn">取消</button>
        <button type="button" class="pill-btn pill-btn-primary" id="ext-confirm-btn">确认写入原位 Excel</button>
      `,
      onMount(card) {
        const fileSel = card.querySelector('#ext-xlsx-select');
        const sheetSel = card.querySelector('#ext-sheet-select');
        const hintEl = card.querySelector('#ext-headers-hint');
        const previewWrap = card.querySelector('#ext-preview-wrap');
        const runBtn = card.querySelector('#ext-run-btn');
        const confirmBtn = card.querySelector('#ext-confirm-btn');

        let currentSheets = [];
        let currentHeaders = [];
        let previewRows = [];

        const renderEditablePreview = () => {
          if (!currentHeaders.length) {
            previewWrap.innerHTML = `<div style="font-size:12px;color:var(--text-tertiary);padding:12px;">当前 Sheet 暂无第 1 行表头</div>`;
            return;
          }
          previewWrap.innerHTML = `
            <table style="width:100%;border-collapse:collapse;font-size:12px;">
              <thead>
                <tr>
                  ${currentHeaders.map((h) => `<th style="text-align:left;padding:5px 6px;border-bottom:1px solid var(--border-hairline);white-space:nowrap;">${escapeHtml(h)}</th>`).join('')}
                  <th style="width:32px;border-bottom:1px solid var(--border-hairline);"></th>
                </tr>
              </thead>
              <tbody>
                ${previewRows
                  .map(
                    (row, rIdx) => `
                    <tr data-preview-row="${rIdx}">
                      ${currentHeaders
                        .map(
                          (_, cIdx) => `
                          <td style="padding:4px 3px;">
                            <input type="text" class="apple-input" data-r="${rIdx}" data-c="${cIdx}" value="${escapeHtml(row[cIdx] ?? '')}" style="padding:4px 7px;font-size:12px;min-width:74px;" />
                          </td>
                        `
                        )
                        .join('')}
                      <td style="padding:4px 2px;text-align:center;">
                        <button type="button" class="icon-pill" data-del-preview-row="${rIdx}" title="删行" style="width:24px;height:24px;">
                          ${icon('x', 11)}
                        </button>
                      </td>
                    </tr>
                  `
                  )
                  .join('')}
              </tbody>
            </table>
            <div style="margin-top:6px;">
              <button type="button" class="pill-btn pill-btn-sm" id="ext-add-empty-row">${icon('plus', 11)} 添加空行</button>
            </div>
          `;
        };

        const syncRowsFromDom = () => {
          const next = [];
          previewWrap.querySelectorAll('tr[data-preview-row]').forEach((tr) => {
            const rowVals = currentHeaders.map((_, cIdx) => {
              const inp = tr.querySelector(`input[data-c="${cIdx}"]`);
              return inp ? inp.value : '';
            });
            next.push(rowVals);
          });
          previewRows = next;
        };

        const runExtract = async () => {
          if (!currentHeaders.length) return;
          previewWrap.innerHTML = `<div style="font-size:12px;color:var(--text-secondary);text-align:center;padding:18px 0;">正在智能拆解匹配表头...</div>`;
          try {
            const res = await api.post('/api/ai/extract-table', {
              text: msg.content,
              headers: currentHeaders,
            });
            previewRows = Array.isArray(res?.rows) && res.rows.length ? res.rows : [currentHeaders.map(() => '')];
            renderEditablePreview();
          } catch (err) {
            previewRows = [currentHeaders.map(() => '')];
            renderEditablePreview();
            showToast(err?.message || '提取失败，请手动编辑', 'warning');
          }
        };

        const loadSheetsForModal = async (xlsxPath) => {
          hintEl.textContent = '正在加载工作表...';
          try {
            const data = await api.get(`/api/excel/sheets?path=${encodeURIComponent(xlsxPath)}`);
            currentSheets = Array.isArray(data?.sheets) ? data.sheets : [];
            sheetSel.innerHTML = currentSheets
              .map((s) => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)} (${s.total_rows}行)</option>`)
              .join('');
            const selectedInfo = currentSheets[0] || null;
            currentHeaders = selectedInfo?.headers || [];
            hintEl.textContent = currentHeaders.length ? `表头：${currentHeaders.join(' / ')}` : '未检测到表头';
            await runExtract();
          } catch (err) {
            hintEl.textContent = err?.message || '读取失败';
            previewWrap.innerHTML = `<div style="font-size:12px;color:var(--danger);padding:10px;">${escapeHtml(err?.message || '读取表格失败')}</div>`;
          }
        };

        previewWrap?.addEventListener('click', (e) => {
          const delBtn = e.target.closest('[data-del-preview-row]');
          if (delBtn) {
            syncRowsFromDom();
            const rIdx = Number(delBtn.dataset.delPreviewRow);
            previewRows.splice(rIdx, 1);
            renderEditablePreview();
            return;
          }
          if (e.target.closest('#ext-add-empty-row')) {
            syncRowsFromDom();
            previewRows.push(currentHeaders.map(() => ''));
            renderEditablePreview();
          }
        });

        fileSel?.addEventListener('change', () => {
          loadSheetsForModal(fileSel.value);
        });

        sheetSel?.addEventListener('change', () => {
          const info = currentSheets.find((s) => s.name === sheetSel.value);
          currentHeaders = info?.headers || [];
          hintEl.textContent = currentHeaders.length ? `表头：${currentHeaders.join(' / ')}` : '未检测到表头';
          runExtract();
        });

        runBtn?.addEventListener('click', runExtract);
        card.querySelector('#ext-cancel-btn')?.addEventListener('click', closeSheet);
        confirmBtn?.addEventListener('click', async () => {
          syncRowsFromDom();
          const targetPath = fileSel?.value;
          const targetSheet = sheetSel?.value || null;
          if (!targetPath || !previewRows.length) {
            showToast('没有可写入的数据行', 'warning');
            return;
          }
          confirmBtn.disabled = true;
          try {
            await api.post('/api/excel/append-rows', {
              path: targetPath,
              sheet: targetSheet,
              rows: previewRows,
            });
            closeSheet();
            store.emit('file:refresh-excel', { path: targetPath, sheet: targetSheet });
            if (targetPath === state.selectedExcelPath) {
              loadExcelSheets(targetPath);
            }
            showToast(`已成功追加 ${previewRows.length} 行至原位 Excel`, 'success');
          } catch (err) {
            showToast(err?.message || '写入 Excel 失败', 'error');
            confirmBtn.disabled = false;
          }
        });

        loadSheetsForModal(defaultPath);
      },
    });
  }

  // ---------------------------------------------------------------------------
  // MODE 3: Local Tools Workbench Renderer & Actions
  // ---------------------------------------------------------------------------

  function renderToolsMode() {
    if (!toolsEl) return;

    // Preserve open/closed state of existing <details> by module id
    toolsEl.querySelectorAll('details.tool-card[data-module-id]').forEach((det) => {
      const id = det.dataset.moduleId;
      if (id) toolOpenStateById.set(id, det.open);
    });

    const excelFiles = getExcelFiles();
    const activeSheetInfo =
      state.excelSheets.find((s) => s.name === state.selectedSheet) || state.excelSheets[0] || null;
    const headers = activeSheetInfo?.headers || [];

    const nodes = state.treeData.nodes || [];
    const tableRows = state.treeData.table_rows || [];
    const orderedNodes = buildTreeRenderList(nodes);
    const activeFile = store.state.activeFile;

    const apps = store.state.apps || [];
    const workspaces = store.state.workspaces || [];
    const appsById = new Map(apps.map((a) => [String(a.id), a]));
    const toolModsMap = new Map(getUiLayout().rightToolModules.map((m) => [m.id, m]));
    const isToolOpen = (id) => {
      const mod = toolModsMap.get(id);
      if (mod && typeof mod.collapsed === 'boolean') {
        return !mod.collapsed;
      }
      return toolOpenStateById.get(id) !== false;
    };

    const quickExcelEmpty = excelFiles.length === 0;
    const quickExcelScrollCls = buildScrollBodyClasses('quick_excel', quickExcelEmpty, 'tool-card-body module-scroll-body');
    const quickExcelScrollStyle = buildScrollBodyStyle('quick_excel', quickExcelEmpty);
    const card1Html = `
      <details class="tool-card module-block" data-module-id="quick_excel" draggable="true" ${isToolOpen('quick_excel') ? 'open' : ''}>
        <summary class="tool-card-summary">
          <span style="display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden;">
            <span class="module-drag-handle" title="拖拽调整卡片顺序" style="color:var(--text-tertiary);cursor:grab;">⠿</span>
            ${icon('table', 14)} <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">快捷表单填表与表格操作</span>
          </span>
          <span style="display:inline-flex;align-items:center;gap:6px;flex-shrink:0;">
            <span style="font-size:11px;color:var(--text-tertiary);font-weight:500;">${excelFiles.length} 份</span>
            ${renderRightModuleControlsHtml('quick_excel', '快捷表单填表与表格操作')}
          </span>
        </summary>
        <div class="${quickExcelScrollCls}" data-scroll-module="right_quick_excel" ${quickExcelScrollStyle ? `style="${quickExcelScrollStyle}"` : ''}>
          ${
            excelFiles.length
              ? `
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
                  <div>
                    <label style="display:block;font-size:11px;color:var(--text-secondary);margin-bottom:3px;">选择 Excel 文件</label>
                    <select class="apple-select" data-action="tools-excel-select" style="padding:6px 8px;font-size:12px;">
                      ${excelFiles
                        .map(
                          (f) =>
                            `<option value="${escapeHtml(f.path)}" ${f.path === state.selectedExcelPath ? 'selected' : ''}>${escapeHtml(f.name || getBaseName(f.path))}</option>`
                        )
                        .join('')}
                    </select>
                  </div>
                  <div>
                    <label style="display:block;font-size:11px;color:var(--text-secondary);margin-bottom:3px;">工作表</label>
                    <select class="apple-select" data-action="tools-sheet-select" style="padding:6px 8px;font-size:12px;">
                      ${
                        state.excelSheets.length
                          ? state.excelSheets
                              .map(
                                (s) =>
                                  `<option value="${escapeHtml(s.name)}" ${s.name === state.selectedSheet ? 'selected' : ''}>${escapeHtml(s.name)} (${s.total_rows}行)</option>`
                              )
                              .join('')
                          : `<option value="">${state.excelLoading ? '加载中...' : '无工作表'}</option>`
                      }
                    </select>
                  </div>
                </div>

                ${
                  headers.length
                    ? `
                      <div id="tools-excel-form" style="display:flex;flex-direction:column;gap:7px;margin-bottom:10px;">
                        ${headers
                          .map(
                            (h, idx) => `
                            <div>
                              <label style="display:block;font-size:11px;color:var(--text-secondary);margin-bottom:2px;">${escapeHtml(h)}</label>
                              <input type="text" class="apple-input" data-excel-col-input="${idx}" placeholder="输入 ${escapeHtml(h)}..." style="padding:6px 10px;font-size:12.5px;" />
                            </div>
                          `
                          )
                          .join('')}
                      </div>
                      <div style="display:flex;flex-wrap:wrap;gap:6px;">
                        <button type="button" class="pill-btn pill-btn-primary pill-btn-sm" data-action="excel-append-form" ${state.excelSubmitting ? 'disabled' : ''}>
                          ${icon('plus', 12)} 写入一行
                        </button>
                        <button type="button" class="pill-btn pill-btn-sm" data-action="excel-add-col">
                          + 增列
                        </button>
                        <button type="button" class="pill-btn pill-btn-sm" data-action="excel-del-row">
                          删指定行
                        </button>
                        <button type="button" class="pill-btn pill-btn-sm" data-action="excel-export-csv">
                          ${icon('download', 12)} 导出 CSV
                        </button>
                      </div>
                    `
                    : `<div style="font-size:12px;color:var(--text-tertiary);">${state.excelLoading ? '正在读取表头...' : '当前工作表无表头，可点击下方增列初始化。'}</div>
                       <div style="margin-top:8px;display:flex;gap:6px;">
                         <button type="button" class="pill-btn pill-btn-sm" data-action="excel-add-col">+ 增列</button>
                         <button type="button" class="pill-btn pill-btn-sm" data-action="excel-export-csv">${icon('download', 12)} 导出 CSV</button>
                       </div>`
                }
              `
              : `<div style="font-size:12px;color:var(--text-tertiary);">暂无 .xlsx 文件，请先在左侧导入本地 Excel 表格。</div>`
          }
        </div>
        ${renderModuleResizerHtml('quick_excel')}
      </details>
    `;

    const treeIsTable = state.treeViewMode === 'table';
    const defaultInlineNodeName = nextSequentialName('新建分类', nodes.map((n) => n?.name || ''));
    const treeEmpty = nodes.length === 0 && !state.inlineTreeCreateOpen && !state.classifyResult;
    const treeScrollCls = buildScrollBodyClasses('knowledge_tree', treeEmpty, 'tool-card-body module-scroll-body');
    const treeScrollStyle = buildScrollBodyStyle('knowledge_tree', treeEmpty);
    const inlineTreeCreateHtml = state.inlineTreeCreateOpen
      ? `
        <div class="inline-quick-create-row" data-role="inline-tree-create-row" style="margin-bottom:8px;">
          <input
            type="text"
            class="inline-rename-input"
            data-role="inline-tree-node-input"
            value="${escapeHtml(state.inlineTreeCreateDraft || '')}"
            placeholder="分类名（留空回车：${escapeHtml(defaultInlineNodeName)}）"
            autocomplete="off"
          />
          <button type="button" class="icon-pill" data-action="tree-inline-create-submit" title="创建节点" aria-label="确认创建" style="width:24px;height:24px;flex-shrink:0;">
            ${icon('check', 12)}
          </button>
          <button type="button" class="icon-pill" data-action="tree-inline-create-cancel" title="取消" aria-label="取消创建" style="width:24px;height:24px;flex-shrink:0;">
            ${icon('x', 12)}
          </button>
        </div>
      `
      : '';
    const card2Html = `
      <details class="tool-card module-block" data-module-id="knowledge_tree" draggable="true" ${isToolOpen('knowledge_tree') ? 'open' : ''}>
        <summary class="tool-card-summary">
          <span style="display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden;">
            <span class="module-drag-handle" title="拖拽调整卡片顺序" style="color:var(--text-tertiary);cursor:grab;">⠿</span>
            ${icon('git-branch', 14)} <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">虚拟知识树分类与总览</span>
          </span>
          <span style="display:inline-flex;align-items:center;gap:6px;flex-shrink:0;">
            <span style="font-size:11px;color:var(--text-tertiary);font-weight:500;">${nodes.length} 节点</span>
            ${renderRightModuleControlsHtml('knowledge_tree', '虚拟知识树分类与总览')}
          </span>
        </summary>
        <div class="${treeScrollCls}" data-scroll-module="right_knowledge_tree" ${treeScrollStyle ? `style="${treeScrollStyle}"` : ''}>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
            <div class="segmented-pill" data-seg="tree-view" style="width:168px;">
              <div class="segmented-thumb" style="width: calc((100% - 6px) / 2); transform: translateX(${treeIsTable ? 100 : 0}%);"></div>
              <button type="button" class="segmented-btn ${!treeIsTable ? 'is-active' : ''}" data-action="tree-switch-view" data-view="tree" style="height:24px;font-size:11.5px;padding:0 8px;">树状视图</button>
              <button type="button" class="segmented-btn ${treeIsTable ? 'is-active' : ''}" data-action="tree-switch-view" data-view="table" style="height:24px;font-size:11.5px;padding:0 8px;">表格总览</button>
            </div>

            <div style="display:flex;gap:5px;flex-wrap:wrap;">
              <button type="button" class="pill-btn pill-btn-sm" data-action="tree-create-node">
                ${icon('plus', 12)} 新建分类节点
              </button>
              <button type="button" class="pill-btn pill-btn-sm" data-action="tree-ai-classify" ${state.classifyLoading ? 'disabled' : ''}>
                ${icon('sparkles', 12)} ${state.classifyLoading ? '归类分析中...' : 'AI 建议归类'}
              </button>
            </div>
          </div>

          ${inlineTreeCreateHtml}

          ${
            state.classifyResult
              ? `
                <div class="glass-card" style="margin-bottom:10px;padding:9px 11px;border-color:var(--accent);background:var(--accent-soft);">
                  <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;">
                    <span style="font-size:12px;font-weight:600;color:var(--accent);">
                      建议归入：「${escapeHtml(state.classifyResult.recommended_node_name || '未命名')}」
                    </span>
                    <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-action="tree-bind-recommended" style="height:24px;font-size:11px;">
                      一键挂载
                    </button>
                  </div>
                  <div style="font-size:11.5px;color:var(--text-secondary);margin-top:4px;">${escapeHtml(state.classifyResult.reason || '')}</div>
                </div>
              `
              : ''
          }

          ${
            treeIsTable
              ? tableRows.length
                ? `
                  <div style="overflow:auto;max-height:240px;border:1px solid var(--border-hairline);border-radius:10px;">
                    <table style="width:100%;border-collapse:collapse;font-size:12px;">
                      <thead>
                        <tr style="background:var(--bg-island);">
                          <th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border-hairline);">文档</th>
                          <th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border-hairline);">分类</th>
                          <th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border-hairline);">状态</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${tableRows
                          .map((row) => {
                            const statusOpts = Array.from(new Set([...TREE_STATUS_OPTIONS, row.status || '待开始']));
                            return `
                              <tr>
                                <td style="padding:5px 8px;border-bottom:1px solid var(--border-hairline);max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                                  <button type="button" draggable="true" data-action="tree-open-file" data-path="${escapeHtml(row.path)}" data-name="${escapeHtml(row.file_name)}" title="点击打开，或拖入笔记生成锚点" style="display:inline-flex;align-items:center;gap:5px;max-width:100%;color:var(--accent);font-weight:500;text-align:left;">
                                    ${renderFileTypeIconHtml(row.file_name, 13)}
                                    <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(row.file_name)}</span>
                                  </button>
                                </td>
                                <td style="padding:5px 8px;border-bottom:1px solid var(--border-hairline);color:var(--text-secondary);">${escapeHtml(row.node_name)}</td>
                                <td style="padding:5px 8px;border-bottom:1px solid var(--border-hairline);">
                                  <select class="apple-select" data-action="tree-status-change" data-node-id="${escapeHtml(row.node_id)}" data-path="${escapeHtml(row.path)}" style="padding:2px 6px;font-size:11px;width:auto;">
                                    ${statusOpts
                                      .map((st) => `<option value="${escapeHtml(st)}" ${st === row.status ? 'selected' : ''}>${escapeHtml(st)}</option>`)
                                      .join('')}
                                  </select>
                                </td>
                              </tr>
                            `;
                          })
                          .join('')}
                      </tbody>
                    </table>
                  </div>
                `
                : `<div style="font-size:12px;color:var(--text-tertiary);">暂无已挂载的知识树文件记录</div>`
              : orderedNodes.length
                ? orderedNodes
                    .map(({ node, depth }) => {
                      const files = Array.isArray(node.files) ? node.files : [];
                      return `
                        <div class="glass-card" style="padding:8px 10px;margin-bottom:7px;margin-left:${depth * 12}px;">
                          <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
                            <span style="font-size:12.5px;font-weight:600;display:inline-flex;align-items:center;gap:5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                              ${icon('folder', 13)} ${escapeHtml(node.name)}
                              <span style="font-size:11px;color:var(--text-tertiary);font-weight:400;">(${files.length})</span>
                            </span>
                            <div style="display:inline-flex;align-items:center;gap:4px;flex-shrink:0;">
                              ${
                                activeFile?.path
                                  ? `<button type="button" class="pill-btn pill-btn-sm" data-action="tree-bind-active" data-node-id="${escapeHtml(node.id)}" title="将当前打开文件挂载到此节点" style="height:22px;padding:0 7px;font-size:11px;">+ 挂载</button>`
                                  : ''
                              }
                              <button type="button" class="icon-pill" data-action="tree-delete-node" data-node-id="${escapeHtml(node.id)}" title="删除节点" style="width:22px;height:22px;">
                                ${icon('trash', 11)}
                              </button>
                            </div>
                          </div>
                          ${
                            files.length
                              ? `<div style="display:flex;flex-direction:column;gap:4px;margin-top:6px;">
                                  ${files
                                    .map((f) => {
                                      const fname = getBaseName(f.path);
                                      const curStatus = f.status || '待开始';
                                      const statusOpts = Array.from(new Set([...TREE_STATUS_OPTIONS, curStatus]));
                                      return `
                                        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:3px 6px;border-radius:8px;background:var(--bg-island);">
                                          <button type="button" draggable="true" data-action="tree-open-file" data-path="${escapeHtml(f.path)}" data-name="${escapeHtml(fname)}" title="点击打开，或拖入笔记生成锚点" style="min-width:0;flex:1 1 auto;display:inline-flex;align-items:center;gap:5px;text-align:left;font-size:12px;color:var(--accent);overflow:hidden;">
                                            ${renderFileTypeIconHtml(fname, 13)}
                                            <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(fname)}</span>
                                            ${renderFileTypeBadgeHtml(fname)}
                                          </button>
                                          <select class="apple-select" data-action="tree-status-change" data-node-id="${escapeHtml(node.id)}" data-path="${escapeHtml(f.path)}" style="width:auto;padding:2px 5px;font-size:11px;height:22px;">
                                            ${statusOpts
                                              .map((st) => `<option value="${escapeHtml(st)}" ${st === curStatus ? 'selected' : ''}>${escapeHtml(st)}</option>`)
                                              .join('')}
                                          </select>
                                          <button type="button" data-action="tree-unbind-file" data-node-id="${escapeHtml(node.id)}" data-path="${escapeHtml(f.path)}" title="解除挂载（不删原文件）" style="color:var(--text-tertiary);display:inline-flex;padding:2px;">
                                            ${icon('x', 11)}
                                          </button>
                                        </div>
                                      `;
                                    })
                                    .join('')}
                                </div>`
                              : `<div style="font-size:11px;color:var(--text-tertiary);margin-top:4px;">暂无挂载文件</div>`
                          }
                        </div>
                      `;
                    })
                    .join('')
                : `<div style="font-size:12px;color:var(--text-tertiary);">暂无知识树分类节点，点击「新建分类节点」开始整理。</div>`
          }
        </div>
        ${renderModuleResizerHtml('knowledge_tree')}
      </details>
    `;

    const appsWsEmpty = apps.length === 0 && workspaces.length === 0;
    const appsWsScrollCls = buildScrollBodyClasses('apps_workspaces', appsWsEmpty, 'tool-card-body module-scroll-body');
    const appsWsScrollStyle = buildScrollBodyStyle('apps_workspaces', appsWsEmpty);
    const card3Html = `
      <details class="tool-card module-block" data-module-id="apps_workspaces" draggable="true" ${isToolOpen('apps_workspaces') ? 'open' : ''}>
        <summary class="tool-card-summary">
          <span style="display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden;">
            <span class="module-drag-handle" title="拖拽调整卡片顺序" style="color:var(--text-tertiary);cursor:grab;">⠿</span>
            ${icon('rocket', 14)} <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">本地软件库与一键场景包</span>
          </span>
          <span style="display:inline-flex;align-items:center;gap:6px;flex-shrink:0;">
            <span style="font-size:11px;color:var(--text-tertiary);font-weight:500;">${apps.length}·${workspaces.length}</span>
            ${renderRightModuleControlsHtml('apps_workspaces', '本地软件库与一键场景包')}
          </span>
        </summary>
        <div class="${appsWsScrollCls}" data-scroll-module="right_apps_workspaces" ${appsWsScrollStyle ? `style="${appsWsScrollStyle}"` : ''}>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">
            <button type="button" class="pill-btn pill-btn-primary pill-btn-sm" data-action="open-capture">
              ${icon('camera', 13)} 捕获当前桌面现场
            </button>
            <button type="button" class="pill-btn pill-btn-sm" data-action="open-add-app">
              ${icon('plus', 12)} 添加软件
            </button>
          </div>

          <div style="font-size:11.5px;font-weight:600;color:var(--text-secondary);margin-bottom:6px;">已登记本地软件</div>
          ${
            apps.length
              ? `<div class="app-pill-grid" style="margin-bottom:12px;">
                  ${apps
                    .map(
                      (app) => `
                      <span class="app-launcher-pill" draggable="true" data-app-id="${escapeHtml(app.id)}" data-name="${escapeHtml(app.name)}" title="点击启动，或直接拖进中间笔记生成直达胶囊" style="padding-right:6px;">
                        <button type="button" data-action="launch-app" data-app-id="${escapeHtml(app.id)}" data-name="${escapeHtml(app.name)}" style="display:inline-flex;align-items:center;gap:5px;">
                          ${icon('external-link', 12)}
                          <span>${escapeHtml(app.name)}</span>
                        </button>
                        <button type="button" data-action="delete-app" data-app-id="${escapeHtml(app.id)}" data-name="${escapeHtml(app.name)}" title="删除软件" style="display:inline-flex;align-items:center;color:var(--text-tertiary);margin-left:2px;">
                          ${icon('x', 11)}
                        </button>
                      </span>
                    `
                    )
                    .join('')}
                </div>`
              : `<div style="font-size:12px;color:var(--text-tertiary);margin-bottom:10px;">暂未登记本地软件</div>`
          }

          <div style="font-size:11.5px;font-weight:600;color:var(--text-secondary);margin-bottom:6px;">一键场景包</div>
          ${
            workspaces.length
              ? workspaces
                  .map((ws) => {
                    const appCount = (ws.app_ids || []).length;
                    const fileCount = (ws.file_paths || []).length;
                    const badgeLabel = `${appCount}软件${fileCount ? `·${fileCount}档` : ''}`;
                    return `
                      <div class="workspace-card workspace-row-compact" style="background:var(--bg-island);">
                        <div class="workspace-row-main" style="display:flex;align-items:center;gap:6px;min-width:0;flex:1;">
                          <span class="workspace-name" title="${escapeHtml(ws.name)}" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(ws.name)}</span>
                          <span class="file-ext-badge workspace-count-badge">${escapeHtml(badgeLabel)}</span>
                        </div>
                        <div class="workspace-row-actions" style="display:inline-flex;align-items:center;gap:4px;flex-shrink:0;">
                          <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-action="launch-workspace" data-ws-id="${escapeHtml(ws.id)}" data-name="${escapeHtml(ws.name)}" style="height:24px;padding:0 8px;font-size:11px;">
                            🚀 联启
                          </button>
                          <button type="button" class="pill-btn pill-btn-sm" data-action="focus-workspace" data-ws-id="${escapeHtml(ws.id)}" data-name="${escapeHtml(ws.name)}" style="height:24px;padding:0 8px;font-size:11px;">
                            ⏱ 专注
                          </button>
                          <button type="button" class="icon-pill" data-action="delete-workspace" data-ws-id="${escapeHtml(ws.id)}" data-name="${escapeHtml(ws.name)}" title="删除一键场景包" style="width:24px;height:24px;">
                            ${icon('trash', 11)}
                          </button>
                        </div>
                      </div>
                    `;
                  })
                  .join('')
              : `<div style="font-size:12px;color:var(--text-tertiary);">暂无一键场景包，可点击上方「捕获当前桌面现场」一键创建。</div>`
          }
        </div>
        ${renderModuleResizerHtml('apps_workspaces')}
      </details>
    `;

    const aiTplCls = buildScrollBodyClasses('ai_templates', false, 'tool-card-body module-scroll-body');
    const aiTplScrollStyle = buildScrollBodyStyle('ai_templates', false);
    const card4Html = `
      <details class="tool-card module-block" data-module-id="ai_templates" draggable="true" ${isToolOpen('ai_templates') ? 'open' : ''}>
        <summary class="tool-card-summary">
          <span style="display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden;">
            <span class="module-drag-handle" title="拖拽调整卡片顺序" style="color:var(--text-tertiary);cursor:grab;">⠿</span>
            ${icon('zap', 14)} <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">AI 常用指令模板</span>
          </span>
          <span style="display:inline-flex;align-items:center;gap:6px;flex-shrink:0;">
            <span style="font-size:11px;color:var(--text-tertiary);font-weight:500;">${AI_PROMPT_TEMPLATES.length} 模板</span>
            ${renderRightModuleControlsHtml('ai_templates', 'AI 常用指令模板')}
          </span>
        </summary>
        <div class="${aiTplCls}" data-scroll-module="right_ai_templates" ${aiTplScrollStyle ? `style="${aiTplScrollStyle}"` : ''}>
          ${renderAiTemplatesCardContentHtml()}
        </div>
        ${renderModuleResizerHtml('ai_templates')}
      </details>
    `;

    // --- V7.3 Tool 2: clipboard_snippets (📋 T1 剪贴板历史与常用模板片段) ---
    const clipHistory = Array.isArray(store.state.clipboardHistory) ? store.state.clipboardHistory : [];
    const mdSnippets = getAllMdSnippets();
    const defaultNewSnippetTitle = nextSequentialName('新建片段', mdSnippets.map((s) => s.title));
    const clipScrollCls = buildScrollBodyClasses('clipboard_snippets', false, 'tool-card-body module-scroll-body');
    const clipScrollStyle = buildScrollBodyStyle('clipboard_snippets', false);
    const inlineSnippetFormHtml = state.inlineSnippetCreateOpen
      ? `
        <div class="glass-card" style="margin-top:8px;padding:8px 10px;display:flex;flex-direction:column;gap:6px;">
          <input
            type="text"
            class="apple-input"
            data-role="inline-snippet-title"
            value="${escapeHtml(state.inlineSnippetTitleDraft)}"
            placeholder="片段名称（留空默认：${escapeHtml(defaultNewSnippetTitle)}）"
            style="height:28px;padding:4px 8px;font-size:12px;"
          />
          <textarea
            class="apple-textarea"
            data-role="inline-snippet-content"
            rows="3"
            placeholder="输入常用 Markdown 模板内容（支持 {{DATE}} 与 [[锚点]]）…"
            style="min-height:60px;padding:6px 8px;font-size:12px;"
          >${escapeHtml(state.inlineSnippetContentDraft)}</textarea>
          <div style="display:flex;justify-content:flex-end;gap:6px;">
            <button type="button" class="pill-btn pill-btn-sm pill-btn-ghost" data-action="snippet-create-cancel" style="height:24px;font-size:11px;">取消</button>
            <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-action="snippet-create-submit" style="height:24px;font-size:11px;">${icon('check', 11)} 保存片段</button>
          </div>
        </div>
      `
      : '';

    const clipboardSnippetsCardHtml = `
      <details class="tool-card module-block" data-module-id="clipboard_snippets" draggable="true" ${isToolOpen('clipboard_snippets') ? 'open' : ''}>
        <summary class="tool-card-summary">
          <span style="display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden;">
            <span class="module-drag-handle" title="拖拽调整卡片顺序" style="color:var(--text-tertiary);cursor:grab;">⠿</span>
            ${icon('clipboard', 14)} <span class="module-title" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">剪贴板历史与常用模板片段</span>
          </span>
          <span style="display:inline-flex;align-items:center;gap:6px;flex-shrink:0;">
            <span style="font-size:11px;color:var(--text-tertiary);font-weight:500;">${clipHistory.length}·${mdSnippets.length}</span>
            ${renderRightModuleControlsHtml('clipboard_snippets', '剪贴板历史与常用模板片段')}
          </span>
        </summary>
        <div class="${clipScrollCls}" data-scroll-module="right_clipboard_snippets" ${clipScrollStyle ? `style="${clipScrollStyle}"` : ''}>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:6px;flex-wrap:wrap;">
            <span style="font-size:11.5px;font-weight:600;color:var(--text-secondary);">📋 剪贴板历史 (${clipHistory.length}/12)</span>
            <div style="display:inline-flex;align-items:center;gap:4px;">
              <button type="button" class="pill-btn pill-btn-sm" data-action="clip-read-system" style="height:22px;padding:0 8px;font-size:11px;" title="读取系统当前剪贴板">
                📥 读取剪贴板
              </button>
              ${
                clipHistory.length > 0
                  ? `<button type="button" class="pill-btn pill-btn-sm pill-btn-ghost" data-action="clip-clear-all" style="height:22px;padding:0 7px;font-size:11px;">清空</button>`
                  : ''
              }
            </div>
          </div>
          <div class="tool-clipboard-list">
            ${
              clipHistory.length > 0
                ? clipHistory
                    .map(
                      (clip) => `
                        <div
                          class="tool-clipboard-item draggable-card"
                          draggable="true"
                          data-drag-type="clipboard-item"
                          data-clip-id="${escapeHtml(clip.id)}"
                          title="点击直接插入当前笔记，或按住拖入中间笔记"
                        >
                          <div style="min-width:0;flex:1 1 auto;" data-action="clip-insert-note" data-clip-id="${escapeHtml(clip.id)}">
                            <div style="font-size:11.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(clip.preview || clip.text)}</div>
                            <div style="font-size:10px;color:var(--text-tertiary);margin-top:1px;">${escapeHtml(clip.time || '')} · ${escapeHtml(clip.source || '复制')}</div>
                          </div>
                          <div style="display:inline-flex;align-items:center;gap:3px;flex-shrink:0;">
                            <button type="button" class="left-icon-btn is-xs" data-action="clip-insert-note" data-clip-id="${escapeHtml(clip.id)}" title="一键插入当前笔记">${icon('plus', 11)}</button>
                            <button type="button" class="left-icon-btn is-xs" data-action="clip-copy-item" data-clip-id="${escapeHtml(clip.id)}" title="复制">${icon('copy', 11)}</button>
                            <button type="button" class="left-icon-btn is-xs" data-action="clip-delete-item" data-clip-id="${escapeHtml(clip.id)}" title="删除此条">${icon('x', 11)}</button>
                          </div>
                        </div>
                      `
                    )
                    .join('')
                : `<div style="font-size:11.5px;color:var(--text-tertiary);padding:4px 2px;">复制或剪切任意文本后自动收录（仅驻留内存，关闭即焚）</div>`
            }
          </div>

          <div style="border-top:1px solid var(--border-hairline);margin-top:10px;padding-top:8px;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:4px;">
              <span style="font-size:11.5px;font-weight:600;color:var(--text-secondary);">📌 常用 Markdown 模板片段</span>
              <button type="button" class="pill-btn pill-btn-sm" data-action="snippet-toggle-create" style="height:22px;padding:0 8px;font-size:11px;">
                + 新建片段
              </button>
            </div>
            <div class="tool-snippet-pills">
              ${mdSnippets
                .map(
                  (snip) => `
                    <span
                      class="tool-snippet-pill draggable-card"
                      draggable="true"
                      data-drag-type="md-snippet"
                      data-snippet-id="${escapeHtml(snip.id)}"
                      title="点击一键插入当前笔记，或按住拖入笔记"
                    >
                      <button
                        type="button"
                        data-action="snippet-insert"
                        data-snippet-id="${escapeHtml(snip.id)}"
                        style="display:inline-flex;align-items:center;gap:4px;color:inherit;"
                      >
                        <span>${escapeHtml(snip.icon || '📌')}</span>
                        <span>${escapeHtml(snip.title)}</span>
                      </button>
                      ${
                        snip.custom
                          ? `<button type="button" data-action="snippet-delete" data-snippet-id="${escapeHtml(snip.id)}" title="删除自定义片段" style="display:inline-flex;align-items:center;color:var(--text-tertiary);margin-left:2px;">×</button>`
                          : ''
                      }
                    </span>
                  `
                )
                .join('')}
            </div>
            ${inlineSnippetFormHtml}
          </div>
        </div>
        ${renderModuleResizerHtml('clipboard_snippets')}
      </details>
    `;

    // --- V7.3 Tool 3: doc_outline (📑 T2 文档大纲与高亮速览) ---
    const outlineData = extractDocOutlineData(store.state.activeDocumentText || '');
    const outlineScrollCls = buildScrollBodyClasses('doc_outline', false, 'tool-card-body module-scroll-body');
    const outlineScrollStyle = buildScrollBodyStyle('doc_outline', false);
    const docOutlineCardHtml = `
      <details class="tool-card module-block" data-module-id="doc_outline" draggable="true" ${isToolOpen('doc_outline') ? 'open' : ''}>
        <summary class="tool-card-summary">
          <span style="display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden;">
            <span class="module-drag-handle" title="拖拽调整卡片顺序" style="color:var(--text-tertiary);cursor:grab;">⠿</span>
            ${icon('book-open', 14)} <span class="module-title" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">文档大纲与高亮速览</span>
          </span>
          <span style="display:inline-flex;align-items:center;gap:6px;flex-shrink:0;">
            <span style="font-size:11px;color:var(--text-tertiary);font-weight:500;">${outlineData.headings.length}节·${outlineData.highlights.length}亮</span>
            ${renderRightModuleControlsHtml('doc_outline', '文档大纲与高亮速览')}
          </span>
        </summary>
        <div class="${outlineScrollCls}" data-scroll-module="right_doc_outline" ${outlineScrollStyle ? `style="${outlineScrollStyle}"` : ''}>
          <div style="font-size:11.5px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;display:flex;align-items:center;justify-content:space-between;">
            <span>📑 章节标题树 (${outlineData.headings.length})</span>
            <span style="font-size:10.5px;color:var(--text-tertiary);font-weight:400;">点击跳转 · 拖拽生成锚点</span>
          </div>
          <div class="tool-outline-tree">
            ${
              outlineData.headings.length > 0
                ? outlineData.headings
                    .map(
                      (h) => `
                        <div
                          class="tool-outline-item draggable-card"
                          style="--level:${Math.max(0, h.level - 1)};"
                          draggable="true"
                          data-drag-type="outline-heading"
                          data-action="outline-jump-heading"
                          data-heading="${escapeHtml(h.text)}"
                          data-line-no="${h.lineNo}"
                          title="点击跳转到 #${escapeHtml(h.text)} (第 ${h.lineNo} 行)，或拖入笔记生成章节锚点"
                        >
                          <span style="font-size:10px;color:var(--text-tertiary);font-family:var(--font-mono);flex-shrink:0;">H${h.level}</span>
                          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(h.text)}</span>
                          <span style="font-size:10px;color:var(--text-tertiary);font-family:var(--font-mono);flex-shrink:0;">L${h.lineNo}</span>
                        </div>
                      `
                    )
                    .join('')
                : `<div style="font-size:11.5px;color:var(--text-tertiary);padding:4px 2px;">当前文档暂无 # ~ #### 标题</div>`
            }
          </div>

          <div style="border-top:1px solid var(--border-hairline);margin-top:8px;padding-top:8px;">
            <div style="font-size:11.5px;font-weight:600;color:var(--text-secondary);margin-bottom:5px;">
              🖍 ==高亮标记== (${outlineData.highlights.length})
            </div>
            ${
              outlineData.highlights.length > 0
                ? `<div style="display:flex;flex-wrap:wrap;gap:5px;">
                    ${outlineData.highlights
                      .map(
                        (hl) => `
                          <button
                            type="button"
                            class="tool-highlight-chip draggable-card"
                            draggable="true"
                            data-drag-type="outline-highlight"
                            data-action="outline-jump-highlight"
                            data-highlight-text="${escapeHtml(hl.text)}"
                            data-line-no="${hl.lineNo}"
                            title="点击定位第 ${hl.lineNo} 行，或拖入笔记"
                          >
                            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:190px;">${escapeHtml(hl.text)}</span>
                            <span style="font-size:10px;opacity:0.65;font-family:var(--font-mono);">L${hl.lineNo}</span>
                          </button>
                        `
                      )
                      .join('')}
                  </div>`
                : `<div style="font-size:11.5px;color:var(--text-tertiary);padding:2px;">使用 ==重点文字== 语法即可在此聚合速览</div>`
            }
          </div>

          <div style="border-top:1px solid var(--border-hairline);margin-top:8px;padding-top:8px;">
            <div style="font-size:11.5px;font-weight:600;color:var(--text-secondary);margin-bottom:5px;">
              ☑ 本篇待办 (${outlineData.todos.length})
            </div>
            ${
              outlineData.todos.length > 0
                ? `<div style="display:flex;flex-direction:column;gap:4px;max-height:140px;overflow-y:auto;">
                    ${outlineData.todos
                      .map(
                        (td) => `
                          <div
                            class="tool-outline-item draggable-card"
                            draggable="true"
                            data-drag-type="outline-todo"
                            data-action="outline-jump-todo"
                            data-todo-text="${escapeHtml(td.text)}"
                            data-line-no="${td.lineNo}"
                            title="点击定位第 ${td.lineNo} 行，或拖入其他笔记"
                          >
                            <span style="color:${td.checked ? 'var(--success)' : 'var(--accent)'};flex-shrink:0;">${td.checked ? '☑' : '☐'}</span>
                            <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${td.checked ? 'text-decoration:line-through;color:var(--text-tertiary);' : ''}">${escapeHtml(td.text)}</span>
                            <span style="font-size:10px;color:var(--text-tertiary);font-family:var(--font-mono);flex-shrink:0;">L${td.lineNo}</span>
                          </div>
                        `
                      )
                      .join('')}
                  </div>`
                : `<div style="font-size:11.5px;color:var(--text-tertiary);padding:2px;">本篇暂无 - [ ] 待办事项</div>`
            }
          </div>
        </div>
        ${renderModuleResizerHtml('doc_outline')}
      </details>
    `;

    // --- V7.3 Tool 4: text_studio (⚡ T3 极简文本排版工坊) ---
    const studioSourceText = state.studioText.trim()
      ? state.studioText
      : (store.state.activeDocumentText || '');
    const studioStats = computeTextStudioStats(studioSourceText);
    const studioScrollCls = buildScrollBodyClasses('text_studio', false, 'tool-card-body module-scroll-body');
    const studioScrollStyle = buildScrollBodyStyle('text_studio', false);
    const textStudioCardHtml = `
      <details class="tool-card module-block" data-module-id="text_studio" draggable="true" ${isToolOpen('text_studio') ? 'open' : ''}>
        <summary class="tool-card-summary">
          <span style="display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden;">
            <span class="module-drag-handle" title="拖拽调整卡片顺序" style="color:var(--text-tertiary);cursor:grab;">⠿</span>
            ${icon('zap', 14)} <span class="module-title" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">极简文本排版工坊</span>
          </span>
          <span style="display:inline-flex;align-items:center;gap:6px;flex-shrink:0;">
            <span data-role="studio-header-words" style="font-size:11px;color:var(--text-tertiary);font-weight:500;">${studioStats.words} 字</span>
            ${renderRightModuleControlsHtml('text_studio', '极简文本排版工坊')}
          </span>
        </summary>
        <div class="${studioScrollCls}" data-scroll-module="right_text_studio" ${studioScrollStyle ? `style="${studioScrollStyle}"` : ''}>
          <div class="tool-text-studio">
            <div class="studio-stat-grid">
              <div class="studio-stat-card">
                <span class="studio-stat-val" data-role="studio-stat-words">${studioStats.words}</span>
                <span class="studio-stat-label" data-role="studio-stat-chars">字数 (${studioStats.chars}字符)</span>
              </div>
              <div class="studio-stat-card">
                <span class="studio-stat-val" data-role="studio-stat-lines">${studioStats.lines}</span>
                <span class="studio-stat-label">总行数</span>
              </div>
              <div class="studio-stat-card">
                <span class="studio-stat-val" data-role="studio-stat-read">${studioStats.readMins}m</span>
                <span class="studio-stat-label">预计阅读</span>
              </div>
            </div>

            <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;">
              <span style="font-size:11px;color:var(--text-tertiary);">${state.studioText.trim() ? '当前统计：工坊输入框' : '当前统计：活动文档（点击转换自动载入）'}</span>
              <div style="display:inline-flex;gap:4px;">
                <button type="button" class="pill-btn pill-btn-sm" data-action="studio-load-doc" style="height:22px;padding:0 8px;font-size:11px;">
                  📥 载入当前文档
                </button>
                <button type="button" class="pill-btn pill-btn-sm pill-btn-ghost" data-action="studio-clear" style="height:22px;padding:0 7px;font-size:11px;">
                  清空
                </button>
              </div>
            </div>

            <textarea
              class="apple-textarea"
              data-role="text-studio-input"
              rows="4"
              placeholder="粘贴或输入待排版文本，或点击上方「载入当前文档」进行纯本地转换…"
              style="min-height:76px;font-size:12px;font-family:var(--font-mono);padding:7px 9px;"
            >${escapeHtml(state.studioText)}</textarea>

            <div class="studio-action-grid">
              <button type="button" class="pill-btn pill-btn-sm" data-action="studio-transform" data-op="pangu" style="height:26px;font-size:11.5px;justify-content:center;">
                中英自动加空格
              </button>
              <button type="button" class="pill-btn pill-btn-sm" data-action="studio-transform" data-op="clean" style="height:26px;font-size:11.5px;justify-content:center;">
                清理空行与乱码
              </button>
              <button type="button" class="pill-btn pill-btn-sm" data-action="studio-transform" data-op="csv-to-table" style="height:26px;font-size:11.5px;justify-content:center;">
                CSV/Tab 转 Markdown 表格
              </button>
              <button type="button" class="pill-btn pill-btn-sm" data-action="studio-transform" data-op="to-todos" style="height:26px;font-size:11.5px;justify-content:center;">
                转为待办清单
              </button>
              <button type="button" class="pill-btn pill-btn-sm" data-action="studio-transform" data-op="json-format" style="grid-column:1 / -1;height:26px;font-size:11.5px;justify-content:center;">
                { } JSON 格式化
              </button>
            </div>

            <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;padding-top:2px;">
              <span
                class="drag-pill-hint draggable-card"
                draggable="true"
                data-drag-type="studio-text"
                title="按住将工坊文本拖入中间笔记"
                style="padding:3px 9px;font-size:11px;color:var(--accent);background:var(--accent-soft);cursor:grab;"
              >
                ⠿ 拖入笔记
              </span>
              <div style="display:inline-flex;gap:5px;">
                <button type="button" class="pill-btn pill-btn-sm" data-action="studio-copy" style="height:24px;padding:0 9px;font-size:11px;">
                  ${icon('copy', 11)} 复制
                </button>
                <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-action="studio-insert-doc" style="height:24px;padding:0 9px;font-size:11px;">
                  ${icon('plus', 11)} 插入当前笔记
                </button>
              </div>
            </div>
          </div>
        </div>
        ${renderModuleResizerHtml('text_studio')}
      </details>
    `;

    // --- V7.3 Tool 5: focus_pulse (⏱ T4 今日专注脉搏与 K1 关系微图谱) ---
    const pulse = store.state.focusPulse || { count: 0, totalMinutes: 0, sessions: [], history: [] };
    const pulseCount = Number(pulse.count) || 0;
    const pulseMins = Number(pulse.totalMinutes) || 0;
    const pulseSessions = Array.isArray(pulse.sessions) ? pulse.sessions : [];
    const ringPct = Math.min(100, Math.round((pulseMins / 120) * 100));
    const ringCircumference = 94.25;
    const ringOffset = Number((ringCircumference * (1 - ringPct / 100)).toFixed(2));
    const linkGraph = store.state.linkGraph || {};
    const graphNodesCount = Array.isArray(linkGraph.local_graph?.nodes) ? linkGraph.local_graph.nodes.length : 0;
    const focusPulseScrollCls = buildScrollBodyClasses('focus_pulse', false, 'tool-card-body module-scroll-body');
    const focusPulseScrollStyle = buildScrollBodyStyle('focus_pulse', false);

    const focusPulseCardHtml = `
      <details class="tool-card module-block" data-module-id="focus_pulse" draggable="true" ${isToolOpen('focus_pulse') ? 'open' : ''}>
        <summary class="tool-card-summary">
          <span style="display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden;">
            <span class="module-drag-handle" title="拖拽调整卡片顺序" style="color:var(--text-tertiary);cursor:grab;">⠿</span>
            ${icon('clock', 14)} <span class="module-title" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">今日专注脉搏与关系微图谱</span>
          </span>
          <span style="display:inline-flex;align-items:center;gap:6px;flex-shrink:0;">
            <span style="font-size:11px;color:var(--text-tertiary);font-weight:500;">${pulseMins}m·${graphNodesCount}节点</span>
            ${renderRightModuleControlsHtml('focus_pulse', '今日专注脉搏与关系微图谱')}
          </span>
        </summary>
        <div class="${focusPulseScrollCls}" data-scroll-module="right_focus_pulse" ${focusPulseScrollStyle ? `style="${focusPulseScrollStyle}"` : ''}>
          <div class="tool-focus-pulse">
            <div class="pulse-ring-card">
              <svg width="38" height="38" viewBox="0 0 38 38" style="flex-shrink:0;transform:rotate(-90deg);">
                <circle cx="19" cy="19" r="15" fill="none" stroke="var(--border-hairline)" stroke-width="3.5" />
                <circle
                  cx="19"
                  cy="19"
                  r="15"
                  fill="none"
                  stroke="${pulseMins >= 120 ? 'var(--success)' : 'var(--accent)'}"
                  stroke-width="3.5"
                  stroke-linecap="round"
                  stroke-dasharray="${ringCircumference}"
                  stroke-dashoffset="${ringOffset}"
                />
              </svg>
              <div class="pulse-ring-meta">
                <div class="pulse-ring-value">今日 ${pulseCount} 次 · ${pulseMins} 分钟</div>
                <div class="pulse-ring-label">
                  ${
                    pulseSessions.length > 0
                      ? `最近完成：${escapeHtml(pulseSessions[pulseSessions.length - 1].title)} (${pulseSessions[pulseSessions.length - 1].minutes}m)`
                      : '暂未记录今日专注，点击右侧开启番茄钟'
                  }
                </div>
              </div>
              <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-action="pulse-start-focus" style="height:26px;padding:0 10px;font-size:11.5px;flex-shrink:0;">
                ${icon('play', 11)} 专注
              </button>
            </div>

            ${
              pulseSessions.length > 0
                ? `<div style="display:flex;flex-direction:column;gap:4px;max-height:110px;overflow-y:auto;">
                    ${pulseSessions
                      .slice(-4)
                      .reverse()
                      .map((s) => {
                        const hm = s.finishedAt ? formatTriggerTime(s.finishedAt).slice(-8, -3) : '';
                        return `
                          <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:4px 8px;border-radius:8px;background:var(--bg-subtle);font-size:11.5px;">
                            <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-primary);">🍅 ${escapeHtml(s.title)}</span>
                            <span style="font-size:10.5px;color:var(--text-tertiary);font-family:var(--font-mono);flex-shrink:0;">${s.minutes}m ${escapeHtml(hm)}</span>
                          </div>
                        `;
                      })
                      .join('')}
                  </div>`
                : ''
            }

            <button
              type="button"
              class="pill-btn pill-btn-sm"
              data-action="pulse-write-review"
              style="height:28px;justify-content:center;font-size:11.5px;width:100%;"
            >
              📝 将今日专注复盘写入当前笔记
            </button>

            <div style="border-top:1px solid var(--border-hairline);margin-top:4px;padding-top:8px;">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:6px;">
                <span style="font-size:11.5px;font-weight:600;color:var(--text-secondary);">🕸 K1 局部关系微图谱 (${graphNodesCount} 节点)</span>
                <button type="button" class="pill-btn pill-btn-sm pill-btn-ghost" data-action="pulse-refresh-graph" style="height:20px;padding:0 6px;font-size:10.5px;">
                  ${icon('rotate-ccw', 10)} 刷新
                </button>
              </div>
              ${renderMiniLinkGraphSvgHtml(linkGraph)}
            </div>
          </div>
        </div>
        ${renderModuleResizerHtml('focus_pulse')}
      </details>
    `;

    const cardMap = {
      quick_excel: card1Html,
      clipboard_snippets: clipboardSnippetsCardHtml,
      doc_outline: docOutlineCardHtml,
      text_studio: textStudioCardHtml,
      focus_pulse: focusPulseCardHtml,
      knowledge_tree: card2Html,
      apps_workspaces: card3Html,
      ai_templates: card4Html,
    };

    const visibleToolModules = getUiLayout().rightToolModules.filter((m) => m.visible);
    toolsEl.innerHTML = visibleToolModules.length
      ? visibleToolModules.map((m) => cardMap[m.id] || '').join('')
      : `
        <div class="empty-state" style="padding:28px 12px;">
          <p class="empty-title">所有工具台卡片已隐藏</p>
          <p class="empty-desc">点击右上角 ⚙ 自定义右侧模块重新开启需要的工具卡片。</p>
          <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-action="open-right-customize">
            ${icon('settings', 13)} 自定义模块
          </button>
        </div>
      `;
  }

  function extractDocOutlineData(rawText) {
    const text = String(rawText || '').replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    const headings = [];
    const highlights = [];
    const todos = [];
    let inFence = false;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const lineNo = i + 1;
      if (/^\s*(?:`{3,}|~{3,})/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;

      const hMatch = line.match(/^\s*(#{1,4})\s+(.+?)\s*#*$/);
      if (hMatch) {
        const cleanHeading = hMatch[2].replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();
        if (cleanHeading) {
          headings.push({
            level: hMatch[1].length,
            text: cleanHeading,
            lineNo,
          });
        }
      }

      const hlRegex = /==([^=\n]+)==/g;
      let hlMatch;
      while ((hlMatch = hlRegex.exec(line)) !== null) {
        const hlText = hlMatch[1].trim();
        if (hlText) {
          highlights.push({ text: hlText, lineNo });
        }
      }

      const todoMatch = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/);
      if (todoMatch) {
        todos.push({
          checked: todoMatch[1].toLowerCase() === 'x',
          text: todoMatch[2].trim(),
          lineNo,
        });
      }
    }

    return { headings, highlights, todos };
  }

  function computeTextStudioStats(rawText) {
    const text = String(rawText || '');
    const chars = text.length;
    const lines = text ? text.replace(/\r\n/g, '\n').split('\n').length : 0;
    const cjkCount = (text.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    const asciiWords = (
      text.replace(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g, ' ').match(/[A-Za-z0-9_]+/g) || []
    ).length;
    const words = cjkCount + asciiWords;
    const readMins = words === 0 ? 0 : Math.max(1, Math.ceil(words / 300));
    return { words, chars, lines, readMins };
  }

  function syncTextStudioStatsDom() {
    if (!toolsEl) return;
    const sourceText = state.studioText.trim()
      ? state.studioText
      : (store.state.activeDocumentText || '');
    const st = computeTextStudioStats(sourceText);
    const wordsEl = toolsEl.querySelector('[data-role="studio-stat-words"]');
    const charsEl = toolsEl.querySelector('[data-role="studio-stat-chars"]');
    const linesEl = toolsEl.querySelector('[data-role="studio-stat-lines"]');
    const readEl = toolsEl.querySelector('[data-role="studio-stat-read"]');
    const headerWordsEl = toolsEl.querySelector('[data-role="studio-header-words"]');
    if (wordsEl) wordsEl.textContent = String(st.words);
    if (charsEl) charsEl.textContent = `字数 (${st.chars}字符)`;
    if (linesEl) linesEl.textContent = String(st.lines);
    if (readEl) readEl.textContent = `${st.readMins}m`;
    if (headerWordsEl) headerWordsEl.textContent = `${st.words} 字`;
  }

  function applyStudioTransform(op, inputStr) {
    const src = String(inputStr || '').replace(/\r\n/g, '\n');
    if (!src.trim()) return src;

    if (op === 'pangu') {
      return src
        .replace(/([\u4e00-\u9fa5])([A-Za-z0-9])/g, '$1 $2')
        .replace(/([A-Za-z0-9])([\u4e00-\u9fa5])/g, '$1 $2');
    }

    if (op === 'clean') {
      return src
        .replace(/[\u200B-\u200D\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/g, '')
        .split('\n')
        .map((l) => l.replace(/[ \t]+$/g, ''))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    if (op === 'csv-to-table') {
      const nonEmptyLines = src
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      if (nonEmptyLines.length === 0) return src;
      const useTab = nonEmptyLines.some((l) => l.includes('\t'));
      const splitRow = (line) => {
        if (useTab) return line.split('\t').map((c) => c.trim());
        const cells = [];
        let cur = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i += 1) {
          const ch = line[i];
          if (ch === '"') {
            inQuotes = !inQuotes;
          } else if ((ch === ',' || ch === '，') && !inQuotes) {
            cells.push(cur.trim());
            cur = '';
          } else {
            cur += ch;
          }
        }
        cells.push(cur.trim());
        return cells;
      };
      const rows = nonEmptyLines.map(splitRow);
      const colCount = Math.max(1, ...rows.map((r) => r.length));
      const padRow = (r) => {
        const next = [...r];
        while (next.length < colCount) next.push('');
        return `| ${next.map((c) => c.replace(/\|/g, '\\|') || ' ').join(' | ')} |`;
      };
      const headerLine = padRow(rows[0]);
      const sepLine = `| ${Array.from({ length: colCount }, () => '---').join(' | ')} |`;
      const bodyLines = rows.slice(1).map(padRow);
      return [headerLine, sepLine, ...bodyLines].join('\n');
    }

    if (op === 'to-todos') {
      return src
        .split('\n')
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return '';
          if (/^[-*+]\s+\[[ xX]\]\s+/.test(trimmed)) return trimmed;
          const cleaned = trimmed.replace(/^(?:[-*+•]|\d+[.)、])\s+/, '');
          return `- [ ] ${cleaned}`;
        })
        .filter(Boolean)
        .join('\n');
    }

    if (op === 'json-format') {
      const stripped = src
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '');
      const parsed = JSON.parse(stripped);
      return JSON.stringify(parsed, null, 2);
    }

    return src;
  }

  function renderMiniLinkGraphSvgHtml(linkGraph) {
    const nodes = Array.isArray(linkGraph?.local_graph?.nodes)
      ? linkGraph.local_graph.nodes.slice(0, 11)
      : [];
    const edges = Array.isArray(linkGraph?.local_graph?.edges)
      ? linkGraph.local_graph.edges
      : [];

    if (nodes.length === 0) {
      return `
        <svg class="mini-link-graph-svg" viewBox="0 0 320 132" role="img" aria-label="局部关系微图谱">
          <text x="160" y="70" text-anchor="middle" font-size="11.5" fill="var(--text-tertiary)">暂无双链或 #标签 节点（在笔记中使用 [[笔记名]] 或 #标签）</text>
        </svg>
      `;
    }

    const cx = 160;
    const cy = 64;
    const rx = 112;
    const ry = 42;
    const posMap = new Map();

    const centerIdx = Math.max(0, nodes.findIndex((n) => n.kind === 'active'));
    const centerNode = nodes[centerIdx];
    const outerNodes = nodes.filter((_, i) => i !== centerIdx);

    posMap.set(centerNode.id, { x: cx, y: cy, node: centerNode, isCenter: true });
    outerNodes.forEach((n, idx) => {
      const angle = (2 * Math.PI * idx) / Math.max(1, outerNodes.length) - Math.PI / 2;
      const x = Math.round(cx + rx * Math.cos(angle));
      const y = Math.round(cy + ry * Math.sin(angle));
      posMap.set(n.id, { x, y, node: n, isCenter: false });
    });

    const linesSvg = edges
      .map((ed) => {
        const s = posMap.get(ed.source);
        const t = posMap.get(ed.target);
        if (!s || !t) return '';
        const strokeColor = ed.kind === 'tag' ? 'rgba(245, 158, 11, 0.45)' : 'rgba(0, 122, 255, 0.38)';
        return `<line x1="${s.x}" y1="${s.y}" x2="${t.x}" y2="${t.y}" stroke="${strokeColor}" stroke-width="1.5" ${ed.kind === 'tag' ? 'stroke-dasharray="3,2"' : ''} />`;
      })
      .join('');

    const nodesSvg = Array.from(posMap.values())
      .map(({ x, y, node, isCenter }) => {
        const fill =
          node.kind === 'active'
            ? '#007AFF'
            : node.kind === 'tag'
              ? '#F59E0B'
              : node.kind === 'neighbor'
                ? '#34C759'
                : '#5856D6';
        const rawLabel = String(node.label || '').replace(/\.md$/i, '');
        const shortLabel = rawLabel.length > 10 ? `${rawLabel.slice(0, 9)}…` : rawLabel;
        const r = isCenter ? 8 : 5.5;
        return `
          <g
            class="mini-graph-node"
            data-action="graph-node-click"
            data-node-id="${escapeHtml(node.id)}"
            data-node-kind="${escapeHtml(node.kind)}"
            data-node-label="${escapeHtml(node.label)}"
            style="cursor:pointer;"
          >
            <title>${escapeHtml(node.label)}（点击打开）</title>
            <circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="#FFFFFF" stroke-width="1.5" />
            <text x="${x}" y="${Math.min(126, y + r + 10)}" text-anchor="middle" font-size="9.5" font-weight="${isCenter ? '700' : '500'}" fill="var(--text-secondary)">${escapeHtml(shortLabel)}</text>
          </g>
        `;
      })
      .join('');

    return `
      <svg class="mini-link-graph-svg" viewBox="0 0 320 132" role="img" aria-label="局部关系微图谱">
        ${linesSvg}
        ${nodesSvg}
      </svg>
    `;
  }

  function openAddColSheet() {
    if (!state.selectedExcelPath) return;
    const sheetInfo = state.excelSheets.find((s) => s.name === state.selectedSheet);
    const nextIdx = (sheetInfo?.headers?.length || 0) + 1;
    const defaultColName = nextSequentialName('新建列', sheetInfo?.headers || []);
    openSheet({
      title: '新增 Excel 列',
      bodyHtml: `
        <div style="display:flex;flex-direction:column;gap:10px;">
          <div>
            <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">新列表头名称</label>
            <input type="text" class="apple-input" id="add-col-name" placeholder="留空自动命名：${escapeHtml(defaultColName)}" />
          </div>
          <div>
            <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">插入列序号（1 为首列，默认末尾第 ${nextIdx} 列）</label>
            <input type="number" class="apple-input" id="add-col-index" min="1" value="${nextIdx}" />
          </div>
        </div>
      `,
      footerHtml: `
        <button type="button" class="pill-btn" id="add-col-cancel">取消</button>
        <button type="button" class="pill-btn pill-btn-primary" id="add-col-ok">确认增列</button>
      `,
      onMount(card) {
        card.querySelector('#add-col-cancel')?.addEventListener('click', closeSheet);
        card.querySelector('#add-col-ok')?.addEventListener('click', async () => {
          const name = card.querySelector('#add-col-name')?.value?.trim() || defaultColName;
          const index = Math.max(1, Number(card.querySelector('#add-col-index')?.value) || nextIdx);
          try {
            await api.post('/api/excel/structure', {
              path: state.selectedExcelPath,
              sheet: state.selectedSheet || null,
              op: 'add_col',
              index,
              name,
            });
            closeSheet();
            await loadExcelSheets(state.selectedExcelPath);
            store.emit('file:refresh-excel', { path: state.selectedExcelPath, sheet: state.selectedSheet });
            showToast(`已新增列「${name}」`, 'success');
          } catch (err) {
            showToast(err?.message || '增列失败', 'error');
          }
        });
      },
    });
  }

  function openDelRowSheet() {
    if (!state.selectedExcelPath) return;
    openSheet({
      title: '删除指定 Excel 行',
      bodyHtml: `
        <div style="display:flex;flex-direction:column;gap:10px;">
          <p style="margin:0;font-size:12px;color:var(--text-secondary);">第 1 行为表头保护行，仅允许删除第 2 行及以上的数据行（写前会自动生成安全快照）。</p>
          <div>
            <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">目标行号 (≥ 2)</label>
            <input type="number" class="apple-input" id="del-row-index" min="2" value="2" />
          </div>
        </div>
      `,
      footerHtml: `
        <button type="button" class="pill-btn" id="del-row-cancel">取消</button>
        <button type="button" class="pill-btn pill-btn-danger" id="del-row-ok">确认删除行</button>
      `,
      onMount(card) {
        card.querySelector('#del-row-cancel')?.addEventListener('click', closeSheet);
        card.querySelector('#del-row-ok')?.addEventListener('click', async () => {
          const index = Number(card.querySelector('#del-row-index')?.value);
          if (!Number.isInteger(index) || index < 2) {
            showToast('请输入 ≥ 2 的有效行号', 'warning');
            return;
          }
          try {
            await api.post('/api/excel/structure', {
              path: state.selectedExcelPath,
              sheet: state.selectedSheet || null,
              op: 'del_row',
              index,
            });
            closeSheet();
            await loadExcelSheets(state.selectedExcelPath);
            store.emit('file:refresh-excel', { path: state.selectedExcelPath, sheet: state.selectedSheet });
            showToast(`已删除第 ${index} 行`, 'success');
          } catch (err) {
            showToast(err?.message || '删行失败', 'error');
          }
        });
      },
    });
  }

  function openCreateTreeNodeSheet() {
    const nodes = state.treeData.nodes || [];
    const defaultNodeName = nextSequentialName('新建分类', nodes.map((n) => n?.name || ''));
    openSheet({
      title: '新建知识树分类节点',
      bodyHtml: `
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div>
            <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">分类节点名称</label>
            <input type="text" class="apple-input" id="tree-node-name" placeholder="留空自动命名：${escapeHtml(defaultNodeName)}" />
          </div>
          <div>
            <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">父级节点（可选）</label>
            <select class="apple-select" id="tree-node-parent">
              <option value="">作为顶级分类</option>
              ${nodes.map((n) => `<option value="${escapeHtml(n.id)}">${escapeHtml(n.name)}</option>`).join('')}
            </select>
          </div>
        </div>
      `,
      footerHtml: `
        <button type="button" class="pill-btn" id="tree-node-cancel">取消</button>
        <button type="button" class="pill-btn pill-btn-primary" id="tree-node-ok">创建节点</button>
      `,
      onMount(card) {
        card.querySelector('#tree-node-cancel')?.addEventListener('click', closeSheet);
        card.querySelector('#tree-node-ok')?.addEventListener('click', async () => {
          const name = card.querySelector('#tree-node-name')?.value?.trim() || defaultNodeName;
          const parentId = card.querySelector('#tree-node-parent')?.value || null;
          try {
            await api.post('/api/tree', { name, parent_id: parentId });
            closeSheet();
            await fetchTree();
            store.emit('tree:updated');
            showToast(`已创建节点「${name}」`, 'success');
          } catch (err) {
            showToast(err?.message || '创建节点失败', 'error');
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
        <div style="display:flex;flex-direction:column;gap:10px;">
          <div>
            <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">软件名称（可留空）</label>
            <input type="text" class="apple-input" id="add-app-name" placeholder="留空自动取程序文件名或 ${escapeHtml(defaultAppName)}" />
          </div>
          <div>
            <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">可执行路径 (.exe / .lnk / 命令名)</label>
            <input type="text" class="apple-input" id="add-app-path" placeholder="例如：C:/.../wps.exe" />
          </div>
          <div>
            <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">识别别名（逗号分隔，供 AI 匹配）</label>
            <input type="text" class="apple-input" id="add-app-aliases" placeholder="例如：WPS, 文档, 表格" />
          </div>
        </div>
      `,
      footerHtml: `
        <button type="button" class="pill-btn" id="add-app-cancel">取消</button>
        <button type="button" class="pill-btn pill-btn-primary" id="add-app-ok">保存软件</button>
      `,
      onMount(card) {
        card.querySelector('#add-app-cancel')?.addEventListener('click', closeSheet);
        card.querySelector('#add-app-ok')?.addEventListener('click', async () => {
          const path = card.querySelector('#add-app-path')?.value?.trim();
          const derivedName = path ? getBaseName(path).replace(/\.(exe|lnk|bat|cmd)$/i, '').trim() : '';
          const name = card.querySelector('#add-app-name')?.value?.trim() || derivedName || defaultAppName;
          const aliasesRaw = card.querySelector('#add-app-aliases')?.value || '';
          const aliases = aliasesRaw
            .split(/[,，]/)
            .map((s) => s.trim())
            .filter(Boolean);
          if (!path) {
            showToast('请填写软件可执行路径', 'warning');
            return;
          }
          try {
            await api.post('/api/apps', { name, path, aliases });
            closeSheet();
            await fetchAppsAndWorkspaces();
            store.emit('apps:updated');
            showToast(`已登记软件：${name}`, 'success');
          } catch (err) {
            showToast(err?.message || '添加软件失败', 'error');
          }
        });
      },
    });
  }

  async function launchApp(appId, name) {
    try {
      const res = await api.post('/api/apps/launch', { app_id: appId });
      if (res?.launched?.length) {
        showToast(`已拉起：${res.launched.map((a) => a.name).join('、')}`, 'success');
      } else if (res?.failed?.length) {
        showToast(res.failed[0].reason || `无法启动 ${name || appId}`, 'warning');
      }
    } catch (err) {
      showToast(err?.message || '启动应用失败', 'error');
    }
  }

  async function launchWorkspace(wsId, name) {
    try {
      const res = await api.post('/api/apps/launch', { workspace_id: wsId });
      const launchedNames = (res?.launched || []).map((a) => a.name);
      const filePaths = res?.file_paths || [];
      if (filePaths.length) {
        store.emit('file:open', { path: filePaths[0], name: getBaseName(filePaths[0]) });
      }
      if (launchedNames.length) {
        showToast(`工作区「${name}」已联启：${launchedNames.join('、')}`, 'success');
      } else if (res?.failed?.length) {
        showToast(
          `工作区已打开关联文档；部分程序未找到：${res.failed.map((f) => f.name).join('、')}`,
          'warning'
        );
      } else {
        showToast(`已激活工作区「${name}」`, 'success');
      }
    } catch (err) {
      showToast(err?.message || '工作区联启失败', 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // Pain Point #7 & #4: Drag-and-Drop Handlers (AI Cards -> Center Note, Tool Cards Reorder)
  // ---------------------------------------------------------------------------

  containerEl.addEventListener('dragstart', (e) => {
    // 0a. Draggable matched file / knowledge-tree bound file -> drop [[filename]] into Center Note
    const filePill = e.target.closest('[data-action="open-matched-file"], [data-action="tree-open-file"]');
    if (filePill) {
      e.stopPropagation();
      const path = filePill.dataset.path || '';
      const name = filePill.dataset.name || getBaseName(path);
      if (!path && !name) {
        e.preventDefault();
        return;
      }
      setDragPayload(e, {
        type: 'file-anchor',
        label: name,
        path,
        markdown: buildFileAnchorMarkdown(path, name),
      });
      store.emit('drag:active', true);
      return;
    }

    // 0b. Draggable local app capsule -> drop [[app:AppName]] into Center Note
    const appPill = e.target.closest('.app-launcher-pill[data-app-id]');
    if (appPill) {
      e.stopPropagation();
      const appId = appPill.dataset.appId || '';
      const appName = (appPill.dataset.name || appPill.textContent || '').trim();
      const appObj = (store.state.apps || []).find((a) => String(a.id) === String(appId)) || null;
      if (!appName) {
        e.preventDefault();
        return;
      }
      setDragPayload(e, {
        type: 'app-portal',
        appId,
        id: appId,
        label: appName,
        app: appObj ? { name: appObj.name, path: appObj.path, aliases: appObj.aliases || [], args: appObj.args || '' } : null,
        markdown: '[[app:' + appName + ']]',
      });
      store.emit('drag:active', true);
      return;
    }

    // 1. Todo item drag (must check before summary card)
    const todoItem = e.target.closest('.todo-item.draggable-card');
    if (todoItem) {
      if (e.target.closest('button, input, select, textarea, a') && !e.target.closest('.drag-pill-hint')) {
        e.preventDefault();
        return;
      }
      e.stopPropagation();
      const idx = Number(todoItem.dataset.todoIdx);
      const todo = state.summaryResult?.todos?.[idx];
      if (!todo) {
        e.preventDefault();
        return;
      }
      const markdown =
        '- [ ] ' + todo.title + (todo.suggested_time ? '（' + todo.suggested_time + '）' : '');
      setDragPayload(e, { type: 'ai-todo', label: todo.title, markdown });
      todoItem.classList.add('is-dragging');
      store.emit('drag:active', true);
      return;
    }

    // 2. AI Summary card drag
    const summaryCard = e.target.closest('.summary-card.draggable-card');
    if (summaryCard) {
      if (e.target.closest('button, input, select, textarea, a') && !e.target.closest('.drag-pill-hint')) {
        e.preventDefault();
        return;
      }
      e.stopPropagation();
      const md = formatSummaryAsMarkdown(state.summaryResult);
      if (!md) {
        e.preventDefault();
        return;
      }
      setDragPayload(e, { type: 'ai-summary', label: 'AI 总结卡片', markdown: md });
      summaryCard.classList.add('is-dragging');
      store.emit('drag:active', true);
      return;
    }

    // 3. Completed Assistant Chat Bubble drag
    const chatBubble = e.target.closest('.chat-bubble.is-assistant.draggable-card');
    if (chatBubble) {
      if (e.target.closest('button, input, select, textarea, a') && !e.target.closest('.drag-pill-hint')) {
        e.preventDefault();
        return;
      }
      e.stopPropagation();
      const msgId = chatBubble.dataset.msgId;
      const msg = state.chatMessages.find((m) => m.id === msgId);
      if (!msg || msg.streaming || msg.isError || !msg.content.trim()) {
        e.preventDefault();
        return;
      }
      setDragPayload(e, { type: 'ai-chat', label: 'AI 问答回复', markdown: msg.content });
      chatBubble.classList.add('is-dragging');
      store.emit('drag:active', true);
      return;
    }

    // 3b. V7.3 Tools Draggable Items (T1 Clipboard & Snippets, T2 Outline & Highlights, T3 Text Studio)
    const clipCard = e.target.closest('[data-drag-type="clipboard-item"]');
    if (clipCard) {
      e.stopPropagation();
      const clipId = clipCard.dataset.clipId;
      const clip = (store.state.clipboardHistory || []).find((c) => c.id === clipId);
      if (!clip?.text) {
        e.preventDefault();
        return;
      }
      setDragPayload(e, {
        type: 'clipboard-item',
        label: clip.preview || '剪贴板片段',
        markdown: clip.text,
      });
      clipCard.classList.add('is-dragging');
      store.emit('drag:active', true);
      return;
    }

    const snipPill = e.target.closest('[data-drag-type="md-snippet"]');
    if (snipPill) {
      e.stopPropagation();
      const snipId = snipPill.dataset.snippetId;
      const snip = getAllMdSnippets().find((s) => s.id === snipId);
      if (!snip?.content) {
        e.preventDefault();
        return;
      }
      const md = resolveSnippetMarkdown(snip.content);
      setDragPayload(e, {
        type: 'md-snippet',
        label: snip.title,
        markdown: md,
      });
      snipPill.classList.add('is-dragging');
      store.emit('drag:active', true);
      return;
    }

    const outlineHeadingEl = e.target.closest('[data-drag-type="outline-heading"]');
    if (outlineHeadingEl) {
      e.stopPropagation();
      const heading = outlineHeadingEl.dataset.heading || '';
      const activeName = store.state.activeFile?.name || '';
      const md = activeName ? `[[${activeName}#${heading}]]` : `[[#${heading}]]`;
      setDragPayload(e, {
        type: 'outline-heading',
        label: `#${heading}`,
        markdown: md,
      });
      outlineHeadingEl.classList.add('is-dragging');
      store.emit('drag:active', true);
      return;
    }

    const outlineHlEl = e.target.closest('[data-drag-type="outline-highlight"]');
    if (outlineHlEl) {
      e.stopPropagation();
      const hlText = outlineHlEl.dataset.highlightText || '';
      setDragPayload(e, {
        type: 'outline-highlight',
        label: hlText,
        markdown: `==${hlText}==`,
      });
      outlineHlEl.classList.add('is-dragging');
      store.emit('drag:active', true);
      return;
    }

    const outlineTodoEl = e.target.closest('[data-drag-type="outline-todo"]');
    if (outlineTodoEl) {
      e.stopPropagation();
      const tdText = outlineTodoEl.dataset.todoText || '';
      setDragPayload(e, {
        type: 'outline-todo',
        label: tdText,
        markdown: `- [ ] ${tdText}`,
      });
      outlineTodoEl.classList.add('is-dragging');
      store.emit('drag:active', true);
      return;
    }

    const studioDragEl = e.target.closest('[data-drag-type="studio-text"]');
    if (studioDragEl) {
      e.stopPropagation();
      const studioTa = toolsEl?.querySelector('[data-role="text-studio-input"]');
      const text = (studioTa?.value ?? state.studioText ?? store.state.activeDocumentText ?? '').trim();
      if (!text) {
        e.preventDefault();
        showToast('文本工坊为空，请先输入或载入内容', 'warning');
        return;
      }
      setDragPayload(e, {
        type: 'studio-text',
        label: '排版工坊文本',
        markdown: text,
      });
      store.emit('drag:active', true);
      return;
    }

    // 4. Tool Card drag-and-drop reordering
    const toolCard = e.target.closest('.tool-card.module-block[data-module-id]');
    if (toolCard && toolsEl?.contains(toolCard)) {
      if (e.target.closest('input, textarea, select, button') && !e.target.closest('.tool-card-summary')) {
        e.preventDefault();
        return;
      }
      const modId = toolCard.dataset.moduleId;
      if (!modId) {
        e.preventDefault();
        return;
      }
      draggedToolModuleId = modId;
      toolCard.classList.add('is-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try {
          e.dataTransfer.setData('application/x-sln-tool-module', modId);
        } catch {
          // ignore
        }
      }
    }
  });

  toolsEl?.addEventListener('dragover', (e) => {
    if (!draggedToolModuleId) return;
    const targetCard = e.target.closest('.tool-card.module-block[data-module-id]');
    if (!targetCard || targetCard.dataset.moduleId === draggedToolModuleId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    toolsEl.querySelectorAll('.tool-card.is-drag-over').forEach((el) => {
      if (el !== targetCard) el.classList.remove('is-drag-over');
    });
    targetCard.classList.add('is-drag-over');
  });

  toolsEl?.addEventListener('dragleave', (e) => {
    const targetCard = e.target.closest('.tool-card.module-block[data-module-id]');
    if (targetCard && !targetCard.contains(e.relatedTarget)) {
      targetCard.classList.remove('is-drag-over');
    }
  });

  toolsEl?.addEventListener('drop', (e) => {
    if (!draggedToolModuleId) return;
    const targetCard = e.target.closest('.tool-card.module-block[data-module-id]');
    const targetId = targetCard?.dataset.moduleId;
    if (!targetId || targetId === draggedToolModuleId) return;
    e.preventDefault();

    const list = [...getUiLayout().rightToolModules];
    const fromIdx = list.findIndex((m) => m.id === draggedToolModuleId);
    const toIdx = list.findIndex((m) => m.id === targetId);
    if (fromIdx >= 0 && toIdx >= 0) {
      const [moved] = list.splice(fromIdx, 1);
      list.splice(toIdx, 0, moved);
      commitUiLayout({ rightToolModules: list });
    }
    draggedToolModuleId = null;
  });

  function handleRightDrop(payload) {
    if (!payload || typeof payload !== 'object' || payload.type === 'module-reorder') return;

    if (payload.path) {
      const targetPath = String(payload.path).trim();
      if (!targetPath) return;
      const existing = store.state.selectedContextPaths || [];
      let ok = existing.includes(targetPath);
      if (!ok) {
        ok = toggleContextPath(targetPath);
      }
      if (ok) {
        ensureVisibleOnMobileOrCollapsed();
        switchMode('chat', { emitEvent: true });
        showToast('已加入右侧 AI 联合问答上下文', 'success');
      }
      return;
    }

    const rawText = String(payload.markdown ?? payload.text ?? payload.content ?? '').trim();
    if (!rawText) return;

    ensureVisibleOnMobileOrCollapsed();
    if (state.mode === 'summary') {
      state.summaryInputText = state.summaryInputText
        ? `${state.summaryInputText.replace(/\s+$/, '')}\n${rawText}`
        : rawText;
      const sumTa = summaryEl?.querySelector('#right-summary-input');
      if (sumTa) {
        sumTa.value = state.summaryInputText;
        sumTa.focus();
        sumTa.selectionStart = sumTa.selectionEnd = sumTa.value.length;
      } else {
        renderSummaryMode();
        window.requestAnimationFrame(() => {
          const nextTa = summaryEl?.querySelector('#right-summary-input');
          nextTa?.focus();
        });
      }
    } else {
      if (state.mode !== 'chat') {
        switchMode('chat', { emitEvent: true });
      }
      state.chatDraft = state.chatDraft
        ? `${state.chatDraft.replace(/\s+$/, '')}\n${rawText}`
        : rawText;
      const chatTa = chatEl?.querySelector('#chat-input');
      if (chatTa) {
        chatTa.value = state.chatDraft;
        chatTa.focus();
        chatTa.selectionStart = chatTa.selectionEnd = chatTa.value.length;
      } else {
        renderChatMode();
        window.requestAnimationFrame(() => {
          const nextTa = chatEl?.querySelector('#chat-input');
          nextTa?.focus();
        });
      }
    }
    showToast('已填入右侧 AI 输入框', 'success');
  }

  containerEl.addEventListener('dragover', (e) => {
    if (draggedToolModuleId) return;
    const activePayload = store.state.activeDragPayload;
    if (activePayload?.type === 'module-reorder') return;
    const hasBlock =
      Boolean(activePayload) ||
      Boolean(e.dataTransfer?.types && Array.from(e.dataTransfer.types).some((t) => t === 'application/x-sln-block' || t === 'text/plain'));
    if (!hasBlock) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    containerEl.classList.add('is-drop-hover');
  });

  containerEl.addEventListener('dragleave', (e) => {
    if (!containerEl.contains(e.relatedTarget)) {
      containerEl.classList.remove('is-drop-hover');
    }
  });

  containerEl.addEventListener('drop', (e) => {
    containerEl.classList.remove('is-drop-hover');
    if (draggedToolModuleId) return;
    const payload = readDragPayload(e);
    if (!payload || payload.type === 'module-reorder') return;
    e.preventDefault();
    e.stopPropagation();
    clearDragPayload();
    store.emit('drag:active', false);
    handleRightDrop(payload);
  });

  containerEl.addEventListener('dragend', () => {
    draggedToolModuleId = null;
    containerEl.classList.remove('is-drop-hover');
    containerEl.querySelectorAll('.is-dragging, .is-drag-over').forEach((el) => {
      el.classList.remove('is-dragging', 'is-drag-over');
    });
    clearDragPayload();
    store.emit('drag:active', false);
  });

  // ---------------------------------------------------------------------------
  // Event Delegation & Store EventBus Wiring
  // ---------------------------------------------------------------------------

  async function submitInlineTreeNode() {
    const input = toolsEl?.querySelector('[data-role="inline-tree-node-input"]');
    const defaultName = nextSequentialName('新建分类', (state.treeData.nodes || []).map((n) => n?.name || ''));
    const name = String(input?.value ?? state.inlineTreeCreateDraft ?? '').trim() || defaultName;
    try {
      await api.post('/api/tree', { name, parent_id: null });
      state.inlineTreeCreateOpen = false;
      state.inlineTreeCreateDraft = '';
      await fetchTree();
      store.emit('tree:updated');
      showToast(`已创建节点「${name}」`, 'success');
    } catch (err) {
      showToast(err?.message || '创建节点失败', 'error');
    }
  }

  containerEl.addEventListener('contextmenu', (e) => {
    const header = e.target.closest('.module-header, .tool-card-summary');
    if (!header || !containerEl.contains(header)) return;
    const block = header.closest('.module-block');
    if (!block) return;
    const summaryModId = block.dataset.summaryModuleId;
    const toolModId = block.dataset.moduleId;
    const group = summaryModId ? 'summary' : 'tools';
    const moduleId = summaryModId || toolModId;
    if (!moduleId) return;
    e.preventDefault();
    e.stopPropagation();
    store.emit('module:context-menu', {
      side: 'right',
      group,
      moduleId,
      heightKey: toolModId ? `right_${toolModId}` : `right_${moduleId}`,
      x: e.clientX,
      y: e.clientY,
    });
  });

  containerEl.addEventListener('input', (e) => {
    const sumTa = e.target.closest('#right-summary-input');
    if (sumTa) {
      state.summaryInputText = sumTa.value;
      return;
    }
    const chatTa = e.target.closest('#chat-input');
    if (chatTa) {
      state.chatDraft = chatTa.value;
      return;
    }
    const treeInput = e.target.closest('[data-role="inline-tree-node-input"]');
    if (treeInput) {
      state.inlineTreeCreateDraft = treeInput.value;
      return;
    }
    const snipTitleInput = e.target.closest('[data-role="inline-snippet-title"]');
    if (snipTitleInput) {
      state.inlineSnippetTitleDraft = snipTitleInput.value;
      return;
    }
    const snipContentInput = e.target.closest('[data-role="inline-snippet-content"]');
    if (snipContentInput) {
      state.inlineSnippetContentDraft = snipContentInput.value;
      return;
    }
    const studioTa = e.target.closest('[data-role="text-studio-input"]');
    if (studioTa) {
      state.studioText = studioTa.value;
      syncTextStudioStatsDom();
    }
  });

  containerEl.addEventListener('keydown', (e) => {
    if (e.target?.id === 'chat-input' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendChatMessage();
      return;
    }
    if (e.target?.matches?.('[data-role="inline-tree-node-input"]')) {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        submitInlineTreeNode();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        state.inlineTreeCreateOpen = false;
        state.inlineTreeCreateDraft = '';
        renderToolsMode();
      }
    }
  });

  containerEl.addEventListener('change', async (e) => {
    const excelSel = e.target.closest('[data-action="tools-excel-select"]');
    if (excelSel) {
      state.selectedExcelPath = excelSel.value;
      await loadExcelSheets(excelSel.value);
      return;
    }

    const sheetSel = e.target.closest('[data-action="tools-sheet-select"]');
    if (sheetSel) {
      state.selectedSheet = sheetSel.value;
      renderToolsMode();
      return;
    }

    const statusSel = e.target.closest('[data-action="tree-status-change"]');
    if (statusSel) {
      const nodeId = statusSel.dataset.nodeId;
      const filePath = statusSel.dataset.path;
      const nextStatus = statusSel.value;
      try {
        await api.patch('/api/tree', {
          node_id: nodeId,
          bind_path: filePath,
          status: nextStatus,
        });
        await fetchTree();
        store.emit('tree:updated');
        showToast(`状态已更新为「${nextStatus}」`, 'success');
      } catch (err) {
        showToast(err?.message || '状态更新失败', 'error');
      }
    }
  });

  containerEl.addEventListener('click', async (e) => {
    // 1. Top 3-Mode Segmented Pill
    const segBtn = e.target.closest('.segmented-pill[data-seg="right-mode"] .segmented-btn');
    if (segBtn) {
      switchMode(segBtn.dataset.mode, { emitEvent: true });
      return;
    }

    // 2. Clickable Universal Portal / Cross-Format Anchor Pill
    const anchorPill = e.target.closest('.anchor-pill');
    if (anchorPill) {
      store.emit('anchor:jump', {
        type: anchorPill.dataset.anchorType || 'file',
        file: anchorPill.dataset.anchorFile || '',
        page: anchorPill.dataset.anchorPage || '',
        sheet: anchorPill.dataset.anchorSheet || '',
        cell: anchorPill.dataset.anchorCell || '',
        heading: anchorPill.dataset.anchorHeading || '',
        member: anchorPill.dataset.anchorMember || '',
        time: anchorPill.dataset.anchorTime || '',
        app: anchorPill.dataset.anchorApp || '',
        url: anchorPill.dataset.anchorUrl || '',
      });
      return;
    }

    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;

    // --- V2/V3/V7.3 Global Right Panel Actions ---
    if (action === 'open-module-size-menu') {
      e.preventDefault();
      e.stopPropagation();
      const modId = actionEl.dataset.moduleId || actionEl.dataset.modId;
      const panel = actionEl.dataset.panel || 'right';
      if (modId) {
        toggleRightModuleSizePopover(actionEl, panel, modId);
      }
      return;
    }

    if (action === 'set-module-size') {
      e.preventDefault();
      e.stopPropagation();
      const modId = actionEl.dataset.modId || actionEl.dataset.moduleId;
      const preset = actionEl.dataset.preset || 'auto';
      if (modId) {
        setModuleSizePreset?.('right', modId, preset);
      }
      return;
    }

    if (action === 'toggle-module-float') {
      e.preventDefault();
      e.stopPropagation();
      const modId = actionEl.dataset.modId || actionEl.dataset.moduleId;
      const modTitle = actionEl.dataset.modTitle || modId;
      if (modId) {
        toggleModuleFloat?.(modId, { title: modTitle, panel: 'right' });
      }
      return;
    }

    if (action === 'open-global-todos') {
      if (typeof setCenterView === 'function') {
        setCenterView('explorer');
      } else {
        store.setCenterView?.('explorer');
      }
      if (isMobileRightViewport()) {
        store.setState({ mobileTab: 'doc' }, 'layout:changed');
        store.emit('mobile:focus-todos');
      }
      return;
    }

    if (action === 'open-right-customize') {
      openRightCustomizeSheet();
      return;
    }

    if (action === 'open-ai-settings') {
      store.emit('settings:open');
      return;
    }

    if (action === 'ai-generate-mindmap') {
      await handleAiGenerateMindmap();
      return;
    }

    if (action === 'ai-polish-fragments') {
      await handleAiPolishFragments();
      return;
    }

    if (action === 'use-ai-template') {
      const tpl = AI_PROMPT_TEMPLATES.find((t) => t.id === actionEl.dataset.templateId);
      await triggerTemplatePrompt(tpl);
      return;
    }

    // --- Mode 1 Actions ---
    if (action === 'summarize-doc') {
      const filePath = store.state.activeFile?.path || null;
      const docText = store.state.activeDocumentText || '';
      if (!filePath && !docText.trim()) {
        showToast('请先打开一份文档或输入内容', 'warning');
        return;
      }
      await runSummarize(filePath ? { filePath } : { text: docText });
      return;
    }

    if (action === 'summarize-text') {
      const text = state.summaryInputText.trim();
      if (!text) {
        showToast('请先在上方输入框写入需要总结的内容', 'warning');
        return;
      }
      await runSummarize({ text });
      return;
    }

    if (action === 'insert-summary-doc') {
      const md = formatSummaryAsMarkdown(state.summaryResult);
      if (md) {
        store.emit('doc:append', { content: md });
        showToast('已将摘要与待办插入当前文档', 'success');
      }
      return;
    }

    if (action === 'todo-insert-note') {
      const idx = Number(actionEl.dataset.todoIdx);
      const todo = state.summaryResult?.todos?.[idx];
      if (todo) {
        const timeHint = todo.suggested_time ? ` *(${todo.suggested_time})*` : '';
        const md = `- [ ] ${todo.title}${timeHint}\n`;
        store.emit('doc:append', { content: md });
        showToast('已将待办插入当前笔记', 'success');
      }
      return;
    }

    if (action === 'open-reminder-sheet') {
      const idx = Number(actionEl.dataset.todoIdx);
      const todo = state.summaryResult?.todos?.[idx];
      if (todo) openReminderSheet(todo);
      return;
    }

    if (action === 'test-reminder-10s') {
      const idx = Number(actionEl.dataset.todoIdx);
      const todo = state.summaryResult?.todos?.[idx];
      if (todo) await trigger10sTestReminder(todo);
      return;
    }

    if (action === 'start-todo-focus') {
      const idx = Number(actionEl.dataset.todoIdx);
      const todo = state.summaryResult?.todos?.[idx];
      openFocusDurationPopover?.(actionEl, {
        title: todo?.title || '专注任务',
      });
      return;
    }

    if (action === 'start-todo-focus-15s') {
      const idx = Number(actionEl.dataset.todoIdx);
      const todo = state.summaryResult?.todos?.[idx];
      store.emit('focus:start', {
        title: todo?.title || '专注演示',
        seconds: 15,
      });
      return;
    }

    if (action === 'open-matched-file' || action === 'tree-open-file') {
      const path = actionEl.dataset.path;
      const name = actionEl.dataset.name || getBaseName(path);
      if (path) {
        store.emit('file:open', { path, name });
      }
      return;
    }

    if (action === 'refresh-reminders') {
      await fetchReminders();
      return;
    }

    if (action === 'delete-reminder') {
      const id = actionEl.dataset.reminderId;
      if (!id) return;
      try {
        await api.del(`/api/reminders?reminder_id=${encodeURIComponent(id)}`);
        await fetchReminders();
        store.emit('reminders:updated');
        showToast('已取消该定时提醒', 'info');
      } catch (err) {
        showToast(err?.message || '删除提醒失败', 'error');
      }
      return;
    }

    // --- Mode 2 Actions ---
    if (action === 'remove-context') {
      toggleContextPath(actionEl.dataset.path);
      return;
    }

    if (action === 'toggle-web-search') {
      state.webSearch = !state.webSearch;
      renderChatMode();
      return;
    }

    if (action === 'clear-chat') {
      if (state.chatAbort) {
        state.chatAbort.abort();
        state.chatAbort = null;
      }
      state.chatStreaming = false;
      state.chatMessages = [];
      renderChatMode();
      return;
    }

    if (action === 'send-chat') {
      await sendChatMessage();
      return;
    }

    if (action === 'stop-chat') {
      state.chatAbort?.abort();
      return;
    }

    if (action === 'chat-quick-prompt') {
      const prompt = actionEl.dataset.prompt;
      if (prompt) await sendChatMessage(prompt);
      return;
    }

    if (action === 'chat-save-note') {
      const msg = state.chatMessages.find((m) => m.id === actionEl.dataset.msgId);
      if (msg) await openSaveNoteSheet(msg);
      return;
    }

    if (action === 'chat-append-doc') {
      const msg = state.chatMessages.find((m) => m.id === actionEl.dataset.msgId);
      if (msg?.content) {
        store.emit('doc:append', { content: msg.content });
        showToast('已追加回复内容到当前文档', 'success');
      }
      return;
    }

    if (action === 'chat-extract-table') {
      const msg = state.chatMessages.find((m) => m.id === actionEl.dataset.msgId);
      if (msg) await openExtractTableSheet(msg);
      return;
    }

    // --- Mode 3 Actions ---
    if (action === 'excel-append-form') {
      if (!state.selectedExcelPath || state.excelSubmitting) return;
      const inputs = Array.from(toolsEl.querySelectorAll('[data-excel-col-input]'));
      const rowValues = inputs.map((inp) => inp.value);
      if (rowValues.every((v) => !String(v).trim())) {
        showToast('请至少填写一列内容', 'warning');
        return;
      }
      state.excelSubmitting = true;
      renderToolsMode();
      try {
        await api.post('/api/excel/append-rows', {
          path: state.selectedExcelPath,
          sheet: state.selectedSheet || null,
          rows: [rowValues],
        });
        store.emit('file:refresh-excel', {
          path: state.selectedExcelPath,
          sheet: state.selectedSheet,
        });
        showToast('已写入一行并生成安全快照', 'success');
        await loadExcelSheets(state.selectedExcelPath);
      } catch (err) {
        showToast(err?.message || '写入 Excel 失败', 'error');
      } finally {
        state.excelSubmitting = false;
        renderToolsMode();
      }
      return;
    }

    if (action === 'excel-add-col') {
      openAddColSheet();
      return;
    }

    if (action === 'excel-del-row') {
      openDelRowSheet();
      return;
    }

    if (action === 'excel-export-csv') {
      if (!state.selectedExcelPath) return;
      const url = `/api/excel/export-csv?path=${encodeURIComponent(state.selectedExcelPath)}${
        state.selectedSheet ? `&sheet=${encodeURIComponent(state.selectedSheet)}` : ''
      }`;
      const a = document.createElement('a');
      a.href = url;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast('已触发 CSV 导出下载', 'info');
      return;
    }

    if (action === 'tree-switch-view') {
      const view = actionEl.dataset.view === 'table' ? 'table' : 'tree';
      if (view !== state.treeViewMode) {
        state.treeViewMode = view;
        renderToolsMode();
      }
      return;
    }

    if (action === 'tree-create-node') {
      state.inlineTreeCreateOpen = true;
      state.inlineTreeCreateDraft = '';
      renderToolsMode();
      window.requestAnimationFrame(() => {
        const inp = toolsEl?.querySelector('[data-role="inline-tree-node-input"]');
        inp?.focus();
      });
      return;
    }

    if (action === 'tree-inline-create-submit') {
      await submitInlineTreeNode();
      return;
    }

    if (action === 'tree-inline-create-cancel') {
      state.inlineTreeCreateOpen = false;
      state.inlineTreeCreateDraft = '';
      renderToolsMode();
      return;
    }

    if (action === 'tree-ai-classify') {
      const activePath = store.state.activeFile?.path || null;
      const activeText = store.state.activeDocumentText || '';
      if (!activePath && !activeText.trim()) {
        showToast('请先在左侧打开一份文档再请求 AI 归类', 'warning');
        return;
      }
      state.classifyLoading = true;
      state.classifyTargetPath = activePath || '';
      renderToolsMode();
      try {
        const res = await api.post('/api/ai/classify', {
          file_path: activePath,
          summary: activePath ? '' : activeText.slice(0, 1200),
        });
        state.classifyResult = res;
      } catch (err) {
        showToast(err?.message || 'AI 归类建议失败', 'error');
      } finally {
        state.classifyLoading = false;
        renderToolsMode();
      }
      return;
    }

    if (action === 'tree-bind-recommended') {
      const rec = state.classifyResult;
      const targetPath = state.classifyTargetPath || store.state.activeFile?.path;
      if (!rec || !targetPath) {
        showToast('请先打开需要挂载的文件', 'warning');
        return;
      }
      try {
        let nodeId = rec.recommended_node_id;
        if (!nodeId) {
          const createdNode = await api.post('/api/tree', {
            name: rec.recommended_node_name || '学习资料',
            parent_id: null,
          });
          nodeId = createdNode.id;
        }
        await api.patch('/api/tree', {
          node_id: nodeId,
          bind_path: targetPath,
          status: '待开始',
        });
        state.classifyResult = null;
        await fetchTree();
        store.emit('tree:updated');
        showToast(`已挂载至「${rec.recommended_node_name}」`, 'success');
      } catch (err) {
        showToast(err?.message || '一键挂载失败', 'error');
      }
      return;
    }

    if (action === 'tree-bind-active') {
      const nodeId = actionEl.dataset.nodeId;
      const targetPath = store.state.activeFile?.path;
      if (!nodeId || !targetPath) return;
      try {
        await api.patch('/api/tree', {
          node_id: nodeId,
          bind_path: targetPath,
          status: '待开始',
        });
        await fetchTree();
        store.emit('tree:updated');
        showToast('已挂载当前文件', 'success');
      } catch (err) {
        showToast(err?.message || '挂载失败', 'error');
      }
      return;
    }

    if (action === 'tree-unbind-file') {
      const nodeId = actionEl.dataset.nodeId;
      const targetPath = actionEl.dataset.path;
      if (!nodeId || !targetPath) return;
      try {
        await api.patch('/api/tree', {
          node_id: nodeId,
          unbind_path: targetPath,
        });
        await fetchTree();
        store.emit('tree:updated');
        showToast('已解除节点挂载', 'info');
      } catch (err) {
        showToast(err?.message || '解绑失败', 'error');
      }
      return;
    }

    if (action === 'tree-delete-node') {
      const nodeId = actionEl.dataset.nodeId;
      if (!nodeId) return;
      try {
        await api.del(`/api/tree?node_id=${encodeURIComponent(nodeId)}`);
        await fetchTree();
        store.emit('tree:updated');
        showToast('已删除知识树节点', 'info');
      } catch (err) {
        showToast(err?.message || '删除节点失败', 'error');
      }
      return;
    }

    if (action === 'open-capture') {
      store.emit('capture:open');
      return;
    }

    if (action === 'open-add-app') {
      store.emit('app:add-open', { autoScan: true });
      return;
    }

    // --- V7.3 Tool 2 Actions: clipboard_snippets ---
    if (action === 'clip-read-system') {
      try {
        const text = await navigator.clipboard.readText();
        if (text && text.trim()) {
          store.pushClipboardHistory?.(text, '系统剪贴板');
          renderToolsMode();
          showToast('已读取系统剪贴板', 'success');
        } else {
          showToast('系统剪贴板当前无文本内容', 'info');
        }
      } catch {
        showToast('未能直接读取系统剪贴板，请在页面内复制或粘贴', 'warning');
      }
      return;
    }

    if (action === 'clip-clear-all') {
      store.clearClipboardHistory?.();
      renderToolsMode();
      showToast('已清空内存剪贴板历史', 'info');
      return;
    }

    if (action === 'clip-insert-note') {
      const clipId = actionEl.dataset.clipId;
      const clip = (store.state.clipboardHistory || []).find((c) => c.id === clipId);
      if (clip?.text) {
        if (typeof setCenterView === 'function') setCenterView('doc');
        store.emit('doc:append', { content: clip.text });
        showToast('已插入剪贴板内容到当前笔记', 'success');
      }
      return;
    }

    if (action === 'clip-copy-item') {
      const clipId = actionEl.dataset.clipId;
      const clip = (store.state.clipboardHistory || []).find((c) => c.id === clipId);
      if (clip?.text) {
        await copyInternal(clip.text, '已复制到剪贴板');
      }
      return;
    }

    if (action === 'clip-delete-item') {
      const clipId = actionEl.dataset.clipId;
      if (clipId) {
        store.removeClipboardItem?.(clipId);
        renderToolsMode();
      }
      return;
    }

    if (action === 'snippet-toggle-create') {
      state.inlineSnippetCreateOpen = !state.inlineSnippetCreateOpen;
      if (state.inlineSnippetCreateOpen) {
        state.inlineSnippetTitleDraft = '';
        state.inlineSnippetContentDraft = '';
      }
      renderToolsMode();
      if (state.inlineSnippetCreateOpen) {
        window.requestAnimationFrame(() => {
          toolsEl?.querySelector('[data-role="inline-snippet-title"]')?.focus();
        });
      }
      return;
    }

    if (action === 'snippet-create-cancel') {
      state.inlineSnippetCreateOpen = false;
      state.inlineSnippetTitleDraft = '';
      state.inlineSnippetContentDraft = '';
      renderToolsMode();
      return;
    }

    if (action === 'snippet-create-submit') {
      const allSnips = getAllMdSnippets();
      const defaultTitle = nextSequentialName('新建片段', allSnips.map((s) => s.title));
      const titleInput = toolsEl?.querySelector('[data-role="inline-snippet-title"]');
      const contentInput = toolsEl?.querySelector('[data-role="inline-snippet-content"]');
      const title = (titleInput?.value ?? state.inlineSnippetTitleDraft ?? '').trim() || defaultTitle;
      const rawContent = (contentInput?.value ?? state.inlineSnippetContentDraft ?? '').trim();
      const content = rawContent || `### ${title} ({{DATE}})\n- `;

      const customList = loadCustomMdSnippets();
      customList.push({
        id: `snip_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        icon: '📌',
        title,
        content,
        custom: true,
      });
      saveCustomMdSnippets(customList);
      state.inlineSnippetCreateOpen = false;
      state.inlineSnippetTitleDraft = '';
      state.inlineSnippetContentDraft = '';
      renderToolsMode();
      showToast(`已保存常用片段「${title}」`, 'success');
      return;
    }

    if (action === 'snippet-insert') {
      const snipId = actionEl.dataset.snippetId;
      const snip = getAllMdSnippets().find((s) => s.id === snipId);
      if (snip?.content) {
        const md = resolveSnippetMarkdown(snip.content);
        if (typeof setCenterView === 'function') setCenterView('doc');
        store.emit('doc:append', { content: md });
        showToast(`已插入模板片段「${snip.title}」`, 'success');
      }
      return;
    }

    if (action === 'snippet-delete') {
      e.stopPropagation();
      const snipId = actionEl.dataset.snippetId;
      if (!snipId) return;
      const nextCustom = loadCustomMdSnippets().filter((s) => s.id !== snipId);
      saveCustomMdSnippets(nextCustom);
      renderToolsMode();
      showToast('已删除自定义模板片段', 'info');
      return;
    }

    // --- V7.3 Tool 3 Actions: doc_outline ---
    if (action === 'outline-jump-heading') {
      const heading = actionEl.dataset.heading || '';
      const lineNo = Number(actionEl.dataset.lineNo) || 1;
      if (typeof setCenterView === 'function') setCenterView('doc');
      store.emit('anchor:jump', {
        type: 'heading',
        file: store.state.activeFile?.name || store.state.activeFile?.path || '',
        heading,
        line: lineNo,
      });
      return;
    }

    if (action === 'outline-jump-highlight') {
      const hlText = actionEl.dataset.highlightText || '';
      const lineNo = Number(actionEl.dataset.lineNo) || 1;
      if (typeof setCenterView === 'function') setCenterView('doc');
      store.emit('anchor:jump', {
        type: 'heading',
        file: store.state.activeFile?.name || store.state.activeFile?.path || '',
        heading: hlText,
        line: lineNo,
      });
      showToast(`已定位高亮：${hlText.slice(0, 20)} (第 ${lineNo} 行)`, 'info', { duration: 1600 });
      return;
    }

    if (action === 'outline-jump-todo') {
      const tdText = actionEl.dataset.todoText || '';
      const lineNo = Number(actionEl.dataset.lineNo) || 1;
      if (typeof setCenterView === 'function') setCenterView('doc');
      store.emit('anchor:jump', {
        type: 'heading',
        file: store.state.activeFile?.name || store.state.activeFile?.path || '',
        heading: tdText,
        line: lineNo,
      });
      showToast(`已定位待办：${tdText.slice(0, 20)} (第 ${lineNo} 行)`, 'info', { duration: 1600 });
      return;
    }

    // --- V7.3 Tool 4 Actions: text_studio ---
    if (action === 'studio-load-doc') {
      const docText = String(store.state.activeDocumentText || '');
      if (!docText.trim()) {
        showToast('当前文档为空，请先打开一篇文档或直接在工坊输入', 'warning');
        return;
      }
      state.studioText = docText;
      renderToolsMode();
      showToast('已载入当前文档内容到文本工坊', 'success');
      return;
    }

    if (action === 'studio-clear') {
      state.studioText = '';
      renderToolsMode();
      return;
    }

    if (action === 'studio-transform') {
      const op = actionEl.dataset.op;
      const studioTa = toolsEl?.querySelector('[data-role="text-studio-input"]');
      const currentInput = (studioTa?.value ?? state.studioText ?? '').trim()
        ? (studioTa?.value ?? state.studioText)
        : String(store.state.activeDocumentText || '');
      if (!currentInput.trim()) {
        showToast('请先输入文本或点击「载入当前文档」', 'warning');
        return;
      }
      try {
        state.studioText = applyStudioTransform(op, currentInput);
        renderToolsMode();
        const opLabels = {
          pangu: '已完成中英自动加空格',
          clean: '已清理多余空行与不可见字符',
          'csv-to-table': '已转换为标准 Markdown 表格',
          'to-todos': '已转换为 Markdown 待办清单',
          'json-format': '已完成 JSON 格式化',
        };
        showToast(opLabels[op] || '已完成文本转换', 'success');
      } catch (err) {
        showToast(`JSON 解析失败：${err?.message || '请检查 JSON 语法'}`, 'warning');
      }
      return;
    }

    if (action === 'studio-copy') {
      const studioTa = toolsEl?.querySelector('[data-role="text-studio-input"]');
      const text = (studioTa?.value ?? state.studioText ?? store.state.activeDocumentText ?? '').trim();
      if (!text) {
        showToast('没有可复制的文本', 'warning');
        return;
      }
      await copyInternal(text, '已复制排版工坊结果');
      return;
    }

    if (action === 'studio-insert-doc') {
      const studioTa = toolsEl?.querySelector('[data-role="text-studio-input"]');
      const text = (studioTa?.value ?? state.studioText ?? '').trim();
      if (!text) {
        showToast('请先在文本工坊输入或转换文本', 'warning');
        return;
      }
      if (typeof setCenterView === 'function') setCenterView('doc');
      store.emit('doc:append', { content: text });
      showToast('已将工坊文本插入当前笔记', 'success');
      return;
    }

    // --- V7.3 Tool 5 Actions: focus_pulse & K1 Mini Graph ---
    if (action === 'pulse-start-focus') {
      openFocusDurationPopover?.(actionEl, {
        title: store.state.activeFile?.name
          ? `专注：${store.state.activeFile.name}`
          : '专注学习',
        filePath: store.state.activeFile?.path || '',
      });
      return;
    }

    if (action === 'pulse-write-review') {
      const pulse = store.state.focusPulse || { count: 0, totalMinutes: 0, sessions: [] };
      const sessions = Array.isArray(pulse.sessions) ? pulse.sessions : [];
      const d = new Date();
      const dateStr =
        pulse.date ||
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const lines = [
        `## ⏱ 今日专注脉搏复盘 (${dateStr})`,
        `- **累计专注**：${Number(pulse.count) || 0} 次（共 ${Number(pulse.totalMinutes) || 0} 分钟）`,
      ];
      if (sessions.length > 0) {
        lines.push('- **专注记录**：');
        sessions.forEach((s) => {
          const hm = s.finishedAt ? formatTriggerTime(s.finishedAt).slice(-8, -3) : '';
          lines.push(`  - [x] **${s.title}** (${s.minutes} 分钟${hm ? ` · ${hm}` : ''})`);
        });
      } else {
        lines.push('- **今日复盘小结**：\n  - ');
      }
      if (typeof setCenterView === 'function') setCenterView('doc');
      store.emit('doc:append', { content: lines.join('\n') });
      showToast('已将今日专注复盘写入当前笔记', 'success');
      return;
    }

    if (action === 'pulse-refresh-graph') {
      try {
        await store.refreshLinkGraph?.(store.state.activeFile?.path || '');
        renderToolsMode();
        showToast('已刷新局部关系微图谱', 'info', { duration: 1500 });
      } catch {
        // ignore
      }
      return;
    }

    if (action === 'graph-node-click') {
      const nodeId = actionEl.dataset.nodeId || '';
      const nodeKind = actionEl.dataset.nodeKind || '';
      const nodeLabel = actionEl.dataset.nodeLabel || '';
      if (!nodeId) return;
      if (nodeKind === 'tag' || nodeId.startsWith('tag:')) {
        const tagName = nodeId.replace(/^tag:/, '');
        const tagEntry = (store.state.linkGraph?.tags || []).find((t) => t.tag === tagName);
        const firstFile = tagEntry?.files?.[0];
        if (firstFile?.path) {
          store.emit('file:open', { path: firstFile.path, name: firstFile.name || getBaseName(firstFile.path) });
          showToast(`已打开标签 #${tagName} 关联笔记：${firstFile.name || getBaseName(firstFile.path)}`, 'info');
        } else {
          showToast(`标签 ${nodeLabel || `#${tagName}`}`, 'info');
        }
      } else {
        store.emit('file:open', { path: nodeId, name: getBaseName(nodeId) });
      }
      return;
    }

    if (action === 'launch-app') {
      await launchApp(actionEl.dataset.appId, actionEl.dataset.name);
      return;
    }

    if (action === 'delete-app') {
      const appId = actionEl.dataset.appId;
      if (!appId) return;
      try {
        await api.del(`/api/apps?app_id=${encodeURIComponent(appId)}`);
        await fetchAppsAndWorkspaces();
        store.emit('apps:updated');
        showToast('已移除软件记录', 'info');
      } catch (err) {
        showToast(err?.message || '删除软件失败', 'error');
      }
      return;
    }

    if (action === 'launch-workspace') {
      await launchWorkspace(actionEl.dataset.wsId, actionEl.dataset.name);
      return;
    }

    if (action === 'focus-workspace') {
      const wsId = actionEl.dataset.wsId || '';
      const wsName = actionEl.dataset.name || '工作区专注';
      openFocusDurationPopover?.(actionEl, {
        title: wsName,
        workspaceId: wsId,
      });
      return;
    }

    if (action === 'delete-workspace') {
      const wsId = actionEl.dataset.wsId;
      if (!wsId) return;
      try {
        await api.del(`/api/workspaces?workspace_id=${encodeURIComponent(wsId)}`);
        await fetchAppsAndWorkspaces();
        store.emit('workspaces:updated');
        showToast('已删除场景工作区', 'info');
      } catch (err) {
        showToast(err?.message || '删除工作区失败', 'error');
      }
    }
  });

  // --- Store EventBus Subscriptions ---
  store.on('right:mode', (payload) => {
    const next = typeof payload === 'string' ? payload : payload?.mode;
    if (next && next !== state.mode) {
      switchMode(next, { emitEvent: false });
    }
  });

  store.on('right:tool-collapse-sync', (mods) => {
    if (Array.isArray(mods)) {
      for (const m of mods) {
        if (m?.id && typeof m.collapsed === 'boolean') {
          toolOpenStateById.set(m.id, !m.collapsed);
        }
      }
      renderToolsMode();
    }
  });

  store.on('ui:layout-changed', () => {
    if (isResizingRightModule) return;
    renderTabsHeader();
    syncModeHeader();
    renderSummaryMode();
    renderToolsMode();
  });

  store.on('config:changed', () => {
    state.liveProviderLabel = '';
    renderSummaryMode();
    renderChatHeaderStatus();
  });

  store.on('system:info', () => {
    renderSummaryMode();
    renderChatHeaderStatus();
  });

  store.on('system:config', () => {
    renderSummaryMode();
    renderChatHeaderStatus();
  });

  store.on('ai:summarize-request', async (payload = {}) => {
    const { text = '', file_path = null, autoRun = true } = payload;
    ensureVisibleOnMobileOrCollapsed();
    switchMode('summary', { emitEvent: true });
    if (text) {
      state.summaryInputText = String(text);
    }
    renderSummaryMode();
    if (autoRun) {
      await runSummarize({ text: state.summaryInputText || text, filePath: file_path });
    }
  });

  store.on('context:changed', () => {
    renderContextBarOnly();
    const countSpan = chatEl?.querySelector('[data-role="chat-ctx-count"]');
    if (countSpan) {
      countSpan.textContent = `${(store.state.selectedContextPaths || []).length}/20 文件`;
    }
    renderSummaryMode();
    renderToolsMode();
  });

  store.on('files:updated', () => {
    syncExcelSelection();
    renderSummaryMode();
  });

  const syncRightOnFileChange = () => {
    renderSummaryMode();
    syncExcelSelection();
  };
  store.on('file:open', syncRightOnFileChange);
  store.on('file:opened', syncRightOnFileChange);
  store.on('right:drop-payload', handleRightDrop);

  store.on('state:changed', ({ keys }) => {
    if (keys?.includes('activeFile')) {
      renderSummaryMode();
      syncExcelSelection();
    }
    if (keys?.includes('activeDocumentText')) {
      const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
      const inStudioInput = Boolean(
        activeEl && toolsEl?.contains(activeEl) && activeEl.matches('[data-role="text-studio-input"], [data-role="inline-snippet-title"], [data-role="inline-snippet-content"]')
      );
      if (!inStudioInput) {
        renderToolsMode();
      } else {
        syncTextStudioStatsDom();
      }
    }
    if (keys?.includes('config') || keys?.includes('systemInfo')) {
      renderSummaryMode();
      renderChatHeaderStatus();
    }
  });

  store.on('clipboard:updated', () => {
    renderToolsMode();
  });
  store.on('focus:pulse-updated', () => {
    renderToolsMode();
  });
  store.on('links:updated', () => {
    renderToolsMode();
  });
  store.on('apps:updated', fetchAppsAndWorkspaces);
  store.on('workspaces:updated', fetchAppsAndWorkspaces);
  store.on('tree:updated', fetchTree);
  store.on('reminders:updated', fetchReminders);
  store.on('sse:reminder:fired', fetchReminders);

  function bindRightModuleHeightResizers() {
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
      isResizingRightModule = true;
      try {
        setModuleHeightSafe(modId, currentH);
      } finally {
        isResizingRightModule = false;
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
      const startH = Math.max(RIGHT_MODULE_MIN_HEIGHT, Math.round(rect.height || 180));
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
      const nextH = Math.max(
        RIGHT_MODULE_MIN_HEIGHT,
        Math.min(RIGHT_MODULE_MAX_HEIGHT, Math.round(activeDrag.startH + dy))
      );
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
        const rawModId = modId.replace(/^right_/, '');
        isResizingRightModule = true;
        try {
          if (typeof setModuleSizePreset === 'function') {
            setModuleSizePreset('right', rawModId, 'auto');
          } else {
            setModuleHeightSafe(modId, null);
          }
        } finally {
          isResizingRightModule = false;
        }
        showToast('已恢复模块自适应高度', 'info', { duration: 1600 });
      }
    });
  }

  // Initial Render + Lazy Initial Loads
  let lastMobileRightState = isMobileRightViewport();
  const syncMobileRightClass = () => {
    const nowMobile = isMobileRightViewport();
    containerEl.classList.toggle('is-mobile-right', nowMobile);
    if (nowMobile !== lastMobileRightState) {
      lastMobileRightState = nowMobile;
      renderSummaryMode();
      renderChatMode();
      renderToolsMode();
    }
  };
  containerEl.classList.toggle('is-mobile-right', lastMobileRightState);
  window.addEventListener('resize', syncMobileRightClass);

  renderTabsHeader();
  syncModeHeader();
  renderSummaryMode();
  renderChatMode();
  renderToolsMode();
  bindRightModuleHeightResizers();

  fetchReminders();
  fetchTree();
  fetchAppsAndWorkspaces();
  fetchFilesIfNeeded().then(syncExcelSelection);
}
