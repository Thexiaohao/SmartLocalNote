"""Bidirectional link (`[[...]]`) and `#tag` knowledge graph scanner for SmartLocalNote.

Zero third-party dependencies (pure Python stdlib `re` + `pathlib`).
All local file reads pass through `core.safe_io.resolve_safe_path`.
"""

from __future__ import annotations

from pathlib import Path
import re
from typing import Any

from core import doc_engine, safe_io

_FENCE_RE = re.compile(r"^\s*(?:`{3,}|~{3,})")
_HEADING_LINE_RE = re.compile(r"^\s*#{1,6}\s+")
_WIKILINK_RE = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]")
_NON_FILE_PREFIX_RE = re.compile(r"^(?:app|ws|url|http|https|mailto|cmd|action):", re.IGNORECASE)
_INLINE_CODE_RE = re.compile(r"`[^`\n]+`")
_TAG_RE = re.compile(r"(?:^|[\s,，;；(（\[])#([A-Za-z0-9_\u4e00-\u9fa5\-/]{1,32})")
_HEX_COLOR_RE = re.compile(r"(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})")

_MAX_GRAPH_NODES = 28


def _read_text_with_fallback(path: Path) -> str:
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "utf-8", "gb18030", "gbk"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _clean_snippet(line: str, limit: int = 140) -> str:
    cleaned = re.sub(r"\s+", " ", line).strip()
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[:limit] + "..."


def _build_file_lookup(items: list[dict[str, Any]]) -> dict[str, Any]:
    by_path: dict[str, dict[str, Any]] = {}
    by_rel: dict[str, dict[str, Any]] = {}
    by_name: dict[str, dict[str, Any]] = {}
    by_stem: dict[str, dict[str, Any]] = {}

    # Prefer notes-dir and .md files when names collide across folders
    def _priority(item: dict[str, Any]) -> tuple[int, int, str]:
        is_md = 0 if str(item.get("ext") or "").lower() == ".md" else 1
        is_notes = 0 if item.get("source") == "notes" else 1
        return (is_md, is_notes, str(item.get("path") or "").lower())

    for item in sorted(items, key=_priority):
        fpath = str(item.get("path") or "")
        name = str(item.get("name") or "")
        if not fpath or not name:
            continue
        by_path[fpath] = item

        p_obj = Path(name)
        name_low = name.lower()
        stem_low = p_obj.stem.lower()
        by_name.setdefault(name_low, item)
        if stem_low:
            by_stem.setdefault(stem_low, item)

        rel_dir = str(item.get("rel_dir") or "").replace("\\", "/").strip("/")
        if rel_dir:
            rel_name = f"{rel_dir}/{name}".lower()
            rel_stem = f"{rel_dir}/{p_obj.stem}".lower() if p_obj.stem else ""
            by_rel.setdefault(rel_name, item)
            if rel_stem:
                by_rel.setdefault(rel_stem, item)

    return {
        "by_path": by_path,
        "by_rel": by_rel,
        "by_name": by_name,
        "by_stem": by_stem,
    }


def _resolve_wikilink(raw_target: str, lookup: dict[str, Any]) -> dict[str, Any] | None:
    cleaned = raw_target.strip().replace("\\", "/").lstrip("/")
    while cleaned.startswith("./"):
        cleaned = cleaned[2:].lstrip("/")
    if not cleaned:
        return None

    candidates = [cleaned]
    if "!" in cleaned:
        archive_part = cleaned.split("!", 1)[0].strip()
        if archive_part:
            candidates.append(archive_part)

    by_rel = lookup["by_rel"]
    by_name = lookup["by_name"]
    by_stem = lookup["by_stem"]

    for cand in candidates:
        low = cand.lower()
        if "/" in low and low in by_rel:
            return by_rel[low]
        base = Path(cand).name.lower()
        if base in by_name:
            return by_name[base]
        if base in by_stem:
            return by_stem[base]
        if base.endswith(".md") and base[:-3] in by_stem:
            return by_stem[base[:-3]]
    return None


