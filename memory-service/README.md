# Memory Service

Python FastAPI service that provides meeting memory — live transcript ingestion, post-meeting event extraction, and cross-meeting context retrieval for the chatbot.

## Architecture

```
                         ┌─────────────────────────────────────────┐
                         │          memory-service (FastAPI)        │
                         │              localhost:8001              │
                         └──────┬──────────────┬──────────────┬────┘
                                │              │              │
                         ┌──────▼──────┐ ┌─────▼─────┐ ┌─────▼──────┐
                         │   Redis     │ │ Supabase  │ │   Groq     │
                         │  (hot buf)  │ │ (Postgres │ │  (LLM      │
                         │             │ │  pgvector)│ │  synthesis) │
                         └─────────────┘ └───────────┘ └────────────┘
```

**Stack:** Python 3.11+, FastAPI, Supabase (Postgres + pgvector), Redis, sentence-transformers (`BAAI/bge-small-en-v1.5`), Groq (`llama-3.3-70b-versatile`)

---

## File Structure

```
memory-service/
├── pyproject.toml              # Package manifest, dependencies, entry point
├── schema.sql                  # Full Postgres schema (7 tables, pgvector)
├── README.md                   # This file
└── app/
    ├── main.py                 # FastAPI app factory, lifespan, router mounting
    ├── config.py               # Env vars: SUPABASE_URL, GROQ_API_KEY, REDIS_URL
    ├── database.py             # Supabase client singleton
    ├── embeddings.py           # sentence-transformers wrapper (bge-small-en-v1.5, 384-dim)
    ├── groq_client.py          # Groq LLM client + RAG synthesis prompt builder
    ├── ingestion.py            # Router: live transcript ingestion (Redis + Postgres)
    ├── query_router.py         # Router: NL question answering (3-tier retrieval)
    ├── post_meeting.py         # Router: post-meeting event extraction pipeline
    ├── utils.py                # Empty placeholder
    └── models/
        ├── segments.py         # CRUD for transcript_segments
        ├── meetings.py         # CRUD for meeting_sessions
        ├── events.py           # CRUD for meeting_events
        └── projects.py         # CRUD for project_memory
```

---

## How It Works

### 1. Live Ingestion (during a meeting)

When the dashboard backend receives a final transcript chunk from Deepgram, it calls:

```
POST /api/memory/ingest
{
  "session_id": "abc123",
  "speaker": "Alice",
  "text": "Let's move the deadline to Friday",
  "start_ts": 1719345600.0,
  "end_ts": 1719345605.0,
  "is_final": true
}
```

**Two-phase write:**

```
POST /api/memory/ingest
       │
       ├──► HOT PATH (sync):  Redis RPUSH session:{id}:segments  (TTL 6h)
       │                      Enables sub-second live queries during active meetings
       │
       └──► COLD PATH (background):
              1. embed(text) → 384-dim vector via bge-small-en-v1.5
              2. INSERT into transcript_segments (via Supabase)
```

Redis failures are non-fatal — the API always returns `{"status": "accepted"}` immediately.

---

### 2. Post-Meeting Processing (when a meeting ends)

The dashboard calls `POST /api/memory/process-meeting` with `{ "session_id": "abc123" }`.

**Pipeline:**

```
1. FETCH meeting metadata from meeting_sessions
2. FETCH all transcript segments (ordered by start_ts)
3. FORMAT transcript as "[12.3s] Speaker_A: Hello everyone..."
4. GROQ EXTRACTION (llama-3.3-70b-versatile, temp=0.1)
   Extracts structured events from the transcript:
     • DECISION        — explicitly agreed upon
     • ACTION_ITEM     — task with assignee
     • FEATURE_DISCUSSION — feature request/description
     • ESTIMATE        — timeline or cost mentioned
     • RISK            — concern/blocker/problem
     • KEY_TOPIC       — important subject
   Each event gets: category, description, detail, assignee, priority, significance (0-1)
5. FILTER (significance >= 0.6), EMBED each description, INSERT into meeting_events
6. UPDATE project_memory rollup:
     • total_meetings, total_decisions, open_action_items
     • key_themes (keyword detection from 18 predefined themes)
     • last_meeting_date
7. MARK meeting_sessions.status = "completed"
```

---

### 3. Context Retrieval (chatbot queries)

When the user asks a question in the dashboard, it calls:

```
POST /api/memory/query
{
  "question": "What action items were assigned to Bob?",
  "session_id": "abc123",    // optional — for live meeting queries
  "project_id": "proj-456"   // optional — for cross-meeting queries
}
```

