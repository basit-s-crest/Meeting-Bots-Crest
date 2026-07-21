"""Query router with intent classification and retrieval strategies.

Query classification is done with simple keyword rules — no LLM call needed
for routing. Only the final answer synthesis uses Groq.
"""

import json
import os
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
    """Extract meaningful keywords from the question for hybrid search.
    Strips common stop words and returns the longest meaningful fragment."""
    stop_words = {
        "what", "when", "where", "who", "how", "is", "was", "are", "were",
        "did", "do", "does", "has", "have", "had", "the", "a", "an", "in",
        "on", "at", "to", "for", "of", "with", "about", "tell", "show",
        "give", "find", "list", "get", "me", "we", "they", "it", "you",
        "that", "this", "these", "those", "can", "could", "would", "will",
        "please", "from", "all", "any", "some", "also", "just", "not",
        "discuss", "discussed", "discussing", "mention", "mentioned",
        "talk", "talked", "talking", "say", "said", "saying",
    }
    words = question.lower().split()
    keywords = [w for w in words if w not in stop_words and len(w) > 2]
    return " ".join(keywords[:5]) if keywords else ""


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


def cosine_similarity(v1: list[float] | None, v2: list[float] | str | None) -> float:
    """Compute cosine similarity between two vector embeddings."""
    if isinstance(v2, str):
        try:
            v2 = json.loads(v2)
        except Exception:
            return 0.0
    if not v1 or not v2 or len(v1) != len(v2):
        return 0.0
    dot = sum(a * b for a, b in zip(v1, v2))
    norm1 = sum(a * a for a in v1) ** 0.5
    norm2 = sum(b * b for b in v2) ** 0.5
    return dot / (norm1 * norm2) if (norm1 > 0 and norm2 > 0) else 0.0


async def _query_semantic(project_id: str | None, question: str, chat_history: list[dict] | None = None) -> dict:
    """Strategy B: Pure vector similarity scoring against transcript_segments filtered by project_id."""
    q_embedding = embed(f"Represent this sentence for searching relevant passages: {question}")
    db = get_db()

    context_lines = []
    citations = []

    # 1. Search transcript_segments directly matching project_id OR meeting session_ids
    if project_id:
        try:
            sess_res = db.table("meeting_sessions") \
                .select("session_id, bot_type, created_at, transcript_file_url") \
                .eq("project_id", project_id) \
                .order("created_at", desc=True) \
                .execute()

            session_map = {s["session_id"]: s for s in (sess_res.data or []) if s.get("session_id")}
            session_ids = list(session_map.keys())

            seg_res_proj = db.table("transcript_segments") \
                .select("id, session_id, speaker_label, text, embedding, created_at") \
                .eq("project_id", project_id) \
                .order("created_at", desc=True) \
                .limit(1000) \
                .execute()

            combined_segments = {s["id"]: s for s in (seg_res_proj.data or [])}

            if session_ids:
                seg_res_sess = db.table("transcript_segments") \
                    .select("id, session_id, speaker_label, text, embedding, created_at") \
                    .in_("session_id", session_ids) \
                    .order("created_at", desc=True) \
                    .limit(1000) \
                    .execute()
                for s in (seg_res_sess.data or []):
                    combined_segments[s["id"]] = s

            segments = list(combined_segments.values())

            if segments:
                # Vector Similarity Scoring (Cosine Distance)
                scored_segments = []
                for s in segments:
                    emb = s.get("embedding")
                    score = cosine_similarity(q_embedding, emb) if emb else 0.0
                    if score >= 0.40:
                        scored_segments.append((score, s))

                # Sort by similarity score descending
                scored_segments.sort(key=lambda item: item[0], reverse=True)

                # Select top passages (highest vector similarity)
                top_passages = [item[1] for item in scored_segments[:15]]

                for s in top_passages:
                    sid = s.get("session_id")
                    s_info = session_map.get(sid, {})
                    date_str = s_info.get('created_at') or s.get('created_at') or 'Meeting'
                    context_lines.append(f"[{date_str} | {s.get('speaker_label', 'Speaker')}]: {s.get('text', '')}")

                # Build citations ONLY from high similarity matches (score >= 0.40)
                used_sessions = set()
                for score, s in scored_segments[:10]:
                    sid = s.get("session_id")
                    if sid and sid not in used_sessions:
                        used_sessions.add(sid)
                        s_info = session_map.get(sid, {})
                        citations.append({
                            "sessionId": sid,
                            "meetingDate": s_info.get("created_at") or s.get("created_at", ""),
                            "platform": s_info.get("bot_type", "meeting"),
                            "snippet": s.get("text", "")[:200]
                        })

            # Include meeting session metadata context for general list/date questions
            if sess_res.data and not context_lines:
                session_meta_lines = [
                    f"Session {s.get('session_id')} ({s.get('bot_type', 'meeting')} platform): held on {s.get('created_at', 'Meeting')}"
                    for s in sess_res.data[:10]
                ]
                context_lines.append("--- Project Recent Meeting Sessions ---\n" + "\n".join(session_meta_lines))

        except Exception as e:
            print(f"[MemoryService] Semantic query error: {e}")

    if not context_lines:
        return {
            "answer": "I could not find information about that in past meetings.",
            "citations": [],
            "answeredVia": "vector_search",
            "usedFallback": False
        }

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
