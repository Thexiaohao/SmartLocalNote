"""Local apps launcher, desktop window capture, workspaces, knowledge tree, and reminder routes."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from api import ok
from core import app_launcher, scheduler, tree_store

router = APIRouter(prefix="/api", tags=["tools"])


class AddAppBody(BaseModel):
    name: str
    path: str
    aliases: list[str] = Field(default_factory=list)
    args: str = ""


class LaunchBody(BaseModel):
    app_id: str | None = None
    workspace_id: str | None = None


class CreateWorkspaceBody(BaseModel):
    name: str
    app_ids: list[str] = Field(default_factory=list)
    file_paths: list[str] = Field(default_factory=list)
    captured_apps: list[dict[str, Any]] = Field(default_factory=list)


class CreateTreeNodeBody(BaseModel):
    name: str
    parent_id: str | None = None


class UpdateTreeNodeBody(BaseModel):
    node_id: str
    name: str | None = None
    parent_id: str | None = None
    bind_path: str | None = None
    unbind_path: str | None = None
    status: str | None = None


class CreateReminderBody(BaseModel):
    title: str
    trigger_at: str | None = None
    delay_seconds: int | None = None
    app_ids: list[str] = Field(default_factory=list)
    file_paths: list[str] = Field(default_factory=list)


@router.get("/apps")
def list_apps() -> dict:
    return ok(app_launcher.list_apps())


@router.post("/apps")
def add_app(body: AddAppBody) -> dict:
    return ok(app_launcher.add_app(body.name, body.path, aliases=body.aliases, args=body.args))


@router.delete("/apps")
@router.delete("/apps/{app_id}")
def delete_app(app_id: str) -> dict:
    return ok(app_launcher.delete_app(app_id))


@router.get("/apps/running-windows")
def get_running_windows() -> dict:
    return ok(app_launcher.get_running_windows())


@router.post("/apps/launch")
def launch_target(body: LaunchBody) -> dict:
    return ok(app_launcher.launch_target(body.app_id, body.workspace_id))


@router.get("/workspaces")
def list_workspaces() -> dict:
    return ok(app_launcher.list_workspaces())


@router.post("/workspaces")
def create_workspace(body: CreateWorkspaceBody) -> dict:
    return ok(app_launcher.create_workspace(body.name, body.app_ids, body.file_paths, body.captured_apps))


@router.delete("/workspaces")
@router.delete("/workspaces/{workspace_id}")
def delete_workspace(workspace_id: str) -> dict:
    return ok(app_launcher.delete_workspace(workspace_id))


@router.get("/tree")
def get_tree() -> dict:
    return ok(tree_store.get_tree())


@router.post("/tree")
def create_tree_node(body: CreateTreeNodeBody) -> dict:
    return ok(tree_store.create_node(body.name, body.parent_id))


@router.patch("/tree")
def update_tree_node(body: UpdateTreeNodeBody) -> dict:
    return ok(
        tree_store.update_node(
            body.node_id,
            name=body.name,
            parent_id=body.parent_id,
            bind_path=body.bind_path,
            unbind_path=body.unbind_path,
            status=body.status,
        )
    )


@router.delete("/tree")
@router.delete("/tree/{node_id}")
def delete_tree_node(node_id: str) -> dict:
    return ok(tree_store.delete_node(node_id))


@router.get("/reminders")
def list_reminders() -> dict:
    return ok(scheduler.list_reminders())


@router.post("/reminders")
def create_reminder(body: CreateReminderBody) -> dict:
    return ok(
        scheduler.create_reminder(
            body.title,
            trigger_at=body.trigger_at,
            delay_seconds=body.delay_seconds,
            app_ids=body.app_ids,
            file_paths=body.file_paths,
        )
    )


@router.delete("/reminders")
@router.delete("/reminders/{reminder_id}")
def delete_reminder(reminder_id: str) -> dict:
    return ok(scheduler.delete_reminder(reminder_id))
