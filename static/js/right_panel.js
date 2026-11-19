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
import { icon } from './icons.js';

const {
  store,
  escapeHtml,
  toggleContextPath,
  showToast,
  openSheet,
  closeSheet,
  renderMarkdownSafe,
} = storeMod;

const UI_LAYOUT_STORAGE_KEY = 'sln_ui_layout';

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
  knowledge_tree: { id: 'knowledge_tree', label: '虚拟知识树分类与总览' },
  apps_workspaces: { id: 'apps_workspaces', label: '本地软件库与工作区联启' },
  ai_templates: { id: 'ai_templates', label: 'AI 常用指令模板' },
};

const DEFAULT_TABS_ORDER = ['summary', 'chat', 'tools'];
const DEFAULT_SUMMARY_MODULES = [
  { id: 'input', visible: true },
  { id: 'summary_card', visible: true },
  { id: 'reminders', visible: true },
  { id: 'ai_templates', visible: true },
];
const DEFAULT_TOOL_MODULES = [
  { id: 'quick_excel', visible: true },
  { id: 'knowledge_tree', visible: true },
  { id: 'apps_workspaces', visible: true },
  { id: 'ai_templates', visible: true },
];

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

function normalizeModuleList(rawList, defaults) {
  const allowed = defaults.map((d) => d.id);
  const seen = new Set();
  const result = [];

  if (Array.isArray(rawList)) {
    for (const entry of rawList) {
      const id = typeof entry === 'string' ? entry : entry?.id;
      if (!id || !allowed.includes(id) || seen.has(id)) continue;
      seen.add(id);
      const visible = typeof entry === 'object' && entry !== null ? entry.visible !== false : true;
      result.push({ id, visible });
    }
  } else if (rawList && typeof rawList === 'object' && Array.isArray(rawList.order)) {
    const hiddenSet = new Set(Array.isArray(rawList.hidden) ? rawList.hidden : []);
    for (const id of rawList.order) {
      if (!allowed.includes(id) || seen.has(id)) continue;
      seen.add(id);
      result.push({ id, visible: !hiddenSet.has(id) });
    }
  }

  for (const def of defaults) {
    if (!seen.has(def.id)) {
      seen.add(def.id);
      result.push({ id: def.id, visible: def.visible !== false });
    }
  }
  return result;
}

function getUiLayout() {
  const raw = store.state.uiLayout || {};
  return {
    rightTabsOrder: normalizeTabsOrder(raw.rightTabsOrder || DEFAULT_TABS_ORDER),
    rightSummaryModules: normalizeModuleList(raw.rightSummaryModules, DEFAULT_SUMMARY_MODULES),
    rightToolModules: normalizeModuleList(raw.rightToolModules, DEFAULT_TOOL_MODULES),
  };
}

