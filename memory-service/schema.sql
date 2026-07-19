-- Table creation schema for Crest Meet database.
-- Clean layout with proper foreign key ordering and pgvector types.

-- Enable pgvector extension if not enabled
CREATE EXTENSION IF NOT EXISTS vector;

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
  speaker_label text NOT NULL,
  resolved_name text,
  text text NOT NULL,
  start_ts double precision NOT NULL,
  end_ts double precision NOT NULL,
  is_final boolean NOT NULL DEFAULT true,
  embedding public.vector(1536), -- Changed from USER-DEFINED to public.vector(1536)
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT transcript_segments_pkey PRIMARY KEY (id),
  CONSTRAINT transcript_segments_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.meeting_sessions(session_id)
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
  embedding public.vector(1536), -- Changed from USER-DEFINED to public.vector(1536)
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
