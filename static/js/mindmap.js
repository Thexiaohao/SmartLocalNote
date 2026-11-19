/**
 * SmartLocalNote - Pure Native SVG Interactive Mind Map (V3)
 * Pain Point #10 + Innovation D:
 *  - Parses Markdown headings (#..####) & indented bullets (-, *, 1.) into a balanced hierarchical tree
 *  - Detects & syncs mastery status badges ([🟢], [🟡], [🔴]) cleanly back into Markdown
 *  - Pure native SVG Bezier curve edges + crisp interactive HTML pill node layer (clickable [[...]] portals & inline dblclick rename)
 *  - Toolbar: Zoom [- / 100% / +], Fit Center, AI Distill Mindmap, Export SVG, Export HiDPI PNG
 *  - Innovation D Node Menu (right-click or hover trigger): Mastery toggles, Focus 25m / 15s Demo, + Add Child Node
 *
 * Zero external libraries. Communicates strictly via callbacks & store EventBus.
 */

import { store, escapeHtml, renderMarkdownSafe, showToast } from './store.js';
import { icon } from './icons.js';

const STATUS_BADGE_MAP = {
  mastered: '[🟢]',
  review: '[🟡]',
  weak: '[🔴]',
};

const STATUS_LABEL_MAP = {
  mastered: '🟢 已掌握',
  review: '🟡 待巩固',
  weak: '🔴 易错薄弱',
};

