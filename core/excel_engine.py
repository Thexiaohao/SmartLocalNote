"""Lightweight in-place Excel (.xlsx) engine for SmartLocalNote.

Strictly uses lazy imports for `openpyxl` inside functions to preserve
fast startup and low idle memory. All disk reads and writes pass through
`core.safe_io` (path whitelist, pre-write `.bak` snapshot, atomic replace).
"""

from __future__ import annotations

import csv
from datetime import date, datetime, time
import io
import math
from pathlib import Path
from typing import Any

from core import safe_io


def _ensure_xlsx_path(path_str: str, *, must_exist: bool = True) -> Path:
    target = safe_io.resolve_safe_path(path_str, must_exist=must_exist)
    if target.suffix.lower() != ".xlsx":
        raise ValueError(f"仅支持 .xlsx 格式表格：{target.name}")
    return target


def _serialize_cell(val: Any) -> Any:
    """Convert Excel cell values into clean JSON-serializable scalars."""
    if val is None:
        return ""
    if isinstance(val, datetime):
        return val.isoformat(sep=" ", timespec="seconds")
    if isinstance(val, date):
        return val.isoformat()
    if isinstance(val, time):
        return val.isoformat(timespec="seconds")
    if isinstance(val, float):
        if math.isnan(val) or math.isinf(val):
            return ""
        if val.is_integer():
            return int(val)
        return val
    if isinstance(val, (int, bool, str)):
        return val
    return str(val)


def _normalize_headers(raw_row: tuple[Any, ...] | list[Any] | None, min_cols: int = 0) -> list[str]:
    cells = list(raw_row) if raw_row is not None else []
    while cells and (cells[-1] is None or str(cells[-1]).strip() == ""):
        cells.pop()
    col_count = max(len(cells), min_cols)
    headers: list[str] = []
    for idx in range(col_count):
        val = cells[idx] if idx < len(cells) else None
        text = str(_serialize_cell(val)).strip() if val is not None else ""
        headers.append(text if text else f"列{idx + 1}")
    return headers


def _select_sheet(wb: Any, sheet: str | None) -> tuple[str, Any]:
    names = wb.sheetnames
    if not names:
        raise ValueError("Excel 文件不包含任何工作表")
    if sheet:
        if sheet not in names:
            raise ValueError(f"工作表不存在：{sheet}")
        return sheet, wb[sheet]
    first = names[0]
    return first, wb[first]


def _parse_col_index(col_ref: int | str, column_index_from_string: Any) -> int:
    """Resolve 1-based integer col index or Excel column letter (e.g. 'C') to 1-based int."""
    if isinstance(col_ref, bool):
        raise ValueError("列索引不能为布尔值")
    if isinstance(col_ref, int):
        if col_ref < 1:
            raise ValueError(f"列索引必须 >= 1：{col_ref}")
        return col_ref
    s = str(col_ref).strip()
    if not s:
        raise ValueError("列索引不能为空")
    if s.isdigit():
        idx = int(s)
        if idx < 1:
            raise ValueError(f"列索引必须 >= 1：{idx}")
        return idx
    if s.isalpha():
        return int(column_index_from_string(s.upper()))
    raise ValueError(f"无效的列标识：{col_ref}")


def _resolve_sort_col_idx(sort_col: str | int | None, headers: list[str]) -> int | None:
    if sort_col is None or str(sort_col).strip() == "":
        return None
    if isinstance(sort_col, int):
        return sort_col if 0 <= sort_col < len(headers) else None
    s = str(sort_col).strip()
    if s in headers:
        return headers.index(s)
    if s.isdigit():
        idx = int(s)
        if 0 <= idx < len(headers):
            return idx
    return None


def _sort_key_for_cell(val: Any) -> tuple[int, float, str]:
    """Numeric-aware sort key with empty cells sorted last and safe string fallback."""
    if val is None or val == "":
        return (2, 0.0, "")
    if isinstance(val, bool):
        return (0, float(int(val)), str(val))
    if isinstance(val, (int, float)):
        return (0, float(val), str(val))
    s = str(val).strip()
    if not s:
        return (2, 0.0, "")
    num_candidate = s.rstrip("%").replace(",", "")
    try:
        return (0, float(num_candidate), s.lower())
    except ValueError:
        return (1, 0.0, s.lower())


