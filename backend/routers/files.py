from __future__ import annotations

import os
from pathlib import Path

import aiofiles
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from auth import require_api_token
from config import settings

router = APIRouter(
    prefix="/api/files",
    tags=["files"],
    dependencies=[Depends(require_api_token)],
)


def _safe_path(rel: str) -> Path:
    """Resolve *rel* inside files_root, rejecting traversals."""
    root = settings.files_root.resolve()
    target = (root / rel.lstrip("/")).resolve()
    if not str(target).startswith(str(root)):
        raise HTTPException(status_code=403, detail="Path is outside the allowed directory")
    return target


class FileEntry(BaseModel):
    name: str
    path: str
    is_dir: bool
    size: int = 0
    modified: float = 0.0
    mime_hint: str = ""


class WriteBody(BaseModel):
    path: str
    content: str


def _mime_hint(name: str) -> str:
    ext = Path(name).suffix.lower()
    return {
        ".md": "markdown",
        ".markdown": "markdown",
        ".txt": "text",
        ".py": "python",
        ".js": "javascript",
        ".jsx": "javascript",
        ".ts": "typescript",
        ".tsx": "typescript",
        ".html": "html",
        ".htm": "html",
        ".css": "css",
        ".json": "json",
        ".yaml": "yaml",
        ".yml": "yaml",
        ".sh": "shell",
        ".bash": "shell",
        ".rs": "rust",
        ".go": "go",
        ".c": "c",
        ".cpp": "cpp",
        ".h": "c",
        ".java": "java",
        ".rb": "ruby",
        ".php": "php",
        ".sql": "sql",
        ".xml": "xml",
        ".toml": "toml",
        ".ini": "ini",
        ".env": "shell",
        ".dockerfile": "dockerfile",
    }.get(ext, "text")


@router.get("/list", response_model=list[FileEntry])
async def list_files(path: str = Query("/")) -> list[FileEntry]:
    target = _safe_path(path)
    if not target.exists():
        raise HTTPException(status_code=404, detail=f"Path not found: {path}")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail="Path is not a directory")

    root = settings.files_root.resolve()
    entries: list[FileEntry] = []
    try:
        items = sorted(target.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower()))
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")

    for item in items:
        try:
            stat = item.stat()
        except (PermissionError, OSError):
            continue
        rel = "/" + str(item.relative_to(root))
        entries.append(FileEntry(
            name=item.name,
            path=rel,
            is_dir=item.is_dir(),
            size=stat.st_size if item.is_file() else 0,
            modified=stat.st_mtime,
            mime_hint=_mime_hint(item.name) if item.is_file() else "",
        ))
    return entries


@router.get("/read")
async def read_file(path: str = Query(...)) -> PlainTextResponse:
    target = _safe_path(path)
    if not target.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    if not target.is_file():
        raise HTTPException(status_code=400, detail="Path is not a file")
    try:
        async with aiofiles.open(target, "r", encoding="utf-8", errors="replace") as f:
            content = await f.read()
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")
    return PlainTextResponse(content)


@router.post("/write", status_code=200)
async def write_file(body: WriteBody) -> dict:
    target = _safe_path(body.path)
    if target.is_dir():
        raise HTTPException(status_code=400, detail="Path is a directory")
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        async with aiofiles.open(target, "w", encoding="utf-8") as f:
            await f.write(body.content)
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")
    return {"status": "saved", "path": body.path}
