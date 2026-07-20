"""Query router with intent classification and retrieval strategies.

Query classification is done with simple keyword rules — no LLM call needed
for routing. Only the final answer synthesis uses Groq.
"""

import json
from datetime import datetime

import redis.asyncio as redis
from fastapi import APIRouter
from pydantic import BaseModel

from app.config import REDIS_URL
from app.database import get_db
from app.embeddings import embed
from app.groq_client import get_groq, build_synthesis_prompt

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


async def _query_redis_buffer(session_id: str, question: str) -> dict:
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

    return await _synthesize(question, context_lines, "current meeting")


async def _query_structured(project_id: str, intent: str) -> dict:
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
        f"List all {intent} for this project", context_lines, "past meetings"
    )


async def _query_semantic(project_id: str | None, question: str) -> dict:
    """Strategy B: pgvector semantic search + keyword hybrid."""
    # bge-small-en-v1.5 expects a query instruction prefix for retrieval.
    q_embedding = embed(f"Represent this sentence for searching relevant passages: {question}")
    keyword = _extract_keywords(question)

    try:
        db = get_db()
        result = db.rpc(
            "search_meeting_events",
            {
                "p_project_id": project_id,
                "p_query_embedding": q_embedding,
                "p_keyword": keyword,
                "p_match_count": 8,
            },
        ).execute()
    except Exception as e:
        return {
            "answer": f"Search failed: {e}",
            "citations": [],
        }

    if not result.data:
        return {
            "answer": "I could not find that in past meetings.",
            "citations": [],
        }

    context_lines = [
        f"[{r['meeting_date']} | {r['bot_type']}] {r['description']}"
        for r in result.data
    ]

    # Build citations from results for the synthesis prompt
    citations = [
        {
            "sessionId": r["session_id"],
            "meetingDate": r["meeting_date"],
            "platform": r["bot_type"],
            "snippet": r["description"][:200],
        }
        for r in result.data[:5]
    ]

    answer = await _synthesize(question, context_lines, "past meetings")

    # Inject the real citations
    answer["citations"] = citations
    return answer


async def _synthesize(question: str, context: list[str], source_label: str) -> dict:
    """Unified answer synthesis via Groq."""
    try:
        groq = get_groq()
        prompt = build_synthesis_prompt(question, context)

        response = groq.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": prompt}],
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

    if not question:
        return {"answer": "Please ask a question.", "citations": []}

    # Step 1: Check for live meeting + current-scope query
    if session_id and _is_current_meeting_query(question):
        return await _query_redis_buffer(session_id, question)

    # Step 2: Check for structured intent (action items, decisions, risks)
    if project_id:
        intent = _classify_intent(question)
        if intent in ("action_items", "decisions", "risks", "estimates"):
            return await _query_structured(project_id, intent)

    # Step 3: Default — semantic vector search
    return await _query_semantic(project_id, question)
