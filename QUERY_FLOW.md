# Query Flow — Complete Walkthrough

## Bot → Transcript → User Question → Answer

```
┌─────────────────────────────────────────────────────────────────────┐
│                    PHASE 1: CAPTURE (Bot joins meeting)             │
└─────────────────────────────────────────────────────────────────────┘
```

### 1. Bot joins the meeting

| Step | File | Code | Database |
|------|------|------|----------|
| User clicks "Launch bot" | `frontend/.../projects/[projectId]/meeting/page.tsx` | `handleLaunchBot()` → `fetch(POST /api/sessions/start)` | — |
| Backend creates session row | `dashboard/backend/server.js` (line ~130) | `app.post('/api/sessions/start')` → `generateId()` + `saveSessionStart()` | **meeting_sessions**: inserts `{ session_id, project_id, bot_type, status: 'active' }` |
| Backend spawns bot process | `dashboard/backend/process-manager.js` (line ~110) | `ProcessManager.spawnBot()` → `child_process.spawn('node src/index.js --port <port>')` | — |
| Playwright launches Chrome | `Google Meet/src/join/meet-bot.js` (line ~60) | `MeetBot.launch()` → `chromium.launch()` | — |

### 2. Audio + speaker detection start

| Step | File | Code | Database |
|------|------|------|----------|
| Monkey-patch RTCPeerConnection | `Google Meet/src/audio/audio-capture.js` (line ~286) | `AudioCapture.initialize()` → `page.addInitScript(AUDIO_CAPTURE_SCRIPT)` | — |
| Intercept all remote audio tracks | `audio-capture.js` (line ~30, injected) | `findPeerConnection()` → `getReceivers()` → `addTrackToMixer()` → mixes all to AudioContext at 16kHz | — |
| Poll DOM for speaking indicator | `Google Meet/src/speaker/speaker-detector.js` (line ~46) | `SpeakerDetector.start()` → `setInterval(() => _poll(), 150)` | — |
| Read KUNJSe class from DOM | `speaker-detector.js` (line ~121) | `_poll()` → `page.evaluate()` → `querySelectorAll('[jsname="QgSmzd"].KUNJSe')` → extracts name from `[aria-label^="More options for <Name>"]` | — |
| Buffer 500ms PCM chunks | `Google Meet/src/chunker/audio-chunker.js` (line ~20) | `AudioChunker.addAudioFrame()` → appends Int16 samples → calls `emitChunk()` at `FRAMES_PER_CHUNK = 8000` | — |
| Tag chunk with speaker | `audio-chunker.js` (line ~100) | `getSpeakerForWindow()` — overlap-weighted majority from `speakerHistory[]` | — |

### 3. Stream to backend

| Step | File | Code |
|------|------|------|
| WebSocket server starts on port | `Google Meet/src/output/chunk-output.js` (line ~22) | `ChunkOutput.start()` → `new WebSocketServer({ port })` |
| Send audio chunk | `chunk-output.js` (line ~80) | `send(chunk)` → `JSON.stringify(chunk)` → `ws.send()` |
| Send speaker event | `chunk-output.js` (line ~119) | `sendSpeakerEvent({ speaker, timestamp })` → broadcasts `{ type: "speaker_event", speaker, timestamp_ts }` |

```
┌─────────────────────────────────────────────────────────────────────┐
│                    PHASE 2: TRANSCRIBE (Backend processes audio)    │
└─────────────────────────────────────────────────────────────────────┘
```

### 4. Backend receives stream