**3-tier routing (rule-based, no LLM cost for classification):**

```
Question arrives
  │
  ├─ session_id present + keywords like "just now", "in this meeting"?
  │   ▼ STRATEGY A: Redis Live Buffer
  │     • LRANGE session:{id}:segments (last 50)
  │     • Format as "[Speaker]: text"
  │     • → Groq synthesis
  │
  ├─ project_id present + structured intent?
  │   (keywords match: action items, decisions, risks, estimates)
  │   ▼ STRATEGY C: Structured SQL Query
  │     • SELECT from meeting_events WHERE project_id=X AND category=Y
  │     • ORDER BY meeting_date DESC LIMIT 10
  │     • → Groq synthesis
  │
  └─ Default
      ▼ STRATEGY B: pgvector Semantic Search
        • embed(question) with BGE retrieval prefix
        • Extract keywords (stop-word filtered, max 5)
        • Supabase RPC "search_meeting_events" (hybrid vector + keyword)
        • → Groq synthesis with citations
```

**Answer synthesis** (all strategies converge here):
- Model: `llama-3.3-70b-versatile` via Groq
- Prompt: "Answer based ONLY on context. Cite meeting date and platform."
- Response: `{ "answer": "...", "citations": [...] }`
- Temperature: 0.2

---

## Database Schema

```
clients
  └── projects (junction via project_clients)
        ├── meeting_sessions
        │     ├── transcript_segments   (per-segment, with 384-dim embedding)
        │     └── meeting_events        (per-event, with 384-dim embedding)
        └── project_memory              (rollup/summary per project)
```

| Table | Purpose | Vector Column |
|---|---|---|
| `clients` | Client organizations | — |
| `projects` | Projects within clients | — |
| `meeting_sessions` | One row per bot session (Meet/Zoom/Teams) | — |
| `transcript_segments` | Individual transcript lines with speaker, timestamps | `embedding vector(1536)` |
| `meeting_events` | Extracted decisions, action items, risks, etc. | `embedding vector(1536)` |
| `project_memory` | Aggregate rollup: totals, themes, risk flags | — |
| `project_clients` | Junction table (project ↔ client) | — |

**Event categories:** DECISION, ACTION_ITEM, FEATURE_DISCUSSION, ESTIMATE, RISK, KEY_TOPIC, MILESTONE

**Priority levels:** High, Medium, Low

---

## Dashboard Integration

The Node.js dashboard backend calls this service via `dashboard/backend/memory-client.js`:

| Function | Endpoint | Timing | Failure Mode |
|---|---|---|---|
| `ingestSegment()` | `POST /ingest` | Every Deepgram final chunk | Fire-and-forget, non-fatal |
| `processMeeting()` | `POST /process-meeting` | Meeting end | Fire-and-forget |
| `queryMemory()` | `POST /query` | User asks question | Falls back to direct Groq + raw .jsonl files |
| `getProjectMemory()` | `GET /projects/{id}` | Dashboard load | Returns null |

**Fallback for queryMemory:** If the memory service is unreachable, the Node client reads the last 5 `.jsonl` transcript files from disk, takes the last 60 lines from each, and calls Groq directly with the raw context. No vector search — degraded but functional.

---

## Environment Variables

```
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
GROQ_API_KEY=gsk_...
REDIS_URL=redis://localhost:6379
MEMORY_SERVICE_PORT=8001
```

---

## Running

```bash
cd memory-service
uv sync                    # Install dependencies
uv run uvicorn app.main:app --host 0.0.0.0 --port 8001
```

---

## Known Issues

1. **Embedding dimension mismatch:** `schema.sql` defines `vector(1536)` columns but `bge-small-en-v1.5` produces 384-dim vectors. The schema needs to be updated to `vector(384)` or a 1536-dim model should be used.

2. **Ingestion endpoint signature:** `ingestion.py` has both `Body(...)` params AND `req: IngestRequest` in the function signature. FastAPI will expect both, likely causing errors. The `Body(...)` params should be removed.

3. **Missing RPC definition:** `search_meeting_events` Supabase function is called via `db.rpc()` but its SQL definition is not in `schema.sql`. Must be created in Supabase manually.

4. **Missing GET route:** `getProjectMemory()` in memory-client.js calls `GET /api/memory/projects/{projectId}`, but no such route exists in the Python routers. This always returns null.

5. **Unpopulated columns:** `project_memory` has `risk_flags`, `pending_blockers`, `important_dates`, `summary_snapshot` — never written by the current `_update_project_memory()` function.
