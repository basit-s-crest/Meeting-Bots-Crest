"""Query router with intent classification and retrieval strategies.

Query classification is done with simple keyword rules — no LLM call needed
for routing. Only the final answer synthesis uses Groq.
"""

import json
import os
import asyncio
from datetime import datetime

print(f"QUERY_ROUTER LOADED - v2 - {os.path.getmtime(__file__)}")

import redis.asyncio as redis
from fastapi import APIRouter
from pydantic import BaseModel

from app.config import REDIS_URL
from app.database import get_db
from app.embeddings import embed
from app.groq_client import get_groq, build_synthesis_prompt
from app.models.chat_messages import get_recent_messages, save_message

router = APIRouter()
_redis_client: redis.Redis | None = None


def get_redis() -> redis.Redis:
    global _redis_client
    if _redis_client is None:
        _redis_client = redis.from_url(REDIS_URL, decode_responses=True)
    return _redis_client


class QueryRequest(BaseModel):
    question: str
    session_id: str | None = None
    project_id: str | None = None
    chat_session_id: str | None = None


# ── Intent classification (rule-based, zero LLM cost) ──────────────

_CURRENT_MEETING_KEYWORDS = [
    "just now", "just said", "earlier", "a minute ago", "currently",
    "right now", "in this meeting", "in this call", "today's meeting",
]

_STRUCTURED_INTENTS = {
    "action_items": ["action item", "to-do", "todo", "who is responsible",
                     "who owns", "assigned to", "follow-up", "follow up"],
    "decisions": ["decision", "decided", "agreed", "concluded", "finalized",
                  "what did we decide"],
    "risks": ["risk", "blocker", "blocking", "concern", "issue", "problem",
              "what's blocking"],
    "estimates": ["estimate", "timeline", "deadline", "due date", "how long",
                  "when will", "by when"],
}


def _classify_intent(question: str) -> str:
    q = question.lower()
    for intent, keywords in _STRUCTURED_INTENTS.items():
        if any(kw in q for kw in keywords):
            return intent
    return "semantic"


def _is_current_meeting_query(question: str) -> bool:
    q = question.lower()
    return any(kw in q for kw in _CURRENT_MEETING_KEYWORDS)


def _extract_keywords(question: str) -> str:
    """Extract keywords with meeting-domain awareness."""
    # Generic stop words — but NOT meeting-specific terms
    stop_words = {
        "the", "a", "an", "in", "on", "at", "to", "for", "of", "with",
        "is", "was", "are", "were", "be", "been", "being",
        "it", "this", "that", "these", "those",
        "can", "could", "would", "will", "should",
        "please", "just", "also", "very", "really",
    }
    # KEEP: "what", "when", "where", "who", "how", "did", "do", "does",
    #        "has", "have", "had", "tell", "show", "give", "find", "list",
    #        "get", "me", "we", "they", "you", "from", "all", "any", "some",
    #        "about", "discuss", "discussed", "mention", "talk", "talked",
    #        "said", "saying"
    # These carry meaning in meeting queries: "who said X", "what was discussed"

    words = question.lower().split()
    keywords = [w.strip("?.!,;:") for w in words if w.lower() not in stop_words and len(w) > 2]
    return " ".join(keywords[:8]) if keywords else ""


# ── Retrieval strategies ──────────────────────────────────────────


async def _query_redis_buffer(session_id: str, question: str, chat_history: list[dict] | None = None) -> dict:
    """Strategy A: Read current meeting's segments from Redis + LLM synthesis."""
    try:
        r = get_redis()
        segments = await r.lrange(f"session:{session_id}:segments", 0, -1)
    except Exception:
        return {
            "answer": "Live meeting buffer is unavailable (Redis not connected).",
            "citations": [],
        }

    if not segments:
        return {
            "answer": "No speech captured yet in this meeting.",
            "citations": [],
        }

    parsed = [json.loads(s) for s in segments]
    # Take most recent segments for context (last ~50 entries)
    recent = parsed[-50:]
    context_lines = [
        f"[{s['speaker_label']}]: {s['text']}" for s in recent
    ]

    return await _synthesize(question, context_lines, "current meeting", chat_history)


