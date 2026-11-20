/**
 * SmartLocalNote - Pure Native SVG Interactive Mind Map & Knowledge Structuring Templates (V7)
 * Capabilities:
 *  - 5 Mature Knowledge Templates:
 *      1. logic    (向右逻辑图 · XMind 经典逻辑树)
 *      2. radial   (中心发散图 · XMind 双向平衡脑图)
 *      3. org      (组织架构图 · 自上而下金字塔树)
 *      4. fishbone (鱼骨因果图 · 石川图/主干脉络图)
 *      5. cards    (知识卡片墙 · Heptabase/MarginNote 看板卡片)
 *  - Pointer-Anchored Zoom: Mouse wheel & zoom controls scale smoothly around the exact cursor position
 *  - Parses Markdown headings (#..####) & indented bullets (-, *, 1.) into a balanced hierarchical tree
 *  - Detects & syncs mastery status badges ([🟢], [🟡], [🔴]) cleanly back into Markdown
 *  - Interactive HTML pill node layer (clickable [[...]] portals & inline dblclick rename)
 *  - Toolbar: Template Switcher, Zoom [- / 100% / +], Fit Center, AI Distill Mindmap, Export SVG, Export HiDPI PNG
 */

import { store, escapeHtml, renderMarkdownSafe, showToast } from './store.js';
import { api } from './api_client.js';
import { icon } from './icons.js';

const TEMPLATE_STORAGE_KEY = 'sln_mindmap_template_v1';
const CARDS_STACK_STORAGE_KEY = 'sln_mindmap_cards_stack_v1';
const CARD_POSITIONS_STORAGE_KEY = 'sln_mindmap_card_pos_v1';
const OUTLINE_OPEN_STORAGE_KEY = 'sln_mindmap_outline_open_v1';
const OUTLINE_WIDTH_STORAGE_KEY = 'sln_mindmap_outline_w_v1';
const CUSTOM_COLORS_STORAGE_KEY = 'sln_mindmap_custom_colors_v1';
const GROUPS_STORAGE_KEY = 'sln_mindmap_groups_v1';
const OUTLINE_DEFAULT_WIDTH = 228;
const OUTLINE_MIN_WIDTH = 160;
const OUTLINE_MAX_WIDTH = 420;
const CARD_W = 312;
const CARD_COL_GAP = 26;
const CARD_ROW_GAP = 24;
const CARD_ACCENTS = ['#007AFF', '#34C759', '#FF9500', '#AF52DE', '#FF2D55', '#5856D6', '#00C7BE'];

const CUSTOM_COLOR_PALETTE = [
  { id: 'default', label: '默认跟随', hex: '' },
  { id: 'indigo', label: '靛蓝', hex: '#4F46E5' },
  { id: 'emerald', label: '翡翠绿', hex: '#16A34A' },
  { id: 'amber', label: '琥珀橙', hex: '#D97706' },
  { id: 'ruby', label: '宝石红', hex: '#DC2626' },
  { id: 'purple', label: '星云紫', hex: '#9333EA' },
  { id: 'teal', label: '青碧', hex: '#0D9488' },
];
const GROUP_COLOR_PALETTE = CUSTOM_COLOR_PALETTE.filter((c) => Boolean(c.hex));

const TEMPLATE_LIST = [
  { id: 'logic', label: '逻辑图', title: '向右逻辑树（经典层层拆解）' },
  { id: 'radial', label: '发散脑图', title: '中心双向发散脑图（XMind 风格）' },
  { id: 'org', label: '架构树', title: '自上而下组织架构图（章节/系统拓扑）' },
  { id: 'timeline', label: '时间轴', title: '横向演进时间轴（XMind 里程碑 / 学习路线）' },
  { id: 'fishbone', label: '鱼骨因果', title: '鱼骨因果脉络图（根因分析/演进主干）' },
  { id: 'cards', label: '卡片看板', title: '白板知识卡片墙（Heptabase / MarginNote 风格）' },
];

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

function measureNodeBox(node, isRootOverride = false) {
  const display = node.text || '节点';
  const cleanVisible = display
    .replace(/\[\[(?:app:|url:)?([^[\]|]+?)(?:\|[^[\]]+)?\]\]/g, '$1')
    .trim();
  const isRoot = isRootOverride || (node.depth <= 1 && node.kind !== 'bullet');
  let weightedLen = 0;
  for (const ch of cleanVisible) {
    weightedLen += ch.charCodeAt(0) > 255 ? 13.5 : 7.6;
  }
  const minW = isRoot ? 122 : 90;
  const maxW = 280;
  const padX = 36;
  const w = Math.min(maxW, Math.max(minW, Math.round(weightedLen + padX)));
  const linesEst = Math.max(1, Math.ceil((weightedLen + padX) / maxW));
  const h = linesEst > 1 ? Math.min(84, 24 + linesEst * 18) : (isRoot ? 42 : 34);
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

// ---------------------------------------------------------------------------
// 1. Classic Rightward Logic Tree Layout
// ---------------------------------------------------------------------------
function computeLogicLayout(root, collapsedIds) {
  const V_GAP = 16;
  const H_GAP = 54;
  const PADDING_X = 52;
  const PADDING_Y = 48;

  const nodesList = [];
  const edgesList = [];

  function measureSubtree(node, level) {
    const box = measureNodeBox(node, level === 0);
    const isCollapsed = collapsedIds.has(node.id);
    const children = isCollapsed ? [] : (node.children || []);
    const hiddenCount = isCollapsed ? countSubtreeNodes(node) : 0;

    const layoutNode = {
      data: node,
      level,
      dir: 'right',
      w: box.w,
      h: box.h,
      x: 0,
      y: 0,
      subtreeH: box.h,
      hiddenCount,
      children: [],
    };

    if (children.length === 0) return layoutNode;

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
      edgesList.push({ from: layoutNode, to: child, dir: 'right' });
    }
  }

  const layoutRoot = measureSubtree(root, 0);
  assignCoords(layoutRoot, PADDING_X, PADDING_Y);

  let maxRight = 360;
  let maxBottom = 260;
  for (const n of nodesList) {
    maxRight = Math.max(maxRight, n.x + n.w + PADDING_X + 32);
    maxBottom = Math.max(maxBottom, n.y + n.h + PADDING_Y);
  }

  return {
    template: 'logic',
    root: layoutRoot,
    nodes: nodesList,
    edges: edgesList,
    spines: [],
    cards: [],
    width: Math.ceil(maxRight),
    height: Math.ceil(maxBottom),
  };
}

// ---------------------------------------------------------------------------
// 2. Radial Centered Mind Map Layout (Left & Right balanced branches)
// ---------------------------------------------------------------------------
function computeRadialLayout(root, collapsedIds) {
  const V_GAP = 16;
  const H_GAP = 56;
  const PADDING_X = 64;
  const PADDING_Y = 52;

  const nodesList = [];
  const edgesList = [];

  function measureSubtree(node, level, dir) {
    const box = measureNodeBox(node, level === 0);
    const isCollapsed = collapsedIds.has(node.id);
    const children = isCollapsed ? [] : (node.children || []);
    const hiddenCount = isCollapsed ? countSubtreeNodes(node) : 0;

    const layoutNode = {
      data: node,
      level,
      dir,
      w: box.w,
      h: box.h,
      x: 0,
      y: 0,
      subtreeH: box.h,
      subtreeW: box.w,
      hiddenCount,
      children: [],
    };

    if (children.length === 0) return layoutNode;

    let sumH = 0;
    let maxChildW = 0;
    for (let i = 0; i < children.length; i += 1) {
      const ch = measureSubtree(children[i], level + 1, dir);
      layoutNode.children.push(ch);
      sumH += ch.subtreeH;
      if (i > 0) sumH += V_GAP;
      maxChildW = Math.max(maxChildW, ch.subtreeW);
    }
    layoutNode.subtreeH = Math.max(box.h, sumH);
    layoutNode.subtreeW = box.w + H_GAP + maxChildW;
    return layoutNode;
  }

  const rootBox = measureNodeBox(root, true);
  const rootCollapsed = collapsedIds.has(root.id);
  const topChildren = rootCollapsed ? [] : (root.children || []);
  const rightBranches = [];
  const leftBranches = [];

  topChildren.forEach((ch, idx) => {
    if (idx % 2 === 0) {
      rightBranches.push(measureSubtree(ch, 1, 'right'));
    } else {
      leftBranches.push(measureSubtree(ch, 1, 'left'));
    }
  });

  const sumGroupH = (arr) =>
    arr.reduce((acc, c) => acc + c.subtreeH, 0) + Math.max(0, arr.length - 1) * V_GAP;
  const maxGroupW = (arr) => arr.reduce((acc, c) => Math.max(acc, c.subtreeW), 0);

  const rightH = sumGroupH(rightBranches);
  const leftH = sumGroupH(leftBranches);
  const leftMaxW = maxGroupW(leftBranches);
  const rightMaxW = maxGroupW(rightBranches);

  const totalH = Math.max(rootBox.h, rightH, leftH) + PADDING_Y * 2;
  const rootX = PADDING_X + (leftMaxW > 0 ? leftMaxW + H_GAP : 0);
  const rootY = (totalH - rootBox.h) / 2;

  const layoutRoot = {
    data: root,
    level: 0,
    dir: 'center',
    w: rootBox.w,
    h: rootBox.h,
    x: rootX,
    y: rootY,
    subtreeH: totalH,
    hiddenCount: rootCollapsed ? countSubtreeNodes(root) : 0,
    children: [...rightBranches, ...leftBranches],
  };
  nodesList.push(layoutRoot);

  function assignRight(node, startX, topY) {
    node.x = startX;
    if (node.children.length === 0) {
      node.y = topY + (node.subtreeH - node.h) / 2;
    } else {
      let curY = topY;
      const childrenH = sumGroupH(node.children);
      if (childrenH < node.subtreeH) curY += (node.subtreeH - childrenH) / 2;
      const nextX = startX + node.w + H_GAP;
      for (const ch of node.children) {
        assignRight(ch, nextX, curY);
        curY += ch.subtreeH + V_GAP;
      }
      const first = node.children[0];
      const last = node.children[node.children.length - 1];
      node.y = (first.y + first.h / 2 + (last.y + last.h / 2)) / 2 - node.h / 2;
    }
    nodesList.push(node);
    for (const ch of node.children) {
      edgesList.push({ from: node, to: ch, dir: 'right' });
    }
  }

  function assignLeft(node, rightEdgeX, topY) {
    node.x = rightEdgeX - node.w;
    if (node.children.length === 0) {
      node.y = topY + (node.subtreeH - node.h) / 2;
    } else {
      let curY = topY;
      const childrenH = sumGroupH(node.children);
      if (childrenH < node.subtreeH) curY += (node.subtreeH - childrenH) / 2;
      const nextRightEdgeX = node.x - H_GAP;
      for (const ch of node.children) {
        assignLeft(ch, nextRightEdgeX, curY);
        curY += ch.subtreeH + V_GAP;
      }
      const first = node.children[0];
      const last = node.children[node.children.length - 1];
      node.y = (first.y + first.h / 2 + (last.y + last.h / 2)) / 2 - node.h / 2;
    }
    nodesList.push(node);
    for (const ch of node.children) {
      edgesList.push({ from: node, to: ch, dir: 'left' });
    }
  }

  let curRightY = (totalH - rightH) / 2;
  for (const rb of rightBranches) {
    assignRight(rb, rootX + rootBox.w + H_GAP, curRightY);
    curRightY += rb.subtreeH + V_GAP;
    edgesList.push({ from: layoutRoot, to: rb, dir: 'right' });
  }

  let curLeftY = (totalH - leftH) / 2;
  for (const lb of leftBranches) {
    assignLeft(lb, rootX - H_GAP, curLeftY);
    curLeftY += lb.subtreeH + V_GAP;
    edgesList.push({ from: layoutRoot, to: lb, dir: 'left' });
  }

  const totalW = rootX + rootBox.w + (rightMaxW > 0 ? H_GAP + rightMaxW : 0) + PADDING_X;
  return {
    template: 'radial',
    root: layoutRoot,
    nodes: nodesList,
    edges: edgesList,
    spines: [],
    cards: [],
    width: Math.max(420, Math.ceil(totalW)),
    height: Math.max(280, Math.ceil(totalH)),
  };
}

// ---------------------------------------------------------------------------
// 3. Top-Down Org Chart Layout
// ---------------------------------------------------------------------------
function computeOrgLayout(root, collapsedIds) {
  const H_GAP = 22;
  const V_GAP = 56;
  const PADDING_X = 52;
  const PADDING_Y = 48;

  const nodesList = [];
  const edgesList = [];

  function measureSubtree(node, level) {
    const box = measureNodeBox(node, level === 0);
    const isCollapsed = collapsedIds.has(node.id);
    const children = isCollapsed ? [] : (node.children || []);
    const hiddenCount = isCollapsed ? countSubtreeNodes(node) : 0;

    const layoutNode = {
      data: node,
      level,
      dir: 'down',
      w: box.w,
      h: box.h,
      x: 0,
      y: 0,
      subtreeW: box.w,
      hiddenCount,
      children: [],
    };

    if (children.length === 0) return layoutNode;

    let sumW = 0;
    for (let i = 0; i < children.length; i += 1) {
      const ch = measureSubtree(children[i], level + 1);
      layoutNode.children.push(ch);
      sumW += ch.subtreeW;
      if (i > 0) sumW += H_GAP;
    }
    layoutNode.subtreeW = Math.max(box.w, sumW);
    return layoutNode;
  }

  function assignCoords(layoutNode, leftX, startY) {
    layoutNode.y = startY;
    if (layoutNode.children.length === 0) {
      layoutNode.x = leftX + (layoutNode.subtreeW - layoutNode.w) / 2;
    } else {
      let curX = leftX;
      const childrenTotalW =
        layoutNode.children.reduce((acc, c) => acc + c.subtreeW, 0) +
        Math.max(0, layoutNode.children.length - 1) * H_GAP;
      if (childrenTotalW < layoutNode.subtreeW) {
        curX += (layoutNode.subtreeW - childrenTotalW) / 2;
      }

      const childY = startY + layoutNode.h + V_GAP;
      for (const ch of layoutNode.children) {
        assignCoords(ch, curX, childY);
        curX += ch.subtreeW + H_GAP;
      }

      const first = layoutNode.children[0];
      const last = layoutNode.children[layoutNode.children.length - 1];
      const midX = (first.x + first.w / 2 + (last.x + last.w / 2)) / 2;
      layoutNode.x = midX - layoutNode.w / 2;
    }

    nodesList.push(layoutNode);
    for (const ch of layoutNode.children) {
      edgesList.push({ from: layoutNode, to: ch, dir: 'down' });
    }
  }

  const layoutRoot = measureSubtree(root, 0);
  assignCoords(layoutRoot, PADDING_X, PADDING_Y);

  let maxRight = 400;
  let maxBottom = 280;
  for (const n of nodesList) {
    maxRight = Math.max(maxRight, n.x + n.w + PADDING_X);
    maxBottom = Math.max(maxBottom, n.y + n.h + PADDING_Y + 24);
  }

  return {
    template: 'org',
    root: layoutRoot,
    nodes: nodesList,
    edges: edgesList,
    spines: [],
    cards: [],
    width: Math.ceil(maxRight),
    height: Math.ceil(maxBottom),
  };
}

