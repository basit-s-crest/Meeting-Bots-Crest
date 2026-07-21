"""Post-meeting extraction pipeline.

Called when a meeting ends:
  1. Fetch all transcript segments for this session
  2. Groq-extract decisions, action items, feature discussions, risks
  3. Embed each event with sentence-transformers
  4. Persist to meeting_events table
  5. Update project_memory rollup
"""

import json
from datetime import date

from fastapi import APIRouter
from pydantic import BaseModel

from app.database import get_db
from app.embeddings import embed
from app.groq_client import get_groq
from app.models.meetings import get_meeting, mark_meeting_completed
from app.models.segments import get_segments
from app.models.events import insert_event
from app.models.projects import get_project_memory, upsert_project_memory

router = APIRouter()


class ProcessMeetingRequest(BaseModel):
    session_id: str


_EXTRACTION_MODEL = "llama-3.3-70b-versatile"
_SIGNIFICANCE_THRESHOLD = 0.6

_EXTRACTION_PROMPT = """Extract key business events from this meeting transcript.

Return a JSON object with a single key "events" containing an array of objects.
Each object must have:
- category: "DECISION" | "ACTION_ITEM" | "FEATURE_DISCUSSION" | "ESTIMATE" | "RISK" | "KEY_TOPIC"
- description: 2-3 sentence summary of what happened
- detail: exact quote from the transcript if relevant, or null
- assignee: person responsible (for ACTION_ITEM only, else null)
- priority: "High" | "Medium" | "Low"
- significance: 0.0 to 1.0 (how important is this for future reference)

Rules:
- Only include items with significance >= 0.5 (I will filter further)
- A FEATURE_DISCUSSION is when someone requests or describes a feature
- An ESTIMATE is when a timeline or cost number is mentioned
- A DECISION is something explicitly agreed upon
- A RISK is a concern, blocker, or potential problem raised
- An ACTION_ITEM is a task someone is responsible for
- A KEY_TOPIC is an important subject discussed but not falling into other categories
- Skip greetings, small talk, logistics, scheduling logistics

TRANSCRIPT:
{transcript_text}

Return ONLY the JSON object, no other text."""


@router.post("/process-meeting")
async def process_meeting(req: ProcessMeetingRequest):
    """Called when a meeting ends. Extract events, update project memory."""
    session_id = req.session_id
    print(f"[PostMeeting] Processing session {session_id}")

    # 1. Fetch meeting metadata
    meeting = await get_meeting(session_id)
    if not meeting:
        print(f"[PostMeeting] Session {session_id} not found")
        return {"status": "error", "message": "Session not found"}

    project_id = meeting.get("project_id")
    bot_type = meeting.get("bot_type", "unknown")
    meeting_date = meeting.get("created_at", date.today().isoformat())
    if isinstance(meeting_date, str):
        meeting_date = meeting_date[:10]
    else:
        meeting_date = meeting_date.isoformat()[:10]

    # 2. Fetch all transcript segments
    segments = await get_segments(session_id)
    if not segments:
        print(f"[PostMeeting] No transcript segments found for {session_id}")
        await mark_meeting_completed(session_id)
        return {"status": "processed", "events_count": 0, "reason": "no segments"}

    # 3. Format transcript text for the LLM
    transcript_text = "\n".join(
        f"[{s['start_ts']:.1f}s] {s['speaker_label']}: {s['text']}"
        for s in segments
    )

    print(f"[PostMeeting] Extracting events from {len(segments)} segments...")

    # 4. Call Groq to extract events
    events = await _extract_events(transcript_text)
    if not events:
        print("[PostMeeting] No events extracted")
        await mark_meeting_completed(session_id)
        return {"status": "processed", "events_count": 0, "reason": "no events found"}

    # 5. Filter by significance, embed, and persist
    stored_count = 0
    for event in events:
        if event.get("significance", 0) < _SIGNIFICANCE_THRESHOLD:
            continue

        description = event.get("description", "").strip()
        if not description:
            continue

        # Generate embedding
        embedding = embed(description)

        # Insert into meeting_events
        event_row = {
            "session_id": session_id,
            "project_id": project_id,
            "category": event.get("category", "KEY_TOPIC"),
            "description": description,
            "detail": event.get("detail"),
            "assignee": event.get("assignee"),
            "priority": event.get("priority"),
            "embedding": embedding,
            "meeting_date": meeting_date,
            "bot_type": bot_type,
        }

        try:
            await insert_event(event_row)
            stored_count += 1
        except Exception as e:
            print(f"[PostMeeting] Failed to insert event: {e}")

    print(f"[PostMeeting] Stored {stored_count} events")

    # 6. Update project memory rollup
    if project_id:
        await _update_project_memory(project_id, stored_count, meeting_date)

    # 7. Mark meeting as completed
    await mark_meeting_completed(session_id)

    return {"status": "processed", "events_count": stored_count}