async def _query_structured(project_id: str, intent: str, chat_history: list[dict] | None = None) -> dict:
    """Strategy C: Direct SQL filter by category."""
    category_map = {
        "action_items": "ACTION_ITEM",
        "decisions": "DECISION",
        "risks": "RISK",
        "estimates": "ESTIMATE",
    }
    category = category_map.get(intent)
    if not category:
        return {"answer": f"Unknown intent: {intent}", "citations": []}

    db = get_db()
    result = (
        db.table("meeting_events")
        .select("description, detail, assignee, priority, meeting_date, bot_type")
        .eq("project_id", project_id)
        .eq("category", category)
        .order("meeting_date", desc=True)
        .limit(10)
        .execute()
    )

    if not result.data:
        return {
            "answer": f"No {intent} found for this project.",
            "citations": [],
        }

    context_lines = [
        f"[{r['meeting_date']} | {r['bot_type']}] {r['description']}"
        + (f" (Assignee: {r['assignee']})" if r.get("assignee") else "")
        for r in result.data
    ]

    return await _synthesize(
        f"List all {intent} for this project", context_lines, "past meetings", chat_history
    )


async def _query_semantic(project_id: str | None, question: str, chat_history: list[dict] | None = None) -> dict:
    """Strategy B: pgvector semantic search + keyword hybrid.

    Searches BOTH meeting_events (extracted decisions/action items/risks) and
    transcript_segments (raw conversation) in parallel, then merges results for
    Groq synthesis. Events give structured "what was decided," segments give
    supporting raw context and exact wording.
    """
    q_embedding = embed(f"Represent this sentence for searching relevant passages: {question}")
    keyword = _extract_keywords(question)
    db = get_db()

    events = []
    segments = []

    # Run both searches in parallel — one embedding, two queries.
    if project_id:
        try:
            events_result, segments_result = await asyncio.gather(
                asyncio.to_thread(
                    lambda: db.rpc(
                        "search_meeting_events",
                        {
                            "p_project_id": project_id,
                            "p_query_embedding": q_embedding,
                            "p_keyword": keyword,
                            "p_match_count": 12,
                        },
                    ).execute()
                ),
                asyncio.to_thread(
                    lambda: db.rpc(
                        "search_transcript_segments",
                        {
                            "p_project_id": project_id,
                            "p_query_embedding": q_embedding,
                            "p_keyword": keyword,
                            "p_match_count": 12,
                        },
                    ).execute()
                ),
            )
            events = events_result.data or []
            segments = segments_result.data or []
        except Exception as e:
            print(f"[MemoryService] Semantic query database error: {e}")

    if not events and not segments:
        # Solution D: Session Metadata Fallback
        # If we have session metadata, list them so the user knows what meetings exist.
        if project_id:
            try:
                sess_res = db.table("meeting_sessions") \
                    .select("session_id, bot_type, created_at") \
                    .eq("project_id", project_id) \
                    .order("created_at", desc=True) \
                    .limit(10) \
                    .execute()
                if sess_res.data:
                    session_meta_lines = [
                        f"Session {s.get('session_id')} ({s.get('bot_type', 'meeting')} platform): held on {s.get('created_at', 'Meeting')}"
                        for s in sess_res.data
                    ]
                    fallback_context = ["--- Project Recent Meeting Sessions ---\n" + "\n".join(session_meta_lines)]
                    answer = await _synthesize(question, fallback_context, "past meetings", chat_history)
                    answer["citations"] = []
                    answer["answeredVia"] = "session_metadata_fallback"
                    answer["usedFallback"] = True
                    return answer
            except Exception as e:
                print(f"[MemoryService] Session metadata fallback error: {e}")

        # No vector results and no sessions, but if we have chat history from this session,
        # the LLM can answer from the previous conversation (e.g. a follow-up
        # like "what is the deployment date?" right after it was mentioned).
        if chat_history:
            answer = await _synthesize(question, [], "past meetings", chat_history)
            answer["citations"] = []
            answer["answeredVia"] = "chat_history"
            answer["usedFallback"] = True
            return answer

        return {
            "answer": "I could not find information about that in past meetings.",
            "citations": [],
            "answeredVia": "vector_search",
            "usedFallback": False
        }

    # Build context lines — events first (higher signal), then segments (raw context).
    context_lines = []
    for r in events:
        context_lines.append(
            f"[EVENT | {r.get('meeting_date') or 'Meeting'} | {r.get('bot_type', 'meeting')}] {r.get('description', '')}"
        )
    for r in segments:
        speaker = r.get("resolved_name") or r.get("speaker_label", "Unknown")
        context_lines.append(
            f"[SEGMENT | {r.get('meeting_date') or 'Meeting'} | {r.get('bot_type', 'meeting')}] {speaker}: {r.get('segment_text', r.get('text', ''))}"
        )

    # Build citations from both sources.
    citations = []
    for r in events[:5]:
        citations.append({
            "sessionId": r.get("session_id"),
            "meetingDate": r.get("meeting_date"),
            "platform": r.get("bot_type", "meeting"),
            "snippet": r.get("description", "")[:200],
        })
    for r in segments[:5]:
        speaker = r.get("resolved_name") or r.get("speaker_label", "Unknown")
        citations.append({
            "sessionId": r.get("session_id"),
            "meetingDate": r.get("meeting_date"),
            "platform": r.get("bot_type", "meeting"),
            "snippet": f"{speaker}: {r.get('segment_text', r.get('text', ''))}"[:200],
        })

    answer = await _synthesize(question, context_lines, "past meetings", chat_history)
    answer["citations"] = citations
    answer["answeredVia"] = "vector_search"
    answer["usedFallback"] = False
    return answer


