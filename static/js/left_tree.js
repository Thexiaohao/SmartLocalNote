/**
 * SmartLocalNote - Left Panel (Full Production: Stages 2, 3 & 4)
 * Sections:
 *  1. Top Toolbar: [+ 新建笔记] & [📥 导入] (Native Picker + Manual Local Path)
 *  2. Local Files: Grouped tree, RAG 5-file circular checkboxes, privacy lock toggles
 *  3. Local Apps & Workspaces: [📸 捕获现场] (Innovation 1), [+ 软件], App launch pills,
 *     Workspace cards with [🚀 联启] & [▶ 专注] duration picker
 *  4. Virtual Knowledge Tree: Top-level nodes quick preview & [管理知识树]
 *
 * Strictly decoupled via store EventBus. Zero direct DOM access to Center/Right panels.
 */

import { store, escapeHtml, toggleContextPath, showToast, openSheet, closeSheet } from './store.js';
import { api } from './api_client.js';
import { icon } from './icons.js';

const MAX_CONTEXT_FILES = 5;
const FOCUS_DURATION_OPTIONS = [
  { label: '15秒演示', seconds: 15 },
  { label: '15分', seconds: 900 },
  { label: '25分', seconds: 1500 },
  { label: '45分', seconds: 2700 },
];

const collapsedGroups = new Set();
const mutating = {
  files: false,
  apps: false,
  workspaces: false,
  tree: false,
};

let containerRef = null;
let isLoadingInitial = true;

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
    case 'csv':
      return 'file-spreadsheet';
    case 'pdf':
      return 'book-open';
    case 'md':
      return 'file-code';
    case 'txt':
    default:
      return 'file-text';
  }
}

function findFileItemByPath(path) {
  const items = store.state.files?.items || [];
  return items.find((item) => item.path === path) || null;
}

function groupFiles(items) {
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

  return Array.from(groups.values());
}