| Step | File | Code | Database |
|------|------|------|----------|
| Bot WebSocket connects | `dashboard/backend/server.js` (line ~840) | `connectToBotAudioStream(sessionId, wsPort, botType, projectId)` → `new WebSocket(url)` | — |
| speaker_event → SpeakerBinder | `dashboard/backend/deepgram-proxy-google.js` (line ~258) | `deepgramProxyGoogle.logSpeakerBoundary()` → `binder.recordHint(speaker, timestamp)` — lag-corrects by 0.25s, stores as hint turn | — |
| audio_chunk → Deepgram | `deepgram-proxy-google.js` (line ~270) | `sendAudio(sessionId, audioBuffer)` → `socket.send(audioBuffer)` to Deepgram WebSocket | — |
| Deepgram returns text | `deepgram-proxy-google.js` (line ~170) | `dgSocket.on('message')` → `binder.resolve(absoluteStartSec, absoluteEndSec)` → overlap-window match + recency tie-break + flicker debounce | — |
| SpeakerBinder confidence gates | `deepgram-proxy-google.js` (line ~90) | `resolve()` checks: `MIN_MATCH_COVERAGE >= 0.35`, `MIN_MATCH_SUPPORT_S >= 0.45`, `MIN_MATCH_CONFIDENCE >= 0.6` | — |
| Final transcript emitted | `deepgram-proxy-google.js` (line ~200) | `onTranscript({ segmentId, speaker, provisional, text, timestamp, isFinal })` | — |

```
┌─────────────────────────────────────────────────────────────────────┐
│                    PHASE 3: STORE (Transcripts saved)               │
└─────────────────────────────────────────────────────────────────────┘
```

### 5. Segment ingestion

| Step | File | Code | Database |
|------|------|------|----------|
| `isFinal` transcript → ingest | `dashboard/backend/server.js` (line ~375) | `ingestSegment(sessionId, { speaker, text, projectId })` | — |
| HTTP POST to memory service | `dashboard/backend/memory-client.js` (line ~60) | `ingestSegment()` → `fetch(\`${url}/api/memory/ingest\`)` | — |
| Hot path: Redis | `memory-service/app/ingestion.py` (line ~40) | `ingest_segment()` → `redis.rpush(f"session:{session_id}:segments", json.dumps(segment))` | **Redis**: `session:<id>:segments` list, 6hr TTL via `expire()` |
| Cold path: embed + insert | `ingestion.py` → background `_store_segment()` | `embed(text)` → `bge-small-en-v1.5` (384-dim) → `insert_segment()` | **transcript_segments**: inserts `{ id, session_id, speaker_label, text, start_ts, end_ts, is_final, project_id, embedding }` |

### 6. Post-meeting processing

| Step | File | Code | Database |
|------|------|------|----------|
| Meeting ends → trigger | `dashboard/backend/memory-client.js` (line ~100) | `processMeeting(sessionId)` → `POST /api/memory/process-meeting` | — |
| Fetch all segments for session | `memory-service/app/post_meeting.py` (line ~50) | `get_segments(session_id)` → `db.table("transcript_segments").select("*").eq("session_id", session_id).execute()` | **transcript_segments**: reads all rows for this `session_id` |
| Extract events via Groq | `post_meeting.py` → `_extract_events()` (line ~30) | Sends formatted transcript to `llama-3.3-70b-versatile` with structured prompt → returns `DECISION, ACTION_ITEM, RISK, ESTIMATE, KEY_TOPIC, MILESTONE` | — |
| Filter by significance | `post_meeting.py` (line ~47) | `if event.significance < 0.6: continue` | — |
| Embed event descriptions | `post_meeting.py` → `embed()` | `bge-small-en-v1.5` encodes `description` → 384-dim vector | — |
| Insert structured events | `post_meeting.py` → `insert_event()` | | **meeting_events**: inserts `{ session_id, project_id, category, description, detail, assignee, priority, embedding, meeting_date, bot_type }` |
| Update project memory | `post_meeting.py` → `_update_project_memory()` | Counts totals, merges summary via Groq, extracts themes + risks + blockers | **project_memory**: upserts `{ project_id, total_meetings, total_decisions, open_action_items, last_meeting_date, key_themes, risk_flags, pending_blockers, summary_snapshot }` |

### What's stored where

