"""CRUD operations for meeting_events table."""

from app.database import get_db


async def insert_event(event: dict):
    db = get_db()
    db.table("meeting_events").insert(event).execute()


async def get_events_by_project(project_id: str, category: str | None = None, limit: int = 10) -> list[dict]:
    db = get_db()
    query = (
        db.table("meeting_events")
        .select("*")
        .eq("project_id", project_id)
        .order("meeting_date", desc=True)
    )
    if category:
        query = query.eq("category", category)
    result = query.limit(limit).execute()
    return result.data


async def get_events_by_user(user_id: str, project_id: str | None = None, category: str | None = "ACTION_ITEM") -> list[dict]:
    db = get_db()
    query = (
        db.table("meeting_events")
        .select("*")
        .eq("assignee_user_id", user_id)
        .order("created_at", desc=True)
    )
    if project_id:
        query = query.eq("project_id", project_id)
    if category:
        query = query.eq("category", category)
    result = query.execute()
    return result.data or []


async def update_event_assignment(event_id: str, assignee_user_id: str | None, confirmed: bool = True, completed: bool | None = None):
    db = get_db()
    payload = {
        "assignee_user_id": assignee_user_id,
        "assignee_confirmed": confirmed,
    }
    if completed is not None:
        payload["completed"] = completed
    result = db.table("meeting_events").update(payload).eq("id", event_id).execute()
    return result.data
