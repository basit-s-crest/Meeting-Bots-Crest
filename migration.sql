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

-- Add exit_reason column to meeting_sessions table
ALTER TABLE public.meeting_sessions ADD COLUMN IF NOT EXISTS exit_reason text;