| Storage | Data | Purpose | Key columns |
|---------|------|---------|-------------|
| **Supabase: `transcript_segments`** | Raw speaker-attributed transcript lines | Semantic search | `speaker_label text`, `text text`, `embedding vector(384)`, `session_id text`, `project_id text` |
| **Supabase: `meeting_events`** | Extracted decisions, action items, risks | Structured answers | `category text`, `description text`, `detail text`, `assignee text`, `embedding vector(384)`, `meeting_date date` |
| **Supabase: `project_memory`** | Rollup summary | Dashboard + thematic queries | `key_themes jsonb`, `risk_flags jsonb`, `summary_snapshot text` |
| **Supabase: `chat_messages`** | Conversation history | Follow-up resolution | `role text (user|assistant)`, `content text`, `chat_session_id text` |
| **Redis: `session:<id>:segments`** | Live segments (6hr TTL) | "What just happened?" queries | JSON list: `[{speaker_label, text, created_at}]` |

```
┌─────────────────────────────────────────────────────────────────────┐
│                    PHASE 4: QUERY (User asks a question)            │
└─────────────────────────────────────────────────────────────────────┘
```

### 7. Frontend sends question

| Step | File | Code | Database |
|------|------|------|----------|
| User types in chat | `frontend/.../projects/[projectId]/page.tsx` | `handleAskQuestion()` → `fetch(POST /api/memory/query)` with `{ question, project_id, chat_session_id }` | — |
| Backend proxy route | `dashboard/backend/server.js` (line ~50) | `app.post('/api/memory/query')` → `queryMemory(req.body)` | — |
| Try Python memory service | `dashboard/backend/memory-client.js` (line ~75) | `queryMemory()` → tries `POST 127.0.0.1:8001/api/memory/query` then 8000 | — |
| Fallback if offline | `memory-client.js` → `fallbackGroqQuery()` (line ~16) | Fetches `.../rest/v1/transcript_segments?order=created_at.desc&limit=50` from Supabase REST API → sends raw to Groq | **transcript_segments**: fetches most recent 50 rows |

### 8. Query Router processes (memory-service)

| Step | File | Code | Database |
|------|------|------|----------|
| Entry point | `memory-service/app/query_router.py` → `query_memory()` (line ~300) | `POST /api/memory/query` handler | — |
| **Step 0: Greeting check** | `_GREETINGS` set (line ~27) | `if question.lower().strip() in _GREETINGS` → return canned response | — |
| **Step 1: Live meeting?** | `_is_current_meeting_query()` (line ~60) | Keyword match `"just now", "currently", "in this meeting"` → `_query_redis_buffer()` | **Redis**: `LRANGE session:<id>:segments 0 -1`, last 50 entries |
| **Step 2: Structured intent?** | `_classify_intent()` (line ~50) | Keyword match → routes to `_query_structured(project_id, intent)` | **meeting_events**: `SELECT * WHERE project_id=X AND category=Y ORDER BY meeting_date DESC LIMIT 10` |
| **Step 3: Semantic search** | `_query_semantic()` (line ~195) | Default path, uses all 3 lanes below | Both tables via RPCs |

### 9. Semantic search in detail