// ---------------------------------------------------------------------------
// 4. Fishbone (Ishikawa Causal / Timeline Backbone) Layout
// ---------------------------------------------------------------------------
function computeFishboneLayout(root, collapsedIds) {
  const PADDING_X = 60;
  const PADDING_Y = 56;
  const nodesList = [];
  const edgesList = [];
  const spines = [];

  const rootBox = measureNodeBox(root, true);
  const rootCollapsed = collapsedIds.has(root.id);
  const topBranches = rootCollapsed ? [] : (root.children || []);

  // Build each bone group (level 1 node + flattened or hierarchical sub-ribs)
  const boneGroups = topBranches.map((branch, idx) => {
    const isTop = idx % 2 === 0;
    const bBox = measureNodeBox(branch, false);
    const bCollapsed = collapsedIds.has(branch.id);
    const subItems = [];

    function collectSub(n, depthOffset) {
      if (collapsedIds.has(n.id)) return;
      for (const ch of n.children || []) {
        const box = measureNodeBox(ch, false);
        subItems.push({
          data: ch,
          level: depthOffset,
          w: box.w,
          h: box.h,
          hiddenCount: collapsedIds.has(ch.id) ? countSubtreeNodes(ch) : 0,
        });
        collectSub(ch, depthOffset + 1);
      }
    }
    collectSub(branch, 2);

    const maxSubW = subItems.reduce((acc, s) => Math.max(acc, s.w + (s.level - 2) * 20), 0);
    const groupW = Math.max(bBox.w + 40, maxSubW + 70, 210);
    const groupH = 54 + bBox.h + subItems.length * 44;
    return {
      branch,
      isTop,
      bBox,
      bHiddenCount: bCollapsed ? countSubtreeNodes(branch) : 0,
      subItems,
      groupW,
      groupH,
    };
  });

  const topMaxH = boneGroups.filter((g) => g.isTop).reduce((acc, g) => Math.max(acc, g.groupH), 140);
  const botMaxH = boneGroups.filter((g) => !g.isTop).reduce((acc, g) => Math.max(acc, g.groupH), 140);
  const spineY = PADDING_Y + topMaxH + 24;

  // Pair top & bottom bones into columns along the horizontal spine
  const colCount = Math.max(1, Math.ceil(boneGroups.length / 2));
  let curSpineX = PADDING_X + rootBox.w + 70;

  const layoutRoot = {
    data: root,
    level: 0,
    dir: 'center',
    w: rootBox.w,
    h: rootBox.h,
    x: PADDING_X,
    y: spineY - rootBox.h / 2,
    hiddenCount: rootCollapsed ? countSubtreeNodes(root) : 0,
    children: [],
  };
  nodesList.push(layoutRoot);

  for (let col = 0; col < colCount; col += 1) {
    const topG = boneGroups[col * 2];
    const botG = boneGroups[col * 2 + 1];
    const colW = Math.max(topG?.groupW || 180, botG?.groupW || 180);

    for (const g of [topG, botG]) {
      if (!g) continue;
      const sign = g.isTop ? -1 : 1;
      const anchorX = curSpineX + 24;
      const totalRibDrop = 44 + g.subItems.length * 42;
      const tipX = anchorX + 46;
      const tipY = spineY + sign * totalRibDrop;

      // Diagonal rib line from main spine to category bone head
      spines.push({
        x1: anchorX,
        y1: spineY,
        x2: tipX,
        y2: tipY,
        kind: 'rib',
      });

      const bLayout = {
        data: g.branch,
        level: 1,
        dir: g.isTop ? 'fish-up' : 'fish-down',
        w: g.bBox.w,
        h: g.bBox.h,
        x: Math.round(tipX - g.bBox.w / 2),
        y: g.isTop ? Math.round(tipY - g.bBox.h) : Math.round(tipY),
        hiddenCount: g.bHiddenCount,
        children: [],
      };
      nodesList.push(bLayout);

      g.subItems.forEach((sub, sIdx) => {
        const frac = (sIdx + 1) / (g.subItems.length + 1);
        const ribX = Math.round(anchorX + (tipX - anchorX) * frac);
        const ribY = Math.round(spineY + (tipY - spineY) * frac);
        const subX = ribX + 22 + (sub.level - 2) * 16;
        const subY = Math.round(ribY - sub.h / 2);

        spines.push({
          x1: ribX,
          y1: ribY,
          x2: subX,
          y2: ribY,
          kind: 'sub-rib',
        });

        nodesList.push({
          data: sub.data,
          level: sub.level,
          dir: 'right',
          w: sub.w,
          h: sub.h,
          x: subX,
          y: subY,
          hiddenCount: sub.hiddenCount,
          children: [],
        });
      });
    }

    curSpineX += colW + 46;
  }

  const tailX = Math.max(PADDING_X + rootBox.w + 160, curSpineX + 20);
  spines.unshift({
    x1: PADDING_X + rootBox.w,
    y1: spineY,
    x2: tailX,
    y2: spineY,
    kind: 'main-spine',
  });

  const totalW = tailX + PADDING_X + 60;
  const totalH = spineY + botMaxH + PADDING_Y + 30;
  return {
    template: 'fishbone',
    root: layoutRoot,
    nodes: nodesList,
    edges: edgesList,
    spines,
    cards: [],
    width: Math.ceil(totalW),
    height: Math.ceil(totalH),
  };
}

// ---------------------------------------------------------------------------
// 5. Knowledge Card Board (Heptabase / MarginNote Card Wall) Layout
// ---------------------------------------------------------------------------
function computeCardsLayout(root, collapsedIds) {
  const PADDING_X = 48;
  const PADDING_Y = 42;
  const nodesList = [];
  const edgesList = [];
  const cards = [];

  const rootBox = measureNodeBox(root, true);
  const rootCollapsed = collapsedIds.has(root.id);
  const topBranches = rootCollapsed ? [] : (root.children || []);

  const cols = topBranches.length <= 1 ? 1 : Math.min(3, Math.max(2, topBranches.length));
  const boardInnerW = cols * CARD_W + Math.max(0, cols - 1) * CARD_COL_GAP;

  const layoutRoot = {
    data: root,
    level: 0,
    dir: 'center',
    w: Math.max(rootBox.w, 180),
    h: rootBox.h,
    x: PADDING_X + Math.max(0, Math.round((boardInnerW - Math.max(rootBox.w, 180)) / 2)),
    y: PADDING_Y,
    hiddenCount: rootCollapsed ? countSubtreeNodes(root) : 0,
    children: [],
  };
  nodesList.push(layoutRoot);

  const colHeights = new Array(cols).fill(PADDING_Y + rootBox.h + 44);

  topBranches.forEach((branch) => {
    let colIdx = 0;
    for (let c = 1; c < cols; c += 1) {
      if (colHeights[c] < colHeights[colIdx]) colIdx = c;
    }
    const cardX = PADDING_X + colIdx * (CARD_W + CARD_COL_GAP);
    const cardY = colHeights[colIdx];

    const bBox = measureNodeBox(branch, false);
    const bCollapsed = collapsedIds.has(branch.id);
    const headerNode = {
      data: branch,
      level: 1,
      dir: 'card',
      w: CARD_W - 24,
      h: bBox.h,
      x: cardX + 12,
      y: cardY + 12,
      hiddenCount: bCollapsed ? countSubtreeNodes(branch) : 0,
      children: [],
    };
    nodesList.push(headerNode);

    let curItemY = cardY + 12 + bBox.h + 12;

    function placeCardDescendants(parentNode, depthOffset) {
      if (collapsedIds.has(parentNode.id)) return;
      for (const ch of parentNode.children || []) {
        const box = measureNodeBox(ch, false);
        const indent = Math.min(48, (depthOffset - 2) * 16);
        const itemNode = {
          data: ch,
          level: depthOffset,
          dir: 'card',
          w: CARD_W - 24 - indent,
          h: box.h,
          x: cardX + 12 + indent,
          y: curItemY,
          hiddenCount: collapsedIds.has(ch.id) ? countSubtreeNodes(ch) : 0,
          children: [],
        };
        nodesList.push(itemNode);
        curItemY += box.h + 6;
        placeCardDescendants(ch, depthOffset + 1);
      }
    }
    placeCardDescendants(branch, 2);

    const cardH = Math.max(82, curItemY - cardY + 12);
    cards.push({
      x: cardX,
      y: cardY,
      w: CARD_W,
      h: cardH,
      title: branch.text,
    });

    edgesList.push({
      from: layoutRoot,
      to: { x: cardX, y: cardY, w: CARD_W, h: cardH },
      dir: 'card',
    });

    colHeights[colIdx] = cardY + cardH + CARD_ROW_GAP;
  });

  const maxBottom = Math.max(260, ...colHeights) + PADDING_Y;
  const totalW = Math.max(460, boardInnerW + PADDING_X * 2);

  return {
    template: 'cards',
    root: layoutRoot,
    nodes: nodesList,
    edges: edgesList,
    spines: [],
    cards,
    width: Math.ceil(totalW),
    height: Math.ceil(maxBottom),
  };
}

// ---------------------------------------------------------------------------
// 6. Horizontal Milestone Timeline Layout (XMind Timeline / Roadmap)
// ---------------------------------------------------------------------------
function computeTimelineLayout(root, collapsedIds) {
  const PADDING_X = 56;
  const PADDING_Y = 52;
  const STEP_GAP = 42;
  const SUB_V_GAP = 10;
  const nodesList = [];
  const edgesList = [];
  const spines = [];

  const rootBox = measureNodeBox(root, true);
  const rootCollapsed = collapsedIds.has(root.id);
  const milestones = rootCollapsed ? [] : (root.children || []);

  const groups = milestones.map((mNode, idx) => {
    const isAbove = idx % 2 === 0;
    const mBox = measureNodeBox(mNode, false);
    const mCollapsed = collapsedIds.has(mNode.id);
    const subs = [];
    function collectSubs(n, depth) {
      if (collapsedIds.has(n.id)) return;
      for (const ch of n.children || []) {
        const box = measureNodeBox(ch, false);
        subs.push({
          data: ch,
          level: depth,
          w: Math.min(250, box.w),
          h: box.h,
          hiddenCount: collapsedIds.has(ch.id) ? countSubtreeNodes(ch) : 0,
        });
        collectSubs(ch, depth + 1);
      }
    }
    collectSubs(mNode, 2);

    const colW = Math.max(mBox.w, ...subs.map((s) => s.w + Math.min(28, (s.level - 2) * 14)), 170);
    const subsH = subs.reduce((acc, s) => acc + s.h + SUB_V_GAP, 0);
    const groupH = 38 + mBox.h + subsH + 16;
    return {
      idx,
      isAbove,
      mNode,
      mBox,
      mHiddenCount: mCollapsed ? countSubtreeNodes(mNode) : 0,
      subs,
      colW,
      groupH,
    };
  });

  const maxAboveH = groups.filter((g) => g.isAbove).reduce((acc, g) => Math.max(acc, g.groupH), 120);
  const maxBelowH = groups.filter((g) => !g.isAbove).reduce((acc, g) => Math.max(acc, g.groupH), 120);
  const railY = PADDING_Y + maxAboveH + 18;

  const layoutRoot = {
    data: root,
    level: 0,
    dir: 'center',
    w: rootBox.w,
    h: rootBox.h,
    x: PADDING_X,
    y: railY - rootBox.h / 2,
    hiddenCount: rootCollapsed ? countSubtreeNodes(root) : 0,
    children: [],
  };
  nodesList.push(layoutRoot);

  let curX = PADDING_X + rootBox.w + 64;
  for (const g of groups) {
    const centerX = curX + Math.round(g.colW / 2);
    const mX = Math.round(centerX - g.mBox.w / 2);
    const mY = g.isAbove ? railY - 36 - g.mBox.h : railY + 36;

    spines.push({
      x1: centerX,
      y1: railY,
      x2: centerX,
      y2: g.isAbove ? mY + g.mBox.h : mY,
      kind: 'rib',
    });

    nodesList.push({
      data: g.mNode,
      level: 1,
      dir: g.isAbove ? 'right' : 'down',
      milestoneBadge: String(g.idx + 1).padStart(2, '0'),
      w: g.mBox.w,
      h: g.mBox.h,
      x: mX,
      y: mY,
      hiddenCount: g.mHiddenCount,
      children: [],
    });

    let subY = g.isAbove ? mY - SUB_V_GAP : mY + g.mBox.h + SUB_V_GAP;
    for (const s of g.subs) {
      const indent = Math.min(28, (s.level - 2) * 14);
      const sx = curX + indent;
      if (g.isAbove) {
        subY -= s.h;
      }
      nodesList.push({
        data: s.data,
        level: s.level,
        dir: 'card',
        w: s.w,
        h: s.h,
        x: sx,
        y: subY,
        hiddenCount: s.hiddenCount,
        children: [],
      });
      if (g.isAbove) {
        subY -= SUB_V_GAP;
      } else {
        subY += s.h + SUB_V_GAP;
      }
    }

    curX += g.colW + STEP_GAP;
  }

  const endRailX = Math.max(PADDING_X + rootBox.w + 180, curX + 16);
  spines.unshift({
    x1: PADDING_X + rootBox.w,
    y1: railY,
    x2: endRailX,
    y2: railY,
    kind: 'main-spine',
  });

  return {
    template: 'timeline',
    root: layoutRoot,
    nodes: nodesList,
    edges: edgesList,
    spines,
    cards: [],
    width: Math.ceil(endRailX + PADDING_X),
    height: Math.ceil(railY + maxBelowH + PADDING_Y),
  };
}

function computeTemplateLayout(templateId, root, collapsedIds) {
  if (templateId === 'radial') return computeRadialLayout(root, collapsedIds);
  if (templateId === 'org') return computeOrgLayout(root, collapsedIds);
  if (templateId === 'timeline') return computeTimelineLayout(root, collapsedIds);
  if (templateId === 'fishbone') return computeFishboneLayout(root, collapsedIds);
  if (templateId === 'cards') return computeCardsLayout(root, collapsedIds);
  return computeLogicLayout(root, collapsedIds);
}

function buildCardEdgePathD(rootRect, cardRect) {
  const rx = rootRect.x + rootRect.w / 2;
  const ry = rootRect.y + rootRect.h;
  const cx = cardRect.x + cardRect.w / 2;
  if (cardRect.y + cardRect.h < rootRect.y) {
    const cy = cardRect.y + cardRect.h;
    const dy = Math.max(24, Math.abs(rootRect.y - cy) * 0.5);
    return `M ${rx} ${rootRect.y} C ${rx} ${rootRect.y - dy}, ${cx} ${cy + dy}, ${cx} ${cy}`;
  }
  const cy = cardRect.y;
  const dy = Math.max(24, Math.abs(cy - ry) * 0.52);
  return `M ${rx} ${ry} C ${rx} ${ry + dy}, ${cx} ${cy - dy}, ${cx} ${cy}`;
}

