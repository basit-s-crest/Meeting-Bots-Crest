-- Table creation schema for Crest Meet database.
-- Clean layout with proper foreign key ordering and pgvector types.

-- Enable pgvector extension if not enabled
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1. Clients
CREATE TABLE public.clients (
  id text NOT NULL DEFAULT (gen_random_uuid())::text,
  name text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT clients_pkey PRIMARY KEY (id)
);

-- 2. Projects
CREATE TABLE public.projects (
  id text NOT NULL DEFAULT (gen_random_uuid())::text,
  name text NOT NULL,
  description text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT projects_pkey PRIMARY KEY (id)
);

-- 3. Meeting Sessions
CREATE TABLE public.meeting_sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  session_id text NOT NULL UNIQUE,
  bot_type text NOT NULL,
  meeting_url text NOT NULL,
  bot_name text,
  status text DEFAULT 'starting'::text,
  created_at timestamp with time zone DEFAULT now(),
  transcript_file_url text,
  report_file_url text,
  client_id text,
  project_id text,
  CONSTRAINT meeting_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT meeting_sessions_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id),
  CONSTRAINT meeting_sessions_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id)
);

-- 4. Transcript Segments
CREATE TABLE public.transcript_segments (
  id text NOT NULL DEFAULT (gen_random_uuid())::text,
  session_id text NOT NULL,
  project_id text NOT NULL,
  speaker_label text NOT NULL,
  resolved_name text,
  text text NOT NULL,
  start_ts double precision NOT NULL,
  end_ts double precision NOT NULL,
  is_final boolean NOT NULL DEFAULT true,
  embedding public.vector(384),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT transcript_segments_pkey PRIMARY KEY (id),
  CONSTRAINT transcript_segments_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.meeting_sessions(session_id),
  CONSTRAINT transcript_segments_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id)
);

-- 5. Meeting Events
CREATE TABLE public.meeting_events (
  id text NOT NULL DEFAULT (gen_random_uuid())::text,
  session_id text NOT NULL,
  project_id text NOT NULL,
  category text NOT NULL CHECK (category = ANY (ARRAY['DECISION'::text, 'ACTION_ITEM'::text, 'FEATURE_DISCUSSION'::text, 'ESTIMATE'::text, 'RISK'::text, 'KEY_TOPIC'::text, 'MILESTONE'::text])),
  description text NOT NULL,
  detail text,
  assignee text,
  priority text CHECK (priority = ANY (ARRAY['High'::text, 'Medium'::text, 'Low'::text])),
  embedding public.vector(384),
  meeting_date date NOT NULL,
  bot_type text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT meeting_events_pkey PRIMARY KEY (id),
  CONSTRAINT meeting_events_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.meeting_sessions(session_id),
  CONSTRAINT meeting_events_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id)
);

-- 6. Project Memory
CREATE TABLE public.project_memory (
  id text NOT NULL DEFAULT (gen_random_uuid())::text,
  project_id text NOT NULL UNIQUE,
  total_meetings integer NOT NULL DEFAULT 0,
  total_decisions integer NOT NULL DEFAULT 0,
  open_action_items integer NOT NULL DEFAULT 0,
  last_meeting_date date,
  last_meeting_platform text,
  key_themes text[] NOT NULL DEFAULT '{}'::text[], -- Changed from ARRAY to text[]
  risk_flags text[] NOT NULL DEFAULT '{}'::text[], -- Changed from ARRAY to text[]
  pending_blockers text[] NOT NULL DEFAULT '{}'::text[], -- Changed from ARRAY to text[]
  important_dates jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary_snapshot text,
  last_updated timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT project_memory_pkey PRIMARY KEY (id),
  CONSTRAINT project_memory_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id)
);

-- 7. Project Clients (Junction Table)
CREATE TABLE public.project_clients (
  project_id text NOT NULL,
  client_id text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT project_clients_pkey PRIMARY KEY (project_id, client_id),
  CONSTRAINT project_clients_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id),
  CONSTRAINT project_clients_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id)
);

-- 8. Vector Indexes (HNSW)
CREATE INDEX IF NOT EXISTS idx_transcript_segments_embedding ON public.transcript_segments USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_meeting_events_embedding ON public.meeting_events USING hnsw (embedding vector_cosine_ops);


-- ──────────────────────────────────────────────────────────────────────────────
-- RPC Functions
-- ──────────────────────────────────────────────────────────────────────────────

-- Hybrid vector + keyword search on meeting_events.
-- No join to meeting_sessions needed — meeting_events already has
-- project_id, meeting_date, and bot_type directly on the row.
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
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.session_id,
    e.description,
    e.meeting_date,
    e.bot_type,
    1 - (e.embedding <=> p_query_embedding) AS similarity
  FROM meeting_events e
  WHERE e.project_id = p_project_id
    AND e.embedding IS NOT NULL
    AND (1 - (e.embedding <=> p_query_embedding)) >= 0.2
    AND (
      p_keyword = ''
      OR e.description ILIKE ANY(string_to_array(p_keyword, '|'))
      OR e.detail ILIKE ANY(string_to_array(p_keyword, '|'))
    )
  ORDER BY e.embedding <=> p_query_embedding
  LIMIT p_match_count;