def get_sheets(path_str: str) -> dict[str, Any]:
    """Read sheet metadata (names, row-1 headers, total_rows, total_cols) using read_only=True."""
    import openpyxl

    target = _ensure_xlsx_path(path_str, must_exist=True)
    wb = openpyxl.load_workbook(target, read_only=True, data_only=True)
    try:
        sheets_info: list[dict[str, Any]] = []
        for sname in wb.sheetnames:
            ws = wb[sname]
            row_iter = ws.iter_rows(values_only=True)
            first_row = next(row_iter, None)
            headers = _normalize_headers(first_row)

            # Count remaining data rows accurately without trusting stale max_row metadata.
            total_data_rows = 0
            max_cols = len(headers)
            for row in row_iter:
                total_data_rows += 1
                if row and len(row) > max_cols:
                    # Only expand max_cols for trailing non-empty cells
                    last_non_empty = len(row)
                    while last_non_empty > max_cols and (
                        row[last_non_empty - 1] is None
                        or str(row[last_non_empty - 1]).strip() == ""
                    ):
                        last_non_empty -= 1
                    if last_non_empty > max_cols:
                        max_cols = last_non_empty

            if max_cols > len(headers):
                headers = _normalize_headers(first_row, min_cols=max_cols)

            sheets_info.append({
                "name": sname,
                "headers": headers,
                "total_rows": total_data_rows,
                "total_cols": len(headers),
            })

        return {
            "path": str(target),
            "name": target.name,
            "sheets": sheets_info,
        }
    finally:
        wb.close()


def get_rows(
    path_str: str,
    sheet: str | None = None,
    page: int = 1,
    page_size: int = 100,
    q: str = "",
    sort_col: str | None = None,
    sort_dir: str = "asc",
) -> dict[str, Any]:
    """Paginated read of Excel sheet rows with keyword search and numeric-aware sorting."""
    import openpyxl

    target = _ensure_xlsx_path(path_str, must_exist=True)
    page = max(1, int(page or 1))
    page_size = max(1, min(500, int(page_size or 100)))
    query = (q or "").strip().lower()
    descending = str(sort_dir or "asc").strip().lower() == "desc"

    wb = openpyxl.load_workbook(target, read_only=True, data_only=True)
    try:
        sheet_name, ws = _select_sheet(wb, sheet)
        row_iter = ws.iter_rows(values_only=True)
        first_row = next(row_iter, None)
        headers = _normalize_headers(first_row)
        col_count = len(headers)

        all_rows: list[dict[str, Any]] = []
        for excel_row_idx, raw_row in enumerate(row_iter, start=2):
            row_vals = list(raw_row) if raw_row is not None else []
            if len(row_vals) > col_count:
                last_non_empty = len(row_vals)
                while last_non_empty > col_count and (
                    row_vals[last_non_empty - 1] is None
                    or str(row_vals[last_non_empty - 1]).strip() == ""
                ):
                    last_non_empty -= 1
                if last_non_empty > col_count:
                    col_count = last_non_empty

            cells = [
                _serialize_cell(row_vals[i] if i < len(row_vals) else None)
                for i in range(col_count)
            ]
            all_rows.append({"row_num": excel_row_idx, "cells": cells})

        if col_count > len(headers):
            headers = _normalize_headers(first_row, min_cols=col_count)
            for item in all_rows:
                if len(item["cells"]) < col_count:
                    item["cells"].extend([""] * (col_count - len(item["cells"])))

        total_data_rows = len(all_rows)

        if query:
            filtered = [
                r
                for r in all_rows
                if any(query in str(c).lower() for c in r["cells"])
            ]
        else:
            filtered = all_rows

        sort_idx = _resolve_sort_col_idx(sort_col, headers)
        if sort_idx is not None:
            if descending:
                # Keep empty values at the bottom even when descending
                non_empty = [
                    r for r in filtered
                    if r["cells"][sort_idx] != "" and r["cells"][sort_idx] is not None
                ]
                empty = [
                    r for r in filtered
                    if r["cells"][sort_idx] == "" or r["cells"][sort_idx] is None
                ]
                non_empty.sort(
                    key=lambda r: _sort_key_for_cell(r["cells"][sort_idx]),
                    reverse=True,
                )
                filtered = non_empty + empty
            else:
                filtered = sorted(
                    filtered,
                    key=lambda r: _sort_key_for_cell(r["cells"][sort_idx]),
                )

        filtered_count = len(filtered)
        total_pages = max(1, math.ceil(filtered_count / page_size)) if filtered_count else 1
        if page > total_pages:
            page = total_pages

        start = (page - 1) * page_size
        end = start + page_size
        page_rows = filtered[start:end]

        return {
            "path": str(target),
            "name": target.name,
            "sheet": sheet_name,
            "headers": headers,
            "rows": page_rows,
            "total_rows": total_data_rows,
            "filtered_rows": filtered_count,
            "page": page,
            "page_size": page_size,
            "total_pages": total_pages,
        }
    finally:
        wb.close()


