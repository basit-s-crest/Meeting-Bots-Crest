# Speaker-Aware Action Item Assignment — Plan

## Goal

Auto-assign action items extracted from meeting transcripts to **the platform user who owns the project** (not all attendees), when the meeting has external/cross-org attendees with mixed personal + institutional emails. Avoid relying on email-as-identity (unreliable for cross-org). The system must work end-to-end without forcing the user to join with a specific Google account.

---

## Approach: Display-Name + Voice-Energy Fingerprint (Bootstrap-from-User)

Cross-org attendees cannot be resolved by email alone — the user's identity in the meeting may be a personal email, an institutional email, a nickname, or none visible at all. Instead, recognize the platform user by **who they sound like and what they were called**, both inside the meeting (via the bot's existing per-channel audio binding) and across meetings (via a per-user fingerprint table seeded by the user themselves on first use).

### Three-stage identity pipeline

1. **During the meeting (real-time)**: the Google Meet bot already binds audio channels → display names via the `ChannelSpeakerBinder` (energy↔glow correlation in `Google Meet/src/speaker/speaker-detector.js`). Each `transcript_segments.speaker_label` is a display name. Persist channel-RMS profiles per session.
2. **After the meeting (post-processing)**: the LLM-extracted `assignee: "<Name>"` from `post_meeting.py` is matched against the in-session roster. If the assignee string is one of the meeting's attendee names, it becomes a "candidate user" with a confidence score. The candidate's user_id is whichever platform user has a matching fingerprint.
3. **Across meetings (bootstrap)**: the first time a platform user has a meeting under their project, the system has no prior signal. Show a post-meeting modal asking "Which participant were you?" with the meeting's transcript speaker labels. The user's selection seeds their fingerprint.

### Why this works for cross-org

- **Doesn't depend on email at all** — survives personal vs institutional email splits, hidden emails, attendees joining from guest accounts.
- **Stable across meetings** — display name in Google Meet is usually consistent per Google account per user (your "Basit Sachinwala" account will always show that name). Even when names collide (two Basits), the voice-energy profile disambiguates.
- **Doesn't constrain how the user joins** — they can use any account, any device, any number of personal/institutional emails.

### Why it does NOT depend on the bot's Google account

The bot joins as a separate Google account (per project taste). It sees all meeting attendees' display names regardless of which account the user is using. Display name is per-account, not per-platform-user, so we need the fingerprint to map display-name → platform-user. The bot account is irrelevant.

---

## Components

### 1. New DB table: `user_speaker_fingerprints`

Per-user, per-platform speaker signature. One row per (user_id, display_name) the user has been seen as, plus an aggregate voice-energy profile per user.

```sql
CREATE TABLE public.user_speaker_fingerprints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  display_name text NOT NULL,                -- e.g. "Basit Sachinwala", "Basit S"
  display_name_normalized text NOT NULL,     -- lowercased, trimmed, no punctuation
  seen_count integer NOT NULL DEFAULT 1,
  last_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  source_session_id text,                    -- which meeting seeded/confirmed this
  UNIQUE (user_id, display_name_normalized)
);

-- One row per user holding the aggregate voice-energy profile.
-- updated whenever a meeting confirms this user's fingerprint.
CREATE TABLE public.user_voice_profiles (
  user_id text PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  avg_rms double precision NOT NULL,
  rms_stddev double precision NOT NULL,
  sample_count integer NOT NULL DEFAULT 0,
  last_updated timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX idx_fingerprint_normalized ON user_speaker_fingerprints (display_name_normalized);
CREATE INDEX idx_fingerprint_user ON user_speaker_fingerprints (user_id);
```

Append to `migration.sql` per the existing project convention. Apply to live Supabase per the workflow taste rule.

### 2. Bot: persist per-channel RMS profiles to `meeting_sessions`

The bot already computes per-channel peak amplitude in `audio-capture.js` and feeds frames to the binder. Add a per-session profile aggregator that, when the meeting ends, posts one JSON blob to a new endpoint:

```
POST /api/meetings/:sessionId/audio-profile
body: { channels: [{ channel: 0, name: "Basit", rms_mean: 0.04, rms_stddev: 0.012, samples: 1234 }, ...] }
```

Store as `meeting_sessions.audio_profile jsonb` — single new column. Avoids per-segment storage cost; one row per session.

### 3. Memory service: candidate-resolution API

New endpoint in `memory-service/app/post_meeting.py` (or a new `resolver.py`) that:

- Takes `session_id` + extracted `assignee: "<name>"` strings from the LLM.
- Looks up the meeting's attendee roster (now available from `meeting_sessions.audio_profile` or from `getParticipantRoster` if the bot scrape returns — but we're not relying on email).
- For each `assignee`, looks up `user_speaker_fingerprints` by `display_name_normalized`. If exactly one user has that name → return `{ user_id, confidence: 0.9 }`.
- If multiple users share the name (e.g., two Basits), compare each candidate's `user_voice_profiles.avg_rms` against the in-session profile for the speaker named "Basit" — pick the closer one. Confidence drops to ~0.6.
- If no fingerprint matches: return `{ user_id: null, confidence: 0, needs_assignment: true }`.

### 4. `meeting_events` schema additions

Two new columns to support the resolver output and the user-driven confirmation flow:

```sql
ALTER TABLE meeting_events
  ADD COLUMN IF NOT EXISTS assignee_user_id text REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS assignee_confidence real,
  ADD COLUMN IF NOT EXISTS assignee_confirmed boolean NOT NULL DEFAULT false;
```

