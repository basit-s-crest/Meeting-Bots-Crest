"""Query router with intent classification and retrieval strategies.

Query classification is done with simple keyword rules — no LLM call needed
for routing. Only the final answer synthesis uses Groq.
"""

import json
import asyncio
from datetime import datetime

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

_GREETINGS = {"hi", "hello", "hey", "greetings", "good morning",
              "good afternoon", "good evening", "hi there", "hello there",
              "who are you", "help"}

_CURRENT_MEETING_KEYWORDS = [
    "just now", "just said", "earlier", "a minute ago", "currently",
    "right now", "in this meeting", "in this call", "today's meeting",
]

_STRUCTURED_INTENTS = {
    "meetings": ["what meetings", "list meetings", "recent meetings", "show meetings",
                 "all meetings", "meeting list", "which meetings"],
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


async def _rewrite_query(question: str, chat_history: list[dict] | None = None) -> str:
    """Rewrite a natural language question into a concise search query.

    Replaces the old _extract_keywords() stop-word approach with an LLM call
    that preserves names, dates, terms and resolves pronouns from chat history.
    The result feeds both the embedding (vector search) and ILIKE (keyword search).
    """
    try:
        groq = get_groq()
        history_block = ""
        if chat_history:
            recent = chat_history[-4:]
            history_block = "\n".join(
                f"{m['role']}: {m['content']}" for m in recent
            )

        prompt = (
            "Rewrite this question as a concise search query for meeting transcripts.\n"
            "Rules:\n"
            "- Keep person names, company names, dates, technical terms, numbers\n"
            "- Remove question words (when, what, who, how) and conversational filler\n"
            "- Output ONLY the rewritten query — no explanation, no quotes\n"
            f"{'Chat history:\n' + history_block + '\n\n' if history_block else ''}"
            f"Question: {question}\n"
            "Search query:"
        )

        response = groq.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=100,
        )

        rewritten = response.choices[0].message.content.strip()
        # Fallback to original if rewrite is empty or degenerate
        if not rewritten or len(rewritten) < 3:
            return question
        return rewritten
    except Exception as e:
        print(f"[QueryRouter] Query rewrite failed, using original: {e}")
        return question


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
    """Strategy C: Direct SQL query for structured intent (events & sessions)."""
    db = get_db()
    if intent == "meetings":
        res = (
            db.table("meeting_sessions")
            .select("session_id, bot_type, created_at, status")
            .eq("project_id", project_id)
            .neq("status", "archived")
            .order("created_at", desc=True)
            .limit(10)
            .execute()
        )
        if not res.data:
            return {"answer": "No active meeting sessions found for this project.", "citations": []}
        context_lines = [
            f"[MEETING | {r.get('created_at', '')[:10]}] Platform: {r.get('bot_type')}, Status: {r.get('status')}, ID: {r.get('session_id')}"
            for r in res.data
        ]
        return await _synthesize("List the meetings in this project", context_lines, "past meetings", chat_history)

    category_map = {
        "action_items": "ACTION_ITEM",
        "decisions": "DECISION",
        "risks": "RISK",
        "estimates": "ESTIMATE",
    }
    category = category_map.get(intent)
    if not category:
        return {"answer": f"Unknown intent: {intent}", "citations": []}

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
    """Strategy B: pgvector semantic search + keyword hybrid with re-ranking.

    Replaces the old _extract_keywords + hard-threshold approach with:
      1. LLM query rewrite (preserves names, dates, technical terms)
      2. Lower vector threshold (0.2) + larger candidate pool (12 per lane)
      3. Parallel search across BOTH meeting_events and transcript_segments
      4. Merge + dedup + re-rank by similarity score
      5. Session metadata fallback when nothing matches
    """
    # Step 1: Rewrite natural language into search query
    rewritten = await _rewrite_query(question, chat_history)
    q_embedding = embed(f"Represent this sentence for searching relevant passages: {rewritten}")

    # Step 2: Build keyword patterns — individual wildcard words separated by | for ILIKE ANY.
    # "CRM discussion delivery date" → "%CRM%|%discussion%|%delivery%|%date%"
    # Each word matches independently in the SQL ILIKE ANY clause.
    words = [w.strip("?.!,;:'\"").lower() for w in rewritten.split() if len(w.strip("?.!,;:'\"")) > 2]
    keyword = "|".join(f"%{w}%" for w in words[:8]) if words else ""

    db = get_db()

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
    except Exception as e:
        return {
            "answer": f"Search failed: {e}",
            "citations": [],
        }

    events = events_result.data or []
    segments = segments_result.data or []

    # Step 3: Merge + dedup + re-rank by similarity score
    # Events get a small score boost since they're higher-signal
    merged = []
    seen_sessions = set()
    for r in events:
        score = r.get("similarity", 0) * 1.05  # 5% boost for structured events
        merged.append((score, "event", r))
        if r.get("session_id"):
            seen_sessions.add(r["session_id"])
    for r in segments:
        score = r.get("similarity", 0)
        merged.append((score, "segment", r))

    # Sort by score descending
    merged.sort(key=lambda x: x[0], reverse=True)

    # Take top 10 across both sources
    top_candidates = merged[:10]

    if not top_candidates:
        # Step 4a: Try chat history fallback
        if chat_history:
            answer = await _synthesize(question, [], "past meetings", chat_history)
            return answer
        # Step 4b: Session metadata fallback — list recent meetings
        return await _session_fallback(project_id)

    # Step 5: Build context lines and citations
    context_lines = []
    citations = []
    citation_sessions = set()

    for score, source_type, r in top_candidates:
        if source_type == "event":
            context_lines.append(
                f"[EVENT | {r['meeting_date']} | {r['bot_type']}] {r['description']}"
            )
            sid = r.get("session_id")
            if sid and sid not in citation_sessions:
                citation_sessions.add(sid)
                citations.append({
                    "sessionId": sid,
                    "meetingDate": r["meeting_date"],
                    "platform": r["bot_type"],
                    "snippet": r["description"][:200],
                })
        else:  # segment
            speaker = r.get("speaker_label", "Unknown")
            seg_text = r.get("text") or r.get("segment_text", "")
            start = r.get("start_ts", "")
            meeting_date = r.get("meeting_date", "")
            bot_type = r.get("bot_type", "meeting")
            ts_str = f"@{start} " if start else ""
            context_lines.append(
                f"[SEGMENT | {meeting_date} {ts_str}| {bot_type}] {speaker}: {seg_text}"
            )
            sid = r.get("session_id")
            if sid and sid not in citation_sessions:
                citation_sessions.add(sid)
                citations.append({
                    "sessionId": sid,
                    "meetingDate": str(meeting_date),
                    "platform": bot_type,
                    "snippet": f"{speaker}: {seg_text}"[:200],
                })

    answer = await _synthesize(question, context_lines, "past meetings", chat_history)
    answer["citations"] = citations
    return answer