def patch_cells(path_str: str, sheet: str | None, changes: list[dict[str, Any]]) -> dict[str, Any]:
    """Incrementally update specified cells and atomically save with a pre-write `.bak` snapshot."""
    import openpyxl
    from openpyxl.utils import column_index_from_string

    if not isinstance(changes, list) or not changes:
        raise ValueError("请提供至少一项单元格修改内容")

    target = _ensure_xlsx_path(path_str, must_exist=True)
    wb = openpyxl.load_workbook(target, read_only=False)
    try:
        sheet_name, ws = _select_sheet(wb, sheet)
        updated = 0
        for item in changes:
            if not isinstance(item, dict):
                raise ValueError("单元格修改项格式无效")
            row_raw = item.get("row")
            col_raw = item.get("col")
            if row_raw is None or col_raw is None:
                raise ValueError("每项修改必须包含 row 与 col")
            row_idx = int(row_raw)
            if row_idx < 1:
                raise ValueError(f"行号必须 >= 1：{row_idx}")
            col_idx = _parse_col_index(col_raw, column_index_from_string)
            ws.cell(row=row_idx, column=col_idx, value=item.get("value"))
            updated += 1

        save_res = safe_io.atomic_save_via_callback(
            target,
            lambda tmp_path: wb.save(tmp_path),
            snapshot=True,
        )
        return {
            "path": str(target),
            "sheet": sheet_name,
            "updated": updated,
            "snapshot_id": save_res["snapshot_id"],
        }
    finally:
        wb.close()


def append_rows(path_str: str, sheet: str | None, rows: list[list[Any]]) -> dict[str, Any]:
    """Append one or more rows to target sheet and atomically save with snapshot."""
    import openpyxl

    if not isinstance(rows, list) or not rows:
        raise ValueError("追加的行数据不能为空")
    for row in rows:
        if not isinstance(row, (list, tuple)):
            raise ValueError("每一行必须是列表格式")

    target = _ensure_xlsx_path(path_str, must_exist=True)
    wb = openpyxl.load_workbook(target, read_only=False)
    try:
        sheet_name, ws = _select_sheet(wb, sheet)
        for row in rows:
            ws.append(list(row))

        new_total_rows = max(0, (ws.max_row or 1) - 1)
        save_res = safe_io.atomic_save_via_callback(
            target,
            lambda tmp_path: wb.save(tmp_path),
            snapshot=True,
        )
        return {
            "path": str(target),
            "sheet": sheet_name,
            "appended": len(rows),
            "new_total_rows": new_total_rows,
            "snapshot_id": save_res["snapshot_id"],
        }
    finally:
        wb.close()


