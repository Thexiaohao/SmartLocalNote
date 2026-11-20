"""Multi-format file import, note CRUD, PDF streaming/annotation, privacy lock, and snapshot routes."""

from __future__ import annotations

from fastapi import APIRouter, Query
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from api import ok
from core import doc_engine, safe_io, search_engine, todo_indexer

router = APIRouter()
files_router = APIRouter(prefix="/api/files", tags=["files"])
todos_router = APIRouter(prefix="/api/todos", tags=["todos"])


class ImportBody(BaseModel):
    paths: list[str]
    is_dir: bool = False


class CreateNoteBody(BaseModel):
    title: str = ""
    content: str = ""
    node_id: str | None = None
    folder_rel: str = ""


class CreateFolderBody(BaseModel):
    parent_dir: str = ""
    name: str = ""


class TrashFileBody(BaseModel):
    path: str
    mode: str = ""


class ToggleTodoBody(BaseModel):
    file_path: str
    line_no: int
    checked: bool
    expected_text: str = ""


class AddTodoBody(BaseModel):
    file_path: str
    text: str = ""


class WriteFileBody(BaseModel):
    path: str
    content: str


class PdfAnnotateBody(BaseModel):
    path: str
    page: int
    note_text: str
    color: str = "yellow"


class PrivacyBody(BaseModel):
    path: str
    private: bool


class RestoreSnapshotBody(BaseModel):
    path: str
    snapshot_id: str


class OpenExternalBody(BaseModel):
    path: str
    reveal_folder: bool = False


class OpenUrlBody(BaseModel):
    url: str


class RelocateBody(BaseModel):
    filename: str


class RenameFileBody(BaseModel):
    path: str
    new_name: str


class RemoveFileBody(BaseModel):
    path: str


class MoveFilesBody(BaseModel):
    paths: list[str] = Field(default_factory=list)
    target_folder_rel: str = ""


@files_router.get("/list")
def list_files() -> dict:
    return ok(doc_engine.list_workspace_files())


@files_router.post("/import")
def import_files(body: ImportBody) -> dict:
    return ok(safe_io.register_import(body.paths, is_dir=body.is_dir))


@files_router.post("/create-note")
def create_note(body: CreateNoteBody) -> dict:
    return ok(doc_engine.create_note(body.title, body.content, body.node_id, folder_rel=body.folder_rel))


@files_router.post("/create-folder")
def create_folder(body: CreateFolderBody) -> dict:
    return ok(doc_engine.create_folder(body.parent_dir, body.name))


@files_router.post("/trash")
def trash_file(body: TrashFileBody) -> dict:
    return ok(doc_engine.delete_file_to_trash(body.path, body.mode))


@files_router.get("/read")
def read_file(path: str = Query(...)) -> dict:
    return ok(doc_engine.read_document(path))


@files_router.get("/expand-content")
def expand_file_content(
    path: str = Query(...),
    page: int | None = Query(default=None),
    sheet: str | None = Query(default=None),
    cell: str | None = Query(default=None),
    member: str | None = Query(default=None),
) -> dict:
    return ok(doc_engine.extract_inline_content(path, page=page, sheet=sheet, cell=cell, member=member))


@files_router.put("/write")
def write_file(body: WriteFileBody) -> dict:
    return ok(doc_engine.write_text_document(body.path, body.content))


@files_router.get("/pdf-stream")
def stream_pdf(path: str = Query(...)) -> FileResponse:
    target = safe_io.resolve_safe_path(path, must_exist=True)
    return FileResponse(target, media_type="application/pdf", headers={"Content-Disposition": "inline"})


@files_router.get("/pdf-page")
def render_pdf_page(
    path: str = Query(...),
    page: int = Query(default=1, ge=1),
    zoom: float = Query(default=1.5, ge=0.25, le=4.0),
) -> Response:
    png_bytes = doc_engine.render_pdf_page_png(path, page=page, zoom=zoom)
    return Response(content=png_bytes, media_type="image/png", headers={"Content-Disposition": "inline"})


@files_router.post("/pdf-annotate")
def annotate_pdf(body: PdfAnnotateBody) -> dict:
    return ok(doc_engine.annotate_pdf(body.path, body.page, body.note_text, color=body.color))


@files_router.post("/privacy")
def set_privacy(body: PrivacyBody) -> dict:
    return ok(safe_io.set_private(body.path, body.private))


@files_router.get("/snapshots")
def get_snapshots(path: str = Query(...)) -> dict:
    return ok(safe_io.list_snapshots(path))


@files_router.post("/snapshots")
def restore_snapshot(body: RestoreSnapshotBody) -> dict:
    return ok(safe_io.restore_snapshot(body.path, body.snapshot_id))


@files_router.get("/raw-stream")
def raw_stream(path: str = Query(...)) -> FileResponse:
    target = safe_io.resolve_safe_path(path, must_exist=True)
    return FileResponse(target, media_type=doc_engine.guess_mime_type(target), headers={"Content-Disposition": "inline"})


@files_router.get("/archive-entry")
def read_archive_entry(path: str = Query(...), member: str = Query(...)) -> dict:
    return ok(doc_engine.read_archive_entry(path, member))


@files_router.post("/open-external")
def open_external(body: OpenExternalBody) -> dict:
    return ok(doc_engine.open_external(body.path, body.reveal_folder))


@files_router.post("/open-url")
def open_url(body: OpenUrlBody) -> dict:
    return ok(doc_engine.open_external_url(body.url))


@files_router.post("/relocate")
def relocate_file(body: RelocateBody) -> dict:
    return ok(doc_engine.relocate_missing_file(body.filename))


@files_router.get("/backlinks")
def get_backlinks(path: str = Query(...)) -> dict:
    return ok(search_engine.find_backlinks(path))


@files_router.post("/rename")
def rename_file(body: RenameFileBody) -> dict:
    return ok(doc_engine.rename_file(body.path, body.new_name))


@files_router.post("/remove")
def remove_file(body: RemoveFileBody) -> dict:
    return ok(doc_engine.remove_from_workspace(body.path))


@files_router.post("/move")
def move_files(body: MoveFilesBody) -> dict:
    return ok(doc_engine.move_files(body.paths, body.target_folder_rel))


@todos_router.get("/all")
def list_all_todos() -> dict:
    return ok(todo_indexer.scan_all_todos())


@todos_router.post("/toggle")
def toggle_todo(body: ToggleTodoBody) -> dict:
    return ok(todo_indexer.toggle_todo(body.file_path, body.line_no, body.checked, body.expected_text))


@todos_router.post("/add")
def add_todo(body: AddTodoBody) -> dict:
    return ok(todo_indexer.add_todo(body.file_path, body.text))


router.include_router(files_router)
router.include_router(todos_router)
