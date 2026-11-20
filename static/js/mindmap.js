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
import { icon } from './icons.js';

const TEMPLATE_STORAGE_KEY = 'sln_mindmap_template_v1';

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
  const COL_GAP = 28;
  const ROW_GAP = 28;
  const CARD_W = 304;
  const nodesList = [];
  const edgesList = [];
  const cards = [];

  const rootBox = measureNodeBox(root, true);
  const rootCollapsed = collapsedIds.has(root.id);
  const topBranches = rootCollapsed ? [] : (root.children || []);

  const cols = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(Math.max(1, topBranches.length)))));
  const boardInnerW = cols * CARD_W + Math.max(0, cols - 1) * COL_GAP;

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

  const colHeights = new Array(cols).fill(PADDING_Y + rootBox.h + 40);

  topBranches.forEach((branch, idx) => {
    const colIdx = idx % cols;
    const cardX = PADDING_X + colIdx * (CARD_W + COL_GAP);
    const cardY = colHeights[colIdx];

    const bBox = measureNodeBox(branch, false);
    const bCollapsed = collapsedIds.has(branch.id);
    const headerNode = {
      data: branch,
      level: 1,
      dir: 'card',
      w: CARD_W - 28,
      h: bBox.h,
      x: cardX + 14,
      y: cardY + 14,
      hiddenCount: bCollapsed ? countSubtreeNodes(branch) : 0,
      children: [],
    };
    nodesList.push(headerNode);

    let curItemY = cardY + 14 + bBox.h + 12;

    function placeCardDescendants(parentNode, depthOffset) {
      if (collapsedIds.has(parentNode.id)) return;
      for (const ch of parentNode.children || []) {
        const box = measureNodeBox(ch, false);
        const indent = Math.min(48, (depthOffset - 2) * 16);
        const itemNode = {
          data: ch,
          level: depthOffset,
          dir: 'card',
          w: CARD_W - 28 - indent,
          h: box.h,
          x: cardX + 14 + indent,
          y: curItemY,
          hiddenCount: collapsedIds.has(ch.id) ? countSubtreeNodes(ch) : 0,
          children: [],
        };
        nodesList.push(itemNode);
        curItemY += box.h + 8;
        placeCardDescendants(ch, depthOffset + 1);
      }
    }
    placeCardDescendants(branch, 2);

    const cardH = Math.max(82, curItemY - cardY + 10);
    cards.push({
      x: cardX,
      y: cardY,
      w: CARD_W,
      h: cardH,
      title: branch.text,
    });

    edgesList.push({
      from: layoutRoot,
      to: headerNode,
      dir: 'down',
    });

    colHeights[colIdx] = cardY + cardH + ROW_GAP;
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

function buildEdgePathD(edge) {
  const { from, to, dir } = edge;
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

  const cardsSvg = (layout.cards || [])
    .map(
      (c) =>
        `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="16" fill="rgba(255,255,255,0.75)" stroke="rgba(0,0,0,0.1)" stroke-width="1.5"/>`
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

  const docName = String(opts.docName || '笔记脑图');
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

  let zoom = 1;
  let panX = 0;
  let panY = 0;
  const lastPointer = { x: null, y: null };
  let currentLayout = null;
  let nodeMenuEl = null;

  const baseTitle = docName.replace(/\.[^.]+$/, '') || 'mindmap';

  const templateBtnsHtml = TEMPLATE_LIST.map(
    (t) =>
      `<button type="button" class="pill-btn pill-btn-sm ${t.id === currentTemplate ? 'pill-btn-primary' : ''}" data-mm-tpl="${t.id}" title="${escapeHtml(t.title)}">${escapeHtml(t.label)}</button>`
  ).join('');

  containerEl.innerHTML = `
    <div class="mindmap-shell">
      <div class="mindmap-toolbar">
        <div class="mindmap-toolbar-group" data-mm-role="tpl-group" style="display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap;">
          <span style="font-size:11.5px;font-weight:600;color:var(--text-tertiary);margin-right:2px;">知识视图:</span>
          ${templateBtnsHtml}
        </div>
        <div class="mindmap-toolbar-group">
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
      <div class="mindmap-stage" id="mindmap-canvas">
        <div class="mindmap-viewport" data-mm-role="viewport" style="transform-origin:0 0;">
          <svg class="mindmap-svg" data-mm-role="svg"></svg>
          <div class="mindmap-nodes-layer" data-mm-role="nodes"></div>
        </div>
        <div class="mindmap-hint-pill">滚轮按鼠标指针位置定点缩放 · 拖动画布 · 顶部切换 6 种知识梳理模板 · 双击节点改名</div>
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
    currentLayout = computeTemplateLayout(currentTemplate, treeRoot, collapsedIds);

    if (svgEl) {
      svgEl.setAttribute('width', String(currentLayout.width));
      svgEl.setAttribute('height', String(currentLayout.height));
      svgEl.setAttribute('viewBox', `0 0 ${currentLayout.width} ${currentLayout.height}`);

      const cardsSvg = (currentLayout.cards || [])
        .map(
          (c) =>
            `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="16" fill="var(--bg-glass)" stroke="var(--border-hairline)" stroke-width="1.5" />`
        )
        .join('');

      const spinesSvg = (currentLayout.spines || [])
        .map(
          (s) =>
            `<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" stroke="${s.kind === 'main-spine' ? 'var(--accent)' : 'var(--text-tertiary)'}" stroke-opacity="${s.kind === 'main-spine' ? '0.65' : '0.45'}" stroke-width="${s.kind === 'main-spine' ? '3.5' : '2'}" stroke-linecap="round" />`
        )
        .join('');

      const edgesSvg = currentLayout.edges
        .map((edge) => `<path class="mindmap-edge" d="${buildEdgePathD(edge)}" />`)
        .join('');

      svgEl.innerHTML = `${cardsSvg}${spinesSvg}${edgesSvg}`;
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
        const dirCls = n.dir === 'left' ? 'is-left' : n.dir === 'down' ? 'is-down' : '';
        el.className = `mindmap-node ${isRoot ? 'is-root' : ''} ${statusCls} ${dirCls}`.trim();
        el.dataset.nodeId = nodeData.id;
        el.style.left = `${n.x}px`;
        el.style.top = `${n.y}px`;
        el.style.width = `${n.w}px`;
        el.style.minHeight = `${n.h}px`;
        if (n.dir === 'card') {
          el.style.borderRadius = n.level === 1 ? '12px' : '9px';
          if (n.level === 1) {
            el.style.fontWeight = '600';
            el.style.background = 'var(--accent-soft)';
          }
        }
        const milestonePrefix = n.milestoneBadge
          ? `<span style="font-size:10px;font-weight:700;font-family:var(--font-mono);padding:1px 5px;border-radius:999px;background:var(--accent-soft);color:var(--accent);flex-shrink:0;">${n.milestoneBadge}</span>`
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

        const foldBadge = hasChildren
          ? `<button type="button" class="mindmap-fold-btn" data-mm-fold="${escapeHtml(nodeData.id)}" title="${isCollapsed ? '展开分支' : '折叠分支'}">${isCollapsed ? `+${n.hiddenCount}` : '−'}</button>`
          : '';

        el.innerHTML = `
          ${milestonePrefix}
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

    const btn = e.target.closest('[data-mm-act]');
    if (!btn) return;
    const act = btn.dataset.mmAct;
    if (act === 'zoom-in') {
      zoomAtPoint(zoom * 1.16);
    } else if (act === 'zoom-out') {
      zoomAtPoint(zoom / 1.16);
    } else if (act === 'center') {
      fitCenter();
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

  // Stage interactions: pan, pointer-anchored wheel zoom, portal pill click, fold, more, dblclick, right-click
  if (stageEl) {
    let panning = false;
    let panStartX = 0;
    let panStartY = 0;
    let origPanX = 0;
    let origPanY = 0;

    stageEl.addEventListener('pointerdown', (e) => {
      const rect = stageEl.getBoundingClientRect();
      lastPointer.x = e.clientX - rect.left;
      lastPointer.y = e.clientY - rect.top;
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
      const rect = stageEl.getBoundingClientRect();
      lastPointer.x = e.clientX - rect.left;
      lastPointer.y = e.clientY - rect.top;
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
      }
    });

    stageEl.addEventListener('dblclick', (e) => {
      const nodeEl = e.target.closest('.mindmap-node');
      if (!nodeEl || e.target.closest('.anchor-pill, [data-media-file], button, input')) return;
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