async def _extract_events(transcript_text: str) -> list[dict]:
    """Call Groq to extract structured events from the transcript."""
    # Truncate very long transcripts to stay within token limits
    max_chars = 50000
    if len(transcript_text) > max_chars:
        lines = transcript_text.split("\n")
        # Keep first and last portions, remove middle
        transcript_text = "\n".join(lines[:1000]) + "\n...[truncated]...\n" + "\n".join(lines[-500:])

    try:
        groq = get_groq()
        response = groq.chat.completions.create(
            model=_EXTRACTION_MODEL,
            messages=[{
                "role": "user",
                "content": _EXTRACTION_PROMPT.format(transcript_text=transcript_text),
            }],
            response_format={"type": "json_object"},
            temperature=0.1,
            max_tokens=3000,
        )

        content = response.choices[0].message.content
        data = json.loads(content)

        # Handle both {"events": [...]} and direct array formats
        if isinstance(data, dict) and "events" in data:
            return data["events"]
        elif isinstance(data, list):
            return data
        else:
            print(f"[PostMeeting] Unexpected response format: {type(data)}")
            return []

    except Exception as e:
        print(f"[PostMeeting] Groq extraction failed: {e}")
        return []


async def _update_project_memory(project_id: str, new_events_count: int, meeting_date: str):
    """Update the project_memory rollup after a meeting is processed."""
    try:
        db = get_db()

        # Count meetings, decisions, and action items via data length
        meetings = db.table("meeting_sessions").select("session_id").eq("project_id", project_id).execute()
        decisions = db.table("meeting_events").select("id").eq("project_id", project_id).eq("category", "DECISION").execute()
        action_items = db.table("meeting_events").select("id").eq("project_id", project_id).eq("category", "ACTION_ITEM").execute()
        recent = db.table("meeting_events").select("description").eq("project_id", project_id).limit(50).execute()

        total_meetings = max(len(meetings.data) if meetings.data else 1, 1)
        total_decisions = len(decisions.data) if decisions.data else 0
        open_action_items = len(action_items.data) if action_items.data else 0

        # Extract rough themes from event descriptions
        all_text = " ".join(r.get("description", "") for r in (recent.data or [])).lower()
        theme_keywords = [
            "pricing", "timeline", "feature", "integration", "security",
            "performance", "design", "testing", "deployment", "api",
            "dashboard", "reporting", "analytics", "migration", "scalability",
            "authentication", "database", "infrastructure",
        ]
        detected_themes = [kw for kw in theme_keywords if kw in all_text]

        record = {
            "project_id": project_id,
            "total_meetings": total_meetings,
            "total_decisions": total_decisions,
            "open_action_items": open_action_items,
            "last_meeting_date": meeting_date,
            "key_themes": detected_themes,
            "last_updated": "now()",
        }

        await upsert_project_memory(record)
        print(f"[PostMeeting] Project memory updated for {project_id}")

    except Exception as e:
        print(f"[PostMeeting] Failed to update project memory: {e}")