```
User: "who discussed about CRM?"
        │
        ▼
  ┌──────────────────────────────────────────────────────────┐
  │  _rewrite_query()                     query_router.py    │
  │  ────────────────                     line ~75           │
  │  Sends to Groq llama-3.3-70b:                            │
  │  "Rewrite this question as a concise search query..."    │
  │  → "CRM discussion"                                      │
  └──────────────────────────────────────────────────────────┘
        │
        ▼
  ┌──────────────────────────────────────────────────────────┐
  │  embed()                              embeddings.py      │
  │  ──────                               line ~15           │
  │  SentenceTransformer('BAAI/                                │
  │    bge-small-en-v1.5')                                     │
  │  .encode("Represent this sentence                         │
  │    for searching relevant passages:                       │
  │    CRM discussion") → [384 floats]                        │
  └──────────────────────────────────────────────────────────┘
        │
        ▼
  ┌──────────────────────────────────────────────────────────┐
  │  Build keyword patterns                 query_router.py  │
  │  "CRM discussion" → "%crm%|%discussion%"  line ~210     │
  │  (pipe-separated wildcards for ILIKE ANY)                │
  └──────────────────────────────────────────────────────────┘
        │
        ▼
  ┌────────────────────────────────────────────────────────────────────────┐
  │  PARALLEL SEARCH via asyncio.gather()     query_router.py line ~215   │
  │                                                                        │
  │  ┌────────────────────────────┐    ┌────────────────────────────┐      │
  │  │ search_meeting_events RPC  │    │ search_transcript_segments │      │
  │  │ schema.sql line ~117      │    │ RPC                        │      │
  │  │                            │    │ schema.sql line ~193      │      │
  │  │ Searches: meeting_events   │    │                            │      │
  │  │ Filters:                   │    │ Searches: transcript_      │      │
  │  │  • project_id = X          │    │   segments                 │      │
  │  │  • embedding IS NOT NULL   │    │ Filters:                   │      │
  │  │  • cosine >= 0.2           │    │  • project_id = X          │      │
  │  │  • ILIKE ANY (keywords)    │    │  • embedding IS NOT NULL   │      │
  │  │ Returns:                   │    │  • cosine >= 0.2           │      │
  │  │  • session_id, description │    │  • ILIKE ANY (keywords)    │      │
  │  │  • meeting_date, bot_type  │    │ Returns:                   │      │
  │  │  • similarity (real)       │    │  • session_id, speaker     │      │
  │  │ Limit: 12                  │    │  • text, start_ts          │      │
  │  └────────────────────────────┘    │  • similarity (real)       │      │
  │                                    │ Limit: 12                  │      │
  │                                    └────────────────────────────┘      │
  └────────────────────────────────────────────────────────────────────────┘
        │
        ▼
  ┌──────────────────────────────────────────────────────────┐
  │  MERGE + RE-RANK                    query_router.py      │
  │  ────────────────                   line ~250            │
  │  Events: score × 1.05 (boost)                            │
  │  Segments: raw score                                     │
  │  Sort by score desc → top 10                              │
  └──────────────────────────────────────────────────────────┘
        │
        ▼
  ┌──────────────────────────────────────────────────────────┐
  │  _synthesize()                        query_router.py    │
  │  ────────────                         line ~280          │
  │  build_synthesis_prompt(question,     groq_client.py     │
  │    context_lines)                                        │
  │                                                          │
  │  → Groq llama-3.3-70b-versatile                         │
  │  → JSON mode, temp 0.2                                  │
  │  → Returns { "answer": "...",                            │
  │              "citations": [...] }                        │
  └──────────────────────────────────────────────────────────┘
        │
        ▼
  ┌──────────────────────────────────────────────────────────┐
  │  Save response                         query_router.py  │
  │  ─────────────                         line ~330        │
  │  save_message(project_id,                                │
  │    chat_session_id, "assistant", answer)                 │
  │  → inserts into chat_messages table                      │
  └──────────────────────────────────────────────────────────┘
        │
        ▼
  Response → server.js → Frontend renders answer + citations
```

### 10. If nothing is found

```
No results from either search?
        │
        ├── Has chat_history?
        │     _synthesize(question, [], "past meetings", chat_history)
        │     → LLM tries to answer from previous conversation context
        │
        └── No chat_history?
              _session_fallback(project_id)    query_router.py line ~315
              ─────────────────────
              db.table("meeting_sessions")
                .select("session_id, bot_type, created_at")
                .eq("project_id", project_id)
                .order("created_at", desc=True)
                .limit(10)
                .execute()
              →
              "I could not find that. Here are your recent meetings:
               - google-meet call on 2026-07-21
               Try asking about specific topics from these sessions."
```

## Complete File Index

### Bot-side (Google Meet/)

