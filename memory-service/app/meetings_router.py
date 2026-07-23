"""FastAPI router for meeting_sessions CRUD endpoints."""

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.models.meetings import (
    create_meeting,
    get_meeting,
    list_meetings,
    update_meeting,
    delete_meeting,
)

router = APIRouter()


class CreateMeetingRequest(BaseModel):
    session_id: str
    bot_type: str
    meeting_url: str
    bot_name: str | None = "Meeting Bot"
    title: str | None = None
    status: str | None = "starting"
    project_id: str | None = None
    client_id: str | None = None


class UpdateMeetingRequest(BaseModel):
    title: str | None = None
    bot_name: str | None = None
    status: str | None = None
    meeting_url: str | None = None
    project_id: str | None = None
    client_id: str | None = None
    transcript_file_url: str | None = None
    report_file_url: str | None = None


@router.post("/meetings")
async def create_meeting_endpoint(body: CreateMeetingRequest):
    """Create a new meeting session."""
    data = body.model_dump(exclude_unset=True)
    if not data.get("title") and data.get("bot_name"):
        data["title"] = data["bot_name"]
    res = await create_meeting(data)
    return {"success": True, "meeting": res}


@router.get("/meetings")
async def list_meetings_endpoint(
    project_id: str | None = Query(None),
    include_archived: bool = Query(True),
    limit: int = Query(100),
):
    """List meeting sessions."""
    meetings = await list_meetings(
        project_id=project_id,
        include_archived=include_archived,
        limit=limit,
    )
    return {"meetings": meetings}


@router.get("/meetings/{session_id}")
async def get_meeting_endpoint(session_id: str):
    """Get details of a single meeting session."""
    meeting = await get_meeting(session_id)
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting session not found")
    return {"meeting": meeting}


@router.put("/meetings/{session_id}")
async def update_meeting_endpoint(session_id: str, body: UpdateMeetingRequest):
    """Update meeting session metadata or status (e.g. rename or archive)."""
    update_data = body.model_dump(exclude_unset=True)
    updated = await update_meeting(session_id, update_data)
    if not updated:
        raise HTTPException(status_code=404, detail="Meeting session not found or failed to update")
    return {"success": True, "meeting": updated}


@router.delete("/meetings/{session_id}")
async def delete_meeting_endpoint(session_id: str):
    """Delete meeting session and perform cascading deletion of segments/events/buffers."""
    success = await delete_meeting(session_id)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to delete meeting session")
    return {"success": True, "session_id": session_id}
