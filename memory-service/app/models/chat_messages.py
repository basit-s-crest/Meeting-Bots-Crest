"""CRUD operations for chat_messages table."""

from app.database import get_db

MAX_HISTORY_TURNS = 10


async def save_message(project_id: str, chat_session_id: str, role: str, content: str):
    """Save a chat message to the database."""
    db = get_db()
    db.table("chat_messages").insert({
        "project_id": project_id,
        "chat_session_id": chat_session_id,
        "role": role,
        "content": content,
    }).execute()


async def get_recent_messages(project_id: str, chat_session_id: str, limit: int = MAX_HISTORY_TURNS) -> list[dict]:
    """Fetch the last N messages for a chat session, ordered oldest-first."""
    db = get_db()
    result = (
        db.table("chat_messages")
        .select("role, content, created_at")
        .eq("project_id", project_id)
        .eq("chat_session_id", chat_session_id)
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    # Reverse so oldest is first (we fetched desc to get most recent)
    return list(reversed(result.data)) if result.data else []