| File | Key classes/functions | Responsibility |
|------|----------------------|---------------|
| `src/index.js` | `main()` | Entry point, parses CLI args, creates BotLifecycle |
| `src/join/meet-bot.js` | `MeetBot.launch()`, `join()`, `handlePreJoin()`, `turnOffCamera()`, `_replaceVideoWithBlack()` | Playwright browser launch, join meeting, camera/mic toggle |
| `src/audio/audio-capture.js` | `AudioCapture.initialize()`, injected `AUDIO_CAPTURE_SCRIPT` with `findPeerConnection()`, `addTrackToMixer()`, `readLoop()` | Injects WebRTC monkey-patch, captures all remote audio, mixes to 16kHz PCM |
| `src/speaker/speaker-detector.js` | `SpeakerDetector.start()`, `_poll()`, `_detectBotTile()` | Polls DOM for KUNJSe speaking indicator every 150ms |
| `src/chunker/audio-chunker.js` | `AudioChunker.addAudioFrame()`, `addSpeakerEvent()`, `emitChunk()`, `getSpeakerForWindow()` | Buffers PCM into 500ms chunks, tags with speaker via timeline overlap |
| `src/output/chunk-output.js` | `ChunkOutput.send()`, `sendSpeakerEvent()` | WebSocket server broadcasting audio chunks + speaker events |
| `src/lifecycle/bot-lifecycle.js` | `BotLifecycle.start()`, `initializeCapture()` | Wires AudioCapture → Chunker → Output + SpeakerDetector |
| `src/config/selectors.js` | `SELECTORS`, `TIMEOUTS`, `AUDIO_CONFIG` | DOM selectors, timeouts, audio config constants |

### Dashboard backend (dashboard/backend/)

| File | Key functions | Responsibility |
|------|---------------|---------------|
| `server.js` | `app.post('/api/sessions/start')`, `connectToBotAudioStream()`, `app.post('/api/memory/query')`, `broadcastToClients()` | Express server: REST routes, WebSocket for live transcripts, bot audio stream listener |
| `deepgram-proxy-google.js` | `DeepgramProxy.initializeSession()`, `sendAudio()`, `logSpeakerBoundary()`, `logStreamStart()` + `SpeakerBinder.recordHint()`, `resolve()` | Deepgram WebSocket + attribution logic (overlap-window, recency tie-break, flicker debounce) |
| `deepgram-proxy-zoom.js` | Same pattern, different attribution (chunk-history based) | Separate Deepgram handler for Zoom |
| `memory-client.js` | `ingestSegment()`, `queryMemory()`, `fallbackGroqQuery()`, `processMeeting()` | Proxy to Python memory service. Pushes live segments, sends questions, direct-to-Groq fallback |
| `process-manager.js` | `ProcessManager.spawnBot()`, `killBot()`, `aggregateTranscriptFile()` | Spawns/kills bot processes, saves transcripts to Supabase Storage |
| `report-generator.js` | `generateReportWithFallback()` | AI report markdown from transcript |
| `supabase-helper.js` | `saveSessionStart()`, `saveSessionEnd()`, `uploadReport()` | Supabase CRUD for sessions, storage uploads |
| `google-drive-helper.js` | `uploadTranscriptToGoogleDrive()`, `uploadReportToGoogleDrive()` | Google Drive upload |

### Memory service (memory-service/)

