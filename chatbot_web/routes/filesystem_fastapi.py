"""
FastAPI REST API routes for filesystem operations in E2B sandbox.

Endpoints:
- GET  /api/fs/list       - List directory contents
- GET  /api/fs/read       - Read file contents
- POST /api/fs/write      - Write file contents
- POST /api/fs/mkdir      - Create directory
- DELETE /api/fs/delete   - Delete file or directory
- POST /api/fs/rename     - Rename/move file or directory
"""

import os
import sys
import logging
import base64
from typing import Optional, List, Dict, Any

from fastapi import APIRouter, HTTPException, Query, Depends
from pydantic import BaseModel

from middleware.auth import get_current_user

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from e2b_code_interpreter import AsyncSandbox
from e2b.exceptions import NotFoundException

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/fs",
    tags=["filesystem"],
    dependencies=[Depends(get_current_user)],
)

# Default workspace path
DEFAULT_PATH = "/home/user/workspace"


class FileInfo(BaseModel):
    name: str
    type: str  # "file" or "directory"
    size: int
    modified: str
    permissions: str
    path: str


class ListResponse(BaseModel):
    path: str
    files: List[FileInfo]


class ReadResponse(BaseModel):
    path: str
    content: str


class WriteRequest(BaseModel):
    path: str
    content: str
    encoding: Optional[str] = None  # "base64" for binary files


class MkdirRequest(BaseModel):
    path: str


class RenameRequest(BaseModel):
    old_path: str
    new_path: str


class SuccessResponse(BaseModel):
    success: bool
    path: Optional[str] = None
    message: Optional[str] = None


def parse_ls_output(output: str, base_path: str) -> List[FileInfo]:
    """Parse ls -la output into FileInfo objects."""
    files = []
    lines = output.strip().split('\n')

    for line in lines:
        # Skip the "total" line and empty lines
        if line.startswith('total') or not line.strip():
            continue

        parts = line.split()
        if len(parts) < 9:
            continue

        # Parse ls -la output format:
        # permissions links owner group size month day time/year name
        permissions = parts[0]
        size = int(parts[4]) if parts[4].isdigit() else 0
        modified = f"{parts[5]} {parts[6]} {parts[7]}"
        name = ' '.join(parts[8:])  # Handle filenames with spaces

        # Skip . and ..
        if name in ['.', '..']:
            continue

        # Determine type from permissions
        file_type = 'directory' if permissions.startswith('d') else 'file'

        # Build full path
        full_path = os.path.join(base_path, name)
        if base_path.endswith('/'):
            full_path = base_path + name

        files.append(FileInfo(
            name=name,
            type=file_type,
            size=size,
            modified=modified,
            permissions=permissions,
            path=full_path
        ))

    return files


async def get_sandbox(sandbox_id: str) -> AsyncSandbox:
    """Connect to sandbox by ID."""
    try:
        sandbox = await AsyncSandbox.connect(sandbox_id=sandbox_id)
        return sandbox
    except NotFoundException:
        raise HTTPException(status_code=404, detail=f"Sandbox {sandbox_id} not found")
    except Exception as e:
        logger.error(f"Failed to connect to sandbox {sandbox_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to connect to sandbox: {str(e)}")


@router.get("/list", response_model=ListResponse)
async def list_directory(
    path: str = Query(default=DEFAULT_PATH, description="Directory path to list"),
    sandbox_id: str = Query(..., description="Sandbox ID")
):
    """List files in a directory."""
    sandbox = await get_sandbox(sandbox_id)

    try:
        # Use ls -la to get detailed file info
        result = await sandbox.commands.run(f'ls -la "{path}"', timeout=10)

        if result.exit_code != 0:
            # Check if path exists
            exists_result = await sandbox.commands.run(f'test -e "{path}" && echo "exists"', timeout=5)
            if "exists" not in (exists_result.stdout or ""):
                raise HTTPException(status_code=404, detail=f"Path not found: {path}")
            raise HTTPException(status_code=500, detail=f"Failed to list directory: {result.stderr}")

        files = parse_ls_output(result.stdout or "", path)
        return ListResponse(path=path, files=files)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error listing directory {path}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/read", response_model=ReadResponse)
