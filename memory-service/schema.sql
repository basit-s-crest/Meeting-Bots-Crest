-- ============================================================
-- Meeting Memory Service — Supabase Schema
-- Run this once in the Supabase SQL Editor.
-- ============================================================

-- 0. Enable pgvector extension
create extension if not exists vector;

-- 1. Clients
create table if not exists public.clients (
  id          text not null default gen_random_uuid()::text,
  name        text not null,
  created_at  timestamptz not null default now(),
  constraint clients_pkey primary key (id)
);

-- 2. Projects
create table if not exists public.projects (
  id          text not null default gen_random_uuid()::text,
  client_id   text not null references public.clients(id),
  name        text not null,
  description text,
  created_at  timestamptz not null default now(),
  constraint projects_pkey primary key (id)
);

create index if not exists projects_client_idx on public.projects (client_id);

-- 3. Add client/project columns to existing meeting_sessions
alter table public.meeting_sessions
  add column if not exists client_id  text references public.clients(id),
  add column if not exists project_id text references public.projects(id);

-- 4. Transcript segments (per-utterance, embedded)
create table if not exists public.transcript_segments (
  id            text not null default gen_random_uuid()::text,
  session_id    text not null references public.meeting_sessions(session_id),
  speaker_label text not null,
  resolved_name text,
  text          text not null,
  start_ts      double precision not null,
  end_ts        double precision not null,
  is_final      boolean not null default true,
  embedding     vector(384),
  created_at    timestamptz not null default now(),
  constraint transcript_segments_pkey primary key (id)
);

create index if not exists segments_session_idx on public.transcript_segments (session_id, start_ts asc);
create index if not exists segments_embedding_idx on public.transcript_segments
  using ivfflat (embedding vector_cosine_ops) with (lists = 50);

-- 5. Extracted meeting events (decisions, action items, key topics)
create table if not exists public.meeting_events (
  id            text not null default gen_random_uuid()::text,
  session_id    text not null references public.meeting_sessions(session_id),
  project_id    text not null references public.projects(id),
  category      text not null
                check (category in (
                  'DECISION', 'ACTION_ITEM', 'FEATURE_DISCUSSION',
                  'ESTIMATE', 'RISK', 'KEY_TOPIC', 'MILESTONE'
                )),
  description   text not null,
  detail        text,
  assignee      text,
  priority      text check (priority in ('High', 'Medium', 'Low')),
  embedding     vector(384),
  meeting_date  date not null,
  bot_type      text not null,
  created_at    timestamptz not null default now(),
  constraint meeting_events_pkey primary key (id)
);

create index if not exists events_project_idx on public.meeting_events (project_id, category, meeting_date desc);
create index if not exists events_embedding_idx on public.meeting_events
  using ivfflat (embedding vector_cosine_ops) with (lists = 50);

-- RPC: search meeting events by vector similarity + keyword
create or replace function search_meeting_events(
  p_project_id text,
  p_query_embedding vector(384),
  p_keyword text default '',
  p_match_count int default 8
)
returns table (
  id text, session_id text, category text, description text, detail text,
  assignee text, priority text, meeting_date date, bot_type text,
  similarity float
)
language plpgsql stable as $$
begin
  return query
  select
    e.id, e.session_id, e.category, e.description, e.detail,
    e.assignee, e.priority, e.meeting_date, e.bot_type,
    1 - (e.embedding <=> p_query_embedding) as similarity
  from public.meeting_events e
  where
    e.project_id = p_project_id
    and 1 - (e.embedding <=> p_query_embedding) > 0.35
    and (
      p_keyword = ''
      or e.description ilike '%' || p_keyword || '%'
      or e.detail ilike '%' || p_keyword || '%'
    )
  order by similarity desc
  limit p_match_count;
end;
$$;

-- RPC: search transcript segments by vector similarity
create or replace function search_transcript_segments(
  p_project_id text,
  p_query_embedding vector(384),
  p_keyword text default '',
  p_match_count int default 6
)
returns table (
  id text, session_id text, speaker_label text, resolved_name text,
  text text, start_ts double precision, meeting_date date, bot_type text,
  similarity float
)
language plpgsql stable as $$
begin
  return query
  select
    s.id, s.session_id, s.speaker_label, s.resolved_name,
    s.text, s.start_ts,
    m.started_at::date as meeting_date,
    m.bot_type,
    1 - (s.embedding <=> p_query_embedding) as similarity
  from public.transcript_segments s
  join public.meeting_sessions m on m.session_id = s.session_id
  where
    m.project_id = p_project_id
    and 1 - (s.embedding <=> p_query_embedding) > 0.3
    and (
      p_keyword = ''
      or s.text ilike '%' || p_keyword || '%'
    )
  order by similarity desc
  limit p_match_count;
end;
$$;

-- 6. Project memory rollup
create table if not exists public.project_memory (
  id                     text not null default gen_random_uuid()::text,
  project_id             text not null unique references public.projects(id),
  total_meetings         integer not null default 0,
  total_decisions        integer not null default 0,
  open_action_items      integer not null default 0,
  last_meeting_date      date,
  last_meeting_platform  text,
  key_themes             text[] not null default '{}',
  risk_flags             text[] not null default '{}',
  pending_blockers       text[] not null default '{}',
  important_dates        jsonb not null default '[]',
  summary_snapshot       text,
  last_updated           timestamptz not null default now(),
  constraint project_memory_pkey primary key (id)
);