async function loadFiles() {
  try {
    const data = await api.get('/api/files/list');
    store.state.files = {
      items: Array.isArray(data?.items) ? data.items : [],
      dirs: Array.isArray(data?.dirs) ? data.dirs : [],
      private_files: Array.isArray(data?.private_files) ? data.private_files : [],
    };
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

  const badge = containerEl.querySelector('[data-role="ctx-count-badge"]');
  if (badge) {
    badge.textContent = `已勾 ${selected.size}/${MAX_CONTEXT_FILES}`;
  }

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
    return `<div class="empty-state" style="padding: 18px 8px;"><p class="empty-desc">正在扫描本地工作区…</p></div>`;
  }

  if (items.length === 0) {
    return `
      <div class="empty-state" style="padding: 18px 8px;">
        <p class="empty-desc">暂无本地文档，点击上方「新建笔记」或「导入」添加资料</p>
      </div>
    `;
  }

  const groups = groupFiles(items);
  return groups
    .map((grp) => {
      const isCollapsed = collapsedGroups.has(grp.key);
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
                    return `
                      <div
                        class="tree-file-item ${isActive ? 'is-selected' : ''}"
                        data-action="open-file"
                        data-path="${escapeHtml(path)}"
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
                        <span style="display:inline-flex;flex-shrink:0;color:var(--text-secondary);">
                          ${icon(getFileIconName(ext), 15)}
                        </span>
                        <span class="file-name" title="${escapeHtml(path)}">${escapeHtml(name)}</span>
                        <span class="file-ext-badge">${escapeHtml(ext)}</span>
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

function renderAppsAndWorkspacesSection(apps, workspaces) {
  const appsHtml =
    apps.length === 0
      ? `<p class="empty-desc" style="margin:4px 0 8px;">暂无已注册软件，可点击「捕获现场」或「+ 软件」快速添加</p>`
      : `
        <div class="app-pill-grid" style="margin-bottom:10px;">
          ${apps
            .map(
              (app) => `
              <button
                type="button"
                class="app-launcher-pill"
                data-action="launch-app"
                data-app-id="${escapeHtml(app.id)}"
                title="${escapeHtml(app.path || app.name)}"
              >
                ${icon('rocket', 12)}
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(app.name)}</span>
              </button>
            `
            )
            .join('')}
        </div>
      `;

  const workspacesHtml =
    workspaces.length === 0
      ? `<p class="empty-desc" style="margin:4px 0;">暂无场景工作区，点击「捕获现场」一键固化当前桌面</p>`
      : workspaces
          .map((ws) => {
            const appCount = Array.isArray(ws.app_ids) ? ws.app_ids.length : 0;
            const fileCount = Array.isArray(ws.file_paths) ? ws.file_paths.length : 0;
            return `
              <div class="workspace-card" data-workspace-id="${escapeHtml(ws.id)}">
                <div class="workspace-card-head">
                  <span class="workspace-name" title="${escapeHtml(ws.name)}">${escapeHtml(ws.name)}</span>
                  <span class="workspace-meta">${appCount} 软件 · ${fileCount} 文档</span>
                </div>
                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                  <button
                    type="button"
                    class="pill-btn pill-btn-sm pill-btn-primary"
                    data-action="launch-workspace"
                    data-ws-id="${escapeHtml(ws.id)}"
                  >
                    ${icon('rocket', 12)} 联启
                  </button>
                  <select
                    class="apple-select"
                    data-role="ws-focus-duration"
                    data-ws-id="${escapeHtml(ws.id)}"
                    aria-label="选择专注时长"
                    style="width:auto;padding:4px 8px;height:28px;font-size:11.5px;border-radius:var(--radius-pill);"
                  >
                    ${FOCUS_DURATION_OPTIONS.map(
                      (opt) =>
                        `<option value="${opt.seconds}" ${opt.seconds === 1500 ? 'selected' : ''}>${escapeHtml(opt.label)}</option>`
                    ).join('')}
                  </select>
                  <button
                    type="button"
                    class="pill-btn pill-btn-sm"
                    data-action="focus-workspace"
                    data-ws-id="${escapeHtml(ws.id)}"
                  >
                    ${icon('play', 12)} 专注
                  </button>
                </div>
              </div>
            `;
          })
          .join('');

  return `${appsHtml}${workspacesHtml}`;
}

function renderKnowledgeTreeSection(treeNodes) {
  const topNodes = (treeNodes || []).filter((n) => !n.parent_id);
  if (topNodes.length === 0) {
    return `<p class="empty-desc" style="margin:4px 0;">暂无知识树节点，点击「管理知识树」创建分类</p>`;
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
              const status = bf.status || '';
              return `
                <div
                  class="tree-file-item"
                  data-action="open-tree-file"
                  data-path="${escapeHtml(path)}"
                  role="button"
                  tabindex="0"
                  style="padding-left:20px;"
                >
                  <span style="display:inline-flex;flex-shrink:0;color:var(--text-secondary);">
                    ${icon(getFileIconName(name.split('.').pop()), 13)}
                  </span>
                  <span class="file-name" title="${escapeHtml(path)}">${escapeHtml(name)}</span>
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

function renderLeftPanel(containerEl) {
  if (!containerEl) return;
  const prevScrollTop = containerEl.querySelector('.panel-body')?.scrollTop || 0;

  const items = store.state.files?.items || [];
  const selectedSet = new Set(store.state.selectedContextPaths || []);
  const activePath = store.state.activeFile?.path || '';
  const apps = store.state.apps || [];
  const workspaces = store.state.workspaces || [];
  const treeNodes = store.state.tree?.nodes || [];

  containerEl.innerHTML = `
    <div class="panel-header">
      <span class="panel-title">资料与工作区</span>
      <span class="file-ext-badge" data-role="ctx-count-badge" title="已勾选参与联合问答文件数">已勾 ${selectedSet.size}/${MAX_CONTEXT_FILES}</span>
    </div>

    <div class="left-toolbar" style="flex-shrink:0;">
      <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-action="new-note">
        ${icon('plus', 13)} 新建笔记
      </button>
      <button type="button" class="pill-btn pill-btn-sm" data-action="import-open">
        ${icon('download', 13)} 导入
      </button>
    </div>

    <div class="panel-body">
      <div class="section-heading">
        <span>本地文件</span>
        <span style="font-weight:500;text-transform:none;">${items.length} 份</span>
      </div>
      <div class="left-files-list">
        ${renderFilesSection(items, selectedSet, activePath)}
      </div>

      <div class="section-heading">
        <span>本地软件与现场</span>
        <div style="display:inline-flex;align-items:center;gap:4px;">
          <button type="button" class="pill-btn pill-btn-sm" data-action="capture-scene" style="height:24px;padding:0 9px;font-size:11px;">
            ${icon('camera', 12)} 捕获现场
          </button>
          <button type="button" class="pill-btn pill-btn-sm" data-action="add-app" style="height:24px;padding:0 9px;font-size:11px;">
            ${icon('plus', 12)} 软件
          </button>
        </div>
      </div>
      <div class="left-apps-workspaces">
        ${renderAppsAndWorkspacesSection(apps, workspaces)}
      </div>

      <div class="section-heading">
        <span>虚拟知识树</span>
        <button type="button" class="pill-btn pill-btn-sm pill-btn-ghost" data-action="manage-tree" style="height:24px;padding:0 8px;font-size:11px;text-transform:none;">
          ${icon('settings', 12)} 管理知识树
        </button>
      </div>
      <div class="left-tree-quick">
        ${renderKnowledgeTreeSection(treeNodes)}
      </div>
    </div>
  `;

  const bodyEl = containerEl.querySelector('.panel-body');
  if (bodyEl && prevScrollTop > 0) {
    bodyEl.scrollTop = prevScrollTop;
  }
}

function openCreateNoteSheet() {
  const nodes = store.state.tree?.nodes || [];
  const nodeOptions = nodes
    .map((n) => `<option value="${escapeHtml(n.id)}">${escapeHtml(n.name)}</option>`)
    .join('');

  openSheet({
    title: '新建本地笔记',
    bodyHtml: `
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div>
          <label for="new-note-title" style="display:block;font-size:12.5px;font-weight:600;margin-bottom:6px;color:var(--text-secondary);">笔记标题</label>
          <input id="new-note-title" type="text" class="apple-input" placeholder="例如：高数第三章错题复盘" />
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
        const title = titleInput?.value?.trim();
        if (!title) {
          showToast('请输入笔记标题', 'warning');
          titleInput?.focus();
          return;
        }
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
          <p id="pick-path-hint" style="margin:8px 0 0;font-size:12px;color:var(--text-secondary);">支持 .md / .txt / .pdf / .xlsx 原位预览与编辑</p>
        </div>

        <div class="glass-card">
          <div style="font-size:12.5px;font-weight:600;margin-bottom:8px;color:var(--text-primary);">方式二：手动输入本地绝对路径</div>
          <input id="manual-import-path" type="text" class="apple-input" placeholder="例如：D:\\Study\\高数讲义.pdf 或 /home/user/notes" />
          <label style="display:inline-flex;align-items:center;gap:8px;margin-top:10px;font-size:12.5px;color:var(--text-secondary);cursor:pointer;">
            <input id="manual-import-isdir" type="checkbox" class="file-check" />
            <span>作为目录挂载（自动扫描目录下所有支持格式）</span>
          </label>
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
    },
  });
}

function openAddAppSheet() {
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
          <label for="add-app-name" style="display:block;font-size:12.5px;font-weight:600;margin-bottom:6px;color:var(--text-secondary);">软件名称</label>
          <input id="add-app-name" type="text" class="apple-input" placeholder="例如：WPS Office / Edge" />
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
        const name = nameInput?.value?.trim();
        const path = pathInput?.value?.trim();
        const aliasesRaw = aliasesInput?.value || '';
        const args = argsInput?.value?.trim() || '';

        if (!name) {
          showToast('请输入软件名称', 'warning');
          nameInput?.focus();
          return;
        }
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
          <label for="capture-ws-name" style="display:block;font-size:12.5px;font-weight:600;margin-bottom:6px;color:var(--text-secondary);">工作区名称</label>
          <input id="capture-ws-name" type="text" class="apple-input" placeholder="如：高数复习现场" />
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
      <button type="button" class="pill-btn pill-btn-primary" id="capture-save-btn">${icon('camera', 14)} 保存为场景工作区</button>
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

      saveBtn?.addEventListener('click', async () => {
        const name = wsNameInput?.value?.trim();
        if (!name) {
          showToast('请输入工作区名称（如：高数复习现场）', 'warning');
          wsNameInput?.focus();
          return;
        }

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
          showToast(`已保存场景工作区「${name}」`, 'success');
        } catch (err) {
          showToast(`保存工作区失败：${err.message}`, 'error');
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
  store.state.activeFile = item;
  syncActiveFileHighlight(containerRef, item.path);
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

/**
 * Initialize Left Panel (Stages 2, 3 & 4 Production).
 * @param {HTMLElement} containerEl
 */
export function initLeftTree(containerEl) {
  if (!containerEl) return;
  containerRef = containerEl;

  renderLeftPanel(containerEl);

  // Sync checkboxes & active highlight cleanly without full re-render flicker
  store.on('context:changed', () => syncContextCheckboxes(containerEl));
  store.on('file:open', (file) => syncActiveFileHighlight(containerEl, file?.path));
  store.on('capture:open', () => openCaptureSceneSheet());

  // Refresh data when mutated elsewhere via EventBus
  store.on('files:updated', async () => {
    if (mutating.files) return;
    await loadFiles();
    renderLeftPanel(containerEl);
  });
  store.on('apps:updated', async () => {
    if (mutating.apps) return;
    await loadApps();
    renderLeftPanel(containerEl);
  });
  store.on('workspaces:updated', async () => {
    if (mutating.workspaces) return;
    await loadWorkspaces();
    renderLeftPanel(containerEl);
  });
  store.on('tree:updated', async () => {
    if (mutating.tree) return;
    await loadTree();
    renderLeftPanel(containerEl);
  });

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
        renderLeftPanel(containerEl);
      }
      return;
    }

    if (action === 'open-file' || action === 'open-tree-file') {
      handleOpenFilePath(actionEl.dataset.path);
      return;
    }

    if (action === 'new-note') {
      openCreateNoteSheet();
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
      const wsId = actionEl.dataset.wsId;
      const ws = (store.state.workspaces || []).find((w) => w.id === wsId);
      const card = actionEl.closest('.workspace-card');
      const selectEl = card?.querySelector('[data-role="ws-focus-duration"]');
      const seconds = Number(selectEl?.value || 1500);
      handleStartWorkspaceFocus(ws, seconds);
      return;
    }

    if (action === 'manage-tree') {
      handleOpenTreeTools();
    }
  });

  // Handle RAG context checkbox toggle
  containerEl.addEventListener('change', (e) => {
    const cb = e.target.closest('.file-check');
    if (!cb) return;
    const path = cb.dataset.path;
    toggleContextPath(path);
    cb.checked = (store.state.selectedContextPaths || []).includes(path);
  });

  // Keyboard accessibility for row items
  containerEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target.closest('.file-check, button, select, input')) return;
    const actionEl = e.target.closest('[data-action="open-file"], [data-action="open-tree-file"], [data-action="toggle-group"]');
    if (!actionEl) return;
    e.preventDefault();
    actionEl.click();
  });

  // Initial backend hydration
  loadAllData().then(() => {
    renderLeftPanel(containerEl);
  });
}