| File | Key functions | DB tables used | Responsibility |
|------|---------------|----------------|---------------|
| `app/main.py` | FastAPI `app.include_router()` | — | Entry point, mounts all routers |
| `app/ingestion.py` | `ingest_segment()`, `_store_segment()` | `transcript_segments`, Redis `session:<id>:segments` | Stores segments to Redis (hot) + Supabase with embedding (cold) |
| `app/query_router.py` | `query_memory()`, `_rewrite_query()`, `_classify_intent()`, `_query_semantic()`, `_query_structured()`, `_query_redis_buffer()`, `_synthesize()`, `_session_fallback()` | `meeting_events`, `transcript_segments`, `meeting_sessions`, `chat_messages`, Redis `session:<id>:segments` | **Core**: greets, classifies intent, routes to Redis/SQL/semantic search, re-ranks, synthesizes via Groq |
| `app/post_meeting.py` | `process_meeting()`, `_extract_events()`, `_update_project_memory()` | `transcript_segments`, `meeting_events`, `project_memory`, `meeting_sessions` | Fetches segments, extracts events via Groq, embeds, inserts events, updates project memory rollup |
| `app/embeddings.py` | `init_embedder()`, `embed()`, `embed_batch()` | — | `bge-small-en-v1.5` (384-dim) — encodes text to vectors |
| `app/groq_client.py` | `get_groq()`, `build_synthesis_prompt()` | — | Groq SDK wrapper + synthesis prompt builder |
| `app/database.py` | `get_db()` | — | Supabase client singleton |
| `app/models/segments.py` | `insert_segment()`, `get_segments()`, `get_session_ids_for_project()` | `transcript_segments` | Insert/query transcript rows |
| `app/models/events.py` | `insert_event()`, `get_events_for_session()` | `meeting_events` | Insert/query structured events |
| `app/models/projects.py` | `get_project_memory()`, `upsert_project_memory()` | `project_memory` | Query/upsert project rollup |
| `app/models/meetings.py` | `get_meeting()` | `meeting_sessions` | Query session metadata |
| `app/models/chat_messages.py` | `get_recent_messages()`, `save_message()` | `chat_messages` | Save/load conversation history |
| `schema.sql` | `search_meeting_events()`, `search_transcript_segments()`, all table definitions | All tables | Schemas + pgvector search RPCs (deploy to Supabase manually) |

### Frontend (dashboard/frontend/)

| File | Key functions | Responsibility |
|------|---------------|---------------|
| `src/app/(app)/projects/[projectId]/page.tsx` | `handleAskQuestion()`, `handleViewTranscript()`, `handleViewReport()` | Project workspace: session list, transcript viewer, report viewer, **chat interface** |
| `src/app/(app)/projects/[projectId]/meeting/page.tsx` | `handleLaunchBot()` | Bot launch page: form to configure and start a bot session |

## SQL Search RPCs

Defined in `memory-service/schema.sql`. Must be deployed to Supabase manually.

### `search_meeting_events`

```sql
-- Searches meeting_events table with vector similarity + optional keyword match
-- Called by: query_router.py _query_semantic() line ~215
-- Parameters: p_project_id, p_query_embedding (vector384), p_keyword (| separated), p_match_count
CREATE OR REPLACE FUNCTION search_meeting_events(
  p_project_id text,
  p_query_embedding vector(384),
  p_keyword text DEFAULT '',
  p_match_count int DEFAULT 8
)
RETURNS TABLE (
  session_id   text,
  description  text,
  meeting_date date,
  bot_type     text,
  similarity   real
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.session_id,
    e.description,
    e.meeting_date,
    e.bot_type,
    (1 - (e.embedding <=> p_query_embedding))::real AS similarity
  FROM meeting_events e
  WHERE e.project_id = p_project_id
    AND e.embedding IS NOT NULL
    AND (1 - (e.embedding <=> p_query_embedding)) >= 0.2       -- cosine similarity threshold
    AND (
      p_keyword = ''
      OR e.description ILIKE ANY(string_to_array(p_keyword, '|'))  -- e.g. '%crm%|%discussion%'
      OR e.detail ILIKE ANY(string_to_array(p_keyword, '|'))
    )
  ORDER BY e.embedding <=> p_query_embedding                    -- cosine distance (ASC = most similar first)
  LIMIT p_match_count;
END;
$$;

-- Indexes used:
--   idx_events_embedding ON meeting_events USING hnsw (embedding vector_cosine_ops)
--   idx_events_desc_trgm ON meeting_events USING gin (description gin_trgm_ops)
--   idx_events_detail_trgm ON meeting_events USING gin (detail gin_trgm_ops)
```

