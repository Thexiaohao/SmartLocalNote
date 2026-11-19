"""AI copilot routes: structured summarization, multi-file SSE chat, table extraction, and classification."""

from __future__ import annotations

from collections.abc import AsyncIterator
import json
from typing import Any

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from api import ok
from core import ai_service

router = APIRouter(prefix="/api/ai", tags=["ai"])

_SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


class SummarizeBody(BaseModel):
    text: str = ""
    file_path: str | None = None


class ChatBody(BaseModel):
    messages: list[dict[str, Any]]
    web_search: bool = False
    context_paths: list[str] = Field(default_factory=list)


class ExtractTableBody(BaseModel):
    text: str
    headers: list[str]


class ClassifyBody(BaseModel):
    file_path: str | None = None
    summary: str = ""


class MindmapBody(BaseModel):
    text: str = ""
    file_path: str | None = None


class PolishBody(BaseModel):
    text: str
    style: str = "article"


async def _format_sse(stream: AsyncIterator[Any]) -> AsyncIterator[str]:
    async for chunk in stream:
        payload = chunk if isinstance(chunk, str) else json.dumps(chunk, ensure_ascii=False)
        yield f"data: {payload}\n\n"


@router.post("/summarize")
async def summarize(body: SummarizeBody) -> dict:
    return ok(await ai_service.summarize_content(body.text, body.file_path))


@router.post("/chat")
async def chat(body: ChatBody) -> StreamingResponse:
    docs = ai_service.validate_chat_context(body.context_paths)
    return StreamingResponse(
        _format_sse(ai_service.stream_chat(body.messages, body.web_search, docs)),
        media_type="text/event-stream",
        headers=_SSE_HEADERS,
    )


@router.post("/extract-table")
async def extract_table(body: ExtractTableBody) -> dict:
    return ok(await ai_service.extract_table_rows(body.text, body.headers))


@router.post("/classify")
async def classify(body: ClassifyBody) -> dict:
    return ok(await ai_service.classify_file(body.file_path, body.summary))


@router.post("/mindmap")
async def mindmap(body: MindmapBody) -> dict:
    return ok(await ai_service.generate_mindmap_outline(body.text, body.file_path))


@router.post("/polish")
async def polish(body: PolishBody) -> dict:
    return ok(await ai_service.polish_fragments(body.text, body.style))
