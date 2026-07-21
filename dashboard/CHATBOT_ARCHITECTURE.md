# Chatbot Architecture — Analysis & Improvement Plan

## 1. How the Chatbot Works Today

### Current Main Branch Architecture

```
User Question
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│                    query_router.py                           │
│                                                             │
│  1. Classify intent (rule-based keyword matching)           │
│  2. Route to one of 3 strategies:                           │
│     A. Redis buffer (live meeting)                          │
│     C. Structured SQL (action items / decisions / risks)    │
│     B. pgvector semantic search (default)                   │
│  3. Synthesize answer via Groq LLM                          │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│                    Supabase (pgvector)                       │
│                                                             │
│  meeting_events    → extracted decisions/risks (≥0.6 sig)   │
│  transcript_segments → raw conversation lines               │
└─────────────────────────────────────────────────────────────┘
```

### Ishita Branch Architecture

```
User Question
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│                    query_router.py                           │
│                                                             │
│  1. Classify intent (same rule-based keywords)              │
│  2. Route to strategies A, C, or B                          │
│  3. Strategy B: fetch ALL segments into Python,             │
│     compute cosine similarity locally, top-15               │
│  4. Synthesize via Groq (no chat history)                   │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│                    Supabase (no pgvector RPCs)               │
│                                                             │
│  transcript_segments → raw conversation (1000 rows fetched) │
│  meeting_events → NOT searched semantically                 │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Side-by-Side Comparison

| Feature | Ishita Branch | Main Branch (current) |
|---------|--------------|----------------------|
| Vector search method | Python-side cosine similarity on fetched rows | Supabase pgvector RPC functions (server-side) |
| Tables searched semantically | `transcript_segments` only | `meeting_events` + `transcript_segments` (both) |
| Keyword hybrid search | None (pure vector) | ILIKE substring + vector via RPC |
| Chat history / follow-ups | None | `chat_messages` table + Groq system prompt |
| Greeting handler | Yes (hardcoded response) | No |
| Session metadata fallback | Yes (lists sessions if no segments match) | No |
| Performance | Fetches up to 1000 rows into Python per query | Server-side HNSW index, returns top N |
| Scale | Degrades linearly as transcript volume grows | Stays fast (indexed vector search) |
| Natural language support | Weak (same issues) | Weak (same issues) |
| Chatbot personality | Friendly greeting, clear error messages | Raw error messages |

---

## 3. The Core Problem: Natural Language Queries Fail

### Symptom

| Query | Works? | Why |
|-------|--------|-----|
| `AWS` | Yes | Short keyword, ILIKE matches directly, high vector similarity |
| `deployment date` | Partial | Keyword matches if exact substring exists in event description |
| `when did the client talk about AWS` | No | Natural language phrasing, keyword extraction strips too much |
| `what was discussed about the pricing model` | No | No exact substring match, vector similarity below threshold |
| `who is responsible for the backend` | Partial | Matches "action items" intent keywords, but only if category was extracted |
| `tell me everything about the API integration` | No | Too broad for ILIKE, vector similarity scattered |

### Root Cause Analysis

**Problem 1: `_extract_keywords` is too aggressive**

```python
# Current: strips "when", "did", "client", "talk", "about" as stop words
# "when did the client talk about AWS" → "aws"
# "what was discussed about the pricing model" → "pricing model"
# "tell me everything about the API integration" → "api integration"
```

The keyword extraction removes words that carry **contextual meaning** in meeting
scenarios. "Client" is not a generic stop word in a business meeting context —
it identifies a participant. "Discussed" and "talked about" are meeting-specific
verbs that signal a meeting query. Stripping them leaves too few keywords for
ILIKE to match, and the remaining keywords may not appear in event descriptions.

**Problem 2: ILIKE substring matching is brittle**

```sql
-- Current RPC:
e.description ILIKE '%' || p_keyword || '%'
```

This requires an **exact substring** match. If the event description is
"AWS deployment timeline discussed — target is Q3" and the keyword is
"aws client", ILIKE fails because "aws client" doesn't appear as a
contiguous substring. Even "aws" alone would match, but the extracted
keyword might be "aws client talk" which doesn't.

**Problem 3: Vector similarity threshold (0.3) is a hard cutoff**

```sql
AND (1 - (e.embedding <=> p_query_embedding)) >= 0.3
```

Natural language queries like "when did the client talk about AWS" produce
a query embedding that's semantically different from the event description
"AWS deployment timeline discussed." The cosine similarity between a
**question** and a **statement** is inherently lower than between two
statements — the embedding model encodes them differently. A 0.3 threshold
can reject legitimate matches.

**Problem 4: No question-to-statement transformation**

The embedding prefix `"Represent this sentence for searching relevant passages: {question}"`
helps, but the BGE model is small (384-dim, `bge-small-en-v1.5`). It doesn't
robustly handle the semantic gap between "when did X happen" (question) and
"X happened on July 30" (statement). A larger model (`bge-large-en-v1.5`,
1024-dim) would handle this better but costs more.

**Problem 5: Event extraction is lossy by design**

The Groq extraction pipeline filters events at `significance >= 0.6` and maps
everything into 7 categories (DECISION, ACTION_ITEM, RISK, etc.). If the
client's AWS mention was casual context (significance 0.4), it never makes it
into `meeting_events`. The only path to it is `transcript_segments`, which the
current `_query_semantic` does search — but the same ILIKE/threshold issues apply.

---

## 4. What the Ishita Branch Did Better (and Worse)

### Better

1. **Greeting handler** — catches "hi", "hello", "help" and returns a friendly
   response instead of hitting the database and returning "I could not find that."

2. **Session metadata fallback** — if no segments match, it lists recent meeting
   sessions as context. The current main branch returns nothing.

3. **No false precision** — the ishita branch doesn't pretend to search
   `meeting_events` when it doesn't. The current main branch calls
   `search_meeting_events` but the results may be empty or irrelevant for
   natural language queries.

### Worse

1. **Fetches 1000 rows into Python** — doesn't scale. As meetings accumulate,
   every query downloads and scores 1000 embeddings in Python. The main branch
   uses server-side pgvector with HNSW indexes.

2. **No `meeting_events` search** — the extracted decisions, action items, and
   risks are invisible to the chatbot. A user asking "what action items were
   assigned?" gets nothing from semantic search.

3. **No chat history** — follow-up questions like "what about the deadline?"
   (referencing a previous answer) fail completely.

4. **No keyword hybrid** — pure vector search misses exact keyword matches that
   ILIKE would catch (e.g., searching "AWS" matches "AWS" exactly via ILIKE
   but might have low vector similarity to an event about "cloud infrastructure").

---

## 5. Proposed Solutions

### Solution A: Fix Keyword Extraction (immediate, low effort)

Replace the aggressive stop-word list with a **meeting-domain-aware** extractor
that preserves business terms:

```python
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
```

**Impact:** "when did the client talk about AWS" → "when client talk about aws"
instead of just "aws". ILIKE now has more terms to match against.

### Solution B: Lower Vector Threshold + Score-Based Ranking (immediate, low effort)

Lower the cosine similarity threshold from 0.3 to 0.15, and let the LLM decide
what's relevant from a larger candidate set:

```sql
-- In both RPC functions:
AND (1 - (e.embedding <=> p_query_embedding)) >= 0.15  -- was 0.3
```

And increase `p_match_count` from 8 to 12 to give the LLM more candidates.

**Trade-off:** more noise in results, but the LLM can filter irrelevant context.
Better to give the LLM too much context than to silently return nothing.

### Solution C: Add a Greeting Handler (immediate, trivial)

Port the ishita branch's greeting handler to main:

```python
_GREETINGS = {"hi", "hello", "hey", "help", "who are you"}
if question.lower().strip().rstrip('.!?') in _GREETINGS:
    return {
        "answer": "Hello! I am your AI Meeting Knowledge Assistant. "
                  "Ask me anything about your project's meetings, "
                  "decisions, or action items.",
        "citations": [],
    }