def _scan_markdown_note(
    src_path: str,
    src_name: str,
    text: str,
    lookup: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[str]]:
    outlinks: list[dict[str, Any]] = []
    seen_targets: set[str] = set()
    tags: list[str] = []
    seen_tags: set[str] = set()

    in_fence = False
    for line_no, raw_line in enumerate(text.splitlines(), start=1):
        if _FENCE_RE.match(raw_line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue

        for match in _WIKILINK_RE.finditer(raw_line):
            raw_target = match.group(1).strip()
            if not raw_target or _NON_FILE_PREFIX_RE.match(raw_target):
                continue
            resolved_item = _resolve_wikilink(raw_target, lookup)
            if resolved_item is not None:
                target_path = str(resolved_item["path"])
                if target_path == src_path:
                    continue
                target_name = str(resolved_item["name"])
                exists = True
                dedup_key = target_path
            else:
                target_path = ""
                target_name = raw_target
                exists = False
                dedup_key = f"missing:{raw_target.lower()}"

            if dedup_key not in seen_targets:
                seen_targets.add(dedup_key)
                outlinks.append({
                    "target_path": target_path,
                    "target_name": target_name,
                    "line_no": line_no,
                    "snippet": _clean_snippet(raw_line),
                    "exists": exists,
                })

        if _HEADING_LINE_RE.match(raw_line):
            continue

        stripped_line = _WIKILINK_RE.sub(" ", _INLINE_CODE_RE.sub(" ", raw_line))
        for tag_match in _TAG_RE.finditer(stripped_line):
            tag = tag_match.group(1).strip()
            if not tag or tag.isdigit():
                continue
            if _HEX_COLOR_RE.fullmatch(tag):
                continue
            if not re.search(r"[A-Za-z0-9_\u4e00-\u9fa5]", tag):
                continue
            if tag not in seen_tags:
                seen_tags.add(tag)
                tags.append(tag)

    return outlinks, tags


def _resolve_active_id(
    active_path: str,
    md_notes: dict[str, dict[str, Any]],
    by_path: dict[str, dict[str, Any]],
    note_outlinks: dict[str, list[dict[str, Any]]],
    backlinks_map: dict[str, list[dict[str, Any]]],
    note_tags: dict[str, list[str]],
) -> str:
    raw = str(active_path or "").strip()
    if raw:
        candidates = [raw]
        try:
            resolved = safe_io.resolve_safe_path(raw, must_exist=False)
            candidates.insert(0, str(resolved))
        except (OSError, PermissionError, ValueError):
            pass
        for cand in candidates:
            if cand in by_path:
                return cand

    if not md_notes:
        return ""

    return max(
        md_notes.keys(),
        key=lambda p: (
            len(note_outlinks.get(p, [])) + len(backlinks_map.get(p, [])),
            len(note_tags.get(p, [])),
            str(md_notes[p].get("name") or "").lower(),
        ),
    )


def _compute_related_files(
    active_id: str,
    active_tags: list[str],
    note_tags: dict[str, list[str]],
    tag_files_map: dict[str, list[dict[str, Any]]],
    by_path: dict[str, dict[str, Any]],
    direct_neighbors: set[str],
) -> list[dict[str, Any]]:
    if not active_id:
        return []

    shared_by_path: dict[str, list[str]] = {}
    for tag in active_tags:
        for entry in tag_files_map.get(tag, []):
            fpath = entry["path"]
            if fpath == active_id:
                continue
            shared_by_path.setdefault(fpath, []).append(tag)

    related: list[dict[str, Any]] = []
    for fpath, shared in shared_by_path.items():
        item = by_path.get(fpath)
        if not item:
            continue
        is_linked = fpath in direct_neighbors
        reason_parts = [f"共标签 #{' #'.join(shared[:3])}"]
        if is_linked:
            reason_parts.append("且存在直接双链")
        related.append({
            "path": fpath,
            "name": str(item.get("name") or Path(fpath).name),
            "rel_dir": str(item.get("rel_dir") or ""),
            "shared_tags": shared,
            "reason": "，".join(reason_parts),
        })

    related.sort(key=lambda r: (-len(r["shared_tags"]), r["name"].lower(), r["path"]))
    if len(related) < 8:
        seen = {r["path"] for r in related} | {active_id}
        for npath in sorted(direct_neighbors):
            if npath in seen:
                continue
            item = by_path.get(npath)
            if not item:
                continue
            ntags = note_tags.get(npath, [])
            related.append({
                "path": npath,
                "name": str(item.get("name") or Path(npath).name),
                "rel_dir": str(item.get("rel_dir") or ""),
                "shared_tags": [t for t in ntags if t in active_tags],
                "reason": "直接双链关联",
            })
            seen.add(npath)
            if len(related) >= 10:
                break

    return related[:10]


def _build_local_graph(
    active_id: str,
    md_notes: dict[str, dict[str, Any]],
    by_path: dict[str, dict[str, Any]],
    note_outlinks: dict[str, list[dict[str, Any]]],
    backlinks_map: dict[str, list[dict[str, Any]]],
    note_tags: dict[str, list[str]],
    tags_summary: list[dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    nodes: list[dict[str, Any]] = []
    node_ids: set[str] = set()

    def _file_degree(fpath: str) -> int:
        return (
            len(backlinks_map.get(fpath, []))
            + sum(1 for o in note_outlinks.get(fpath, []) if o["exists"])
            + len(note_tags.get(fpath, []))
        )

    def _add_node(nid: str, label: str, kind: str, count: int) -> bool:
        if nid in node_ids:
            return True
        if len(nodes) >= _MAX_GRAPH_NODES:
            return False
        node_ids.add(nid)
        nodes.append({"id": nid, "label": label, "kind": kind, "count": count})
        return True

    if active_id and active_id in by_path:
        active_item = by_path[active_id]
        _add_node(active_id, str(active_item.get("name") or Path(active_id).name), "active", _file_degree(active_id))

        neighbor_paths: set[str] = set()
        for bl in backlinks_map.get(active_id, []):
            neighbor_paths.add(bl["source_path"])
        for ol in note_outlinks.get(active_id, []):
            if ol["exists"] and ol["target_path"]:
                neighbor_paths.add(ol["target_path"])

        for npath in sorted(neighbor_paths, key=lambda p: (-_file_degree(p), p))[:12]:
            nitem = by_path.get(npath)
            if nitem:
                _add_node(npath, str(nitem.get("name") or Path(npath).name), "neighbor", _file_degree(npath))

        tag_count_lookup = {t["tag"]: t["count"] for t in tags_summary}
        active_tags_sorted = sorted(
            note_tags.get(active_id, []),
            key=lambda t: (-tag_count_lookup.get(t, 0), t.lower()),
        )
        for tag in active_tags_sorted[:6]:
            _add_node(f"tag:{tag}", f"#{tag}", "tag", tag_count_lookup.get(tag, 1))

        # Add 2-hop tag peers connected to active's tags
        for t_entry in tags_summary:
            if t_entry["tag"] not in note_tags.get(active_id, []):
                continue
            for f_entry in t_entry["files"]:
                if len(nodes) >= 22:
                    break
                fpath = f_entry["path"]
                if fpath != active_id and fpath in by_path:
                    _add_node(fpath, f_entry["name"], "neighbor", _file_degree(fpath))

    # Fill remaining capacity with top global hubs & top tags for vault context
    if len(nodes) < _MAX_GRAPH_NODES:
        hub_candidates = sorted(
            md_notes.keys(),
            key=lambda p: (-_file_degree(p), str(md_notes[p].get("name") or "").lower()),
        )
        for hpath in hub_candidates:
            if len(nodes) >= _MAX_GRAPH_NODES - min(4, len(tags_summary)):
                break
            if _file_degree(hpath) <= 0 and nodes:
                continue
            hitem = md_notes[hpath]
            _add_node(hpath, str(hitem.get("name") or Path(hpath).name), "hub", _file_degree(hpath))

        for t_entry in tags_summary:
            if len(nodes) >= _MAX_GRAPH_NODES:
                break
            _add_node(f"tag:{t_entry['tag']}", f"#{t_entry['tag']}", "tag", t_entry["count"])

    edges: list[dict[str, str]] = []
    seen_edges: set[tuple[str, str, str]] = set()

    def _add_edge(source: str, target: str, kind: str) -> None:
        if source == target or source not in node_ids or target not in node_ids:
            return
        key = (source, target, kind)
        if key in seen_edges:
            return
        seen_edges.add(key)
        edges.append({"source": source, "target": target, "kind": kind})

    for src_path, out_list in note_outlinks.items():
        if src_path not in node_ids:
            continue
        for ol in out_list:
            if ol["exists"] and ol["target_path"] in node_ids:
                _add_edge(src_path, ol["target_path"], "link")

    for src_path, t_list in note_tags.items():
        if src_path not in node_ids:
            continue
        for tag in t_list:
            tag_nid = f"tag:{tag}"
            if tag_nid in node_ids:
                _add_edge(src_path, tag_nid, "tag")

    return {"nodes": nodes, "edges": edges}


def build_link_graph(active_path: str = "") -> dict[str, Any]:
    """Scan workspace `.md` files for `[[...]]` links and `#tags` to build the knowledge graph."""
    workspace = doc_engine.list_workspace_files()
    items = workspace.get("items", [])
    lookup = _build_file_lookup(items)
    by_path: dict[str, dict[str, Any]] = lookup["by_path"]

    md_notes: dict[str, dict[str, Any]] = {}
    note_outlinks: dict[str, list[dict[str, Any]]] = {}
    backlinks_map: dict[str, list[dict[str, Any]]] = {}
    backlinks_seen: dict[str, set[str]] = {}
    note_tags: dict[str, list[str]] = {}
    tag_files_map: dict[str, list[dict[str, Any]]] = {}

    for item in items:
        fpath = str(item.get("path") or "")
        ext = str(item.get("ext") or "").lower()
        if not fpath or ext != ".md":
            continue
        try:
            safe_target = safe_io.resolve_safe_path(fpath, must_exist=True)
            text = _read_text_with_fallback(safe_target)
        except (OSError, PermissionError, FileNotFoundError, ValueError):
            continue

        resolved_str = str(safe_target)
        note_name = str(item.get("name") or safe_target.name)
        md_notes[resolved_str] = item
        note_outlinks[resolved_str] = []
        note_tags[resolved_str] = []

        outlinks, tags = _scan_markdown_note(resolved_str, note_name, text, lookup)
        note_outlinks[resolved_str] = outlinks
        note_tags[resolved_str] = tags

        for ol in outlinks:
            if ol["exists"] and ol["target_path"]:
                tpath = ol["target_path"]
                seen_src = backlinks_seen.setdefault(tpath, set())
                if resolved_str not in seen_src:
                    seen_src.add(resolved_str)
                    backlinks_map.setdefault(tpath, []).append({
                        "source_path": resolved_str,
                        "source_name": note_name,
                        "line_no": ol["line_no"],
                        "snippet": ol["snippet"],
                    })

        rel_dir = str(item.get("rel_dir") or "")
        for tag in tags:
            tag_files_map.setdefault(tag, []).append({
                "path": resolved_str,
                "name": note_name,
                "rel_dir": rel_dir,
            })

    tags_summary: list[dict[str, Any]] = []
    for tag_name, files in tag_files_map.items():
        sorted_files = sorted(files, key=lambda f: (f["name"].lower(), f["path"]))
        tags_summary.append({
            "tag": tag_name,
            "count": len(sorted_files),
            "files": sorted_files,
        })
    tags_summary.sort(key=lambda t: (-t["count"], t["tag"].lower()))

    active_id = _resolve_active_id(
        active_path,
        md_notes,
        by_path,
        note_outlinks,
        backlinks_map,
        note_tags,
    )
    active_item = by_path.get(active_id, {}) if active_id else {}
    active_outlinks = note_outlinks.get(active_id, [])
    active_backlinks = backlinks_map.get(active_id, [])
    active_tags = note_tags.get(active_id, [])
    direct_neighbors = {
        bl["source_path"] for bl in active_backlinks
    } | {
        ol["target_path"] for ol in active_outlinks if ol["exists"] and ol["target_path"]
    }

    related_files = _compute_related_files(
        active_id,
        active_tags,
        note_tags,
        tag_files_map,
        by_path,
        direct_neighbors,
    )

    local_graph = _build_local_graph(
        active_id,
        md_notes,
        by_path,
        note_outlinks,
        backlinks_map,
        note_tags,
        tags_summary,
    )

    total_links = sum(len(v) for v in note_outlinks.values())
    orphan_notes = sum(
        1 for p in md_notes
        if not note_outlinks.get(p) and not backlinks_map.get(p)
    )

    return {
        "tags": tags_summary,
        "active": {
            "path": active_id,
            "name": str(active_item.get("name") or (Path(active_id).name if active_id else "")),
            "backlinks": active_backlinks,
            "outlinks": active_outlinks,
            "tags": active_tags,
            "related_files": related_files,
        },
        "local_graph": local_graph,
        "stats": {
            "total_notes": len(md_notes),
            "total_links": total_links,
            "total_tags": len(tags_summary),
            "orphan_notes": orphan_notes,
        },
    }