END;
$$;


-- ──────────────────────────────────────────────────────────────────────────────
-- Indexes
-- ──────────────────────────────────────────────────────────────────────────────

-- Project isolation (btree)
CREATE INDEX idx_events_project ON meeting_events (project_id);
CREATE INDEX idx_segments_project ON transcript_segments (project_id);

-- Vector similarity (HNSW — works on empty tables, handles incremental inserts)
CREATE INDEX idx_events_embedding ON meeting_events USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_segments_embedding ON transcript_segments USING hnsw (embedding vector_cosine_ops);

-- Keyword search (trigram — enables ILIKE '%term%' via GIN index)
CREATE INDEX idx_events_desc_trgm ON meeting_events USING gin (description gin_trgm_ops);
CREATE INDEX idx_events_detail_trgm ON meeting_events USING gin (detail gin_trgm_ops);
CREATE INDEX idx_segments_text_trgm ON transcript_segments USING gin (text gin_trgm_ops);


-- ──────────────────────────────────────────────────────────────────────────────
-- Indexes
-- ──────────────────────────────────────────────────────────────────────────────

-- Project isolation (btree)
CREATE INDEX idx_events_project ON meeting_events (project_id);
CREATE INDEX idx_segments_project ON transcript_segments (project_id);

-- Vector similarity (HNSW — works on empty tables, handles incremental inserts)
CREATE INDEX idx_events_embedding ON meeting_events USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_segments_embedding ON transcript_segments USING hnsw (embedding vector_cosine_ops);

-- Keyword search (trigram — enables ILIKE '%term%' via GIN index)
CREATE INDEX idx_events_desc_trgm ON meeting_events USING gin (description gin_trgm_ops);
CREATE INDEX idx_events_detail_trgm ON meeting_events USING gin (detail gin_trgm_ops);
CREATE INDEX idx_segments_text_trgm ON transcript_segments USING gin (text gin_trgm_ops);


-- ──────────────────────────────────────────────────────────────────────────────
-- Chat History (short-term conversational context for follow-up resolution)
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE public.chat_messages (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id text NOT NULL,
  chat_session_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT chat_messages_pkey PRIMARY KEY (id),
  CONSTRAINT chat_messages_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id)
);

CREATE INDEX idx_chat_session ON chat_messages (chat_session_id, created_at);


-- Hybrid vector + keyword search on transcript_segments.
-- Joins with meeting_sessions to return meeting_date and bot_type.
-- Drop first: return type changed (added meeting_date, bot_type columns)
DROP FUNCTION IF EXISTS search_transcript_segments(text, vector(384), text, int);

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
  meeting_date  date,
  bot_type      text,
  similarity    real
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.session_id,
    s.speaker_label,
    s.text,
    s.start_ts,
    ms.created_at::date AS meeting_date,
    COALESCE(ms.bot_type, 'meeting') AS bot_type,
    (1 - (s.embedding <=> p_query_embedding))::real AS similarity
  FROM transcript_segments s
  LEFT JOIN meeting_sessions ms ON ms.session_id = s.session_id
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


-- ──────────────────────────────────────────────────────────────────────────────
-- Scheduled (Upcoming) Meetings — custom calendar + project assignment
-- ──────────────────────────────────────────────────────────────────────────────
-- One row per Google Calendar event, upserted by calendar_event_id so
-- re-syncing never duplicates. project_id is nullable: a meeting can be
-- unassigned, and "assign to project" simply fills this column.
-- session_id is backfilled when auto-join spawns a bot, tracing the
-- calendar event to the real captured session.
CREATE TABLE IF NOT EXISTS public.scheduled_meetings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  calendar_event_id text NOT NULL UNIQUE,
  project_id text,
  session_id text,
  title text NOT NULL,
  description text,
  meeting_url text,
  bot_type text,
  start_time timestamp with time zone NOT NULL,
  end_time timestamp with time zone,
  timezone text,
  status text NOT NULL DEFAULT 'upcoming',
  auto_join boolean NOT NULL DEFAULT false,
  html_link text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT scheduled_meetings_pkey PRIMARY KEY (id),
  CONSTRAINT scheduled_meetings_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL,
  CONSTRAINT scheduled_meetings_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES public.meeting_sessions(session_id) ON DELETE SET NULL
);

CREATE INDEX idx_scheduled_meetings_start_time ON public.scheduled_meetings (start_time);
CREATE INDEX idx_scheduled_meetings_project_id  ON public.scheduled_meetings (project_id);
CREATE INDEX idx_scheduled_meetings_status      ON public.scheduled_meetings (status);