```

### Solution D: Session Metadata Fallback (immediate, low effort)

Port the ishita branch's fallback: when no segments/events match, list recent
meeting sessions so the user at least knows what meetings exist.

### Solution E: Use a Larger Embedding Model (medium effort, high impact)

Replace `bge-small-en-v1.5` (384-dim) with `bge-large-en-v1.5` (1024-dim) or
`bge-m3` (1024-dim). Larger models handle the question-vs-statement semantic gap
much better. Requires:
- Changing `embeddings.py` to load the larger model
- Re-embedding all existing rows (migration script)
- Updating `vector(384)` to `vector(1024)` in schema + RPC functions
- More memory/compute for the embedding service

### Solution F: Two-Stage Retrieval — Retrieve Broad, Then Re-Rank (medium effort)

Instead of a single vector search with a hard threshold:
1. **Retrieve** top-20 candidates with a LOW threshold (0.1)
2. **Re-rank** using a lightweight cross-encoder or the LLM itself
3. **Return** top-8 after re-ranking

This separates "recall" (find everything possibly relevant) from "precision"
(keep only what's actually relevant). The current approach conflates both into
a single threshold.

### Solution G: Summary-Aware Retrieval (high effort, high impact)

Instead of searching only raw segments or extracted events, generate a
**meeting summary** per session (via Groq) and embed THAT. A summary like
"Alice and Bob discussed AWS deployment timeline, targeting Q3 launch"
matches natural language queries like "when did they talk about AWS?" far
better than individual segment embeddings.

---

## 6. Recommended Implementation Order

| Priority | Solution | Effort | Impact | Description |
|----------|----------|--------|--------|-------------|
| 1 | A | Low | Medium | Fix keyword extraction — stop stripping meeting-specific terms |
| 2 | B | Low | Medium | Lower vector threshold from 0.3 to 0.15 |
| 3 | C | Trivial | Low | Add greeting handler |
| 4 | D | Low | Low | Session metadata fallback |
| 5 | F | Medium | High | Two-stage retrieval (broad retrieve + re-rank) |
| 6 | E | Medium | High | Upgrade to larger embedding model |
| 7 | G | High | Very High | Summary-aware retrieval |

Solutions A + B + C + D can be implemented in one session and will
immediately fix the most common natural language query failures.
Solutions E + F + G are longer-term upgrades for production quality.

---

## 7. What Each Solution Fixes

| Query | Current | +A (keywords) | +B (threshold) | +F (re-rank) | +E (large model) |
|-------|---------|---------------|----------------|--------------|-------------------|
| `AWS` | Works | Works | Works | Works | Works |
| `when client talked about AWS` | Fails | Works (more keywords) | Works (lower cutoff) | Works | Works |
| `what was discussed about pricing` | Fails | Partial | Works | Works | Works |
| `deployment date of the project` | Fails | Partial | Works | Works | Works |
| `tell me about the API integration` | Fails | Partial | Partial | Works | Works |
| `who is responsible for backend` | Partial | Works | Works | Works | Works |