def modify_structure(
    path_str: str,
    sheet: str | None,
    op: str,
    index: int = 1,
    name: str = "",
) -> dict[str, Any]:
    """Add column, delete row, or delete column in-place with pre-write `.bak` snapshot."""
    import openpyxl

    valid_ops = {"add_col", "del_row", "del_col"}
    if op not in valid_ops:
        raise ValueError(f"不支持的结构操作：{op}")

    target = _ensure_xlsx_path(path_str, must_exist=True)
    wb = openpyxl.load_workbook(target, read_only=False)
    try:
        sheet_name, ws = _select_sheet(wb, sheet)
        idx = int(index)

        if op == "add_col":
            max_col = ws.max_column or 0
            # Treat a brand-new empty 1x1 sheet with empty A1 as 0 real columns
            if max_col == 1 and ws.max_row == 1 and ws.cell(row=1, column=1).value is None:
                target_col = 1
                col_title = (name or "").strip() or "新列1"
            elif 1 <= idx <= max_col:
                ws.insert_cols(idx, amount=1)
                target_col = idx
                col_title = (name or "").strip() or f"新列{max_col + 1}"
            else:
                target_col = max_col + 1
                col_title = (name or "").strip() or f"新列{target_col}"
            ws.cell(row=1, column=target_col, value=col_title)
        elif op == "del_row":
            max_row = ws.max_row or 0
            if idx < 1 or idx > max_row:
                raise ValueError(f"行号越界：{idx}（当前总行数 {max_row}）")
            if idx < 2:
                raise ValueError("禁止删除第 1 行表头")
            ws.delete_rows(idx, amount=1)
        elif op == "del_col":
            max_col = ws.max_column or 0
            if idx < 1 or idx > max_col:
                raise ValueError(f"列号越界：{idx}（当前总列数 {max_col}）")
            ws.delete_cols(idx, amount=1)

        save_res = safe_io.atomic_save_via_callback(
            target,
            lambda tmp_path: wb.save(tmp_path),
            snapshot=True,
        )
        return {
            "path": str(target),
            "sheet": sheet_name,
            "op": op,
            "index": idx,
            "total_rows": max(0, (ws.max_row or 1) - 1),
            "total_cols": ws.max_column or 0,
            "snapshot_id": save_res["snapshot_id"],
        }
    finally:
        wb.close()


def export_csv_bytes(path_str: str, sheet: str | None = None) -> tuple[str, bytes]:
    """Export target sheet to UTF-8 BOM CSV bytes and return `(filename, bytes_data)`."""
    import openpyxl

    target = _ensure_xlsx_path(path_str, must_exist=True)
    wb = openpyxl.load_workbook(target, read_only=True, data_only=True)
    try:
        sheet_name, ws = _select_sheet(wb, sheet)
        buf = io.StringIO()
        writer = csv.writer(buf, lineterminator="\r\n")
        for row in ws.iter_rows(values_only=True):
            writer.writerow([_serialize_cell(cell) for cell in row])
        filename = f"{target.stem}_{sheet_name}.csv"
        return filename, buf.getvalue().encode("utf-8-sig")
    finally:
        wb.close()


def extract_text_summary(
    path_str: str,
    max_rows: int = 60,
    max_chars: int = 4000,
) -> str:
    """Extract Markdown table summary of an `.xlsx` file for cross-format AI RAG."""
    import openpyxl
    from openpyxl.utils import get_column_letter

    target = _ensure_xlsx_path(path_str, must_exist=True)
    wb = openpyxl.load_workbook(target, read_only=True, data_only=True)
    try:
        sheet_names = wb.sheetnames
        if not sheet_names:
            return f"表格文件：{target.name}（无工作表）"

        first_sheet = sheet_names[0]
        ws = wb[first_sheet]
        row_iter = ws.iter_rows(values_only=True)
        first_row = next(row_iter, None)
        headers = _normalize_headers(first_row)
        col_count = len(headers)

        lines: list[str] = [
            f"表格文件：{target.name}",
            f"工作表列表：{', '.join(sheet_names)}",
            f"当前摘要工作表：{first_sheet}（列坐标 A~{get_column_letter(max(1, col_count))}，行号从第 2 行开始）",
            "",
        ]

        if headers:
            col_headers = [f"{get_column_letter(i + 1)}:{h}" for i, h in enumerate(headers)]
            lines.append("| 行号 | " + " | ".join(col_headers) + " |")
            lines.append("| --- | " + " | ".join(["---"] * len(col_headers)) + " |")

        extracted_rows = 0
        total_remaining = 0
        for excel_row_idx, raw_row in enumerate(row_iter, start=2):
            if extracted_rows < max_rows:
                vals = list(raw_row) if raw_row is not None else []
                row_cells = [
                    str(_serialize_cell(vals[i] if i < len(vals) else "")).replace("|", "\\|").replace("\n", " ")
                    for i in range(max(1, col_count))
                ]
                lines.append(f"| 第{excel_row_idx}行 | " + " | ".join(row_cells) + " |")
                extracted_rows += 1
            else:
                total_remaining += 1

        if total_remaining > 0:
            lines.append(f"\n...（还有 {total_remaining} 行未展开）")

        text = "\n".join(lines)
        if len(text) > max_chars:
            marker = "\n\n[内容过长已截断]"
            keep = max(0, max_chars - len(marker))
            return text[:keep] + marker
        return text
    finally:
        wb.close()
