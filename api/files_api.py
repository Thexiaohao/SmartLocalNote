"""Multi-format file import, note CRUD, PDF streaming/annotation, privacy lock, and snapshot routes."""

from __future__ import annotations

from fastapi import APIRouter, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel

from api import ok
from core import doc_engine, safe_io

router = APIRouter(prefix="/api/files", tags=["files"])


class ImportBody(BaseModel):
    paths: list[str]
    is_dir: bool = False


class CreateNoteBody(BaseModel):
    title: str
    content: str = ""
    node_id: str | None = None


class WriteFileBody(BaseModel):
    path: str
    content: str


class PdfAnnotateBody(BaseModel):
    path: str
    page: int
    note_text: str


class PrivacyBody(BaseModel):
    path: str
    private: bool


class RestoreSnapshotBody(BaseModel):
    path: str
    snapshot_id: str


@router.get("/list")
def list_files() -> dict:
    return ok(doc_engine.list_workspace_files())


@router.post("/import")
def import_files(body: ImportBody) -> dict:
    return ok(safe_io.register_import(body.paths, is_dir=body.is_dir))


@router.post("/create-note")
def create_note(body: CreateNoteBody) -> dict:
    return ok(doc_engine.create_note(body.title, body.content, body.node_id))


@router.get("/read")
def read_file(path: str = Query(...)) -> dict:
    return ok(doc_engine.read_document(path))


@router.put("/write")
def write_file(body: WriteFileBody) -> dict:
    return ok(doc_engine.write_text_document(body.path, body.content))


@router.get("/pdf-stream")
def stream_pdf(path: str = Query(...)) -> FileResponse:
    target = safe_io.resolve_safe_path(path, must_exist=True)
    return FileResponse(target, media_type="application/pdf", headers={"Content-Disposition": "inline"})


@router.post("/pdf-annotate")
def annotate_pdf(body: PdfAnnotateBody) -> dict:
    return ok(doc_engine.annotate_pdf(body.path, body.page, body.note_text))


@router.post("/privacy")
def set_privacy(body: PrivacyBody) -> dict:
    return ok(safe_io.set_private(body.path, body.private))


@router.get("/snapshots")
def get_snapshots(path: str = Query(...)) -> dict:
    return ok(safe_io.list_snapshots(path))


@router.post("/snapshots")
def restore_snapshot(body: RestoreSnapshotBody) -> dict:
    return ok(safe_io.restore_snapshot(body.path, body.snapshot_id))