function commitUiLayout(patch) {
  if (typeof storeMod.updateUiLayout === 'function') {
    return storeMod.updateUiLayout(patch);
  }
  const current = getUiLayout();
  const next = {
    rightTabsOrder: patch.rightTabsOrder ? normalizeTabsOrder(patch.rightTabsOrder) : current.rightTabsOrder,
    rightSummaryModules: patch.rightSummaryModules
      ? normalizeModuleList(patch.rightSummaryModules, DEFAULT_SUMMARY_MODULES)
      : current.rightSummaryModules,
    rightToolModules: patch.rightToolModules
      ? normalizeModuleList(patch.rightToolModules, DEFAULT_TOOL_MODULES)
      : current.rightToolModules,
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
  if (typeof storeMod.resetUiLayout === 'function') {
    return storeMod.resetUiLayout();
  }
  const next = {
    rightTabsOrder: [...DEFAULT_TABS_ORDER],
    rightSummaryModules: DEFAULT_SUMMARY_MODULES.map((m) => ({ ...m })),
    rightToolModules: DEFAULT_TOOL_MODULES.map((m) => ({ ...m })),
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
    classifyResult: null,
    classifyLoading: false,
    classifyTargetPath: '',
  };

  let msgSeq = 1;
  let draggedToolModuleId = null;
  const toolOpenStateById = new Map([
    ['quick_excel', true],
    ['knowledge_tree', true],
    ['apps_workspaces', true],
    ['ai_templates', true],
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
      ? `将结合「${activeName}」切换至问答发送`
      : ctxCount > 0
      ? `将结合已勾选的 ${ctxCount} 份文档发送`
      : '点击即自动切换问答并发送指令';

    return `
      <div style="font-size:11.5px;color:var(--text-tertiary);margin-bottom:8px;">
        ${escapeHtml(hintText)}
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">
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
    if (typeof window !== 'undefined' && window.innerWidth <= 767 && store.state.mobileTab !== 'ai') {
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
          ${icon('rotate-ccw', 13)} 恢复默认
        </button>
        <button type="button" class="pill-btn pill-btn-primary" id="customize-done-btn">完成</button>
      `,
      onMount(card) {
        const root = card.querySelector('#right-customize-root');

        const renderCustomizeBody = () => {
          if (!root) return;
          const layout = getUiLayout();

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
                return `
                  <div class="glass-card" style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 11px;">
                    <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;min-width:0;flex:1;">
                      <input type="checkbox" class="file-check" data-cust-toggle="${groupKey}" data-idx="${idx}" ${mod.visible ? 'checked' : ''} />
                      <span style="font-size:13px;font-weight:500;${mod.visible ? '' : 'color:var(--text-tertiary);text-decoration:line-through;'}">${escapeHtml(label)}</span>
                    </label>
                    <div style="display:inline-flex;gap:4px;flex-shrink:0;">
                      <button type="button" class="icon-pill" data-cust-mod-move="${groupKey}" data-idx="${idx}" data-delta="-1" ${idx === 0 ? 'disabled' : ''} title="上移" style="width:26px;height:26px;font-size:12px;">↑</button>
                      <button type="button" class="icon-pill" data-cust-mod-move="${groupKey}" data-idx="${idx}" data-delta="1" ${idx === list.length - 1 ? 'disabled' : ''} title="下移" style="width:26px;height:26px;font-size:12px;">↓</button>
                    </div>
                  </div>
                `;
              })
              .join('');

          root.innerHTML = `
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

        root?.addEventListener('change', (e) => {
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
          showToast('已恢复右侧默认模块布局', 'success');
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

    const inputHtml = `
      <div class="glass-card module-block" data-summary-module-id="input" style="margin-bottom:10px;padding:10px 12px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:6px;">
          <span style="font-size:11.5px;font-weight:600;color:var(--text-secondary);">速记与智能提炼</span>
          <span style="font-size:11px;color:var(--text-tertiary);max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(activeLabel)}">${escapeHtml(activeLabel)}</span>
        </div>
        <textarea
          id="right-summary-input"
          class="apple-textarea"
          rows="3"
          style="min-height:74px;font-size:13px;"
          placeholder="随时记下一段想法、会议记录或复习安排，点击 AI 自动提炼待办与软件直达..."
        >${escapeHtml(state.summaryInputText)}</textarea>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;">
          <button type="button" class="pill-btn pill-btn-primary pill-btn-sm" data-action="summarize-doc" ${state.summaryLoading ? 'disabled' : ''}>
            ${icon('sparkles', 13)} ${state.summaryLoading ? '提炼中...' : '总结当前文档'}
          </button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="summarize-text" ${state.summaryLoading ? 'disabled' : ''}>
            ${icon('sparkles', 13)} 总结上方文本
          </button>
        </div>
      </div>
    `;

    let resultHtml = '';
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
            ${renderMarkdownSafe(res.summary || '')}
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

        <div class="section-heading">
          <span>需要做什么 (${todos.length})</span>
          <span style="font-size:10.5px;font-weight:400;text-transform:none;letter-spacing:0;">可拖拽单条待办至中间笔记</span>
        </div>

        ${
          todos.length
            ? todos
                .map((td, idx) => {
                  const prioBadge =
                    td.priority === 'high'
                      ? `<span style="padding:1px 6px;border-radius:9999px;background:var(--danger-soft);color:var(--danger);font-size:10.5px;font-weight:600;flex-shrink:0;">优先</span>`
                      : '';
                  return `
                    <div class="todo-item draggable-card" draggable="true" data-drag-type="ai-todo" data-todo-idx="${idx}">
                      <div class="todo-item-row">
                        <div style="min-width:0;flex:1 1 auto;">
                          <div class="todo-title">${escapeHtml(td.title)}</div>
                          ${
                            td.suggested_time
                              ? `<div style="font-size:11.5px;color:var(--text-secondary);margin-top:2px;">建议时间：${escapeHtml(td.suggested_time)}</div>`
                              : ''
                          }
                        </div>
                        <div style="display:inline-flex;align-items:center;gap:4px;flex-shrink:0;">
                          ${prioBadge}
                          <span class="drag-pill-hint" title="按住直接拖进中间笔记栏" style="display:inline-flex;align-items:center;gap:3px;padding:1px 6px;border-radius:9999px;font-size:10.5px;color:var(--text-tertiary);background:var(--bg-island);border:1px dashed var(--border-hairline);cursor:grab;">⠿ 拖入</span>
                        </div>
                      </div>
                      <div class="todo-actions">
                        <button type="button" class="pill-btn pill-btn-sm" data-action="open-reminder-sheet" data-todo-idx="${idx}">
                          ${icon('bell', 12)} 设提醒
                        </button>
                        <button type="button" class="pill-btn pill-btn-sm" data-action="test-reminder-10s" data-todo-idx="${idx}" title="10秒后弹出桌面通知与灵动岛提醒">
                          ${icon('zap', 12)} 10秒测试
                        </button>
                        <select class="apple-select" data-role="focus-duration" aria-label="专注时长" style="width:auto;height:28px;padding:0 8px;font-size:11.5px;border-radius:9999px;">
                          <option value="1500" selected>25分</option>
                          <option value="900">15分</option>
                          <option value="2700">45分</option>
                          <option value="15">15秒演示</option>
                        </select>
                        <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-action="start-todo-focus" data-todo-idx="${idx}">
                          ${icon('play', 11)} 专注
                        </button>
                        <button type="button" class="pill-btn pill-btn-sm" data-action="start-todo-focus-15s" data-todo-idx="${idx}" title="一键 15 秒专注演示闭环" style="background:var(--success-soft);color:var(--success);border-color:transparent;">
                          15s演示
                        </button>
                      </div>
                    </div>
                  `;
                })
                .join('')
            : `<div class="glass-card" style="font-size:12.5px;color:var(--text-secondary);">暂无具体待办项</div>`
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
                    <button type="button" class="app-launcher-pill" data-action="launch-app" data-app-id="${escapeHtml(app.id)}" data-name="${escapeHtml(app.name)}">
                      ${icon('external-link', 12)}
                      <span>${escapeHtml(app.name)}</span>
                    </button>
                  `
                  )
                  .join('')}
                ${matchedFiles
                  .map(
                    (fp) => `
                    <button type="button" class="app-launcher-pill" data-action="open-matched-file" data-path="${escapeHtml(fp)}" style="background:var(--accent-soft);color:var(--accent);border-color:transparent;">
                      <span>${getFormatEmoji(fp)}</span>
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
      resultHtml = `
        <div class="glass-card" style="margin-bottom:10px;">
          <div style="font-size:12.5px;font-weight:600;margin-bottom:4px;display:flex;align-items:center;gap:6px;">
            ${icon('sparkles', 14)} <span>AI 总结与待办提炼就绪</span>
          </div>
          <p style="margin:0;font-size:12px;color:var(--text-secondary);line-height:1.55;">
            在上方输入想法，或点击「总结当前文档」自动生成核心摘要、提炼“需要做什么”待办清单，并一键设置定时提醒、拉起本地软件或开启灵动岛专注。
          </p>
        </div>
      `;
    }

    const summaryCardModuleHtml = `<div class="module-block" data-summary-module-id="summary_card">${resultHtml}</div>`;

    const remindersHtml = `
      <div class="module-block" data-summary-module-id="reminders">
        <div class="section-heading" style="margin-top:14px;">
          <span>定时提醒 (${pendingAndFired.length})</span>
          <button type="button" class="pill-btn pill-btn-ghost pill-btn-sm" data-action="refresh-reminders" style="height:22px;padding:0 8px;font-size:11px;">
            ${icon('rotate-ccw', 11)} 刷新
          </button>
        </div>
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
            : `<div style="font-size:12px;color:var(--text-tertiary);padding:4px 2px;">暂无定时提醒，可在提炼待办中点击「设提醒」或「10秒测试」</div>`
        }
      </div>
    `;

    const aiTemplatesSummaryHtml = `
      <div class="glass-card module-block" data-summary-module-id="ai_templates" style="margin-top:10px;padding:10px 12px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:6px;">
          <span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;color:var(--text-primary);">
            ${icon('zap', 13)} AI 常用指令模板
          </span>
        </div>
        ${renderAiTemplatesCardContentHtml()}
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
    } catch (err) {
      state.summaryError = err?.message || 'AI 总结失败';
      showToast(state.summaryError, 'error');
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
            <input type="text" class="apple-input" id="rem-title-input" value="${escapeHtml(todo?.title || '')}" placeholder="输入提醒事项..." />
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
          const title = card.querySelector('#rem-title-input')?.value?.trim();
          if (!title) {
            showToast('请输入提醒内容', 'warning');
            return;
          }
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
      return `<div style="font-size:11.5px;color:var(--text-tertiary);">在左侧勾选文件（最多5份）即可跨格式联合问答</div>`;
    }
    return paths
      .map((p) => {
        const name = getBaseName(p);
        return `
          <span class="context-file-pill" title="${escapeHtml(p)}">
            <span>${getFormatEmoji(p)}</span>
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
      ? renderMarkdownSafe(msg.content)
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
          <p class="empty-desc">在左侧勾选最多 5 份 PDF / Excel / Markdown / TXT，直接融合提问并生成可点击的页码与单元格锚点。</p>
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
      bodyEl.innerHTML = renderMarkdownSafe(msg.content);
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
            ${(store.state.selectedContextPaths || []).length}/5 文件
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
      if (!selected.includes(activeFile.path) && selected.length < 5) {
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

  async function openSaveNoteSheet(msg) {
    if (!state.treeData.nodes.length) {
      await fetchTree();
    }
    const nodes = state.treeData.nodes || [];
    const firstLine = String(msg.content || '')
      .split('\n')
      .map((l) => l.replace(/^[#>\s*-]+/, '').trim())
      .find((l) => l.length >= 2);
    const defaultTitle = (firstLine || 'AI 问答笔记').slice(0, 28);

    openSheet({
      title: '存入本地 Markdown 笔记',
      bodyHtml: `
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div>
            <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:5px;">笔记标题</label>
            <input type="text" class="apple-input" id="note-save-title" value="${escapeHtml(defaultTitle)}" placeholder="输入笔记文件名..." />
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
          const title = card.querySelector('#note-save-title')?.value?.trim();
          const nodeId = card.querySelector('#note-save-node')?.value || null;
          if (!title) {
            showToast('请输入笔记标题', 'warning');
            return;
          }
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

    const card1Html = `
      <details class="tool-card module-block" data-module-id="quick_excel" draggable="true" ${toolOpenStateById.get('quick_excel') !== false ? 'open' : ''}>
        <summary class="tool-card-summary">
          <span style="display:inline-flex;align-items:center;gap:6px;">
            <span class="module-drag-handle" title="拖拽调整卡片顺序" style="color:var(--text-tertiary);cursor:grab;">⠿</span>
            ${icon('table', 14)} 快捷表单填表与表格操作
          </span>
          <span style="font-size:11.5px;color:var(--text-tertiary);font-weight:500;">${excelFiles.length} 份表格</span>
        </summary>
        <div class="tool-card-body">
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
      </details>
    `;

    const treeIsTable = state.treeViewMode === 'table';
    const card2Html = `
      <details class="tool-card module-block" data-module-id="knowledge_tree" draggable="true" ${toolOpenStateById.get('knowledge_tree') !== false ? 'open' : ''}>
        <summary class="tool-card-summary">
          <span style="display:inline-flex;align-items:center;gap:6px;">
            <span class="module-drag-handle" title="拖拽调整卡片顺序" style="color:var(--text-tertiary);cursor:grab;">⠿</span>
            ${icon('git-branch', 14)} 虚拟知识树分类与总览
          </span>
          <span style="font-size:11.5px;color:var(--text-tertiary);font-weight:500;">${nodes.length} 节点</span>
        </summary>
        <div class="tool-card-body">
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
                                <td style="padding:5px 8px;border-bottom:1px solid var(--border-hairline);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                                  <button type="button" data-action="tree-open-file" data-path="${escapeHtml(row.path)}" data-name="${escapeHtml(row.file_name)}" style="color:var(--accent);font-weight:500;text-align:left;">
                                    ${escapeHtml(row.file_name)}
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
                                          <button type="button" data-action="tree-open-file" data-path="${escapeHtml(f.path)}" data-name="${escapeHtml(fname)}" style="min-width:0;flex:1 1 auto;text-align:left;font-size:12px;color:var(--accent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                                            ${getFormatEmoji(f.path)} ${escapeHtml(fname)}
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
      </details>
    `;

    const card3Html = `
      <details class="tool-card module-block" data-module-id="apps_workspaces" draggable="true" ${toolOpenStateById.get('apps_workspaces') !== false ? 'open' : ''}>
        <summary class="tool-card-summary">
          <span style="display:inline-flex;align-items:center;gap:6px;">
            <span class="module-drag-handle" title="拖拽调整卡片顺序" style="color:var(--text-tertiary);cursor:grab;">⠿</span>
            ${icon('rocket', 14)} 本地软件库与工作区联启
          </span>
          <span style="font-size:11.5px;color:var(--text-tertiary);font-weight:500;">${apps.length} 应用 · ${workspaces.length} 现场</span>
        </summary>
        <div class="tool-card-body">
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
                      <span class="app-launcher-pill" style="padding-right:6px;">
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

          <div style="font-size:11.5px;font-weight:600;color:var(--text-secondary);margin-bottom:6px;">场景工作区组合</div>
          ${
            workspaces.length
              ? workspaces
                  .map((ws) => {
                    const appNames = (ws.app_ids || []).map((id) => appsById.get(String(id))?.name || id);
                    const fileCount = (ws.file_paths || []).length;
                    return `
                      <div class="workspace-card" style="background:var(--bg-island);">
                        <div class="workspace-card-head">
                          <span class="workspace-name">${escapeHtml(ws.name)}</span>
                          <div style="display:inline-flex;align-items:center;gap:4px;flex-shrink:0;">
                            <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-action="launch-workspace" data-ws-id="${escapeHtml(ws.id)}" data-name="${escapeHtml(ws.name)}" style="height:24px;padding:0 9px;font-size:11px;">
                              🚀 联启
                            </button>
                            <button type="button" class="pill-btn pill-btn-sm" data-action="focus-workspace" data-name="${escapeHtml(ws.name)}" style="height:24px;padding:0 9px;font-size:11px;">
                              ▶ 专注
                            </button>
                            <button type="button" class="icon-pill" data-action="delete-workspace" data-ws-id="${escapeHtml(ws.id)}" data-name="${escapeHtml(ws.name)}" title="删除工作区" style="width:24px;height:24px;">
                              ${icon('trash', 11)}
                            </button>
                          </div>
                        </div>
                        <div class="workspace-meta">
                          ${appNames.length ? `软件：${escapeHtml(appNames.join('、'))}` : '暂无关联软件'} · ${fileCount} 份文档
                        </div>
                      </div>
                    `;
                  })
                  .join('')
              : `<div style="font-size:12px;color:var(--text-tertiary);">暂无场景工作区，可点击上方「捕获当前桌面现场」一键创建。</div>`
          }
        </div>
      </details>
    `;

    const card4Html = `
      <details class="tool-card module-block" data-module-id="ai_templates" draggable="true" ${toolOpenStateById.get('ai_templates') !== false ? 'open' : ''}>
        <summary class="tool-card-summary">
          <span style="display:inline-flex;align-items:center;gap:6px;">
            <span class="module-drag-handle" title="拖拽调整卡片顺序" style="color:var(--text-tertiary);cursor:grab;">⠿</span>
            ${icon('zap', 14)} AI 常用指令模板
          </span>
          <span style="font-size:11.5px;color:var(--text-tertiary);font-weight:500;">${AI_PROMPT_TEMPLATES.length} 模板</span>
        </summary>
        <div class="tool-card-body">
          ${renderAiTemplatesCardContentHtml()}
        </div>
      </details>
    `;

    const cardMap = {
      quick_excel: card1Html,
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

  function openAddColSheet() {
    if (!state.selectedExcelPath) return;
    const sheetInfo = state.excelSheets.find((s) => s.name === state.selectedSheet);
    const nextIdx = (sheetInfo?.headers?.length || 0) + 1;
    openSheet({
      title: '新增 Excel 列',
      bodyHtml: `
        <div style="display:flex;flex-direction:column;gap:10px;">
          <div>
            <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">新列表头名称</label>
            <input type="text" class="apple-input" id="add-col-name" placeholder="例如：备注 / 错题原因" />
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
          const name = card.querySelector('#add-col-name')?.value?.trim();
          const index = Math.max(1, Number(card.querySelector('#add-col-index')?.value) || nextIdx);
          if (!name) {
            showToast('请输入新列表头名称', 'warning');
            return;
          }
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
    openSheet({
      title: '新建知识树分类节点',
      bodyHtml: `
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div>
            <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">分类节点名称</label>
            <input type="text" class="apple-input" id="tree-node-name" placeholder="例如：高等数学 / 错题集" />
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
          const name = card.querySelector('#tree-node-name')?.value?.trim();
          const parentId = card.querySelector('#tree-node-parent')?.value || null;
          if (!name) {
            showToast('节点名称不能为空', 'warning');
            return;
          }
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
    openSheet({
      title: '添加本地软件直达',
      bodyHtml: `
        <div style="display:flex;flex-direction:column;gap:10px;">
          <div>
            <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">软件名称</label>
            <input type="text" class="apple-input" id="add-app-name" placeholder="例如：WPS Office" />
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
          const name = card.querySelector('#add-app-name')?.value?.trim();
          const path = card.querySelector('#add-app-path')?.value?.trim();
          const aliasesRaw = card.querySelector('#add-app-aliases')?.value || '';
          const aliases = aliasesRaw
            .split(/[,，]/)
            .map((s) => s.trim())
            .filter(Boolean);
          if (!name || !path) {
            showToast('请填写软件名称与路径', 'warning');
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

  containerEl.addEventListener('dragend', () => {
    draggedToolModuleId = null;
    containerEl.querySelectorAll('.is-dragging, .is-drag-over').forEach((el) => {
      el.classList.remove('is-dragging', 'is-drag-over');
    });
    clearDragPayload();
  });

  // ---------------------------------------------------------------------------
  // Event Delegation & Store EventBus Wiring
  // ---------------------------------------------------------------------------

  containerEl.addEventListener('input', (e) => {
    const sumTa = e.target.closest('#right-summary-input');
    if (sumTa) {
      state.summaryInputText = sumTa.value;
      return;
    }
    const chatTa = e.target.closest('#chat-input');
    if (chatTa) {
      state.chatDraft = chatTa.value;
    }
  });

  containerEl.addEventListener('keydown', (e) => {
    if (e.target?.id === 'chat-input' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendChatMessage();
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

    // 2. Clickable Cross-Format Anchor Pill
    const anchorPill = e.target.closest('.anchor-pill');
    if (anchorPill) {
      store.emit('anchor:jump', {
        file: anchorPill.dataset.anchorFile || '',
        page: anchorPill.dataset.anchorPage || '',
        sheet: anchorPill.dataset.anchorSheet || '',
        cell: anchorPill.dataset.anchorCell || '',
      });
      return;
    }

    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;

    // --- V2 Global Right Panel Actions ---
    if (action === 'open-right-customize') {
      openRightCustomizeSheet();
      return;
    }

    if (action === 'open-ai-settings') {
      store.emit('settings:open');
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
      const itemEl = actionEl.closest('.todo-item');
      const durSelect = itemEl?.querySelector('[data-role="focus-duration"]');
      const seconds = Math.max(5, Number(durSelect?.value) || 1500);
      store.emit('focus:start', {
        title: todo?.title || '专注任务',
        seconds,
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
      openCreateTreeNodeSheet();
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
      openAddAppSheet();
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
      const wsName = actionEl.dataset.name || '工作区专注';
      store.emit('focus:start', { title: wsName, seconds: 1500 });
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

  store.on('ui:layout-changed', () => {
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
      countSpan.textContent = `${(store.state.selectedContextPaths || []).length}/5 文件`;
    }
    renderSummaryMode();
    renderToolsMode();
  });

  store.on('files:updated', () => {
    syncExcelSelection();
    renderSummaryMode();
  });

  store.on('file:open', () => {
    renderSummaryMode();
    syncExcelSelection();
  });

  store.on('state:changed', ({ keys }) => {
    if (keys?.includes('activeFile')) {
      renderSummaryMode();
      syncExcelSelection();
    }
    if (keys?.includes('config') || keys?.includes('systemInfo')) {
      renderSummaryMode();
      renderChatHeaderStatus();
    }
  });

  store.on('apps:updated', fetchAppsAndWorkspaces);
  store.on('workspaces:updated', fetchAppsAndWorkspaces);
  store.on('tree:updated', fetchTree);
  store.on('reminders:updated', fetchReminders);
  store.on('sse:reminder:fired', fetchReminders);

  // Initial Render + Lazy Initial Loads
  renderTabsHeader();
  syncModeHeader();
  renderSummaryMode();
  renderChatMode();
  renderToolsMode();

  fetchReminders();
  fetchTree();
  fetchAppsAndWorkspaces();
  fetchFilesIfNeeded().then(syncExcelSelection);
}