async def _session_fallback(project_id: str | None) -> dict:
    """When no search results match, list recent sessions so the user knows what exists."""
    if not project_id:
        return {"answer": "I could not find that in past meetings.", "citations": []}
    try:
        db = get_db()
        result = (
            db.table("meeting_sessions")
            .select("session_id, bot_type, created_at, transcript_file_url")
            .eq("project_id", project_id)
            .order("created_at", desc=True)
            .limit(10)
            .execute()
        )
        if result.data:
            sessions = "\n".join(
                f"  - {s['bot_type']} call on {s['created_at'][:10]}" if s.get('created_at') else f"  - {s['bot_type']} call"
                for s in result.data
            )
            return {
                "answer": f"I could not find that in past meetings. Here are your recent meetings:\n{sessions}\n\nTry asking about specific topics from these sessions.",
                "citations": [],
            }
    except Exception as e:
        print(f"[MemoryService] Session fallback error: {e}")
    return {"answer": "I could not find that in past meetings.", "citations": []}


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

    # Step 0: Greeting handler — trivial, avoid hitting the database
    if question.lower().strip().rstrip('.!?') in _GREETINGS:
        return {
            "answer": "Hello! I am your AI Meeting Knowledge Assistant. "
                      "Ask me anything about your project's meeting transcripts, "
                      "key decisions, or action items!",
            "citations": [],
        }

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

    # Step 2: Check for structured intent (action items, decisions, risks, meetings)
    intent = _classify_intent(question)
    if intent in ("action_items", "decisions", "risks", "estimates", "meetings"):
        result = await _query_structured(project_id, intent, chat_history)
        if chat_session_id:
            await save_message(project_id, chat_session_id, "assistant", result.get("answer", ""))
        return result

    # Step 3: Default — semantic vector search
    result = await _query_semantic(project_id, question, chat_history)
    if chat_session_id:
        await save_message(project_id, chat_session_id, "assistant", result.get("answer", ""))
    return result