async def _synthesize(question: str, context: list[str], source_label: str, chat_history: list[dict] | None = None) -> dict:
    """Unified answer synthesis via Groq."""
    try:
        groq = get_groq()
        prompt = build_synthesis_prompt(question, context)

        messages = []
        if chat_history:
            history_text = "\n".join(f"{m['role']}: {m['content']}" for m in chat_history)
            messages.append({
                "role": "system",
                "content": f"Previous conversation in this session:\n{history_text}\n\nUse this to resolve follow-up references like 'him', 'that', 'the deadline', etc.",
            })
        messages.append({"role": "user", "content": prompt})

        response = groq.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=messages,
            response_format={"type": "json_object"},
            temperature=0.2,
            max_tokens=1024,
        )

        result = json.loads(response.choices[0].message.content)
        return {
            "answer": result.get("answer", ""),
            "citations": result.get("citations", []),
        }
    except Exception as e:
        return {
            "answer": f"Failed to generate answer: {e}",
            "citations": [],
        }


# ── Route ────────────────────────────────────────────────────────


@router.post("/query")
async def query_memory(body: QueryRequest):
    """Answer a natural language question using meeting memory.

    Routing logic:
      1. If session_id provided and question is about current meeting → Redis
      2. If intent is structured (action_items, decisions, risks) → SQL
      3. Default → pgvector semantic search
    """
    question = body.question.strip()
    session_id = body.session_id
    project_id = body.project_id
    chat_session_id = body.chat_session_id

    if not question:
        return {"answer": "Please ask a question.", "citations": []}

    _GREETINGS = {"hi", "hello", "hey", "greetings", "good morning", "good afternoon", "good evening", "hi there", "hello there", "who are you", "help"}
    if question.lower().strip().rstrip('.!?') in _GREETINGS:
        return {
            "answer": "Hello! I am your AI Meeting Knowledge Assistant. Ask me anything about your project's meeting transcripts, key decisions, or action items!",
            "citations": [],
            "answeredVia": "greeting_handler",
            "usedFallback": False
        }

    # Step 1: Check for live meeting + current-scope query
    # Load recent chat history for follow-up resolution
    chat_history = None
    if chat_session_id and project_id:
        chat_history = await get_recent_messages(project_id, chat_session_id)
        # Save the user's question immediately
        await save_message(project_id, chat_session_id, "user", question)

    # Step 1: Check for live meeting + current-scope query (uses Redis, no project_id needed)
    if session_id and _is_current_meeting_query(question):
        result = await _query_redis_buffer(session_id, question, chat_history)
        if chat_session_id and project_id:
            await save_message(project_id, chat_session_id, "assistant", result.get("answer", ""))
        return result

    # All other strategies require project_id for data isolation
    if not project_id:
        return {
            "answer": "Please provide a project context to search across meetings.",
            "citations": [],
        }

    # Step 2: Check for structured intent (action items, decisions, risks)
    intent = _classify_intent(question)
    if intent in ("action_items", "decisions", "risks", "estimates"):
        result = await _query_structured(project_id, intent, chat_history)
        if result.get("citations") or (result.get("answer") and not result.get("answer").startswith("No ")):
            if chat_session_id:
                await save_message(project_id, chat_session_id, "assistant", result.get("answer", ""))
            return result

    # Step 3: Default — semantic vector search
    result = await _query_semantic(project_id, question, chat_history)
    if chat_session_id:
        await save_message(project_id, chat_session_id, "assistant", result.get("answer", ""))
    return result
