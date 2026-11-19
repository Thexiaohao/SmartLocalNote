"""Lightweight in-place Excel spreadsheet inspection, editing, structure, and CSV export routes."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Query
from fastapi.responses import Response
from pydantic import BaseModel

from api import ok
from core import excel_engine

router = APIRouter(prefix="/api/excel", tags=["excel"])


class PatchCellsBody(BaseModel):
    path: str
    sheet: str | None = None
    changes: list[dict[str, Any]]


class AppendRowsBody(BaseModel):
    path: str
    sheet: str | None = None
    rows: list[list[Any]]


class StructureBody(BaseModel):
    path: str
    sheet: str | None = None
    op: str
    index: int = 1
    name: str = ""


@router.get("/sheets")
def get_sheets(path: str = Query(...)) -> dict:
    return ok(excel_engine.get_sheets(path))


@router.get("/rows")
def get_rows(
    path: str = Query(...),
    sheet: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=500),
    q: str = Query(""),
    sort_col: str | None = Query(None),
    sort_dir: str = Query("asc"),
) -> dict:
    data = excel_engine.get_rows(
        path, sheet=sheet, page=page, page_size=page_size, q=q, sort_col=sort_col, sort_dir=sort_dir
    )
    return ok(data)


@router.patch("/cells")
def patch_cells(body: PatchCellsBody) -> dict:
    return ok(excel_engine.patch_cells(body.path, body.sheet, body.changes))


@router.post("/append-rows")
def append_rows(body: AppendRowsBody) -> dict:
    return ok(excel_engine.append_rows(body.path, body.sheet, body.rows))


@router.post("/structure")
def modify_structure(body: StructureBody) -> dict:
    return ok(excel_engine.modify_structure(body.path, body.sheet, body.op, body.index, body.name))


@router.get("/export-csv")
def export_csv(path: str = Query(...), sheet: str | None = Query(None)) -> Response:
    filename, data = excel_engine.export_csv_bytes(path, sheet)
    headers = {"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"}
    return Response(content=data, media_type="text/csv; charset=utf-8", headers=headers)
