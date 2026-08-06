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