### `search_transcript_segments`

```sql
-- Searches transcript_segments table with vector similarity + optional keyword match
-- Called by: query_router.py _query_semantic() line ~225
-- Same structure as above, searches text column instead of description/detail
CREATE OR REPLACE FUNCTION search_transcript_segments(
  p_project_id text,
  p_query_embedding vector(384),
  p_keyword text DEFAULT '',
  p_match_count int DEFAULT 8
)
RETURNS TABLE (
  session_id    text,
  speaker_label text,
  text          text,
  start_ts      double precision,
  similarity    real
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.session_id,
    s.speaker_label,
    s.text,
    s.start_ts,
    (1 - (s.embedding <=> p_query_embedding))::real AS similarity
  FROM transcript_segments s
  WHERE s.project_id = p_project_id
    AND s.embedding IS NOT NULL
    AND (1 - (s.embedding <=> p_query_embedding)) >= 0.2
    AND (
      p_keyword = ''
      OR s.text ILIKE ANY(string_to_array(p_keyword, '|'))
    )
  ORDER BY s.embedding <=> p_query_embedding
  LIMIT p_match_count;
END;
$$;

-- Indexes used:
--   idx_segments_embedding ON transcript_segments USING hnsw (embedding vector_cosine_ops)
--   idx_segments_text_trgm ON transcript_segments USING gin (text gin_trgm_ops)
```

## All Supabase Tables

### `meeting_sessions`
| Column | Type | Purpose |
|--------|------|---------|
| `session_id` | text PK | Unique meeting ID |
| `project_id` | text FK → projects | Project isolation |
| `bot_type` | text | "google-meet", "zoom", "teams" |
| `status` | text | "active", "completed", "failed" |
| `created_at` | timestamptz | When the bot joined |
| Used by: `server.js` (create on session start), `_session_fallback()` (list recent), `post_meeting.py` (metadata) |

### `transcript_segments`
| Column | Type | Purpose |
|--------|------|---------|
| `speaker_label` | text | Who spoke |
| `text` | text | What was said |
| `embedding` | vector(384) | Semantic search vector |
| `project_id` | text | Project isolation |
| `session_id` | text | Source meeting |
| Used by: `ingestion.py` (INSERT), `search_transcript_segments` RPC (SELECT), fallbackGroqQuery (SELECT) |

### `meeting_events`
| Column | Type | Purpose |
|--------|------|---------|
| `category` | text | DECISION, ACTION_ITEM, RISK, etc. |
| `description` | text | Short summary of the event |
| `detail` | text | Longer context |
| `assignee` | text | Person responsible (for action items) |
| `embedding` | vector(384) | Semantic search vector |
| `meeting_date` | date | When the meeting happened |
| Used by: `post_meeting.py` (INSERT), `_query_structured()` (SELECT by category), `search_meeting_events` RPC (SELECT) |

### `project_memory`
| Column | Type | Purpose |
|--------|------|---------|
| `project_id` | text PK | One row per project |
| `total_meetings` | int | Meeting count |
| `total_decisions` | int | Decision count |
| `open_action_items` | int | Unresolved items |
| `key_themes` | jsonb | Auto-detected topics |
| `risk_flags` | jsonb | Extracted risks |
| `summary_snapshot` | text | LLM-generated summary |
| Used by: `post_meeting.py` (upsert), dashboard (display) |

### `chat_messages`
| Column | Type | Purpose |
|--------|------|---------|
| `project_id` | text | Project isolation |
| `chat_session_id` | text | Groups messages into conversations |
| `role` | text | "user" or "assistant" |
| `content` | text | The message text |
| Used by: `query_router.py` (save/load conversation history for follow-up resolution) |

### Redis key
| Key | Type | Purpose |
|-----|------|---------|
| `session:<session_id>:segments` | List | Live meeting segments (6hr TTL), used by `_query_redis_buffer()` |

