-- Create users table
CREATE TABLE IF NOT EXISTS public.users (
  id text NOT NULL DEFAULT (gen_random_uuid())::text,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT users_pkey PRIMARY KEY (id)
);

-- Add user_id column to projects table if not already present
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS user_id text;

-- Add foreign key constraint linking projects to users
-- Note: Doing this in a separate block to ensure it doesn't fail if already present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage 
    WHERE table_name = 'projects' AND constraint_name = 'projects_user_id_fkey'
  ) THEN
    ALTER TABLE public.projects 
      ADD CONSTRAINT projects_user_id_fkey 
      FOREIGN KEY (user_id) 
      REFERENCES public.users(id)
      ON DELETE CASCADE;
  END IF;
END $$;

-- Add exit_reason column to meeting_sessions table
ALTER TABLE public.meeting_sessions ADD COLUMN IF NOT EXISTS exit_reason text;

-- Add attendee_emails column to meeting_sessions table if not already present
ALTER TABLE public.meeting_sessions ADD COLUMN IF NOT EXISTS attendee_emails text[];

-- Scheduling approval flow: two-stage approval (organizer on CrestMeet, then attendees via Meet-chat link)
CREATE TABLE IF NOT EXISTS public.scheduling_approvals (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  session_id text NOT NULL,
  project_id text,
  title text,
  date text,
  time text,
  timezone text,
  raw_mention text,
  token text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending_organizer',
  approved_by text,
  approvals jsonb NOT NULL DEFAULT '[]'::jsonb,
  event_id text,
  html_link text,
  finalized_by text,
  finalized_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT scheduling_approvals_pkey PRIMARY KEY (id)
);

-- Index for looking up proposals by live session.
CREATE INDEX IF NOT EXISTS scheduling_approvals_session_id_idx ON public.scheduling_approvals (session_id);
-- Index for the public token lookup.
CREATE INDEX IF NOT EXISTS scheduling_approvals_token_idx ON public.scheduling_approvals (token);

-- ==============================================================================
-- Speaker-Aware Action Item Assignment & Voice Fingerprinting
-- ==============================================================================

-- 1. Store audio profile JSON on meeting sessions
ALTER TABLE public.meeting_sessions ADD COLUMN IF NOT EXISTS audio_profile jsonb;

-- 2. User Speaker Fingerprints (Name aliases across meetings)
CREATE TABLE IF NOT EXISTS public.user_speaker_fingerprints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  display_name_normalized text NOT NULL,
  seen_count integer NOT NULL DEFAULT 1,
  last_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  source_session_id text,
  UNIQUE (user_id, display_name_normalized)
);

-- 3. User Voice Profiles (Voice energy + optional vector embedding)
CREATE TABLE IF NOT EXISTS public.user_voice_profiles (
  user_id text PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  avg_rms double precision NOT NULL DEFAULT 0.0,
  rms_stddev double precision NOT NULL DEFAULT 0.0,
  voice_embedding vector(192),
  sample_count integer NOT NULL DEFAULT 0,
  last_updated timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fingerprint_normalized ON public.user_speaker_fingerprints (display_name_normalized);
CREATE INDEX IF NOT EXISTS idx_fingerprint_user ON public.user_speaker_fingerprints (user_id);

-- 4. Assignee and deadline fields on meeting_events
ALTER TABLE public.meeting_events
  ADD COLUMN IF NOT EXISTS assignee_user_id text REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assignee_confidence real,
  ADD COLUMN IF NOT EXISTS assignee_confirmed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deadline timestamp with time zone,
  ADD COLUMN IF NOT EXISTS completed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS completed_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS idx_meeting_events_assignee ON public.meeting_events (assignee_user_id);