function buildEdgePathD(edge) {
  const { from, to, dir } = edge;
  if (dir === 'card') {
    return buildCardEdgePathD(from, to);
  }
  if (dir === 'left') {
    const x1 = from.x;
    const y1 = from.y + from.h / 2;
    const x2 = to.x + to.w;
    const y2 = to.y + to.h / 2;
    const dx = Math.max(24, Math.abs(x1 - x2) * 0.52);
    return `M ${x1} ${y1} C ${x1 - dx} ${y1}, ${x2 + dx} ${y2}, ${x2} ${y2}`;
  }
  if (dir === 'down') {
    const x1 = from.x + from.w / 2;
    const y1 = from.y + from.h;
    const x2 = to.x + to.w / 2;
    const y2 = to.y;
    const dy = Math.max(20, Math.abs(y2 - y1) * 0.52);
    return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
  }
  const x1 = from.x + from.w;
  const y1 = from.y + from.h / 2;
  const x2 = to.x;
  const y2 = to.y + to.h / 2;
  const dx = Math.max(24, Math.abs(x2 - x1) * 0.52);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function collectAllTreeTitles(root) {
  const titles = [];
  const walk = (node) => {
    if (!node) return;
    if (node.text) titles.push(node.text);
    for (const ch of node.children || []) walk(ch);
  };
  walk(root);
  return titles;
}

function getNextSequentialCardName(prefix = '新建卡片', existingTitles = []) {
  if (typeof store.nextSequentialName === 'function') {
    try {
      const candidate = store.nextSequentialName(prefix, existingTitles);
      if (candidate) return candidate;
    } catch {
      // fallback below
    }
  }
  const used = new Set((existingTitles || []).map((t) => String(t || '').trim()));
  let idx = 1;
  while (used.has(`${prefix}${idx}`)) {
    idx += 1;
  }
  return `${prefix}${idx}`;
}

function findLastDescendantLine(node) {
  if (!node) return -1;
  let maxIdx = Number.isInteger(node.lineIdx) ? node.lineIdx : -1;
  for (const ch of node.children || []) {
    maxIdx = Math.max(maxIdx, findLastDescendantLine(ch));
  }
  return maxIdx;
}

function getNodeLineRange(markdown, nodeData) {
  if (!nodeData || nodeData.lineIdx < 0) return null;
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const startLine = nodeData.lineIdx;
  const endLine = Math.min(lines.length - 1, Math.max(startLine, findLastDescendantLine(nodeData)));
  if (startLine >= lines.length) return null;
  const subtreeMarkdown = lines.slice(startLine, endLine + 1).join('\n');
  return { startLine, endLine, subtreeMarkdown };
}

function removeLineRangeFromMarkdown(markdown, startLine, endLine) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  if (startLine < 0 || startLine >= lines.length || endLine < startLine) return markdown;
  lines.splice(startLine, endLine - startLine + 1);
  // Collapse double blank lines at splice boundary
  if (startLine > 0 && startLine < lines.length && lines[startLine - 1].trim() === '' && lines[startLine].trim() === '') {
    lines.splice(startLine, 1);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function buildCardKeysForBranches(branches) {
  const seenCounts = new Map();
  return (branches || []).map((branch) => {
    const base = `${branch.kind || 'node'}:${branch.headingLevel || 0}:${branch.text || ''}`;
    const idx = seenCounts.get(base) || 0;
    seenCounts.set(base, idx + 1);
    return `${base}#${idx}`;
  });
}

function loadAllCardPositions() {
  try {
    const raw = localStorage.getItem(CARD_POSITIONS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function loadDocCardPositions(docKey) {
  if (!docKey) return {};
  const all = loadAllCardPositions();
  const docMap = all[docKey];
  return docMap && typeof docMap === 'object' ? { ...docMap } : {};
}

function saveDocCardPositions(docKey, docMap) {
  if (!docKey) return;
  try {
    const all = loadAllCardPositions();
    if (!docMap || Object.keys(docMap).length === 0) {
      delete all[docKey];
    } else {
      all[docKey] = docMap;
    }
    localStorage.setItem(CARD_POSITIONS_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // ignore storage quota errors
  }
}

function clampOutlineWidth(val) {
  const num = Number(val);
  if (!Number.isFinite(num)) return OUTLINE_DEFAULT_WIDTH;
  return Math.max(OUTLINE_MIN_WIDTH, Math.min(OUTLINE_MAX_WIDTH, Math.round(num)));
}

function hexToRgba(hex, alpha = 1) {
  const clean = String(hex || '').trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return `rgba(0, 122, 255, ${alpha})`;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function buildNodeColorKey(nodeData) {
  if (!nodeData) return '';
  const lineKey = Number.isInteger(nodeData.lineIdx) && nodeData.lineIdx >= 0 ? String(nodeData.lineIdx) : 'root';
  return `${lineKey}:${String(nodeData.text || '').trim()}`;
}

function loadJsonStorageMap(storageKey) {
  try {
    const raw = localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function loadDocCustomColors(docKey) {
  if (!docKey) return {};
  const all = loadJsonStorageMap(CUSTOM_COLORS_STORAGE_KEY);
  const docMap = all[docKey];
  return docMap && typeof docMap === 'object' ? { ...docMap } : {};
}

function saveDocCustomColors(docKey, docMap) {
  if (!docKey) return;
  try {
    const all = loadJsonStorageMap(CUSTOM_COLORS_STORAGE_KEY);
    if (!docMap || Object.keys(docMap).length === 0) {
      delete all[docKey];
    } else {
      all[docKey] = docMap;
    }
    localStorage.setItem(CUSTOM_COLORS_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // ignore storage quota errors
  }
}

function loadDocGroups(docKey) {
  if (!docKey) return [];
  const all = loadJsonStorageMap(GROUPS_STORAGE_KEY);
  const arr = all[docKey];
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((g) => g && typeof g === 'object' && g.id)
    .map((g) => ({
      id: String(g.id),
      title: String(g.title || '新建分组1'),
      x: Number.isFinite(Number(g.x)) ? Number(g.x) : 80,
      y: Number.isFinite(Number(g.y)) ? Number(g.y) : 80,
      w: Math.max(220, Number.isFinite(Number(g.w)) ? Number(g.w) : 440),
      h: Math.max(150, Number.isFinite(Number(g.h)) ? Number(g.h) : 290),
      color: String(g.color || '#4F46E5'),
    }));
}

function saveDocGroups(docKey, groups) {
  if (!docKey) return;
  try {
    const all = loadJsonStorageMap(GROUPS_STORAGE_KEY);
    if (!Array.isArray(groups) || groups.length === 0) {
      delete all[docKey];
    } else {
      all[docKey] = groups;
    }
    localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // ignore storage quota errors
  }
}

function serializeSubtreeToMarkdown(nodeData, levelOffset = 0) {
  if (!nodeData) return '';
  const lines = [];
  const badge = STATUS_BADGE_MAP[nodeData.status] ? ` ${STATUS_BADGE_MAP[nodeData.status]}` : '';
  const title = `${nodeData.text || '未命名节点'}${badge}`.trim();
  if (nodeData.kind === 'heading' && levelOffset === 0) {
    const hashes = '#'.repeat(Math.min(4, Math.max(2, nodeData.headingLevel || 2)));
    lines.push(`${hashes} ${title}`);
  } else {
    const indent = '  '.repeat(Math.max(0, levelOffset));
    lines.push(`${indent}- ${title}`);
  }
  for (const ch of nodeData.children || []) {
    const nextOffset = nodeData.kind === 'heading' && levelOffset === 0 ? 0 : levelOffset + 1;
    lines.push(serializeSubtreeToMarkdown(ch, nextOffset));
  }
  return lines.filter(Boolean).join('\n');
}

function ensureMindmapV73Styles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('mindmap-v73-styles')) return;
  const style = document.createElement('style');
  style.id = 'mindmap-v73-styles';
  style.textContent = `
    .mindmap-workspace {
      display: flex;
      flex: 1 1 auto;
      min-height: 0;
      min-width: 0;
      position: relative;
      overflow: hidden;
    }
    .mindmap-outline-pane {
      flex: 0 0 auto;
      min-width: ${OUTLINE_MIN_WIDTH}px;
      max-width: ${OUTLINE_MAX_WIDTH}px;
      display: flex;
      flex-direction: column;
      min-height: 0;
      background: var(--bg-glass);
      border-right: 1px solid var(--border-hairline);
      z-index: 4;
      overflow: hidden;
      user-select: none;
    }
    .mindmap-outline-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 9px 12px 6px;
      flex-shrink: 0;
    }
    .mindmap-outline-title {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-primary);
      letter-spacing: 0.01em;
    }
    .mindmap-outline-count {
      font-family: var(--font-mono);
      font-size: 10.5px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 999px;
      background: var(--bg-subtle);
      color: var(--text-secondary);
    }
    .mindmap-outline-search-wrap {
      padding: 0 10px 8px;
      border-bottom: 1px solid var(--border-hairline);
      flex-shrink: 0;
    }
    .mindmap-outline-search {
      width: 100%;
      box-sizing: border-box;
      height: 28px;
      padding: 0 10px;
      border-radius: 999px;
      border: 1px solid var(--border-hairline);
      background: var(--bg-subtle);
      color: var(--text-primary);
      font-family: var(--font-sans);
      font-size: 12px;
      outline: none;
    }
    .mindmap-outline-search:focus {
      border-color: var(--accent);
      background: var(--bg-island);
    }
    .mindmap-outline-list {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      padding: 6px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .mindmap-outline-item {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
      box-sizing: border-box;
      text-align: left;
      padding: 5px 8px;
      border-radius: 9px;
      border: 1px solid transparent;
      background: transparent;
      color: var(--text-secondary);
      font-size: 12px;
      line-height: 1.35;
      cursor: pointer;
      transition: transform 140ms var(--ease-spring), opacity 140ms var(--ease-apple);
    }
    .mindmap-outline-item:hover {
      background: var(--bg-subtle);
      color: var(--text-primary);
    }
    .mindmap-outline-item.is-active {
      background: var(--accent-soft);
      border-color: rgba(0, 122, 255, 0.28);
      color: var(--accent);
      font-weight: 600;
    }
    .mindmap-outline-item.is-root-item {
      font-weight: 700;
      color: var(--text-primary);
    }
    .mm-outline-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .mm-outline-label {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .mm-outline-child-badge {
      flex-shrink: 0;
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-tertiary);
      padding: 0 4px;
    }
    .mindmap-outline-empty {
      padding: 18px 10px;
      text-align: center;
      font-size: 12px;
      color: var(--text-tertiary);
    }
    .mindmap-outline-resizer {
      flex: 0 0 6px;
      width: 6px;
      margin-left: -3px;
      margin-right: -3px;
      position: relative;
      z-index: 14;
      cursor: col-resize;
      touch-action: none;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
    }
    .mindmap-outline-resizer::after {
      content: '';
      width: 2px;
      height: 36px;
      border-radius: 999px;
      background: var(--border-hairline);
      opacity: 0.72;
      transition: transform 140ms var(--ease-spring), opacity 140ms var(--ease-apple);
    }
    .mindmap-outline-resizer:hover::after,
    .mindmap-outline-resizer.is-dragging::after {
      background: var(--accent);
      opacity: 1;
      transform: scaleX(1.6) scaleY(1.35);
    }
    .mindmap-workspace .mindmap-stage {
      flex: 1 1 auto;
      min-width: 0;
      min-height: 0;
    }
    .mindmap-groups-layer {
      position: absolute;
      top: 0;
      left: 0;
      z-index: 1;
      pointer-events: none;
    }
    .mindmap-svg {
      position: relative;
      z-index: 2;
    }
    .mindmap-nodes-layer {
      z-index: 3;
      pointer-events: none;
    }
    .mindmap-node,
    .mindmap-card-box {
      pointer-events: auto;
    }
    .mindmap-group-frame {
      position: absolute;
      pointer-events: auto;
      box-sizing: border-box;
      border-radius: 18px;
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      box-shadow: 0 8px 26px rgba(0, 0, 0, 0.05);
      display: flex;
      flex-direction: column;
      user-select: none;
      transition: opacity 150ms var(--ease-apple), transform 150ms var(--ease-spring);
    }
    .mindmap-group-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px 6px;
      cursor: grab;
      flex-wrap: nowrap;
      border-bottom: 1px dashed rgba(128, 128, 140, 0.22);
    }
    .mindmap-group-frame.is-dragging .mindmap-group-header {
      cursor: grabbing;
    }
    .mindmap-group-title {
      font-size: 12.5px;
      font-weight: 700;
      color: var(--text-primary);
      padding: 2px 6px;
      border-radius: 6px;
      cursor: text;
      min-width: 40px;
      max-width: 170px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .mindmap-group-title:hover {
      background: rgba(128, 128, 140, 0.12);
    }
    .mindmap-group-title-input {
      font-family: var(--font-sans);
      font-size: 12.5px;
      font-weight: 700;
      color: var(--text-primary);
      background: var(--bg-island);
      border: 1px solid var(--accent);
      border-radius: 6px;
      padding: 2px 6px;
      width: 132px;
      outline: none;
    }
    .mindmap-group-badge {
      font-family: var(--font-mono);
      font-size: 10.5px;
      font-weight: 600;
      padding: 1px 7px;
      border-radius: 999px;
      background: var(--bg-island);
      border: 1px solid var(--border-hairline);
      color: var(--text-secondary);
      flex-shrink: 0;
    }
    .mindmap-group-colors {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-left: auto;
      flex-shrink: 0;
    }
    .mindmap-group-color-dot {
      width: 11px;
      height: 11px;
      border-radius: 50%;
      border: 1.5px solid rgba(255, 255, 255, 0.85);
      cursor: pointer;
      padding: 0;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.22);
      transition: transform 130ms var(--ease-spring);
    }
    .mindmap-group-color-dot:hover {
      transform: scale(1.22);
    }
    .mindmap-group-color-dot.is-active {
      transform: scale(1.22);
      outline: 2px solid var(--text-primary);
      outline-offset: 1px;
    }
    .mindmap-group-btn {
      height: 22px;
      padding: 0 7px;
      border-radius: 999px;
      border: 1px solid var(--border-hairline);
      background: var(--bg-island);
      color: var(--text-primary);
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      flex-shrink: 0;
      transition: transform 130ms var(--ease-spring), opacity 130ms ease;
    }
    .mindmap-group-btn:hover {
      transform: translateY(-1px);
      border-color: var(--accent);
      color: var(--accent);
    }
    .mindmap-group-delete {
      width: 22px;
      padding: 0;
      justify-content: center;
      color: var(--text-tertiary);
    }
    .mindmap-group-delete:hover {
      color: var(--danger);
      border-color: var(--danger);
    }
    .mindmap-group-resize {
      position: absolute;
      z-index: 2;
    }
    .mindmap-group-resize[data-resize-dir="se"] {
      right: 2px;
      bottom: 2px;
      width: 16px;
      height: 16px;
      cursor: nwse-resize;
      display: flex;
      align-items: flex-end;
      justify-content: flex-end;
      padding: 3px;
      box-sizing: border-box;
      opacity: 0.65;
    }
    .mindmap-group-resize[data-resize-dir="se"]::after {
      content: '';
      width: 8px;
      height: 8px;
      border-right: 2px solid var(--text-tertiary);
      border-bottom: 2px solid var(--text-tertiary);
      border-bottom-right-radius: 3px;
    }
    .mindmap-group-resize[data-resize-dir="e"] {
      top: 14px; bottom: 16px; right: -4px; width: 8px; cursor: ew-resize;
    }
    .mindmap-group-resize[data-resize-dir="w"] {
      top: 14px; bottom: 16px; left: -4px; width: 8px; cursor: ew-resize;
    }
    .mindmap-group-resize[data-resize-dir="s"] {
      left: 14px; right: 16px; bottom: -4px; height: 8px; cursor: ns-resize;
    }
    .mindmap-group-resize[data-resize-dir="n"] {
      left: 14px; right: 16px; top: -4px; height: 8px; cursor: ns-resize;
    }
    .mindmap-group-resize[data-resize-dir="ne"] {
      top: -4px; right: -4px; width: 12px; height: 12px; cursor: nesw-resize;
    }
    .mindmap-group-resize[data-resize-dir="nw"] {
      top: -4px; left: -4px; width: 12px; height: 12px; cursor: nwse-resize;
    }
    .mindmap-group-resize[data-resize-dir="sw"] {
      bottom: -4px; left: -4px; width: 12px; height: 12px; cursor: nesw-resize;
    }
    .mindmap-color-strip {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px 8px;
    }
    .mindmap-color-swatch {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      border: 1.5px solid var(--border-hairline);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: 700;
      color: #FFFFFF;
      padding: 0;
      transition: transform 140ms var(--ease-spring);
    }
    .mindmap-color-swatch:hover {
      transform: scale(1.18);
    }
    .mindmap-color-swatch.is-active {
      transform: scale(1.15);
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .mindmap-color-swatch.is-default {
      background: var(--bg-subtle);
      color: var(--text-secondary);
    }
    @keyframes mmNodePulse {
      0% { transform: scale(1); opacity: 1; }
      35% { transform: scale(1.045); opacity: 0.82; }
      70% { transform: scale(0.99); opacity: 1; }
      100% { transform: scale(1); opacity: 1; }
    }
    .mindmap-node.is-pulse-highlight,
    .mindmap-card-box.is-pulse-highlight,
    .mindmap-card-item.is-pulse-highlight {
      animation: mmNodePulse 680ms var(--ease-spring) 1;
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
  `;
  document.head.appendChild(style);
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

function appendChildBulletToMarkdown(markdown, parentNode, childText, existingTitles = []) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const rawTrimmed = String(childText || '').trim();
  const cleanChild = rawTrimmed || getNextSequentialCardName('新建卡片', existingTitles);

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

  const insertAfter = findLastDescendantLine(parentNode);
  lines.splice(insertAfter + 1, 0, newLine);
  return lines.join('\n');
}

function appendSiblingToMarkdown(markdown, targetNode, siblingText, existingTitles = []) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const rawTrimmed = String(siblingText || '').trim();
  const cleanSibling = rawTrimmed || getNextSequentialCardName('新建卡片', existingTitles);

  if (!targetNode || targetNode.lineIdx < 0 || targetNode.lineIdx >= lines.length) {
    const trimmedEnd = String(markdown ?? '').trimEnd();
    const sep = trimmedEnd ? '\n\n' : '';
    return `${trimmedEnd}${sep}## ${cleanSibling}\n`;
  }

  let newLine = '';
  if (targetNode.kind === 'heading') {
    const hashes = '#'.repeat(Math.min(6, Math.max(1, targetNode.headingLevel || 2)));
    newLine = `${hashes} ${cleanSibling}`;
  } else {
    const origLine = lines[targetNode.lineIdx] || '';
    const indentMatch = origLine.match(/^(\s*)/);
    const baseIndent = indentMatch ? indentMatch[1] : '';
    newLine = `${baseIndent}- ${cleanSibling}`;
  }

  const insertAfter = findLastDescendantLine(targetNode);
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

  const cardsSvg = (layout.cards || [])
    .map(
      (c) =>
        `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="16" fill="rgba(255,255,255,0.88)" stroke="rgba(0,0,0,0.1)" stroke-width="1.5"/>`
    )
    .join('');

  const spinesSvg = (layout.spines || [])
    .map(
      (s) =>
        `<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" stroke="${s.kind === 'main-spine' ? '#007AFF' : strokeColor}" stroke-opacity="${s.kind === 'main-spine' ? '0.75' : '0.55'}" stroke-width="${s.kind === 'main-spine' ? '3.5' : '2'}" stroke-linecap="round"/>`
    )
    .join('');

  const pathsSvg = layout.edges
    .map((edge) => {
      const d = buildEdgePathD(edge);
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
          <rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${n.dir === 'card' ? 10 : Math.round(n.h / 2)}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>
          <text x="${n.x + n.w / 2}" y="${n.y + n.h / 2 + 4}" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, PingFang SC, Microsoft YaHei, sans-serif" font-size="${isRoot ? 13.5 : 12.5}" font-weight="${isRoot ? 600 : 500}" fill="${textFill}">${escapeHtml(label + badge)}</text>
        </g>
      `;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">
  <rect width="100%" height="100%" fill="#F5F5F7"/>
  ${cardsSvg}
  ${spinesSvg}
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
 */
export function renderMindMap(containerEl, opts = {}) {
  if (!containerEl) return null;
  ensureMindmapV73Styles();

  const docName = String(opts.docName || '笔记脑图');
  const currentDocPath = String(opts.docPath || store.state.activeFile?.path || docName || '');
  const docPosKey = currentDocPath || docName;
  let currentMarkdown = String(opts.markdown ?? '');
  const collapsedIds = new Set();

  let currentTemplate = 'logic';
  try {
    const saved = localStorage.getItem(TEMPLATE_STORAGE_KEY);
    if (saved && TEMPLATE_LIST.some((t) => t.id === saved)) {
      currentTemplate = saved;
    }
  } catch {
    // ignore storage errors
  }

  let isCardsStack = false;
  try {
    const savedStack = localStorage.getItem(CARDS_STACK_STORAGE_KEY);
    isCardsStack = savedStack === 'stack' || savedStack === '1' || savedStack === 'true';
  } catch {
    // ignore storage errors
  }

  const isMobileMindmapViewport =
    typeof window !== 'undefined' &&
    (window.innerWidth <= 768 || Boolean(document.body?.classList?.contains('is-android-app')));
  let isOutlineOpen = !isMobileMindmapViewport;
  if (!isMobileMindmapViewport) {
    try {
      const savedOutlineOpen = localStorage.getItem(OUTLINE_OPEN_STORAGE_KEY);
      if (savedOutlineOpen !== null) {
        isOutlineOpen = savedOutlineOpen === '1' || savedOutlineOpen === 'true';
      }
    } catch {
      // ignore storage errors
    }
  }

  let outlineWidth = OUTLINE_DEFAULT_WIDTH;
  try {
    const savedOutlineW = localStorage.getItem(OUTLINE_WIDTH_STORAGE_KEY);
    if (savedOutlineW !== null) {
      outlineWidth = clampOutlineWidth(Number(savedOutlineW));
    }
  } catch {
    // ignore storage errors
  }

  let docCardPositions = loadDocCardPositions(docPosKey);
  let docCustomColors = loadDocCustomColors(docPosKey);
  let docGroups = loadDocGroups(docPosKey);

  let zoom = 1;
  let panX = 0;
  let panY = 0;
  const lastPointer = { x: null, y: null };
  let currentLayout = null;
  let currentTreeRoot = null;
  let currentNodeMap = new Map();
  let currentParentMap = new Map();
  let nodeMenuEl = null;
  let tempEditorState = null;
  let selectedNodeId = null;
  let hoveredNodeId = null;
  let outlineSearchQuery = '';
  let topCardZIndex = 30;
  let topNodeZIndex = 20;
  let topGroupZIndex = 10;
  let activeCardDrag = null;
  let activeGroupInteraction = null;
  let panAnimFrame = null;
  let resizeTooltipEl = null;

  const baseTitle = docName.replace(/\.[^.]+$/, '') || 'mindmap';

  const templateBtnsHtml = TEMPLATE_LIST.map(
    (t) =>
      `<button type="button" class="pill-btn pill-btn-sm ${t.id === currentTemplate ? 'pill-btn-primary' : ''}" data-mm-tpl="${t.id}" title="${escapeHtml(t.title)}">${escapeHtml(t.label)}</button>`
  ).join('');

  containerEl.innerHTML = `
    <div class="mindmap-shell">
      <div class="mindmap-toolbar">
        <div class="mindmap-toolbar-group" data-mm-role="tpl-group" style="display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap;">
          <button type="button" class="pill-btn pill-btn-sm ${isOutlineOpen ? 'pill-btn-primary' : ''}" data-mm-action="toggle-outline" title="展开/收起大纲侧边联动栏">📑 大纲联动</button>
          <span style="font-size:11.5px;font-weight:600;color:var(--text-tertiary);margin:0 2px 0 4px;">知识视图:</span>
          ${templateBtnsHtml}
          <span class="mindmap-cards-controls" data-mm-role="cards-controls" style="display:${currentTemplate === 'cards' ? 'inline-flex' : 'none'};align-items:center;gap:4px;margin-left:6px;padding-left:8px;border-left:1px solid var(--border-hairline);">
            <button type="button" class="pill-btn pill-btn-sm ${!isCardsStack ? 'pill-btn-primary' : ''}" data-mm-cards-mode="tile" title="最短列瀑布流平铺，零重叠">⊞ 平铺</button>
            <button type="button" class="pill-btn pill-btn-sm ${isCardsStack ? 'pill-btn-primary' : ''}" data-mm-cards-mode="stack" title="紧凑阶梯堆叠，悬停自动浮出置顶">📚 堆叠</button>
            <button type="button" class="pill-btn pill-btn-sm" data-mm-act="add-root-card" title="新增顶级知识卡片（自动顺延命名）">＋ 新建卡片</button>
            <button type="button" class="pill-btn pill-btn-sm" data-mm-act="reset-card-pos" title="清除手动拖拽偏移，恢复自动排布">↺ 重置卡片位置</button>
          </span>
        </div>
        <div class="mindmap-toolbar-group">
          <button type="button" class="pill-btn pill-btn-sm" data-mm-action="add-group-frame" title="在画布可视中心创建分组框（可圈选卡片一键导出为新笔记）">🔲 新建分组框</button>
          <button type="button" class="pill-btn pill-btn-sm" data-mm-act="zoom-out" title="以指针为中心缩小">－</button>
          <span class="mindmap-zoom-label" data-mm-role="zoom-label">100%</span>
          <button type="button" class="pill-btn pill-btn-sm" data-mm-act="zoom-in" title="以指针为中心放大">＋</button>
          <button type="button" class="pill-btn pill-btn-sm" data-mm-act="center" title="自适应居中视图">⌖ 居中</button>
          <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-mm-act="ai-generate">
            ${icon('sparkles', 13)} AI 提炼脑图
          </button>
          <button type="button" class="pill-btn pill-btn-sm" data-mm-act="export-svg">导出 SVG</button>
          <button type="button" class="pill-btn pill-btn-sm" data-mm-act="export-png">导出 PNG</button>
        </div>
      </div>
      <div class="mindmap-workspace" data-mm-role="workspace">
        <aside class="mindmap-outline-pane" data-mm-role="outline-pane" style="width:${outlineWidth}px;${isOutlineOpen ? '' : 'display:none;'}">
          <div class="mindmap-outline-header">
            <span class="mindmap-outline-title">📑 大纲联动</span>
            <span class="mindmap-outline-count" data-mm-role="outline-count">0</span>
          </div>
          <div class="mindmap-outline-search-wrap">
            <input type="search" class="mindmap-outline-search" data-mm-role="outline-search" placeholder="筛选大纲节点..." />
          </div>
          <div class="mindmap-outline-list" data-mm-role="outline-list"></div>
        </aside>
        <div class="mindmap-outline-resizer" data-mm-role="outline-resizer" role="separator" aria-orientation="vertical" title="左右拖动调节大纲栏宽度 · 双击复位 228px" style="${isOutlineOpen ? '' : 'display:none;'}"></div>
        <div class="mindmap-stage" id="mindmap-canvas" tabindex="-1" style="outline:none;">
          <div class="mindmap-viewport" data-mm-role="viewport" style="transform-origin:0 0;">
            <div class="mindmap-groups-layer" data-mm-role="groups"></div>
            <svg class="mindmap-svg" data-mm-role="svg"></svg>
            <div class="mindmap-nodes-layer" data-mm-role="nodes"></div>
          </div>
          <div class="mindmap-hint-pill" data-mm-role="hint-pill"></div>
        </div>
      </div>
    </div>
  `;

  const outlineToggleBtn = containerEl.querySelector('[data-mm-action="toggle-outline"]');
  const outlinePaneEl = containerEl.querySelector('[data-mm-role="outline-pane"]');
  const outlineResizerEl = containerEl.querySelector('[data-mm-role="outline-resizer"]');
  const outlineCountEl = containerEl.querySelector('[data-mm-role="outline-count"]');
  const outlineSearchEl = containerEl.querySelector('[data-mm-role="outline-search"]');
  const outlineListEl = containerEl.querySelector('[data-mm-role="outline-list"]');
  const stageEl = containerEl.querySelector('.mindmap-stage');
  const viewportEl = containerEl.querySelector('[data-mm-role="viewport"]');
  const groupsLayer = containerEl.querySelector('[data-mm-role="groups"]');
  const svgEl = containerEl.querySelector('[data-mm-role="svg"]');
  const nodesLayer = containerEl.querySelector('[data-mm-role="nodes"]');
  const zoomLabelEl = containerEl.querySelector('[data-mm-role="zoom-label"]');
  const cardsControlsEl = containerEl.querySelector('[data-mm-role="cards-controls"]');
  const resetPosBtn = containerEl.querySelector('[data-mm-act="reset-card-pos"]');
  const hintPillEl = containerEl.querySelector('[data-mm-role="hint-pill"]');

  function syncCardsToolbarState() {
    if (cardsControlsEl) {
      cardsControlsEl.style.display = currentTemplate === 'cards' ? 'inline-flex' : 'none';
    }
    containerEl.querySelectorAll('[data-mm-cards-mode]').forEach((b) => {
      const mode = b.dataset.mmCardsMode;
      b.classList.toggle('pill-btn-primary', (mode === 'stack') === isCardsStack);
    });
    if (resetPosBtn) {
      const hasCustom = Object.keys(docCardPositions).length > 0;
      resetPosBtn.disabled = !hasCustom;
      resetPosBtn.classList.toggle('pill-btn-primary', hasCustom);
      resetPosBtn.style.opacity = hasCustom ? '1' : '0.48';
    }
    if (hintPillEl) {
      hintPillEl.textContent =
        currentTemplate === 'cards'
          ? '拖动卡片标题栏自由定位 · 拖到顶部灵动岛暂存或底部垃圾桶删除 · 双击/点 ✎ 原位扩大编辑 · Tab 加子项'
          : '滚轮按鼠标指针位置定点缩放 · 拖动画布 · 顶部切换 6 种知识梳理模板 · 双击节点扩大编辑';
    }
  }

  function closeNodeMenu() {
    if (nodeMenuEl) {
      nodeMenuEl.remove();
      nodeMenuEl = null;
    }
  }

  function closeTempEditor(commitChanges = false) {
    if (!tempEditorState) return;
    const state = tempEditorState;
    tempEditorState = null;
    state.cleanup(commitChanges);
  }

  function applyTransform() {
    if (viewportEl) {
      viewportEl.style.transformOrigin = '0 0';
      viewportEl.style.transform = `translate3d(${panX}px, ${panY}px, 0) scale(${zoom})`;
    }
    if (zoomLabelEl) {
      zoomLabelEl.textContent = `${Math.round(zoom * 100)}%`;
    }
  }

  /**
   * Zoom keeping the world coordinate under (anchorX, anchorY) strictly stationary.
   */
  function zoomAtPoint(nextZoomRaw, anchorX = null, anchorY = null) {
    const nextZoom = Math.min(2.6, Math.max(0.28, Number(nextZoomRaw.toFixed(3))));
    if (Math.abs(nextZoom - zoom) < 0.001) return;
    const rect = stageEl?.getBoundingClientRect();
    const sw = rect?.width || 640;
    const sh = rect?.height || 420;
    const ax = Number.isFinite(anchorX)
      ? anchorX
      : Number.isFinite(lastPointer.x) && lastPointer.x >= 0 && lastPointer.x <= sw
      ? lastPointer.x
      : sw / 2;
    const ay = Number.isFinite(anchorY)
      ? anchorY
      : Number.isFinite(lastPointer.y) && lastPointer.y >= 0 && lastPointer.y <= sh
      ? lastPointer.y
      : sh / 2;

    panX = Number((ax - ((ax - panX) / zoom) * nextZoom).toFixed(2));
    panY = Number((ay - ((ay - panY) / zoom) * nextZoom).toFixed(2));
    zoom = nextZoom;
    applyTransform();
  }

  function fitCenter() {
    if (!stageEl || !currentLayout) return;
    const rect = stageEl.getBoundingClientRect();
    const sw = Math.max(320, rect.width || 640);
    const sh = Math.max(240, rect.height || 420);
    const fitZoom = Math.min(1.05, Math.max(0.38, Math.min((sw - 40) / currentLayout.width, (sh - 40) / currentLayout.height)));
    zoom = Number(fitZoom.toFixed(2));
    panX = Math.max(16, Math.round((sw - currentLayout.width * zoom) / 2));
    panY = Math.max(16, Math.round((sh - currentLayout.height * zoom) / 2));
    applyTransform();
  }

  function findNodeById(id) {
    if (!id) return null;
    if (currentNodeMap.has(id)) return currentNodeMap.get(id);
    return currentLayout?.nodes?.find((n) => n.data.id === id)?.data || null;
  }

  function findEditableTargetEl(nodeId) {
    if (!nodesLayer || !nodeId) return null;
    const rawEl = nodesLayer.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
    if (!rawEl) return null;
    if (rawEl.classList.contains('mindmap-card-box')) {
      return rawEl.querySelector('.mindmap-card-header') || rawEl;
    }
    return rawEl;
  }

  function addChildToNode(nodeData, childName = '') {
    if (!nodeData) return;
    const allTitles = collectAllTreeTitles(currentTreeRoot);
    const nextName = String(childName || '').trim() || getNextSequentialCardName('新建卡片', allTitles);
    currentMarkdown = appendChildBulletToMarkdown(currentMarkdown, nodeData, nextName, allTitles);
    collapsedIds.delete(nodeData.id);
    opts.onUpdateMarkdown?.(currentMarkdown);
    renderTree(false);
  }

  function addSiblingToNode(nodeData, siblingName = '') {
    if (!nodeData) return;
    const allTitles = collectAllTreeTitles(currentTreeRoot);
    const nextName = String(siblingName || '').trim() || getNextSequentialCardName('新建卡片', allTitles);
    currentMarkdown = appendSiblingToMarkdown(currentMarkdown, nodeData, nextName, allTitles);
    opts.onUpdateMarkdown?.(currentMarkdown);
    renderTree(false);
  }

  function getNodeCustomColor(nodeData) {
    if (!nodeData) return '';
    const key = buildNodeColorKey(nodeData);
    return key && docCustomColors[key] ? String(docCustomColors[key]) : '';
  }

  function setNodeCustomColor(nodeData, hex) {
    if (!nodeData) return;
    const key = buildNodeColorKey(nodeData);
    if (!key) return;
    if (!hex) {
      delete docCustomColors[key];
    } else {
      docCustomColors[key] = hex;
    }
    saveDocCustomColors(docPosKey, docCustomColors);
    renderTree(false);
  }

  function ensureResizeTooltip() {
    if (resizeTooltipEl && document.body.contains(resizeTooltipEl)) return resizeTooltipEl;
    resizeTooltipEl = document.getElementById('pane-resize-tooltip');
    if (!resizeTooltipEl) {
      resizeTooltipEl = document.createElement('div');
      resizeTooltipEl.id = 'pane-resize-tooltip';
      resizeTooltipEl.className = 'pane-resize-tooltip';
      resizeTooltipEl.hidden = true;
      document.body.appendChild(resizeTooltipEl);
    }
    return resizeTooltipEl;
  }

  function showResizeTooltip(clientX, clientY, px) {
    const tip = ensureResizeTooltip();
    tip.textContent = `${Math.round(px)}px`;
    tip.hidden = false;
    const left = Math.min(window.innerWidth - 76, Math.max(8, clientX + 14));
    const top = Math.min(window.innerHeight - 36, Math.max(8, clientY - 28));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  function hideResizeTooltip() {
    if (resizeTooltipEl) {
      resizeTooltipEl.hidden = true;
    }
  }

  function syncOutlineVisibility() {
    if (outlinePaneEl) {
      outlinePaneEl.style.display = isOutlineOpen ? 'flex' : 'none';
      outlinePaneEl.style.width = `${outlineWidth}px`;
    }
    if (outlineResizerEl) {
      outlineResizerEl.style.display = isOutlineOpen ? 'flex' : 'none';
    }
    if (outlineToggleBtn) {
      outlineToggleBtn.classList.toggle('pill-btn-primary', isOutlineOpen);
    }
  }

  function syncOutlineActive(targetNodeId = null, shouldScroll = false) {
    if (!outlineListEl) return;
    const activeId = targetNodeId || selectedNodeId || hoveredNodeId;
    outlineListEl.querySelectorAll('.mindmap-outline-item.is-active').forEach((el) => {
      el.classList.remove('is-active');
    });
    if (!activeId) return;
    const rowEl = outlineListEl.querySelector(`[data-outline-node-id="${CSS.escape(activeId)}"]`);
    if (rowEl) {
      rowEl.classList.add('is-active');
      if (shouldScroll) {
        rowEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }

  function renderOutlineTree() {
    if (!outlineListEl || !currentTreeRoot) return;
    const flatItems = [];
    const walk = (node, depth, branchAccent) => {
      if (!node) return;
      const customColor = getNodeCustomColor(node);
      const dotColor =
        depth === 0
          ? customColor || 'var(--accent)'
          : customColor || branchAccent || 'var(--text-tertiary)';
      flatItems.push({ node, depth, dotColor });
      const children = node.children || [];
      children.forEach((ch, idx) => {
        const nextAccent = depth === 0 ? CARD_ACCENTS[idx % CARD_ACCENTS.length] : branchAccent;
        walk(ch, depth + 1, nextAccent);
      });
    };
    walk(currentTreeRoot, 0, 'var(--accent)');

    if (outlineCountEl) {
      outlineCountEl.textContent = String(flatItems.length);
    }

    const q = outlineSearchQuery.trim().toLowerCase();
    const filtered = q
      ? flatItems.filter((it) => String(it.node.text || '').toLowerCase().includes(q))
      : flatItems;

    if (filtered.length === 0) {
      outlineListEl.innerHTML = '<div class="mindmap-outline-empty">暂无匹配的节点</div>';
      return;
    }

    const activeId = hoveredNodeId || selectedNodeId;
    outlineListEl.innerHTML = filtered
      .map((it) => {
        const indentPx = 8 + Math.min(5, it.depth) * 13;
        const isActive = activeId && it.node.id === activeId;
        const isRoot = it.depth === 0;
        const childCount = (it.node.children || []).length;
        const cleanLabel = String(it.node.text || '节点').replace(/\[\[(?:app:|url:)?([^[\]|]+?)(?:\|[^[\]]+)?\]\]/g, '$1');
        return `
          <button type="button"
            class="mindmap-outline-item ${isRoot ? 'is-root-item' : ''} ${isActive ? 'is-active' : ''}"
            data-outline-node-id="${escapeHtml(it.node.id)}"
            style="padding-left:${indentPx}px;"
            title="${escapeHtml(cleanLabel)}">
            <span class="mm-outline-dot" style="background:${escapeHtml(it.dotColor)};"></span>
            <span class="mm-outline-label">${escapeHtml(cleanLabel)}</span>
            ${childCount > 0 ? `<span class="mm-outline-child-badge">${childCount}</span>` : ''}
          </button>
        `;
      })
      .join('');
  }

  function animatePanTo(targetPanX, targetPanY, duration = 240) {
    if (panAnimFrame) {
      window.cancelAnimationFrame(panAnimFrame);
      panAnimFrame = null;
    }
    const startX = panX;
    const startY = panY;
    const deltaX = targetPanX - startX;
    const deltaY = targetPanY - startY;
    if (Math.hypot(deltaX, deltaY) < 1) {
      panX = targetPanX;
      panY = targetPanY;
      applyTransform();
      return;
    }
    const startTs = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - startTs) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      panX = Number((startX + deltaX * eased).toFixed(2));
      panY = Number((startY + deltaY * eased).toFixed(2));
      applyTransform();
      if (t < 1) {
        panAnimFrame = window.requestAnimationFrame(step);
      } else {
        panAnimFrame = null;
      }
    };
    panAnimFrame = window.requestAnimationFrame(step);
  }

  function focusNodeInCanvas(nodeId) {
    if (!nodeId || !nodesLayer || !stageEl) return;

    // Expand any collapsed ancestors so the target node is rendered on canvas
    let needRerender = false;
    let cursor = currentParentMap.get(nodeId);
    while (cursor) {
      if (collapsedIds.has(cursor)) {
        collapsedIds.delete(cursor);
        needRerender = true;
      }
      cursor = currentParentMap.get(cursor);
    }
    if (needRerender) {
      renderTree(false);
    }

    const targetEl = nodesLayer.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
    if (!targetEl) return;

    selectedNodeId = nodeId;
    nodesLayer.querySelectorAll('.is-selected').forEach((el) => el.classList.remove('is-selected'));
    targetEl.classList.add('is-selected');
    syncOutlineActive(nodeId, false);

    // Elevate z-index to highest
    const cardBox = targetEl.closest('.mindmap-card-box');
    if (cardBox) {
      topCardZIndex += 1;
      cardBox.style.zIndex = String(topCardZIndex);
    } else if (targetEl.classList.contains('mindmap-node')) {
      topNodeZIndex += 1;
      targetEl.style.zIndex = String(topNodeZIndex);
    }

    // Trigger pulse highlight
    targetEl.classList.remove('is-pulse-highlight');
    void targetEl.offsetWidth;
    targetEl.classList.add('is-pulse-highlight');
    window.setTimeout(() => {
      targetEl.classList.remove('is-pulse-highlight');
    }, 850);

    // Compute world center of target element
    let worldX = parseFloat(targetEl.style.left);
    let worldY = parseFloat(targetEl.style.top);
    if (!Number.isFinite(worldX)) worldX = targetEl.offsetLeft;
    if (!Number.isFinite(worldY)) worldY = targetEl.offsetTop;
    if (cardBox && targetEl !== cardBox) {
      const boxX = parseFloat(cardBox.style.left) || cardBox.offsetLeft || 0;
      const boxY = parseFloat(cardBox.style.top) || cardBox.offsetTop || 0;
      worldX = boxX + targetEl.offsetLeft;
      worldY = boxY + targetEl.offsetTop;
    }
    const worldW = targetEl.offsetWidth || 120;
    const worldH = targetEl.offsetHeight || 36;
    const cx = worldX + worldW / 2;
    const cy = worldY + worldH / 2;

    const stageRect = stageEl.getBoundingClientRect();
    const targetPanX = Math.round(stageRect.width / 2 - cx * zoom);
    const targetPanY = Math.round(stageRect.height / 2 - cy * zoom);
    animatePanTo(targetPanX, targetPanY, 260);
  }

  function computeGroupContainedItems(group) {
    if (!nodesLayer || !group) return [];
    const candidates = nodesLayer.querySelectorAll('.mindmap-card-box, .mindmap-node:not(.is-root)');
    const matches = [];
    candidates.forEach((el) => {
      const nodeId = el.dataset.nodeId;
      const nodeData = findNodeById(nodeId);
      if (!nodeData) return;
      const x = Number.isFinite(parseFloat(el.style.left)) ? parseFloat(el.style.left) : el.offsetLeft;
      const y = Number.isFinite(parseFloat(el.style.top)) ? parseFloat(el.style.top) : el.offsetTop;
      const w = el.offsetWidth || 100;
      const h = el.offsetHeight || 36;
      const cx = x + w / 2;
      const cy = y + h / 2;
      if (cx >= group.x && cx <= group.x + group.w && cy >= group.y && cy <= group.y + group.h) {
        matches.push({ el, nodeData, x, y, w, h });
      }
    });
    matches.sort((a, b) => (Math.abs(a.y - b.y) > 20 ? a.y - b.y : a.x - b.x));
    return matches;
  }

  function updateAllGroupCounts() {
    if (!groupsLayer) return;
    for (const g of docGroups) {
      const badgeEl = groupsLayer.querySelector(`[data-mm-group-badge="${CSS.escape(g.id)}"]`);
      if (badgeEl) {
        const count = computeGroupContainedItems(g).length;
        badgeEl.textContent = `${count} 项`;
      }
    }
  }

  async function exportGroupToNewNote(group, triggerBtn = null) {
    if (!group) return;
    const contained = computeGroupContainedItems(group);
    if (contained.length === 0) {
      showToast('当前分组框内暂无卡片或节点，请先拖入卡片或调整框选范围', 'warning');
      return;
    }

    // Deduplicate ancestor/descendant nodes if both are inside the frame
    const selectedIds = new Set(contained.map((it) => it.nodeData.id));
    const topItems = contained.filter((it) => {
      let parentId = currentParentMap.get(it.nodeData.id);
      while (parentId) {
        if (selectedIds.has(parentId)) return false;
        parentId = currentParentMap.get(parentId);
      }
      return true;
    });

    const sections = topItems
      .map((it) => {
        const range = getNodeLineRange(currentMarkdown, it.nodeData);
        if (range?.subtreeMarkdown) return range.subtreeMarkdown.trim();
        return serializeSubtreeToMarkdown(it.nodeData).trim();
      })
      .filter(Boolean);

    const noteTitle = String(group.title || '新建分组').trim() || '新建分组';
    const content = `# ${noteTitle}\n\n${sections.join('\n\n')}\n`;

    const origText = triggerBtn?.textContent;
    if (triggerBtn) {
      triggerBtn.disabled = true;
      triggerBtn.textContent = '导出中...';
    }

    try {
      const created = await api.post('/api/files/create-note', {
        title: noteTitle,
        content,
      });
      try {
        const filesData = await api.get('/api/files/list');
        store.setState({ files: filesData });
        store.emit('files:updated', filesData);
      } catch {
        store.emit('files:updated', created);
      }
      showToast(`已导出分组「${noteTitle}」为新笔记：${created?.name || `${noteTitle}.md`}`, 'success', {
        duration: 6000,
        actionLabel: '打开新笔记',
        onAction: () => {
          if (created?.path) {
            store.emit('file:open', created);
          }
        },
      });
    } catch (err) {
      showToast(`导出新笔记失败：${err?.message || '未知错误'}`, 'error');
    } finally {
      if (triggerBtn && triggerBtn.isConnected) {
        triggerBtn.disabled = false;
        triggerBtn.textContent = origText || '📤 导出为笔记';
      }
    }
  }

  function startGroupRename(group, titleEl) {
    if (!group || !titleEl) return;
    if (titleEl.dataset.editing === '1') return;
    titleEl.dataset.editing = '1';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'mindmap-group-title-input';
    input.value = group.title || '';
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const commit = (save) => {
      if (done) return;
      done = true;
      const nextTitle = save ? input.value.trim() || group.title : group.title;
      if (save && nextTitle !== group.title) {
        group.title = nextTitle;
        saveDocGroups(docPosKey, docGroups);
      }
      renderGroupFrames();
    };

    input.addEventListener('pointerdown', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        commit(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        commit(false);
      }
    });
    input.addEventListener('blur', () => commit(true));
  }

  function renderGroupFrames() {
    if (!groupsLayer) return;
    groupsLayer.innerHTML = '';
    for (const group of docGroups) {
      const frameEl = document.createElement('div');
      frameEl.className = 'mindmap-group-frame';
      frameEl.dataset.groupId = group.id;
      const gColor = group.color || '#4F46E5';
      frameEl.style.left = `${group.x}px`;
      frameEl.style.top = `${group.y}px`;
      frameEl.style.width = `${group.w}px`;
      frameEl.style.height = `${group.h}px`;
      frameEl.style.background = hexToRgba(gColor, 0.075);
      frameEl.style.border = `1.5px solid ${hexToRgba(gColor, 0.48)}`;

      const colorDotsHtml = GROUP_COLOR_PALETTE.map(
        (c) =>
          `<button type="button" class="mindmap-group-color-dot ${c.hex === gColor ? 'is-active' : ''}" data-mm-group-color="${c.hex}" style="background:${c.hex};" title="${escapeHtml(c.label)}"></button>`
      ).join('');

      frameEl.innerHTML = `
        <div class="mindmap-group-header" data-mm-group-drag="${escapeHtml(group.id)}">
          <span class="mindmap-group-title" data-mm-group-rename="${escapeHtml(group.id)}" title="点击或双击重命名">${escapeHtml(group.title)}</span>
          <span class="mindmap-group-badge" data-mm-group-badge="${escapeHtml(group.id)}">0 项</span>
          <div class="mindmap-group-colors">${colorDotsHtml}</div>
          <button type="button" class="mindmap-group-btn mindmap-group-export" data-mm-group-export="${escapeHtml(group.id)}" title="收集框内卡片导出为新笔记">📤 导出为笔记</button>
          <button type="button" class="mindmap-group-btn mindmap-group-delete" data-mm-group-delete="${escapeHtml(group.id)}" title="删除分组框（保留框内卡片）">✕</button>
        </div>
        <div class="mindmap-group-resize" data-resize-dir="n"></div>
        <div class="mindmap-group-resize" data-resize-dir="s"></div>
        <div class="mindmap-group-resize" data-resize-dir="e"></div>
        <div class="mindmap-group-resize" data-resize-dir="w"></div>
        <div class="mindmap-group-resize" data-resize-dir="ne"></div>
        <div class="mindmap-group-resize" data-resize-dir="nw"></div>
        <div class="mindmap-group-resize" data-resize-dir="sw"></div>
        <div class="mindmap-group-resize" data-resize-dir="se" title="拖拽缩放分组框"></div>
      `;
      groupsLayer.appendChild(frameEl);
    }
    updateAllGroupCounts();
  }

  function createNewGroupFrame() {
    const rect = stageEl?.getBoundingClientRect();
    const sw = rect?.width || 680;
    const sh = rect?.height || 420;
    const w = 460;
    const h = 300;
    const centerWorldX = (sw / 2 - panX) / zoom;
    const centerWorldY = (sh / 2 - panY) / zoom;
    const x = Math.round(centerWorldX - w / 2);
    const y = Math.round(centerWorldY - h / 2);

    const nextTitle = getNextSequentialCardName(
      '新建分组',
      docGroups.map((g) => g.title)
    );
    const colorObj = GROUP_COLOR_PALETTE[docGroups.length % GROUP_COLOR_PALETTE.length];
    const newGroup = {
      id: `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      title: nextTitle,
      x,
      y,
      w,
      h,
      color: colorObj ? colorObj.hex : '#4F46E5',
    };
    docGroups.push(newGroup);
    saveDocGroups(docPosKey, docGroups);
    renderGroupFrames();
    showToast(`已创建分组框「${nextTitle}」，可拖动四边缩放或点击标题改名`, 'info', { duration: 2400 });
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

    const currentCustomColor = getNodeCustomColor(nodeData);
    const colorSwatchesHtml = CUSTOM_COLOR_PALETTE.map((c) => {
      const isDefault = !c.hex;
      const isActive = currentCustomColor === c.hex;
      return `<button type="button"
        class="mindmap-color-swatch ${isDefault ? 'is-default' : ''} ${isActive ? 'is-active' : ''}"
        data-mm-menu="color:${escapeHtml(c.hex)}"
        style="${c.hex ? `background:${c.hex};` : ''}"
        title="${escapeHtml(c.label)}">${isDefault ? '↺' : isActive ? '✓' : ''}</button>`;
    }).join('');

    menu.innerHTML = `
      <div class="context-menu-label">${escapeHtml(nodeData.text.slice(0, 26))}</div>
      <div class="context-menu-label" style="font-size:11px;padding-bottom:2px;">🎨 卡片配色</div>
      <div class="mindmap-color-strip">${colorSwatchesHtml}</div>
      <div class="context-menu-sep"></div>
      ${statusItem('mastered', STATUS_LABEL_MAP.mastered)}
      ${statusItem('review', STATUS_LABEL_MAP.review)}
      ${statusItem('weak', STATUS_LABEL_MAP.weak)}
      ${nodeData.status !== 'none' ? `<button type="button" class="context-menu-item" data-mm-menu="status:none"><span>清除掌握标记</span></button>` : ''}
      <div class="context-menu-sep"></div>
      <button type="button" class="context-menu-item" data-mm-menu="focus-25m"><span>▶ 专注攻克 (25分钟)</span></button>
      <button type="button" class="context-menu-item" data-mm-menu="focus-15s"><span>⚡ 专注演示 (15秒)</span></button>
      <div class="context-menu-sep"></div>
      <button type="button" class="context-menu-item" data-mm-menu="add-child"><span>+ 添加子节点 (Tab)</span></button>
      ${nodeData.lineIdx >= 0 ? `<button type="button" class="context-menu-item" data-mm-menu="add-sibling"><span>+ 添加同级卡片 (Enter)</span></button>` : ''}
      ${nodeData.lineIdx >= 0 ? `<button type="button" class="context-menu-item" data-mm-menu="rename"><span>✎ 编辑节点内容 (F2)</span></button>` : ''}
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

      if (act.startsWith('color:')) {
        const nextHex = act.slice(6);
        setNodeCustomColor(nodeData, nextHex);
        return;
      }

      if (act.startsWith('status:')) {
        const nextStatus = act.slice(7);
        if (nodeData.lineIdx < 0) {
          showToast('虚拟根节点无对应行，请在 Markdown 标题上标记', 'info');
          return;
        }
        currentMarkdown = applyLineTextUpdate(currentMarkdown, nodeData.lineIdx, nodeData.text, nextStatus);
        opts.onUpdateMarkdown?.(currentMarkdown);
        renderTree(false);
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
        addChildToNode(nodeData);
        return;
      }

      if (act === 'add-sibling') {
        addSiblingToNode(nodeData);
        return;
      }

      if (act === 'rename') {
        const targetEl = findEditableTargetEl(nodeData.id);
        if (targetEl) startInlineRename(targetEl, nodeData);
      }
    });

    nodeMenuEl = menu;
  }

  function startInlineRename(targetEl, nodeData) {
    if (!nodeData) return;
    if (nodeData.lineIdx < 0) {
      showToast('根节点名称来自文件名，请添加 # 一级标题后编辑', 'info');
      return;
    }
    closeNodeMenu();
    closeTempEditor(false);

    const anchorEl = targetEl || findEditableTargetEl(nodeData.id);
    if (!anchorEl) return;

    const targetRect = anchorEl.getBoundingClientRect();
    const editorW = Math.min(560, Math.max(360, Math.round(targetRect.width || 360)));
    const editor = document.createElement('div');
    editor.className = 'mindmap-temp-editor';
    editor.setAttribute('role', 'dialog');
    editor.setAttribute('aria-label', '编辑节点内容');
    editor.style.cssText = [
      'position:fixed',
      'z-index:9999',
      `width:${editorW}px`,
      'max-width:calc(100vw - 24px)',
      'background:var(--bg-island)',
      'border:1.5px solid var(--accent)',
      'border-radius:14px',
      'box-shadow:var(--shadow-float)',
      'padding:10px 12px',
      'display:flex',
      'flex-direction:column',
      'gap:8px',
      'color:var(--text-primary)',
    ].join(';');

    const kindBadge = nodeData.kind === 'heading' ? `H${nodeData.headingLevel || 2} 标题` : '列表条目';
    editor.innerHTML = `
      <div class="mindmap-temp-editor-head" style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11.5px;color:var(--text-secondary);">
        <span style="font-weight:600;color:var(--accent);">✎ 编辑${kindBadge}</span>
        <span class="mindmap-temp-editor-count" data-mm-edit-count style="font-family:var(--font-mono);font-size:11px;"></span>
      </div>
      <textarea class="mindmap-temp-editor-input" rows="2" style="width:100%;min-height:64px;box-sizing:border-box;resize:none;overflow:hidden;border:1px solid var(--border-hairline);border-radius:10px;padding:8px 10px;background:var(--bg-subtle);color:var(--text-primary);font-family:var(--font-sans);font-size:13.5px;line-height:1.5;outline:none;"></textarea>
      <div class="mindmap-temp-editor-footer" style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
        <span style="font-size:11px;color:var(--text-tertiary);">Enter 保存 · Shift+Enter 换行 · Esc 取消</span>
        <div style="display:inline-flex;align-items:center;gap:6px;">
          <button type="button" class="pill-btn pill-btn-sm" data-mm-edit-cancel>取消</button>
          <button type="button" class="pill-btn pill-btn-sm pill-btn-primary" data-mm-edit-save>✓ 保存</button>
        </div>
      </div>
    `;

    const initLeft = Math.max(12, Math.min(Math.round(targetRect.left), window.innerWidth - editorW - 12));
    const initTop = Math.max(12, Math.min(Math.round(targetRect.top - 6), window.innerHeight - 180));
    editor.style.left = `${initLeft}px`;
    editor.style.top = `${initTop}px`;
    document.body.appendChild(editor);

    const textarea = editor.querySelector('.mindmap-temp-editor-input');
    const countEl = editor.querySelector('[data-mm-edit-count]');
    textarea.value = nodeData.text || '';

    const syncEditorLayout = () => {
      textarea.style.height = 'auto';
      const maxH = Math.max(150, window.innerHeight - 170);
      const nextH = Math.min(maxH, Math.max(64, textarea.scrollHeight));
      textarea.style.height = `${nextH}px`;
      textarea.style.overflowY = textarea.scrollHeight > maxH ? 'auto' : 'hidden';
      if (countEl) countEl.textContent = `${textarea.value.length} 字`;

      const edRect = editor.getBoundingClientRect();
      const clampedLeft = Math.max(12, Math.min(edRect.left, window.innerWidth - edRect.width - 12));
      const clampedTop = Math.max(12, Math.min(edRect.top, window.innerHeight - edRect.height - 12));
      editor.style.left = `${Math.round(clampedLeft)}px`;
      editor.style.top = `${Math.round(clampedTop)}px`;
    };

    syncEditorLayout();
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    let finished = false;
    const finish = (commitChanges) => {
      if (finished) return;
      finished = true;
      tempEditorState = null;
      const rawVal = textarea.value;
      editor.remove();

      if (!commitChanges) return;
      const normalized = rawVal.replace(/\r?\n+/g, ' ').trim();
      if (!normalized || normalized === nodeData.text) return;

      // Preserve custom card position if renaming a top-level card
      const cardBoxEl = anchorEl.closest('.mindmap-card-box');
      const oldCardKey = cardBoxEl?.dataset?.cardKey;
      if (oldCardKey && docCardPositions[oldCardKey]) {
        const savedPos = docCardPositions[oldCardKey];
        const parts = oldCardKey.split('#');
        const suffix = parts.length > 1 ? parts[parts.length - 1] : '0';
        const newKey = `${nodeData.kind || 'node'}:${nodeData.headingLevel || 0}:${normalized}#${suffix}`;
        delete docCardPositions[oldCardKey];
        docCardPositions[newKey] = savedPos;
        saveDocCardPositions(docPosKey, docCardPositions);
      }

      // Preserve custom color if renaming this node
      const oldColorKey = buildNodeColorKey(nodeData);
      if (oldColorKey && docCustomColors[oldColorKey]) {
        const savedColor = docCustomColors[oldColorKey];
        const newColorKey = `${nodeData.lineIdx >= 0 ? nodeData.lineIdx : 'root'}:${normalized}`;
        delete docCustomColors[oldColorKey];
        docCustomColors[newColorKey] = savedColor;
        saveDocCustomColors(docPosKey, docCustomColors);
      }

      currentMarkdown = applyLineTextUpdate(currentMarkdown, nodeData.lineIdx, normalized, nodeData.status);
      opts.onUpdateMarkdown?.(currentMarkdown);
      renderTree(false);
    };

    tempEditorState = {
      el: editor,
      cleanup: finish,
    };

    textarea.addEventListener('input', syncEditorLayout);
    textarea.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      } else if (e.key === 'Enter' && (!e.shiftKey || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        finish(true);
      }
    });

    editor.querySelector('[data-mm-edit-cancel]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      finish(false);
    });
    editor.querySelector('[data-mm-edit-save]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      finish(true);
    });
  }

  function renderStandardNodeEl(nodeData, layoutNode) {
    const isRoot = layoutNode.level === 0;
    const hasChildren = (nodeData.children?.length || 0) > 0;
    const isCollapsed = collapsedIds.has(nodeData.id);
    const statusCls = nodeData.status !== 'none' ? `status-${nodeData.status}` : '';
    const dirCls = layoutNode.dir === 'left' ? 'is-left' : layoutNode.dir === 'down' ? 'is-down' : '';
    const selectedCls = selectedNodeId === nodeData.id ? 'is-selected' : '';

    const el = document.createElement('div');
    el.className = `mindmap-node ${isRoot ? 'is-root' : ''} ${statusCls} ${dirCls} ${selectedCls}`.trim();
    el.dataset.nodeId = nodeData.id;
    el.style.left = `${layoutNode.x}px`;
    el.style.top = `${layoutNode.y}px`;
    el.style.width = `${layoutNode.w}px`;
    el.style.minHeight = `${layoutNode.h}px`;

    const customColor = getNodeCustomColor(nodeData);
    if (customColor) {
      el.dataset.customColor = customColor;
      if (isRoot) {
        el.style.background = customColor;
        el.style.borderColor = customColor;
        el.style.boxShadow = `0 8px 22px ${hexToRgba(customColor, 0.34)}`;
      } else {
        el.style.borderColor = hexToRgba(customColor, 0.65);
        el.style.borderTop = `3px solid ${customColor}`;
        el.style.background = `linear-gradient(180deg, ${hexToRgba(customColor, 0.14)} 0%, ${hexToRgba(customColor, 0.04)} 100%), var(--bg-island)`;
        el.style.boxShadow = `0 4px 16px ${hexToRgba(customColor, 0.16)}`;
      }
    }

    const milestonePrefix = layoutNode.milestoneBadge
      ? `<span style="font-size:10px;font-weight:700;font-family:var(--font-mono);padding:1px 5px;border-radius:999px;background:var(--accent-soft);color:var(--accent);flex-shrink:0;">${layoutNode.milestoneBadge}</span>`
      : '';

    const renderedHtml = renderMarkdownSafe(nodeData.text || '节点', { compactMedia: true })
      .replace(/^<p>([\s\S]*)<\/p>\n?$/i, '$1');

    const statusDot =
      nodeData.status === 'mastered'
        ? '<span class="mm-status-badge" title="已掌握">🟢</span>'
        : nodeData.status === 'review'
        ? '<span class="mm-status-badge" title="待巩固">🟡</span>'
        : nodeData.status === 'weak'
        ? '<span class="mm-status-badge" title="易错薄弱">🔴</span>'
        : '';

    const editBtn =
      nodeData.lineIdx >= 0
        ? `<button type="button" class="mindmap-node-more" data-mm-edit="${escapeHtml(nodeData.id)}" title="编辑节点内容">✎</button>`
        : '';

    const foldBadge = hasChildren
      ? `<button type="button" class="mindmap-fold-btn" data-mm-fold="${escapeHtml(nodeData.id)}" title="${isCollapsed ? '展开分支' : '折叠分支'}">${isCollapsed ? `+${layoutNode.hiddenCount}` : '−'}</button>`
      : '';

    el.innerHTML = `
      ${milestonePrefix}
      ${statusDot}
      <span class="mindmap-node-label">${renderedHtml}</span>
      ${editBtn}
      <button type="button" class="mindmap-node-more" data-mm-more="${escapeHtml(nodeData.id)}" title="学习状态与专注操作">⋯</button>
      ${foldBadge}
    `;

    el.addEventListener('pointerenter', () => {
      topNodeZIndex += 1;
      el.style.zIndex = String(topNodeZIndex);
    });

    return el;
  }

  function renderCardsBoard(treeRoot) {
    const PADDING_X = 48;
    const PADDING_Y = 42;
    const STACK_STEP_X = 18;
    const STACK_STEP_Y = 56;

    const rootBox = measureNodeBox(treeRoot, true);
    const rootW = Math.max(rootBox.w, 180);
    const rootH = rootBox.h;
    const rootCollapsed = collapsedIds.has(treeRoot.id);
    const topBranches = rootCollapsed ? [] : (treeRoot.children || []);
    const cardKeys = buildCardKeysForBranches(topBranches);

    const stageWidth = Math.max(680, stageEl?.clientWidth || 980);
    const fitCols = Math.floor((stageWidth - PADDING_X * 2 + CARD_COL_GAP) / (CARD_W + CARD_COL_GAP));
    const cols = topBranches.length <= 1 ? 1 : Math.max(2, Math.min(3, fitCols, topBranches.length));
    const boardInnerW = cols * CARD_W + Math.max(0, cols - 1) * CARD_COL_GAP;

    const rootX = PADDING_X + Math.max(0, Math.round((boardInnerW - rootW) / 2));
    const rootY = PADDING_Y;

    const layoutRoot = {
      data: treeRoot,
      level: 0,
      dir: 'center',
      w: rootW,
      h: rootH,
      x: rootX,
      y: rootY,
      hiddenCount: rootCollapsed ? countSubtreeNodes(treeRoot) : 0,
      children: [],
    };

    nodesLayer.innerHTML = '';

    // 1. Mount Root Node
    const rootEl = renderStandardNodeEl(treeRoot, layoutRoot);
    nodesLayer.appendChild(rootEl);

    // 2. Phase 1: Mount real DOM cards into nodesLayer so browser computes exact flow heights
    const cardEntries = topBranches.map((branch, idx) => {
      const accent = CARD_ACCENTS[idx % CARD_ACCENTS.length];
      const cardKey = cardKeys[idx];
      const isCollapsed = collapsedIds.has(branch.id);
      const totalSubCount = countSubtreeNodes(branch);
      const statusCls = branch.status !== 'none' ? `status-${branch.status}` : '';
      const selectedCls = selectedNodeId === branch.id ? 'is-selected' : '';

      const cardEl = document.createElement('div');
      cardEl.className = `mindmap-card-box ${statusCls} ${selectedCls}`.trim();
      cardEl.dataset.nodeId = branch.id;
      cardEl.dataset.cardKey = cardKey;
      cardEl.style.cssText = [
        'position:absolute',
        'left:0px',
        'top:0px',
        `width:${CARD_W}px`,
        'box-sizing:border-box',
        'border-radius:16px',
        'background:var(--bg-island)',
        'border:1.5px solid var(--border-hairline)',
        `border-top:3.5px solid ${accent}`,
        'box-shadow:var(--shadow-island)',
        'display:flex',
        'flex-direction:column',
        'overflow:visible',
        'transition:transform 160ms var(--ease-spring), opacity 160ms var(--ease-apple)',
      ].join(';');

      const headerHtml = renderMarkdownSafe(branch.text || '新建卡片', { compactMedia: true })
        .replace(/^<p>([\s\S]*)<\/p>\n?$/i, '$1');

      const headerStatusDot =
        branch.status === 'mastered'
          ? '<span class="mm-status-badge" title="已掌握">🟢</span>'
          : branch.status === 'review'
          ? '<span class="mm-status-badge" title="待巩固">🟡</span>'
          : branch.status === 'weak'
          ? '<span class="mm-status-badge" title="易错薄弱">🔴</span>'
          : '';

      const headerEl = document.createElement('div');
      headerEl.className = 'mindmap-card-header';
      headerEl.style.cssText = [
        'display:flex',
        'align-items:flex-start',
        'gap:7px',
        'padding:11px 12px 9px',
        isCollapsed ? '' : 'border-bottom:1px solid var(--border-hairline)',
        'cursor:grab',
        'user-select:none',
      ].filter(Boolean).join(';');

      headerEl.innerHTML = `
        <span class="mindmap-card-drag-handle" title="拖拽移动卡片（可拖入顶部灵动岛暂存或底部垃圾桶删除）" style="display:inline-flex;align-items:center;justify-content:center;color:var(--text-tertiary);cursor:grab;padding-top:2px;flex-shrink:0;font-size:13px;line-height:1;">⋮⋮</span>
        ${headerStatusDot}
        <span class="mindmap-card-title mindmap-node-label" style="flex:1;min-width:0;font-size:13.5px;font-weight:650;line-height:1.4;color:var(--text-primary);white-space:normal;word-break:break-word;overflow-wrap:anywhere;display:block;-webkit-line-clamp:unset;">${headerHtml}</span>
        <span class="mindmap-card-count" title="子节点总数" style="flex-shrink:0;font-size:11px;font-weight:600;font-family:var(--font-mono);padding:1px 6px;border-radius:999px;background:var(--bg-subtle);color:var(--text-secondary);">${totalSubCount}</span>
        <div class="mindmap-card-actions" style="display:inline-flex;align-items:center;gap:2px;flex-shrink:0;">
          ${branch.lineIdx >= 0 ? `<button type="button" class="mindmap-card-action-btn" data-mm-edit="${escapeHtml(branch.id)}" title="编辑卡片标题" style="width:22px;height:22px;border-radius:999px;border:none;background:var(--bg-subtle);color:var(--text-secondary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:11.5px;">✎</button>` : ''}
          <button type="button" class="mindmap-card-action-btn mindmap-node-more" data-mm-more="${escapeHtml(branch.id)}" title="更多操作" style="width:22px;height:22px;border-radius:999px;border:none;background:var(--bg-subtle);color:var(--text-secondary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:12px;opacity:1;">⋯</button>
          ${(branch.children?.length || 0) > 0 ? `<button type="button" class="mindmap-card-action-btn" data-mm-fold="${escapeHtml(branch.id)}" title="${isCollapsed ? '展开卡片' : '折叠卡片'}" style="min-width:22px;height:22px;padding:0 5px;border-radius:999px;border:1px solid var(--border-hairline);background:var(--bg-island);color:var(--text-secondary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;">${isCollapsed ? `+${totalSubCount}` : '−'}</button>` : ''}
        </div>
      `;
      cardEl.appendChild(headerEl);

      // Collect descendant items in normal flow
      const flatItems = [];
      if (!isCollapsed) {
        const bodyEl = document.createElement('div');
        bodyEl.className = 'mindmap-card-body';
        bodyEl.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:10px 12px 12px;';

        const walkItems = (parentNode, depthOffset) => {
          if (collapsedIds.has(parentNode.id)) return;
          for (const ch of parentNode.children || []) {
            flatItems.push({ data: ch, depth: depthOffset });
            walkItems(ch, depthOffset + 1);
          }
        };
        walkItems(branch, 2);

        for (const it of flatItems) {
          const item = it.data;
          const indentPx = Math.min(44, Math.max(0, (it.depth - 2) * 14));
          const itemStatusCls = item.status !== 'none' ? `status-${item.status}` : '';
          const itemSelectedCls = selectedNodeId === item.id ? 'is-selected' : '';
          const itemHasChildren = (item.children?.length || 0) > 0;
          const itemCollapsed = collapsedIds.has(item.id);
          const itemHiddenCount = itemCollapsed ? countSubtreeNodes(item) : 0;

          const itemEl = document.createElement('div');
          itemEl.className = `mindmap-card-item ${itemStatusCls} ${itemSelectedCls}`.trim();
          itemEl.dataset.nodeId = item.id;
          itemEl.dataset.depth = String(it.depth);

          let statusBg = 'var(--bg-subtle)';
          let statusBorder = 'var(--border-hairline)';
          if (item.status === 'mastered') {
            statusBg = 'var(--success-soft)';
            statusBorder = 'var(--success)';
          } else if (item.status === 'review') {
            statusBg = 'var(--warning-soft)';
            statusBorder = 'var(--warning)';
          } else if (item.status === 'weak') {
            statusBg = 'var(--danger-soft)';
            statusBorder = 'var(--danger)';
          }

          const guideLeft = it.depth > 2 ? `box-shadow:-8px 0 0 -6px ${accent};` : '';
          itemEl.style.cssText = [
            'display:flex',
            'align-items:flex-start',
            'gap:6px',
            `margin-left:${indentPx}px`,
            'padding:6px 8px',
            'border-radius:10px',
            `background:${statusBg}`,
            `border:1px solid ${statusBorder}`,
            guideLeft,
            'cursor:pointer',
            'position:relative',
          ].filter(Boolean).join(';');

          const itemHtml = renderMarkdownSafe(item.text || '节点', { compactMedia: true })
            .replace(/^<p>([\s\S]*)<\/p>\n?$/i, '$1');

          const itemStatusDot =
            item.status === 'mastered'
              ? '<span class="mm-status-badge" title="已掌握">🟢</span>'
              : item.status === 'review'
              ? '<span class="mm-status-badge" title="待巩固">🟡</span>'
              : item.status === 'weak'
              ? '<span class="mm-status-badge" title="易错薄弱">🔴</span>'
              : '';

          itemEl.innerHTML = `
            <span class="mindmap-card-item-dot" style="width:6px;height:6px;border-radius:50%;background:${accent};margin-top:6px;flex-shrink:0;opacity:${it.depth === 2 ? '0.9' : '0.55'};"></span>
            ${itemStatusDot}
            <span class="mindmap-card-item-label mindmap-node-label" style="flex:1;min-width:0;font-size:12.5px;line-height:1.45;color:var(--text-primary);white-space:normal;word-break:break-word;overflow-wrap:anywhere;display:block;-webkit-line-clamp:unset;">${itemHtml}</span>
            <div class="mindmap-card-item-actions" style="display:inline-flex;align-items:center;gap:2px;flex-shrink:0;">
              ${item.lineIdx >= 0 ? `<button type="button" class="mindmap-card-action-btn" data-mm-edit="${escapeHtml(item.id)}" title="编辑条目" style="width:20px;height:20px;border-radius:999px;border:none;background:transparent;color:var(--text-tertiary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:11px;">✎</button>` : ''}
              <button type="button" class="mindmap-card-action-btn" data-mm-more="${escapeHtml(item.id)}" title="更多操作" style="width:20px;height:20px;border-radius:999px;border:none;background:transparent;color:var(--text-tertiary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:11.5px;">⋯</button>
              ${itemHasChildren ? `<button type="button" class="mindmap-card-action-btn" data-mm-fold="${escapeHtml(item.id)}" title="${itemCollapsed ? '展开' : '折叠'}" style="min-width:20px;height:20px;padding:0 4px;border-radius:999px;border:1px solid var(--border-hairline);background:var(--bg-island);color:var(--text-secondary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;">${itemCollapsed ? `+${itemHiddenCount}` : '−'}</button>` : ''}
            </div>
          `;
          bodyEl.appendChild(itemEl);
        }

        const addChildBtn = document.createElement('button');
        addChildBtn.type = 'button';
        addChildBtn.className = 'mindmap-card-add-child';
        addChildBtn.dataset.mmAddChild = branch.id;
        addChildBtn.textContent = '+ 添加子项';
        addChildBtn.style.cssText = 'align-self:flex-start;margin-top:2px;padding:3px 9px;border-radius:999px;font-size:11.5px;color:var(--text-secondary);background:transparent;border:1px dashed var(--border-hairline);cursor:pointer;';
        bodyEl.appendChild(addChildBtn);

        cardEl.appendChild(bodyEl);
      }

      // Hover z-index lift (cards never obscure each other on hover)
      cardEl.addEventListener('pointerenter', () => {
        if (activeCardDrag && activeCardDrag.cardEl !== cardEl) return;
        topCardZIndex += 1;
        cardEl.style.zIndex = String(topCardZIndex);
        cardEl.classList.add('is-hovered');
        if (!cardEl.classList.contains('is-dragging')) {
          cardEl.style.transform = 'translateY(-3px) scale(1.02)';
          cardEl.style.boxShadow = 'var(--shadow-float)';
          cardEl.style.borderColor = 'var(--accent)';
        }
      });

      cardEl.addEventListener('pointerleave', () => {
        cardEl.classList.remove('is-hovered');
        if (!cardEl.classList.contains('is-dragging')) {
          cardEl.style.transform = '';
          cardEl.style.boxShadow = 'var(--shadow-island)';
          cardEl.style.borderColor = 'var(--border-hairline)';
        }
      });

      nodesLayer.appendChild(cardEl);
      return { branch, idx, accent, cardKey, cardEl, headerEl };
    });

    // 3. Phase 2: Measure real offsetHeight & compute Shortest-Column Masonry or Stack layout
    const measuredRootW = Math.max(rootW, rootEl.offsetWidth || rootW);
    const measuredRootH = Math.max(rootH, rootEl.offsetHeight || rootH);
    layoutRoot.w = measuredRootW;
    layoutRoot.h = measuredRootH;

    const colHeights = new Array(cols).fill(PADDING_Y + measuredRootH + 46);
    const stackCols = cardEntries.length <= 2 ? 1 : cardEntries.length <= 6 ? 2 : 3;
    const cardsPerStack = Math.max(1, Math.ceil(cardEntries.length / stackCols));
    const stackBaseY = PADDING_Y + measuredRootH + 48;

    const exportCards = [];
    const exportNodes = [layoutRoot];
    const exportEdges = [];
    const edgeHtmlParts = [];

    let maxRight = Math.max(460, rootX + measuredRootW + PADDING_X);
    let maxBottom = Math.max(280, rootY + measuredRootH + PADDING_Y + 80);

    cardEntries.forEach((entry, i) => {
      const realH = Math.max(76, entry.cardEl.offsetHeight || 96);
      const savedPos = docCardPositions[entry.cardKey];
      let cardX = 0;
      let cardY = 0;
      let baseZ = 10 + i;

      if (savedPos && Number.isFinite(savedPos.x) && Number.isFinite(savedPos.y)) {
        cardX = Math.round(savedPos.x);
        cardY = Math.round(savedPos.y);
      } else if (isCardsStack) {
        const stackIdx = Math.floor(i / cardsPerStack);
        const posInStack = i % cardsPerStack;
        const deckSpanW = CARD_W + Math.max(0, cardsPerStack - 1) * STACK_STEP_X;
        cardX = PADDING_X + stackIdx * (deckSpanW + 38) + posInStack * STACK_STEP_X;
        cardY = stackBaseY + posInStack * STACK_STEP_Y;
        baseZ = 10 + stackIdx * 12 + posInStack;
      } else {
        let shortestCol = 0;
        for (let c = 1; c < cols; c += 1) {
          if (colHeights[c] < colHeights[shortestCol]) shortestCol = c;
        }
        cardX = PADDING_X + shortestCol * (CARD_W + CARD_COL_GAP);
        cardY = colHeights[shortestCol];
        colHeights[shortestCol] = cardY + realH + CARD_ROW_GAP;
      }

      entry.x = cardX;
      entry.y = cardY;
      entry.w = CARD_W;
      entry.h = realH;
      entry.cardEl.style.left = `${cardX}px`;
      entry.cardEl.style.top = `${cardY}px`;
      entry.cardEl.style.zIndex = String(baseZ);

      maxRight = Math.max(maxRight, cardX + CARD_W + PADDING_X);
      maxBottom = Math.max(maxBottom, cardY + realH + PADDING_Y + 24);

      const cardRect = { x: cardX, y: cardY, w: CARD_W, h: realH };
      exportCards.push({ ...cardRect, title: entry.branch.text, accent: entry.accent });
      exportEdges.push({ from: layoutRoot, to: cardRect, dir: 'card' });
      edgeHtmlParts.push(
        `<path class="mindmap-edge" data-card-edge-id="${escapeHtml(entry.branch.id)}" d="${buildCardEdgePathD(layoutRoot, cardRect)}" />`
      );

      // Record header & item rects for SVG/PNG export fidelity
      exportNodes.push({
        data: entry.branch,
        level: 1,
        dir: 'card',
        x: cardX + 10,
        y: cardY + 10,
        w: CARD_W - 20,
        h: Math.max(28, entry.headerEl.offsetHeight || 34),
      });
      entry.cardEl.querySelectorAll('.mindmap-card-item').forEach((itemEl) => {
        const itemData = currentNodeMap.get(itemEl.dataset.nodeId);
        if (!itemData) return;
        exportNodes.push({
          data: itemData,
          level: Number(itemEl.dataset.depth) || 2,
          dir: 'card',
          x: cardX + itemEl.offsetLeft,
          y: cardY + itemEl.offsetTop,
          w: Math.max(80, itemEl.offsetWidth || CARD_W - 36),
          h: Math.max(24, itemEl.offsetHeight || 30),
        });
      });
    });

    // If Stack Mode or empty board, center root over actual board span
    if (isCardsStack && cardEntries.length > 0) {
      const cardsMinX = Math.min(...cardEntries.map((c) => c.x));
      const cardsMaxX = Math.max(...cardEntries.map((c) => c.x + c.w));
      const nextRootX = Math.max(PADDING_X, Math.round((cardsMinX + cardsMaxX - measuredRootW) / 2));
      layoutRoot.x = nextRootX;
      rootEl.style.left = `${nextRootX}px`;
      maxRight = Math.max(maxRight, nextRootX + measuredRootW + PADDING_X);
      edgeHtmlParts.length = 0;
      exportEdges.length = 0;
      for (const entry of cardEntries) {
        const cardRect = { x: entry.x, y: entry.y, w: entry.w, h: entry.h };
        exportEdges.push({ from: layoutRoot, to: cardRect, dir: 'card' });
        edgeHtmlParts.push(
          `<path class="mindmap-edge" data-card-edge-id="${escapeHtml(entry.branch.id)}" d="${buildCardEdgePathD(layoutRoot, cardRect)}" />`
        );
      }
    }

    const totalW = Math.ceil(maxRight);
    const totalH = Math.ceil(maxBottom);

    if (svgEl) {
      svgEl.setAttribute('width', String(totalW));
      svgEl.setAttribute('height', String(totalH));
      svgEl.setAttribute('viewBox', `0 0 ${totalW} ${totalH}`);
      svgEl.innerHTML = edgeHtmlParts.join('');
    }
    if (nodesLayer) {
      nodesLayer.style.width = `${totalW}px`;
      nodesLayer.style.height = `${totalH}px`;
    }

    currentLayout = {
      template: 'cards',
      root: layoutRoot,
      nodes: exportNodes,
      edges: exportEdges,
      spines: [],
      cards: exportCards,
      cardEntries,
      width: totalW,
      height: totalH,
    };
  }

  function renderTree(shouldCenter = false) {
    closeNodeMenu();
    closeTempEditor(false);
    const treeRoot = parseMarkdownToTree(currentMarkdown, docName);
    currentTreeRoot = treeRoot;

    // Index all nodes in tree by id for O(1) lookup
    currentNodeMap = new Map();
    const indexNodes = (n) => {
      if (!n) return;
      currentNodeMap.set(n.id, n);
      for (const ch of n.children || []) indexNodes(ch);
    };
    indexNodes(treeRoot);

    syncCardsToolbarState();

    if (currentTemplate === 'cards') {
      renderCardsBoard(treeRoot);
    } else {
      currentLayout = computeTemplateLayout(currentTemplate, treeRoot, collapsedIds);

      if (svgEl) {
        svgEl.setAttribute('width', String(currentLayout.width));
        svgEl.setAttribute('height', String(currentLayout.height));
        svgEl.setAttribute('viewBox', `0 0 ${currentLayout.width} ${currentLayout.height}`);

        const spinesSvg = (currentLayout.spines || [])
          .map(
            (s) =>
              `<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" stroke="${s.kind === 'main-spine' ? 'var(--accent)' : 'var(--text-tertiary)'}" stroke-opacity="${s.kind === 'main-spine' ? '0.65' : '0.45'}" stroke-width="${s.kind === 'main-spine' ? '3.5' : '2'}" stroke-linecap="round" />`
          )
          .join('');

        const edgesSvg = currentLayout.edges
          .map((edge) => `<path class="mindmap-edge" d="${buildEdgePathD(edge)}" />`)
          .join('');

        svgEl.innerHTML = `${spinesSvg}${edgesSvg}`;
      }

      if (nodesLayer) {
        nodesLayer.style.width = `${currentLayout.width}px`;
        nodesLayer.style.height = `${currentLayout.height}px`;
        nodesLayer.innerHTML = '';

        for (const n of currentLayout.nodes) {
          const el = renderStandardNodeEl(n.data, n);
          nodesLayer.appendChild(el);
        }
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
    const tplBtn = e.target.closest('[data-mm-tpl]');
    if (tplBtn) {
      const nextTpl = tplBtn.dataset.mmTpl;
      if (nextTpl && nextTpl !== currentTemplate) {
        currentTemplate = nextTpl;
        try {
          localStorage.setItem(TEMPLATE_STORAGE_KEY, currentTemplate);
        } catch {
          // ignore
        }
        containerEl.querySelectorAll('[data-mm-tpl]').forEach((b) => {
          b.classList.toggle('pill-btn-primary', b.dataset.mmTpl === currentTemplate);
        });
        renderTree(true);
      }
      return;
    }

    const cardsModeBtn = e.target.closest('[data-mm-cards-mode]');
    if (cardsModeBtn) {
      const nextStack = cardsModeBtn.dataset.mmCardsMode === 'stack';
      if (nextStack !== isCardsStack) {
        isCardsStack = nextStack;
        try {
          localStorage.setItem(CARDS_STACK_STORAGE_KEY, isCardsStack ? 'stack' : 'tile');
        } catch {
          // ignore
        }
        renderTree(true);
      }
      return;
    }

    const btn = e.target.closest('[data-mm-act]');
    if (!btn) return;
    const act = btn.dataset.mmAct;
    if (act === 'zoom-in') {
      zoomAtPoint(zoom * 1.16);
    } else if (act === 'zoom-out') {
      zoomAtPoint(zoom / 1.16);
    } else if (act === 'center') {
      fitCenter();
    } else if (act === 'add-root-card') {
      if (currentTreeRoot) {
        collapsedIds.delete(currentTreeRoot.id);
        addChildToNode(currentTreeRoot);
      }
    } else if (act === 'reset-card-pos') {
      if (Object.keys(docCardPositions).length === 0) return;
      docCardPositions = {};
      saveDocCardPositions(docPosKey, docCardPositions);
      renderTree(true);
      showToast('已重置卡片自动排布', 'success');
    } else if (act === 'ai-generate') {
      opts.onAiGenerate?.();
    } else if (act === 'export-svg') {
      if (!currentLayout) return;
      const svgText = buildExportSvgString(currentLayout);
      triggerFileDownload(new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' }), `${baseTitle}_${currentTemplate}.svg`);
      showToast('已导出 SVG 矢量知识图', 'success');
    } else if (act === 'export-png') {
      if (!currentLayout) return;
      const svgText = buildExportSvgString(currentLayout);
      const svgBlob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(svgBlob);
      const img = new Image();
      img.onload = () => {
        const scale = 2;
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
              triggerFileDownload(pngBlob, `${baseTitle}_${currentTemplate}.png`);
              showToast('已导出 PNG 知识图', 'success');
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

  // Stage interactions: card drag, pan, pointer-anchored wheel zoom, portal pill click, fold, edit, more, dblclick, right-click
  if (stageEl) {
    let panning = false;
    let panStartX = 0;
    let panStartY = 0;
    let origPanX = 0;
    let origPanY = 0;

    const TRASH_ZONE_SEL = '#portable-trash-dock, [data-drop-zone="trash"], [data-drop-zone="app-trash"], [data-drop-zone="system-trash"]';
    const clearDropZoneHighlights = () => {
      document
        .querySelectorAll('#portable-trash-dock.is-drag-over, [data-drop-zone].is-drag-over, #dynamic-island.is-drag-over, #island-shelf-drawer.is-drag-over')
        .forEach((el) => el.classList.remove('is-drag-over'));
    };

    stageEl.addEventListener('pointerdown', (e) => {
      const rect = stageEl.getBoundingClientRect();
      lastPointer.x = e.clientX - rect.left;
      lastPointer.y = e.clientY - rect.top;
      if (e.button !== 0) return;

      // Check card header drag first (never conflict with stage panning)
      const cardHeaderEl = e.target.closest('.mindmap-card-header');
      if (cardHeaderEl && !e.target.closest('button, .anchor-pill, [data-media-file], input, textarea')) {
        const cardEl = cardHeaderEl.closest('.mindmap-card-box');
        const branchId = cardEl?.dataset?.nodeId;
        const branchData = findNodeById(branchId);
        if (cardEl && branchData) {
          closeNodeMenu();
          closeTempEditor(false);
          const origX = parseFloat(cardEl.style.left) || 0;
          const origY = parseFloat(cardEl.style.top) || 0;
          const cardKey = cardEl.dataset.cardKey || '';
          const lineInfo = getNodeLineRange(currentMarkdown, branchData);

          activeCardDrag = {
            pointerId: e.pointerId,
            cardEl,
            headerEl: cardHeaderEl,
            branchData,
            cardKey,
            startClientX: e.clientX,
            startClientY: e.clientY,
            origX,
            origY,
            curX: origX,
            curY: origY,
            cardW: cardEl.offsetWidth || CARD_W,
            cardH: cardEl.offsetHeight || 100,
            hasDragged: false,
            lineInfo,
          };
          try {
            stageEl.setPointerCapture?.(e.pointerId);
          } catch {
            // ignore
          }
          return;
        }
      }

      if (e.target.closest('.mindmap-node, .mindmap-card-box, button, input, textarea')) return;
      closeNodeMenu();
      closeTempEditor(false);
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
      const rect = stageEl.getBoundingClientRect();
      lastPointer.x = e.clientX - rect.left;
      lastPointer.y = e.clientY - rect.top;

      if (activeCardDrag && e.pointerId === activeCardDrag.pointerId) {
        const dxClient = e.clientX - activeCardDrag.startClientX;
        const dyClient = e.clientY - activeCardDrag.startClientY;

        if (!activeCardDrag.hasDragged && Math.hypot(dxClient, dyClient) > 8) {
          activeCardDrag.hasDragged = true;
          topCardZIndex += 1;
          activeCardDrag.cardEl.style.zIndex = String(topCardZIndex);
          activeCardDrag.cardEl.classList.add('is-dragging');
          activeCardDrag.cardEl.style.transition = 'none';
          activeCardDrag.cardEl.style.boxShadow = 'var(--shadow-float)';
          activeCardDrag.cardEl.style.borderColor = 'var(--accent)';
          activeCardDrag.headerEl.style.cursor = 'grabbing';

          const info = activeCardDrag.lineInfo;
          store.beginGlobalDrag?.({
            type: 'mindmap-card',
            title: activeCardDrag.branchData.text,
            markdown: info?.subtreeMarkdown || `## ${activeCardDrag.branchData.text}`,
            lineIndex: info?.startLine ?? activeCardDrag.branchData.lineIdx,
            endLineIndex: info?.endLine ?? activeCardDrag.branchData.lineIdx,
            sourceDocPath: currentDocPath,
          });
        }

        if (activeCardDrag.hasDragged) {
          const nextX = Math.round(activeCardDrag.origX + dxClient / zoom);
          const nextY = Math.round(activeCardDrag.origY + dyClient / zoom);
          activeCardDrag.curX = nextX;
          activeCardDrag.curY = nextY;
          activeCardDrag.cardEl.style.left = `${nextX}px`;
          activeCardDrag.cardEl.style.top = `${nextY}px`;

          // Live update connected Bezier edge
          if (svgEl && currentLayout?.root) {
            const edgeEl = svgEl.querySelector(`[data-card-edge-id="${CSS.escape(activeCardDrag.branchData.id)}"]`);
            if (edgeEl) {
              edgeEl.setAttribute(
                'd',
                buildCardEdgePathD(currentLayout.root, {
                  x: nextX,
                  y: nextY,
                  w: activeCardDrag.cardW,
                  h: activeCardDrag.cardH,
                })
              );
            }
          }

          // Drop zone hover feedback
          clearDropZoneHighlights();
          const hitEls = document.elementsFromPoint(e.clientX, e.clientY);
          const trashTarget = hitEls.find((el) => el.matches?.(TRASH_ZONE_SEL))
            || hitEls.map((el) => el.closest?.(TRASH_ZONE_SEL)).find(Boolean);
          const shelfTarget = !trashTarget
            ? hitEls.find((el) => el.matches?.('[data-drop-zone="drag-shelf"], #dynamic-island, #island-shelf-drawer'))
              || hitEls.map((el) => el.closest?.('[data-drop-zone="drag-shelf"], #dynamic-island, #island-shelf-drawer')).find(Boolean)
            : null;

          if (trashTarget) {
            trashTarget.classList.add('is-drag-over');
            activeCardDrag.cardEl.style.opacity = '0.72';
          } else if (shelfTarget) {
            shelfTarget.classList.add('is-drag-over');
            activeCardDrag.cardEl.style.opacity = '0.84';
          } else {
            activeCardDrag.cardEl.style.opacity = '1';
          }
        }
        return;
      }

      if (!panning) return;
      panX = Math.round(origPanX + (e.clientX - panStartX));
      panY = Math.round(origPanY + (e.clientY - panStartY));
      applyTransform();
    });

    const endCardDrag = (e, cancelled = false) => {
      if (!activeCardDrag) return;
      const drag = activeCardDrag;
      activeCardDrag = null;

      if (e?.pointerId != null) {
        try {
          stageEl.releasePointerCapture?.(e.pointerId);
        } catch {
          // ignore
        }
      }

      drag.cardEl.classList.remove('is-dragging');
      drag.cardEl.style.transition = 'transform 160ms var(--ease-spring), opacity 160ms var(--ease-apple)';
      drag.cardEl.style.opacity = '1';
      drag.cardEl.style.boxShadow = 'var(--shadow-island)';
      drag.cardEl.style.borderColor = 'var(--border-hairline)';
      drag.headerEl.style.cursor = 'grab';
      clearDropZoneHighlights();

      if (!drag.hasDragged) return;

      try {
        if (cancelled) {
          drag.cardEl.style.left = `${drag.origX}px`;
          drag.cardEl.style.top = `${drag.origY}px`;
          const edgeEl = svgEl?.querySelector(`[data-card-edge-id="${CSS.escape(drag.branchData.id)}"]`);
          if (edgeEl && currentLayout?.root) {
            edgeEl.setAttribute('d', buildCardEdgePathD(currentLayout.root, { x: drag.origX, y: drag.origY, w: drag.cardW, h: drag.cardH }));
          }
          return;
        }

        const hitEls = document.elementsFromPoint(e.clientX, e.clientY);
        const overTrash = hitEls.some(
          (el) => el.matches?.(TRASH_ZONE_SEL) || el.closest?.(TRASH_ZONE_SEL)
        );
        const overShelf =
          !overTrash &&
          hitEls.some(
            (el) => el.matches?.('[data-drop-zone="drag-shelf"], #dynamic-island, #island-shelf-drawer') || el.closest?.('[data-drop-zone="drag-shelf"], #dynamic-island, #island-shelf-drawer')
          );

        const info = drag.lineInfo;
        const subtreeMd = info?.subtreeMarkdown || `## ${drag.branchData.text}`;

        if (overTrash) {
          if (info && info.startLine >= 0) {
            currentMarkdown = removeLineRangeFromMarkdown(currentMarkdown, info.startLine, info.endLine);
            opts.onUpdateMarkdown?.(currentMarkdown);
          }
          if (drag.cardKey && docCardPositions[drag.cardKey]) {
            delete docCardPositions[drag.cardKey];
            saveDocCardPositions(docPosKey, docCardPositions);
          }
          store.trashVirtualItem?.({
            kind: 'mindmap-card',
            title: drag.branchData.text,
            payload: { markdown: subtreeMd, docPath: currentDocPath },
          });
          showToast(`已将卡片「${drag.branchData.text}」移入回收站`, 'info');
          renderTree(false);
          return;
        }

        if (overShelf) {
          // Restore card position visually & emit shelf add
          drag.cardEl.style.left = `${drag.origX}px`;
          drag.cardEl.style.top = `${drag.origY}px`;
          const edgeEl = svgEl?.querySelector(`[data-card-edge-id="${CSS.escape(drag.branchData.id)}"]`);
          if (edgeEl && currentLayout?.root) {
            edgeEl.setAttribute('d', buildCardEdgePathD(currentLayout.root, { x: drag.origX, y: drag.origY, w: drag.cardW, h: drag.cardH }));
          }
          const prevLen = Array.isArray(store.state.shelfItems) ? store.state.shelfItems.length : 0;
          store.emit('shelf:add-item', {
            kind: 'text',
            title: drag.branchData.text,
            content: subtreeMd,
            sourceDocPath: currentDocPath,
          });
          const afterLen = Array.isArray(store.state.shelfItems) ? store.state.shelfItems.length : 0;
          if (afterLen === prevLen && typeof store.addToShelf === 'function') {
            store.addToShelf({
              type: 'text',
              label: drag.branchData.text,
              markdown: subtreeMd,
              path: currentDocPath,
            });
          }
          showToast(`已将卡片「${drag.branchData.text}」收入灵动岛暂存舱`, 'success');
          return;
        }

        // Dropped inside canvas: persist custom coordinates
        if (drag.cardKey) {
          docCardPositions[drag.cardKey] = { x: drag.curX, y: drag.curY };
          saveDocCardPositions(docPosKey, docCardPositions);
          syncCardsToolbarState();
        }

        // Expand SVG / layer bounds if dragged outside current box
        const needW = Math.max(currentLayout?.width || 460, drag.curX + drag.cardW + 48);
        const needH = Math.max(currentLayout?.height || 280, drag.curY + drag.cardH + 48);
        if (currentLayout && (needW > currentLayout.width || needH > currentLayout.height)) {
          currentLayout.width = Math.ceil(needW);
          currentLayout.height = Math.ceil(needH);
          svgEl?.setAttribute('width', String(currentLayout.width));
          svgEl?.setAttribute('height', String(currentLayout.height));
          svgEl?.setAttribute('viewBox', `0 0 ${currentLayout.width} ${currentLayout.height}`);
          if (nodesLayer) {
            nodesLayer.style.width = `${currentLayout.width}px`;
            nodesLayer.style.height = `${currentLayout.height}px`;
          }
        }
      } finally {
        store.endGlobalDrag?.();
      }
    };

    const endPan = (e) => {
      if (activeCardDrag && e?.pointerId === activeCardDrag.pointerId) {
        endCardDrag(e, e.type === 'pointercancel');
        return;
      }
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
        const rect = stageEl.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        lastPointer.x = mx;
        lastPointer.y = my;
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        zoomAtPoint(zoom * factor, mx, my);
      },
      { passive: false }
    );

    stageEl.addEventListener('click', (e) => {
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

      const mediaEl = e.target.closest('[data-media-file]');
      if (mediaEl) {
        e.stopPropagation();
        const payload = {
          type: 'media',
          file: mediaEl.dataset.mediaFile || '',
          time: mediaEl.dataset.mediaTime || '',
        };
        if (typeof opts.onAnchorClick === 'function') {
          opts.onAnchorClick(payload);
        } else {
          store.emit('anchor:jump', payload);
        }
        return;
      }

      const editBtn = e.target.closest('[data-mm-edit]');
      if (editBtn) {
        e.stopPropagation();
        const id = editBtn.dataset.mmEdit;
        const nodeData = findNodeById(id);
        const targetEl = findEditableTargetEl(id);
        if (nodeData && targetEl) {
          startInlineRename(targetEl, nodeData);
        }
        return;
      }

      const addChildBtn = e.target.closest('[data-mm-add-child]');
      if (addChildBtn) {
        e.stopPropagation();
        const nodeData = findNodeById(addChildBtn.dataset.mmAddChild);
        if (nodeData) {
          addChildToNode(nodeData);
        }
        return;
      }

      const foldBtn = e.target.closest('[data-mm-fold]');
      if (foldBtn) {
        e.stopPropagation();
        const id = foldBtn.dataset.mmFold;
        if (collapsedIds.has(id)) collapsedIds.delete(id);
        else collapsedIds.add(id);
        renderTree(false);
        return;
      }

      const moreBtn = e.target.closest('[data-mm-more]');
      if (moreBtn) {
        e.stopPropagation();
        const nodeData = findNodeById(moreBtn.dataset.mmMore);
        if (nodeData) {
          const rect = moreBtn.getBoundingClientRect();
          openNodeContextMenu(nodeData, rect.right + 4, rect.bottom + 4);
        }
        return;
      }

      // Select clicked node/card item for keyboard shortcuts (Tab/Enter/F2)
      const clickedTarget = e.target.closest('.mindmap-card-item, .mindmap-card-box, .mindmap-node');
      if (clickedTarget && clickedTarget.dataset.nodeId) {
        selectedNodeId = clickedTarget.dataset.nodeId;
        nodesLayer?.querySelectorAll('.is-selected').forEach((el) => el.classList.remove('is-selected'));
        clickedTarget.classList.add('is-selected');
        stageEl.focus({ preventScroll: true });
      }
    });

    stageEl.addEventListener('dblclick', (e) => {
      if (e.target.closest('.anchor-pill, [data-media-file], button, input, textarea')) return;
      const itemEl = e.target.closest('.mindmap-card-item');
      if (itemEl) {
        const nodeData = findNodeById(itemEl.dataset.nodeId);
        if (nodeData) startInlineRename(itemEl, nodeData);
        return;
      }
      const headerEl = e.target.closest('.mindmap-card-header');
      if (headerEl) {
        const cardEl = headerEl.closest('.mindmap-card-box');
        const nodeData = findNodeById(cardEl?.dataset?.nodeId);
        if (nodeData) startInlineRename(headerEl, nodeData);
        return;
      }
      const nodeEl = e.target.closest('.mindmap-node');
      if (nodeEl) {
        const nodeData = findNodeById(nodeEl.dataset.nodeId);
        if (nodeData) startInlineRename(nodeEl, nodeData);
      }
    });

    stageEl.addEventListener('contextmenu', (e) => {
      const targetEl = e.target.closest('.mindmap-card-item, .mindmap-card-box, .mindmap-node');
      e.preventDefault();
      e.stopPropagation();
      if (targetEl) {
        const nodeData = findNodeById(targetEl.dataset.nodeId);
        if (nodeData) {
          selectedNodeId = nodeData.id;
          openNodeContextMenu(nodeData, e.clientX, e.clientY);
        }
      } else {
        closeNodeMenu();
      }
    });

    stageEl.addEventListener('keydown', (e) => {
      if (tempEditorState) return;
      if (e.target.closest('input, textarea')) return;
      const selNode = selectedNodeId ? findNodeById(selectedNodeId) : null;
      if (!selNode) return;

      if (e.key === 'Tab') {
        e.preventDefault();
        addChildToNode(selNode);
      } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        addSiblingToNode(selNode);
      } else if (e.key === 'F2') {
        e.preventDefault();
        const targetEl = findEditableTargetEl(selNode.id);
        if (targetEl) startInlineRename(targetEl, selNode);
      }
    });
  }

  // Listen for trash virtual restore of mindmap-card
  const unsubscribeRestore = store.on('trash:restore-virtual', (item) => {
    if (!containerEl.isConnected) {
      destroy();
      return;
    }
    if (!item || item.kind !== 'mindmap-card') return;
    if (typeof opts.onUpdateMarkdown !== 'function') return;

    const itemPath = String(item.payload?.docPath || '');
    if (itemPath && currentDocPath && itemPath !== currentDocPath) return;

    const restoredMd = String(item.payload?.markdown || '').trim();
    if (!restoredMd) return;

    const trimmed = currentMarkdown.trimEnd();
    currentMarkdown = trimmed ? `${trimmed}\n\n${restoredMd}\n` : `${restoredMd}\n`;
    opts.onUpdateMarkdown(currentMarkdown);
    renderTree(false);
    showToast(`已将卡片「${item.title || '知识卡片'}」还原到脑图`, 'success');
  });

  const dismissDocHandler = (e) => {
    if (!containerEl.isConnected) {
      destroy();
      return;
    }
    if (nodeMenuEl && !e.target.closest('.mindmap-node-menu')) {
      closeNodeMenu();
    }
    if (tempEditorState && !e.target.closest('.mindmap-temp-editor')) {
      closeTempEditor(true);
    }
  };
  document.addEventListener('pointerdown', dismissDocHandler);

  function destroy() {
    document.removeEventListener('pointerdown', dismissDocHandler);
    if (typeof unsubscribeRestore === 'function') unsubscribeRestore();
    closeNodeMenu();
    closeTempEditor(false);
    if (activeCardDrag) {
      store.endGlobalDrag?.();
      activeCardDrag = null;
    }
  }

  renderTree(true);

  return {
    update(nextMd) {
      currentMarkdown = String(nextMd ?? '');
      renderTree(false);
    },
    fitCenter,
    destroy,
  };
}