async def read_file(
    path: str = Query(..., description="File path to read"),
    sandbox_id: str = Query(..., description="Sandbox ID")
):
    """Read file contents."""
    sandbox = await get_sandbox(sandbox_id)

    try:
        # Check if it's a directory
        is_dir_result = await sandbox.commands.run(f'test -d "{path}" && echo "dir"', timeout=5)
        if "dir" in (is_dir_result.stdout or ""):
            raise HTTPException(status_code=400, detail="Cannot read directory as file")

        # Check if file exists
        exists_result = await sandbox.commands.run(f'test -f "{path}" && echo "exists"', timeout=5)
        if "exists" not in (exists_result.stdout or ""):
            raise HTTPException(status_code=404, detail=f"File not found: {path}")

        # Read file content
        content = await sandbox.files.read(path)
        return ReadResponse(path=path, content=content)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error reading file {path}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/write", response_model=SuccessResponse)
async def write_file(
    request: WriteRequest,
    sandbox_id: str = Query(..., description="Sandbox ID")
):
    """Write content to a file."""
    sandbox = await get_sandbox(sandbox_id)

    try:
        # Check if path is a directory
        is_dir_result = await sandbox.commands.run(f'test -d "{request.path}" && echo "dir"', timeout=5)
        if "dir" in (is_dir_result.stdout or ""):
            raise HTTPException(status_code=400, detail="Cannot write to directory")

        # Create parent directory if needed
        parent_dir = os.path.dirname(request.path)
        if parent_dir:
            await sandbox.commands.run(f'mkdir -p "{parent_dir}"', timeout=10)

        # Handle base64 encoding for binary files
        content = request.content
        if request.encoding == "base64":
            content = base64.b64decode(content)

        # Write file
        await sandbox.files.write(request.path, content)
        return SuccessResponse(success=True, path=request.path)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error writing file {request.path}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/mkdir", response_model=SuccessResponse)
async def make_directory(
    request: MkdirRequest,
    sandbox_id: str = Query(..., description="Sandbox ID")
):
    """Create a directory."""
    sandbox = await get_sandbox(sandbox_id)

    try:
        # Check if path already exists
        exists_result = await sandbox.commands.run(f'test -e "{request.path}" && echo "exists"', timeout=5)
        if "exists" in (exists_result.stdout or ""):
            raise HTTPException(status_code=400, detail="Path already exists")

        # Create directory
        result = await sandbox.commands.run(f'mkdir -p "{request.path}"', timeout=10)

        if result.exit_code != 0:
            raise HTTPException(status_code=500, detail=f"Failed to create directory: {result.stderr}")

        return SuccessResponse(success=True, path=request.path)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating directory {request.path}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/delete", response_model=SuccessResponse)
async def delete_item(
    path: str = Query(..., description="Path to delete"),
    sandbox_id: str = Query(..., description="Sandbox ID")
):
    """Delete a file or directory."""
    sandbox = await get_sandbox(sandbox_id)

    try:
        # Check if path exists
        exists_result = await sandbox.commands.run(f'test -e "{path}" && echo "exists"', timeout=5)
        if "exists" not in (exists_result.stdout or ""):
            raise HTTPException(status_code=404, detail=f"Path not found: {path}")

        # Delete (use -rf for directories)
        result = await sandbox.commands.run(f'rm -rf "{path}"', timeout=30)

        if result.exit_code != 0:
            raise HTTPException(status_code=500, detail=f"Failed to delete: {result.stderr}")

        return SuccessResponse(success=True, message=f"Deleted: {path}")

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting {path}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/rename", response_model=SuccessResponse)
async def rename_item(
    request: RenameRequest,
    sandbox_id: str = Query(..., description="Sandbox ID")
):
    """Rename or move a file or directory."""
    sandbox = await get_sandbox(sandbox_id)

    try:
        # Check if source exists
        exists_result = await sandbox.commands.run(f'test -e "{request.old_path}" && echo "exists"', timeout=5)
        if "exists" not in (exists_result.stdout or ""):
            raise HTTPException(status_code=404, detail=f"Source not found: {request.old_path}")

        # Check if destination already exists
        dest_exists = await sandbox.commands.run(f'test -e "{request.new_path}" && echo "exists"', timeout=5)
        if "exists" in (dest_exists.stdout or ""):
            raise HTTPException(status_code=400, detail=f"Destination already exists: {request.new_path}")

        # Create parent directory of destination if needed
        parent_dir = os.path.dirname(request.new_path)
        if parent_dir:
            await sandbox.commands.run(f'mkdir -p "{parent_dir}"', timeout=10)

        # Move/rename
        result = await sandbox.commands.run(f'mv "{request.old_path}" "{request.new_path}"', timeout=30)

        if result.exit_code != 0:
            raise HTTPException(status_code=500, detail=f"Failed to rename: {result.stderr}")

        return SuccessResponse(success=True, path=request.new_path, message=f"Renamed to: {request.new_path}")

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error renaming {request.old_path} to {request.new_path}: {e}")
        raise HTTPException(status_code=500, detail=str(e))
