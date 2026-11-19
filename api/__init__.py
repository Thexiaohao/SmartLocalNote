"""FastAPI thin-route helpers and global exception handlers."""

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


def ok(data=None, message: str = "") -> dict:
    """Return unified success response envelope."""
    return {"ok": True, "data": data, "message": message}


def err(message: str, status_code: int = 400) -> JSONResponse:
    """Return unified error JSONResponse envelope."""
    return JSONResponse(status_code=status_code, content={"ok": False, "message": message})


def register_exception_handlers(app: FastAPI) -> None:
    """Register standard exception handlers mapping Python errors to HTTP JSON envelopes."""

    @app.exception_handler(PermissionError)
    async def _handle_permission_error(_request: Request, exc: PermissionError) -> JSONResponse:
        return err(str(exc) or "权限不足，访问被拒绝", status_code=403)

    @app.exception_handler(FileNotFoundError)
    async def _handle_not_found_error(_request: Request, exc: FileNotFoundError) -> JSONResponse:
        return err(str(exc) or "目标文件或路径不存在", status_code=404)

    @app.exception_handler(ValueError)
    async def _handle_value_error(_request: Request, exc: ValueError) -> JSONResponse:
        return err(str(exc) or "请求参数无效", status_code=400)