function stripStatusToken(rawText) {
  return String(rawText || '')
    .replace(/\s*\[(🟢|🟡|🔴)\]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectStatusToken(rawText) {
  const s = String(rawText || '');
  if (s.includes('[🟢]')) return 'mastered';
  if (s.includes('[🟡]')) return 'review';
  if (s.includes('[🔴]')) return 'weak';
  return 'none';
}

function parseMarkdownToTree(markdown, docName = '笔记脑图') {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  let idSeq = 1;
  const nextId = () => `mm_${idSeq++}`;

  const rawItems = [];
  let inCodeBlock = false;
  let currentHeadingDepth = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const headingMatch = line.match(/^(#{1,4})\s+(.+?)\s*$/);
    if (headingMatch) {
      const depth = headingMatch[1].length;
      currentHeadingDepth = depth;
      const rawContent = headingMatch[2].replace(/\s+#+\s*$/, '').trim();
      rawItems.push({
        id: nextId(),
        kind: 'heading',
        headingLevel: depth,
        depth,
        lineIdx: i,
        rawText: rawContent,
        text: stripStatusToken(rawContent),
        status: detectStatusToken(rawContent),
        collapsed: false,
        children: [],
      });
      continue;
    }

    const bulletMatch = line.match(/^(\s*)(?:[-*+]|\d+\.)\s+(.+?)\s*$/);
    if (bulletMatch) {
      const indentStr = bulletMatch[1].replace(/\t/g, '  ');
      const indentLevel = Math.floor(indentStr.length / 2);
      const baseDepth = currentHeadingDepth > 0 ? currentHeadingDepth : 1;
      const depth = baseDepth + 1 + indentLevel;
      const rawContent = bulletMatch[2].trim();
      rawItems.push({
        id: nextId(),
        kind: 'bullet',
        indentSpaces: indentStr.length,
        depth,
        lineIdx: i,
        rawText: rawContent,
        text: stripStatusToken(rawContent),
        status: detectStatusToken(rawContent),
        collapsed: false,
        children: [],
      });
    }
  }

  let root;
  if (rawItems.length === 0) {
    const fallbackTitle = String(docName || '笔记脑图').replace(/\.(md|txt)$/i, '');
    root = {
      id: 'mm_root',
      kind: 'virtual-root',
      depth: 0,
      lineIdx: -1,
      rawText: fallbackTitle,
      text: fallbackTitle,
      status: 'none',
      collapsed: false,
      children: [],
    };
    return root;
  }

  const firstH1Idx = rawItems.findIndex((it) => it.kind === 'heading' && it.headingLevel === 1);
  if (firstH1Idx === 0 && rawItems.filter((it) => it.kind === 'heading' && it.headingLevel === 1).length === 1) {
    root = rawItems[0];
    rawItems.shift();
  } else {
    const cleanTitle = String(docName || '笔记脑图').replace(/\.(md|txt)$/i, '');
    root = {
      id: 'mm_root',
      kind: 'virtual-root',
      depth: 0,
      lineIdx: -1,
      rawText: cleanTitle,
      text: cleanTitle,
      status: 'none',
      collapsed: false,
      children: [],
    };
  }

  const stack = [root];
  for (const item of rawItems) {
    while (stack.length > 1 && stack[stack.length - 1].depth >= item.depth) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    parent.children.push(item);
    stack.push(item);
  }

  return root;
}

function measureNodeBox(node) {
  const display = node.text || '节点';
  // Strip [[...]] wrappers to approximate rendered pill text width cleanly
  const cleanVisible = display
    .replace(/\[\[(?:app:|url:)?([^[\]|]+?)(?:\|[^[\]]+)?\]\]/g, '$1')
    .trim();
  const isRoot = node.depth <= 1 && node.kind !== 'bullet';
  let weightedLen = 0;
  for (const ch of cleanVisible) {
    weightedLen += ch.charCodeAt(0) > 255 ? 13.5 : 7.6;
  }
  const minW = isRoot ? 118 : 88;
  const maxW = 280;
  const padX = 34;
  const w = Math.min(maxW, Math.max(minW, Math.round(weightedLen + padX)));
  const linesEst = Math.max(1, Math.ceil((weightedLen + padX) / maxW));
  const h = linesEst > 1 ? Math.min(82, 24 + linesEst * 18) : (isRoot ? 42 : 34);
  return { w, h };
}

function countSubtreeNodes(node) {
  if (!node.children || node.children.length === 0) return 0;
  let total = node.children.length;
  for (const ch of node.children) {
    total += countSubtreeNodes(ch);
  }
  return total;
}

function computeTreeLayout(root, collapsedIds) {
  const V_GAP = 16;
  const H_GAP = 54;
  const PADDING_X = 48;
  const PADDING_Y = 44;

  const nodesList = [];
  const edgesList = [];

  function measureSubtree(node, level) {
    const box = measureNodeBox(node);
    const isCollapsed = collapsedIds.has(node.id);
    const children = isCollapsed ? [] : (node.children || []);
    const hiddenCount = isCollapsed ? countSubtreeNodes(node) : 0;

    const layoutNode = {
      data: node,
      level,
      w: box.w,
      h: box.h,
      x: 0,
      y: 0,
      subtreeH: box.h,
      hiddenCount,
      children: [],
    };

    if (children.length === 0) {
      return layoutNode;
    }

    let sumChildrenH = 0;
    for (let i = 0; i < children.length; i += 1) {
      const childLayout = measureSubtree(children[i], level + 1);
      layoutNode.children.push(childLayout);
      sumChildrenH += childLayout.subtreeH;
      if (i > 0) sumChildrenH += V_GAP;
    }

    layoutNode.subtreeH = Math.max(box.h, sumChildrenH);
    return layoutNode;
  }

  function assignCoords(layoutNode, startX, topY) {
    layoutNode.x = startX;
    if (layoutNode.children.length === 0) {
      layoutNode.y = topY + (layoutNode.subtreeH - layoutNode.h) / 2;
    } else {
      let curY = topY;
      const childrenTotalH =
        layoutNode.children.reduce((acc, c) => acc + c.subtreeH, 0) +
        Math.max(0, layoutNode.children.length - 1) * V_GAP;
      if (childrenTotalH < layoutNode.subtreeH) {
        curY += (layoutNode.subtreeH - childrenTotalH) / 2;
      }

      const childStartX = startX + layoutNode.w + H_GAP;
      for (const child of layoutNode.children) {
        assignCoords(child, childStartX, curY);
        curY += child.subtreeH + V_GAP;
      }

      const firstChild = layoutNode.children[0];
      const lastChild = layoutNode.children[layoutNode.children.length - 1];
      const midChildrenY =
        (firstChild.y + firstChild.h / 2 + (lastChild.y + lastChild.h / 2)) / 2;
      layoutNode.y = midChildrenY - layoutNode.h / 2;
    }

    nodesList.push(layoutNode);
    for (const child of layoutNode.children) {
      edgesList.push({ from: layoutNode, to: child });
    }
  }

  const layoutRoot = measureSubtree(root, 0);
  assignCoords(layoutRoot, PADDING_X, PADDING_Y);

  let maxRight = 320;
  let maxBottom = 240;
  for (const n of nodesList) {
    maxRight = Math.max(maxRight, n.x + n.w + PADDING_X + 32);
    maxBottom = Math.max(maxBottom, n.y + n.h + PADDING_Y);
  }

  return {
    root: layoutRoot,
    nodes: nodesList,
    edges: edgesList,
    width: Math.ceil(maxRight),
    height: Math.ceil(maxBottom),
  };
}

function applyLineTextUpdate(markdown, lineIdx, nextCleanText, nextStatus) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  if (lineIdx < 0 || lineIdx >= lines.length) return markdown;
  const orig = lines[lineIdx];
  const badge = STATUS_BADGE_MAP[nextStatus] ? ` ${STATUS_BADGE_MAP[nextStatus]}` : '';
  const body = `${stripStatusToken(nextCleanText)}${badge}`.trim();

  const headingMatch = orig.match(/^(\s*#{1,6}\s+)(.*)$/);
  if (headingMatch) {
    lines[lineIdx] = `${headingMatch[1]}${body}`;
    return lines.join('\n');
  }

  const bulletMatch = orig.match(/^(\s*(?:[-*+]|\d+\.)\s+)(.*)$/);
  if (bulletMatch) {
    lines[lineIdx] = `${bulletMatch[1]}${body}`;
    return lines.join('\n');
  }

  lines[lineIdx] = body;
  return lines.join('\n');
}

function appendChildBulletToMarkdown(markdown, parentNode, childText) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const cleanChild = String(childText || '新分支节点').trim() || '新分支节点';

  // Virtual root: append at end of file as H2 or bullet
  if (!parentNode || parentNode.lineIdx < 0 || parentNode.lineIdx >= lines.length) {
    const trimmedEnd = String(markdown ?? '').trimEnd();
    const sep = trimmedEnd ? '\n\n' : '';
    return `${trimmedEnd}${sep}## ${cleanChild}\n`;
  }

  const parentLine = lines[parentNode.lineIdx];
  let newLine = `- ${cleanChild}`;
  if (parentNode.kind === 'bullet') {
    const indentMatch = parentLine.match(/^(\s*)/);
    const baseIndent = indentMatch ? indentMatch[1] : '';
    newLine = `${baseIndent}  - ${cleanChild}`;
  }

  // Insert right after parent's last descendant line if available
  const findLastDescendantLine = (node) => {
    let maxIdx = node.lineIdx;
    for (const ch of node.children || []) {
      maxIdx = Math.max(maxIdx, findLastDescendantLine(ch));
    }
    return maxIdx;
  };
  const insertAfter = findLastDescendantLine(parentNode);
  lines.splice(insertAfter + 1, 0, newLine);
  return lines.join('\n');
}

function buildExportSvgString(layout) {
  const strokeColor = '#8E8E93';
  const statusBorder = {
    none: 'rgba(0, 0, 0, 0.12)',
    mastered: '#34C759',
    review: '#FF9500',
    weak: '#FF3B30',
  };
  const statusFill = {
    none: '#FFFFFF',
    mastered: '#F0FBF3',
    review: '#FFF8EE',
    weak: '#FFF2F1',
  };

  const pathsSvg = layout.edges
    .map(({ from, to }) => {
      const x1 = from.x + from.w;
      const y1 = from.y + from.h / 2;
      const x2 = to.x;
      const y2 = to.y + to.h / 2;
      const dx = Math.max(24, (x2 - x1) * 0.52);
      const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
      return `<path d="${d}" fill="none" stroke="${strokeColor}" stroke-opacity="0.45" stroke-width="2" stroke-linecap="round"/>`;
    })
    .join('');

  const nodesSvg = layout.nodes
    .map((n) => {
      const isRoot = n.level === 0;
      const fill = isRoot ? '#007AFF' : (statusFill[n.data.status] || '#FFFFFF');
      const stroke = isRoot ? '#007AFF' : (statusBorder[n.data.status] || 'rgba(0,0,0,0.12)');
      const textFill = isRoot ? '#FFFFFF' : '#1D1D1F';
      const label = n.data.text.replace(/\[\[(?:app:|url:)?([^[\]|]+?)(?:\|[^[\]]+)?\]\]/g, '$1');
      const badge = STATUS_BADGE_MAP[n.data.status] ? ` ${STATUS_BADGE_MAP[n.data.status]}` : '';
      return `
        <g>
          <rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${Math.round(n.h / 2)}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>
          <text x="${n.x + n.w / 2}" y="${n.y + n.h / 2 + 4}" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, PingFang SC, Microsoft YaHei, sans-serif" font-size="${isRoot ? 13.5 : 12.5}" font-weight="${isRoot ? 600 : 500}" fill="${textFill}">${escapeHtml(label + badge)}</text>
        </g>
      `;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">
  <rect width="100%" height="100%" fill="#F5F5F7"/>
  ${pathsSvg}
  ${nodesSvg}
</svg>`;
}

function triggerFileDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/**
 * Render an interactive pure native SVG + HTML overlay Mind Map inside containerEl.
 * @param {HTMLElement} containerEl
 * @param {{
 *   markdown: string,
 *   docName?: string,
 *   onUpdateMarkdown?: (nextMd: string) => void,
 *   onAnchorClick?: (anchorPayload: object) => void,
 *   onFocusNode?: (title: string, seconds: number) => void,
 *   onAiGenerate?: () => void,
 * }} opts
 */
export function renderMindMap(containerEl, opts = {}) {
  if (!containerEl) return null;

  const docName = String(opts.docName || '笔记脑图');
  let currentMarkdown = String(opts.markdown ?? '');
  const collapsedIds = new Set();

  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let currentLayout = null;
  let nodeMenuEl = null;

  const baseTitle = docName.replace(/\.[^.]+$/, '') || 'mindmap';

  containerEl.innerHTML = `
    <div class="mindmap-shell">
      <div class="mindmap-toolbar">
        <div class="mindmap-toolbar-group">
          <button type="button" class="pill-btn pill-btn-sm" data-mm-act="zoom-out" title="缩小">－</button>
          <span class="mindmap-zoom-label" data-mm-role="zoom-label">100%</span>
          <button type="button" class="pill-btn pill-btn-sm" data-mm-act="zoom-in" title="放大">＋</button>
          <button type="button" class="pill-btn pill-btn-sm" data-mm-act="center" title="居中重置视图">⌖ 居中</button>
        </div>
        <div class="mindmap-toolbar-group">
          <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-mm-act="ai-generate">
            ${icon('sparkles', 13)} AI 提炼脑图
          </button>
          <button type="button" class="pill-btn pill-btn-sm" data-mm-act="export-svg">导出 SVG</button>
          <button type="button" class="pill-btn pill-btn-sm" data-mm-act="export-png">导出 PNG</button>
        </div>
      </div>
      <div class="mindmap-stage" id="mindmap-canvas">
        <div class="mindmap-viewport" data-mm-role="viewport">
          <svg class="mindmap-svg" data-mm-role="svg"></svg>
          <div class="mindmap-nodes-layer" data-mm-role="nodes"></div>
        </div>
        <div class="mindmap-hint-pill">滚轮缩放 · 拖动画布 · 双击节点改名 · 右键 / ⋯ 打开攻克菜单</div>
      </div>
    </div>
  `;

  const stageEl = containerEl.querySelector('.mindmap-stage');
  const viewportEl = containerEl.querySelector('[data-mm-role="viewport"]');
  const svgEl = containerEl.querySelector('[data-mm-role="svg"]');
  const nodesLayer = containerEl.querySelector('[data-mm-role="nodes"]');
  const zoomLabelEl = containerEl.querySelector('[data-mm-role="zoom-label"]');

  function closeNodeMenu() {
    if (nodeMenuEl) {
      nodeMenuEl.remove();
      nodeMenuEl = null;
    }
  }

  function applyTransform() {
    if (viewportEl) {
      viewportEl.style.transform = `translate3d(${panX}px, ${panY}px, 0) scale(${zoom})`;
    }
    if (zoomLabelEl) {
      zoomLabelEl.textContent = `${Math.round(zoom * 100)}%`;
    }
  }

  function fitCenter() {
    if (!stageEl || !currentLayout) return;
    const rect = stageEl.getBoundingClientRect();
    const sw = Math.max(320, rect.width || 640);
    const sh = Math.max(240, rect.height || 420);
    const fitZoom = Math.min(1.05, Math.max(0.45, Math.min((sw - 40) / currentLayout.width, (sh - 40) / currentLayout.height)));
    zoom = Number(fitZoom.toFixed(2));
    panX = Math.max(16, Math.round((sw - currentLayout.width * zoom) / 2));
    panY = Math.max(16, Math.round((sh - currentLayout.height * zoom) / 2));
    applyTransform();
  }

  function findNodeById(id) {
    return currentLayout?.nodes?.find((n) => n.data.id === id)?.data || null;
  }

  function openNodeContextMenu(nodeData, clientX, clientY) {
    closeNodeMenu();
    const menu = document.createElement('div');
    menu.className = 'context-menu mindmap-node-menu is-open';
    menu.setAttribute('role', 'menu');

    const statusItem = (st, label) => `
      <button type="button" class="context-menu-item ${nodeData.status === st ? 'is-active' : ''}" data-mm-menu="status:${st}">
        <span>${label}</span>
        ${nodeData.status === st ? '<span>✓</span>' : ''}
      </button>
    `;

    menu.innerHTML = `
      <div class="context-menu-label">${escapeHtml(nodeData.text.slice(0, 26))}</div>
      ${statusItem('mastered', STATUS_LABEL_MAP.mastered)}
      ${statusItem('review', STATUS_LABEL_MAP.review)}
      ${statusItem('weak', STATUS_LABEL_MAP.weak)}
      ${nodeData.status !== 'none' ? `<button type="button" class="context-menu-item" data-mm-menu="status:none"><span>清除掌握标记</span></button>` : ''}
      <div class="context-menu-sep"></div>
      <button type="button" class="context-menu-item" data-mm-menu="focus-25m"><span>▶ 专注攻克 (25分钟)</span></button>
      <button type="button" class="context-menu-item" data-mm-menu="focus-15s"><span>⚡ 专注演示 (15秒)</span></button>
      <div class="context-menu-sep"></div>
      <button type="button" class="context-menu-item" data-mm-menu="add-child"><span>+ 添加子节点</span></button>
      ${nodeData.lineIdx >= 0 ? `<button type="button" class="context-menu-item" data-mm-menu="rename"><span>✎ 重命名节点</span></button>` : ''}
    `;

    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(clientX, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(clientY, window.innerHeight - rect.height - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    menu.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-mm-menu]');
      if (!btn) return;
      const act = btn.dataset.mmMenu;
      closeNodeMenu();

      if (act.startsWith('status:')) {
        const nextStatus = act.slice(7);
        if (nodeData.lineIdx < 0) {
          showToast('虚拟根节点无对应行，请在 Markdown 标题上标记', 'info');
          return;
        }
        currentMarkdown = applyLineTextUpdate(currentMarkdown, nodeData.lineIdx, nodeData.text, nextStatus);
        opts.onUpdateMarkdown?.(currentMarkdown);
        renderTree();
        return;
      }

      if (act === 'focus-25m') {
        if (typeof opts.onFocusNode === 'function') {
          opts.onFocusNode(nodeData.text, 1500);
        } else {
          store.emit('focus:start', { title: nodeData.text, seconds: 1500 });
        }
        return;
      }

      if (act === 'focus-15s') {
        if (typeof opts.onFocusNode === 'function') {
          opts.onFocusNode(nodeData.text, 15);
        } else {
          store.emit('focus:start', { title: nodeData.text, seconds: 15 });
        }
        return;
      }

      if (act === 'add-child') {
        currentMarkdown = appendChildBulletToMarkdown(currentMarkdown, nodeData, '新子节点');
        collapsedIds.delete(nodeData.id);
        opts.onUpdateMarkdown?.(currentMarkdown);
        renderTree();
        return;
      }

      if (act === 'rename') {
        const nodeEl = nodesLayer?.querySelector(`.mindmap-node[data-node-id="${CSS.escape(nodeData.id)}"]`);
        if (nodeEl) startInlineRename(nodeEl, nodeData);
      }
    });

    nodeMenuEl = menu;
  }

  function startInlineRename(nodeEl, nodeData) {
    if (nodeData.lineIdx < 0) {
      showToast('根节点名称来自文件名，请添加 # 一级标题后编辑', 'info');
      return;
    }
    if (nodeEl.classList.contains('is-editing')) return;
    nodeEl.classList.add('is-editing');

    const textWrap = nodeEl.querySelector('.mindmap-node-label');
    if (!textWrap) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'mindmap-inline-input';
    input.value = nodeData.text;
    textWrap.replaceChildren(input);
    input.focus();
    input.select();

    let committed = false;
    const commit = (cancel = false) => {
      if (committed) return;
      committed = true;
      nodeEl.classList.remove('is-editing');
      if (!cancel) {
        const nextText = input.value.trim();
        if (nextText && nextText !== nodeData.text) {
          currentMarkdown = applyLineTextUpdate(currentMarkdown, nodeData.lineIdx, nextText, nodeData.status);
          opts.onUpdateMarkdown?.(currentMarkdown);
        }
      }
      renderTree();
    };

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        commit(false);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        commit(true);
      }
    });
    input.addEventListener('blur', () => commit(false));
  }

  function renderTree(shouldCenter = false) {
    closeNodeMenu();
    const treeRoot = parseMarkdownToTree(currentMarkdown, docName);
    currentLayout = computeTreeLayout(treeRoot, collapsedIds);

    if (svgEl) {
      svgEl.setAttribute('width', String(currentLayout.width));
      svgEl.setAttribute('height', String(currentLayout.height));
      svgEl.setAttribute('viewBox', `0 0 ${currentLayout.width} ${currentLayout.height}`);
      svgEl.innerHTML = currentLayout.edges
        .map(({ from, to }) => {
          const x1 = from.x + from.w;
          const y1 = from.y + from.h / 2;
          const x2 = to.x;
          const y2 = to.y + to.h / 2;
          const dx = Math.max(24, (x2 - x1) * 0.52);
          const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
          return `<path class="mindmap-edge" d="${d}" />`;
        })
        .join('');
    }

    if (nodesLayer) {
      nodesLayer.style.width = `${currentLayout.width}px`;
      nodesLayer.style.height = `${currentLayout.height}px`;
      nodesLayer.innerHTML = '';

      for (const n of currentLayout.nodes) {
        const nodeData = n.data;
        const isRoot = n.level === 0;
        const hasChildren = (nodeData.children?.length || 0) > 0;
        const isCollapsed = collapsedIds.has(nodeData.id);
        const statusCls = nodeData.status !== 'none' ? `status-${nodeData.status}` : '';

        const el = document.createElement('div');
        el.className = `mindmap-node ${isRoot ? 'is-root' : ''} ${statusCls}`.trim();
        el.dataset.nodeId = nodeData.id;
        el.style.left = `${n.x}px`;
        el.style.top = `${n.y}px`;
        el.style.width = `${n.w}px`;
        el.style.minHeight = `${n.h}px`;

        // Render inline Markdown/portal pills cleanly inside node label without block <p> wrappers
        const renderedHtml = renderMarkdownSafe(nodeData.text || '节点')
          .replace(/^<p>([\s\S]*)<\/p>\n?$/i, '$1');

        const statusDot =
          nodeData.status === 'mastered'
            ? '<span class="mm-status-badge" title="已掌握">🟢</span>'
            : nodeData.status === 'review'
            ? '<span class="mm-status-badge" title="待巩固">🟡</span>'
            : nodeData.status === 'weak'
            ? '<span class="mm-status-badge" title="易错薄弱">🔴</span>'
            : '';

        const foldBadge = hasChildren
          ? `<button type="button" class="mindmap-fold-btn" data-mm-fold="${escapeHtml(nodeData.id)}" title="${isCollapsed ? '展开分支' : '折叠分支'}">${isCollapsed ? `+${n.hiddenCount}` : '−'}</button>`
          : '';

        el.innerHTML = `
          ${statusDot}
          <span class="mindmap-node-label">${renderedHtml}</span>
          <button type="button" class="mindmap-node-more" data-mm-more="${escapeHtml(nodeData.id)}" title="学习状态与专注操作">⋯</button>
          ${foldBadge}
        `;

        nodesLayer.appendChild(el);
      }
    }

    if (shouldCenter) {
      fitCenter();
    } else {
      applyTransform();
    }
  }

  // Toolbar click handlers
  containerEl.querySelector('.mindmap-toolbar')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mm-act]');
    if (!btn) return;
    const act = btn.dataset.mmAct;
    if (act === 'zoom-in') {
      zoom = Math.min(2.2, Number((zoom + 0.15).toFixed(2)));
      applyTransform();
    } else if (act === 'zoom-out') {
      zoom = Math.max(0.35, Number((zoom - 0.15).toFixed(2)));
      applyTransform();
    } else if (act === 'center') {
      fitCenter();
    } else if (act === 'ai-generate') {
      opts.onAiGenerate?.();
    } else if (act === 'export-svg') {
      if (!currentLayout) return;
      const svgText = buildExportSvgString(currentLayout);
      triggerFileDownload(new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' }), `${baseTitle}_mindmap.svg`);
      showToast('已导出 SVG 矢量脑图', 'success');
    } else if (act === 'export-png') {
      if (!currentLayout) return;
      const svgText = buildExportSvgString(currentLayout);
      const svgBlob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(svgBlob);
      const img = new Image();
      img.onload = () => {
        const scale = 2; // HiDPI 2x
        const canvas = document.createElement('canvas');
        canvas.width = currentLayout.width * scale;
        canvas.height = currentLayout.height * scale;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.scale(scale, scale);
          ctx.drawImage(img, 0, 0);
          canvas.toBlob((pngBlob) => {
            URL.revokeObjectURL(url);
            if (pngBlob) {
              triggerFileDownload(pngBlob, `${baseTitle}_mindmap.png`);
              showToast('已导出高清 PNG 脑图', 'success');
            }
          }, 'image/png');
        } else {
          URL.revokeObjectURL(url);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        showToast('导出 PNG 失败', 'error');
      };
      img.src = url;
    }
  });

  // Stage interactions: pan, wheel zoom, portal pill click, fold, more, dblclick, right-click
  if (stageEl) {
    let panning = false;
    let panStartX = 0;
    let panStartY = 0;
    let origPanX = 0;
    let origPanY = 0;

    stageEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.mindmap-node, button, input')) return;
      closeNodeMenu();
      panning = true;
      panStartX = e.clientX;
      panStartY = e.clientY;
      origPanX = panX;
      origPanY = panY;
      stageEl.classList.add('is-panning');
      try {
        stageEl.setPointerCapture?.(e.pointerId);
      } catch {
        // ignore
      }
    });

    stageEl.addEventListener('pointermove', (e) => {
      if (!panning) return;
      panX = Math.round(origPanX + (e.clientX - panStartX));
      panY = Math.round(origPanY + (e.clientY - panStartY));
      applyTransform();
    });

    const endPan = (e) => {
      if (!panning) return;
      panning = false;
      stageEl.classList.remove('is-panning');
      if (e?.pointerId != null) {
        try {
          stageEl.releasePointerCapture?.(e.pointerId);
        } catch {
          // ignore
        }
      }
    };

    stageEl.addEventListener('pointerup', endPan);
    stageEl.addEventListener('pointercancel', endPan);

    stageEl.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 0.08 : -0.08;
        zoom = Math.min(2.2, Math.max(0.35, Number((zoom + delta).toFixed(2))));
        applyTransform();
      },
      { passive: false }
    );

    stageEl.addEventListener('click', (e) => {
      // 1. Anchor portal pill inside node
      const pill = e.target.closest('.anchor-pill');
      if (pill) {
        e.stopPropagation();
        const payload = {
          type: pill.dataset.anchorType || 'file',
          file: pill.dataset.anchorFile || '',
          page: pill.dataset.anchorPage || '',
          sheet: pill.dataset.anchorSheet || '',
          cell: pill.dataset.anchorCell || '',
          app: pill.dataset.anchorApp || '',
          url: pill.dataset.anchorUrl || '',
          member: pill.dataset.anchorMember || '',
          time: pill.dataset.anchorTime || '',
          heading: pill.dataset.anchorHeading || '',
        };
        if (typeof opts.onAnchorClick === 'function') {
          opts.onAnchorClick(payload);
        } else {
          store.emit('anchor:jump', payload);
        }
        return;
      }

      // 2. Collapse/expand branch button
      const foldBtn = e.target.closest('[data-mm-fold]');
      if (foldBtn) {
        e.stopPropagation();
        const id = foldBtn.dataset.mmFold;
        if (collapsedIds.has(id)) collapsedIds.delete(id);
        else collapsedIds.add(id);
        renderTree(false);
        return;
      }

      // 3. Hover quick menu trigger
      const moreBtn = e.target.closest('[data-mm-more]');
      if (moreBtn) {
        e.stopPropagation();
        const nodeData = findNodeById(moreBtn.dataset.mmMore);
        if (nodeData) {
          const rect = moreBtn.getBoundingClientRect();
          openNodeContextMenu(nodeData, rect.right + 4, rect.bottom + 4);
        }
      }
    });

    stageEl.addEventListener('dblclick', (e) => {
      const nodeEl = e.target.closest('.mindmap-node');
      if (!nodeEl || e.target.closest('.anchor-pill, button, input')) return;
      const nodeData = findNodeById(nodeEl.dataset.nodeId);
      if (nodeData) {
        startInlineRename(nodeEl, nodeData);
      }
    });

    stageEl.addEventListener('contextmenu', (e) => {
      const nodeEl = e.target.closest('.mindmap-node');
      e.preventDefault();
      e.stopPropagation();
      if (nodeEl) {
        const nodeData = findNodeById(nodeEl.dataset.nodeId);
        if (nodeData) {
          openNodeContextMenu(nodeData, e.clientX, e.clientY);
        }
      } else {
        closeNodeMenu();
      }
    });
  }

  const dismissDocHandler = (e) => {
    if (!containerEl.isConnected) {
      document.removeEventListener('pointerdown', dismissDocHandler);
      closeNodeMenu();
      return;
    }
    if (nodeMenuEl && !e.target.closest('.mindmap-node-menu')) {
      closeNodeMenu();
    }
  };
  document.addEventListener('pointerdown', dismissDocHandler);

  renderTree(true);

  return {
    update(nextMd) {
      currentMarkdown = String(nextMd ?? '');
      renderTree(false);
    },
    fitCenter,
    destroy: closeNodeMenu,
  };
}
