"""Workspace-wide Markdown GFM task aggregator and bidirectional atomic writer."""

from __future__ import annotations

import hashlib
from pathlib import Path
import re
from typing import Any

from core import doc_engine, safe_io

_TODO_LINE_RE = re.compile(r"^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.*)$")
_HEADING_RE = re.compile(r"^#{1,6}\s+(.+)$")
_FENCE_RE = re.compile(r"^\s*(```|~~~)")


def _make_todo_id(file_path: str, line_no: int, text: str) -> str:
    raw = f"{file_path}:{line_no}:{text}".encode("utf-8", errors="ignore")
    return f"td_{hashlib.md5(raw).hexdigest()[:10]}"


def _parse_markdown_todos(content: str) -> list[dict[str, Any]]:
    """Extract 1-based GFM tasks and their nearest preceding heading from Markdown text."""
    results: list[dict[str, Any]] = []
    current_heading = ""
    in_fence = False

    for line_no, raw_line in enumerate(content.splitlines(), start=1):
        if _FENCE_RE.match(raw_line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue

        hm = _HEADING_RE.match(raw_line.strip())
        if hm:
            current_heading = hm.group(1).strip().rstrip("#").strip()
            continue

        tm = _TODO_LINE_RE.match(raw_line)
        if tm:
            mark = tm.group(2)
            task_text = tm.group(4).strip()
            results.append({
                "line_no": line_no,
                "text": task_text,
                "checked": mark.lower() == "x",
                "heading": current_heading,
            })

    return results


def scan_all_todos() -> dict[str, Any]:
    """Scan all `.md` files in the workspace and aggregate GFM todo items and stats."""
    ws = doc_engine.list_workspace_files()
    items: list[dict[str, Any]] = []
    by_file: dict[str, dict[str, int]] = {}
    total_all = 0
    done_all = 0

    for f_info in ws.get("items", []):
        if str(f_info.get("ext") or "").lower() != ".md":
            continue
        file_path = str(f_info.get("path") or "")
        if not file_path:
            continue
        target = Path(file_path)
        try:
            content = doc_engine._read_text_with_fallback(target)
        except OSError:
            continue

        parsed = _parse_markdown_todos(content)
        if not parsed:
            continue

        file_name = str(f_info.get("name") or target.name)
        rel_dir = str(f_info.get("rel_dir") or "")
        file_done = 0
        for row in parsed:
            checked = bool(row["checked"])
            if checked:
                file_done += 1
            items.append({
                "id": _make_todo_id(file_path, row["line_no"], row["text"]),
                "file_path": file_path,
                "file_name": file_name,
                "rel_dir": rel_dir,
                "line_no": row["line_no"],
                "text": row["text"],
                "checked": checked,
                "heading": row["heading"],
            })

        file_total = len(parsed)
        by_file[file_path] = {
            "total": file_total,
            "done": file_done,
            "open": file_total - file_done,
        }
        total_all += file_total
        done_all += file_done

    return {
        "items": items,
        "by_file": by_file,
        "stats": {
            "total": total_all,
            "done": done_all,
            "open": total_all - done_all,
        },
    }


def _find_matching_todo_line(
    lines: list[str],
    line_no: int,
    expected_text: str,
) -> tuple[int, re.Match[str]] | None:
    idx = line_no - 1
    clean_expected = str(expected_text or "").strip()

    if 0 <= idx < len(lines):
        line_body = lines[idx].rstrip("\r\n")
        m = _TODO_LINE_RE.match(line_body)
        if m and (not clean_expected or m.group(4).strip() == clean_expected):
            return idx, m

    if clean_expected:
        candidates: list[tuple[int, int, re.Match[str]]] = []
        for i, raw in enumerate(lines):
            m = _TODO_LINE_RE.match(raw.rstrip("\r\n"))
            if m and m.group(4).strip() == clean_expected:
                candidates.append((abs(i - idx), i, m))
        if candidates:
            candidates.sort(key=lambda c: c[0])
            _, best_idx, best_match = candidates[0]
            return best_idx, best_match

    return None


def toggle_todo(
    file_path: str,
    line_no: int,
    checked: bool,
    expected_text: str = "",
) -> dict[str, Any]:
    """Toggle `[ ]` / `[x]` on a specific Markdown GFM task line atomically."""
    target = safe_io.resolve_safe_path(file_path, must_exist=True)
    content = doc_engine._read_text_with_fallback(target)
    lines = content.splitlines(keepends=True)

    found = _find_matching_todo_line(lines, int(line_no), expected_text)
    if found is None:
        raise ValueError(f"未在 {target.name} 第 {line_no} 行找到匹配的待办事项")

    actual_idx, m = found
    raw_line = lines[actual_idx]
    line_ending = raw_line[len(raw_line.rstrip("\r\n")) :]
    new_mark = "x" if checked else " "
    lines[actual_idx] = f"{m.group(1)}{new_mark}{m.group(3)}{m.group(4)}{line_ending}"

    new_text = "".join(lines)
    safe_io.atomic_write_text(Path(target), new_text, snapshot=False)
    actual_line_no = actual_idx + 1

    return {
        "ok": True,
        "file_path": str(target),
        "line_no": actual_line_no,
        "checked": bool(checked),
        "content": new_text,
    }


def add_todo(file_path: str, text: str = "") -> dict[str, Any]:
    """Append a new `- [ ] ...` GFM todo item to a Markdown note atomically."""
    target = safe_io.resolve_safe_path(file_path, must_exist=True)
    content = doc_engine._read_text_with_fallback(target)

    final_text = str(text or "").strip()
    if not final_text:
        existing_texts = [row["text"] for row in _parse_markdown_todos(content)]
        final_text = doc_engine._next_sequential_name("新建待办", existing_texts)

    todo_line = f"- [ ] {final_text}"
    if not content:
        new_text = f"{todo_line}\n"
    elif content.endswith("\n"):
        new_text = f"{content}{todo_line}\n"
    else:
        new_text = f"{content}\n{todo_line}\n"

    new_line_no = len(new_text.splitlines())
    safe_io.atomic_write_text(Path(target), new_text, snapshot=False)

    return {
        "ok": True,
        "file_path": str(target),
        "line_no": new_line_no,
        "text": final_text,
        "content": new_text,
    }
