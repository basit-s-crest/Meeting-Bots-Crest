"""CRUD operations for meeting_sessions table."""

import redis.asyncio as redis
from app.config import REDIS_URL
from app.database import get_db


async def create_meeting(data: dict) -> dict:
    """Create a new meeting session."""
    db = get_db()
    res = db.table("meeting_sessions").insert(data).execute()
    return res.data[0] if res.data else data


async def get_meeting(session_id: str) -> dict | None:
    """Fetch single meeting session by session_id."""
    db = get_db()
    try:
        result = (
            db.table("meeting_sessions")
            .select("*")
            .eq("session_id", session_id)
            .single()
            .execute()
        )
        return result.data if result.data else None
    except Exception:
        return None


async def list_meetings(project_id: str | None = None, include_archived: bool = True, limit: int = 100) -> list[dict]:
    """List meeting sessions with optional project filtering."""
    db = get_db()
    query = db.table("meeting_sessions").select("*")
    if project_id:
        query = query.eq("project_id", project_id)
    if not include_archived:
        query = query.neq("status", "archived")
    query = query.order("created_at", desc=True).limit(limit)
    res = query.execute()
    raw_data = res.data or []

    # Determine which sessions have actual transcript content. A meeting is valid if it
    # has a transcript file OR transcript segments in the DB, even if the storage upload
    # was skipped/failed (transcript_file_url null). Only genuinely empty meetings are
    # filtered out.
    session_ids = [m.get("session_id") for m in raw_data if m.get("session_id")]
    session_ids_with_segments: set[str] = set()
    if session_ids:
        try:
            seg_res = db.table("transcript_segments").select("session_id").in_("session_id", session_ids).execute()
            session_ids_with_segments = {r.get("session_id") for r in (seg_res.data or []) if r.get("session_id")}
        except Exception as e:
            print(f"[MeetingModel] Notice: segment check failed for empty-meeting filter: {e}")

    filtered = [
        m for m in raw_data
        if m.get("status") in ("active", "starting")
        or m.get("transcript_file_url")
        or m.get("session_id") in session_ids_with_segments
    ]
    return filtered


async def update_meeting(session_id: str, update_data: dict) -> dict | None:
    """Update meeting session metadata or status."""
    db = get_db()
    # Filter out None values to avoid overwriting existing columns
    clean_data = {k: v for k, v in update_data.items() if v is not None}
    if not clean_data:
        return await get_meeting(session_id)
    res = (
        db.table("meeting_sessions")
        .update(clean_data)
        .eq("session_id", session_id)
        .execute()
    )
    return res.data[0] if res.data else None


async def mark_meeting_completed(session_id: str):
    """Mark meeting status as completed."""
    await update_meeting(session_id, {"status": "completed"})


async def delete_meeting(session_id: str) -> bool:
    """Cascading deletion of a meeting session, its segments, events, and Redis buffer."""
    db = get_db()
    try:
        # 1. Delete associated transcript_segments
        db.table("transcript_segments").delete().eq("session_id", session_id).execute()
    except Exception as e:
        print(f"[MeetingModel] Notice: delete transcript_segments for {session_id}: {e}")

    try:
        # 2. Delete associated meeting_events
        db.table("meeting_events").delete().eq("session_id", session_id).execute()
    except Exception as e:
        print(f"[MeetingModel] Notice: delete meeting_events for {session_id}: {e}")

    try:
        # 3. Delete from meeting_sessions
        db.table("meeting_sessions").delete().eq("session_id", session_id).execute()
    except Exception as e:
        print(f"[MeetingModel] Notice: delete meeting_sessions for {session_id}: {e}")

    try:
        # 4. Clean up Redis live buffer if active
        r = redis.from_url(REDIS_URL, decode_responses=True)
        await r.delete(f"session:{session_id}:segments")
        await r.aclose()
    except Exception as e:
        print(f"[MeetingModel] Notice: clean up Redis for {session_id}: {e}")

    return True