`assignee_confirmed=true` means the user explicitly picked this assignment in the post-meeting modal. Unconfirmed items show as "Needs review" in the UI.

### 5. Post-meeting extraction writes resolved assignments

In `post_meeting.py` (the existing Groq extractor), after the LLM returns each event:

```
event = await resolve_assignee(event, session_id, project_id)
await insert_event(event_row)
```

`resolve_assignee` performs steps described in (3) and stamps `assignee_user_id` + `assignee_confidence`.

### 6. First-meeting bootstrap: post-meeting modal in the dashboard

After a meeting completes, on the project page, if the project owner has **no rows** in `user_speaker_fingerprints`, surface a modal:

> "We can't tell which participant was you. Pick the display name from your meeting so we can recognize you next time."

- Lists distinct `speaker_label`s from the meeting's transcript segments (already in `transcript_segments`).
- User picks one → POST `/api/fingerprints/seed { user_id, display_name, session_id }` → creates `user_speaker_fingerprints` row + computes initial `user_voice_profiles` row from the meeting's `audio_profile` for that channel.
- Also lists unconfirmed action items with the assignee dropdown pre-filled to the picked name; user can correct.

The modal only appears once per user — once any row exists in `user_speaker_fingerprints` for that user, future meetings skip straight to auto-resolution. If the auto-resolver has low confidence (`< 0.5`) for an event, the same modal re-appears on the dashboard as a "review" prompt (non-blocking).

### 7. UI for confirmed-vs-unconfirmed action items

On the meeting detail view in the dashboard:
- Action items: `[ Assignee: Basit (you) ✓ ]` for confirmed/platform-matched ones
- `[ Assignee: Sarah — needs review ]` with a dropdown to pick the right person for unconfirmed ones

Each `PATCH /api/meeting-events/:id { assignee_user_id }` confirms or reassigns.

---

## Files to change

### DB / migration
- `migration.sql` — append the new tables + `meeting_events` columns + `meeting_sessions.audio_profile`.

### Bot (`Google Meet/`)
- `src/join/meet-bot.js` — add `getAudioProfile()` that aggregates channel RMS for the session.
- `src/lifecycle/bot-lifecycle.js` — on stop, call `getAudioProfile()` and POST to backend IPC.
- (Note: the bot's email-scrape code we wrote earlier in this session is now obsolete — leave it in place since it's harmless and the user already said to discard it; the resolver doesn't depend on it.)

### Backend (`dashboard/backend/`)
- `supabase-helper.js` — add:
  - `saveAudioProfile(sessionId, profile)`
  - `getAudioProfileForSession(sessionId)`
  - `seedFingerprint(userId, displayName, sessionId)` — also bootstraps voice profile
  - `getFingerprintsForUser(userId)`
  - `findMatchingFingerprints(displayName)` — name lookup with normalization
  - `updateEventAssignee(eventId, userId, confirmed)`
- `process-manager.js` — accept new IPC message `AUDIO_PROFILE`, persist on bot stop alongside the existing attendee-emails flush.
- `server.js` — new routes:
  - `POST /api/fingerprints/seed`
  - `PATCH /api/meeting-events/:id`
  - `GET /api/meetings/:sessionId/audio-profile` (for the modal to render)
- `memory-client.js` — proxy the resolver call to the memory service.

### Memory service (`memory-service/`)
- `app/post_meeting.py` — call resolver before insert; new columns on event row.
- New: `app/resolver.py` — pure function `resolve_assignee(assignee_str, session_id) -> { user_id, confidence, reason }` using the `user_speaker_fingerprints` + `user_voice_profiles` + `meeting_sessions.audio_profile` tables.
- `app/models/events.py` — accept the new columns.

### Frontend (`dashboard/frontend/`)
- `app/(app)/projects/[projectId]/meeting/page.tsx` — add the post-meeting modal + action-item list with confirm/reassign controls.

---

## Verification

1. Apply migration to live Supabase; confirm new tables/columns exist.
2. Run `node --check` on every edited JS file; `python -m py_compile` on every edited Python file.
3. Manual end-to-end test:
   - Start a fresh project (no fingerprint exists).
   - Start a meeting on Google Meet with two attendees (user + one other person). Bot joins via separate account.
   - End meeting → wait for extraction.
   - Open dashboard → modal appears listing speaker labels; user picks their own name.
   - Verify `user_speaker_fingerprints` row created, `user_voice_profiles` row created.
   - Verify all `meeting_events` for that session have `assignee_user_id = user.id` and `assignee_confirmed = true` (since the user just confirmed in the modal).
4. Second meeting test:
   - Different display name this time (e.g., user logged into Meet as "Basit S" instead of "Basit Sachinwala").
   - Verify the resolver still matches — name normalization + voice profile disambiguates.
5. Cross-org test: third meeting where one other attendee has the same display name.
   - Verify confidence drops; action item shows as "Needs review" with a confirm dropdown.
6. Pure-cold test: new user, first meeting ever.
   - Verify modal appears, no fingerprint exists, resolver returns `user_id: null` for all events until user picks.

---

## Open questions deferred

- **Voice-energy similarity threshold**: starting at `|Δrms| < 0.01`; tune from real data once we have 10+ meetings.
- **Re-bootstrapping**: if user changes display name permanently, they can re-seed via a "Reset my voice profile" button in Settings (out of scope for v1).
- **Zoom / Microsoft Teams parity**: same fingerprint works cross-platform because the fingerprint is keyed on display-name + voice-energy, both of which the bots already emit per-platform. Wrap the Zoom/Teams audio-capture profile aggregation the same way in a follow-up PR.