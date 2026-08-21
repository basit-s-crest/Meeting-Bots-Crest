import { Groq } from 'groq-sdk';
import crypto from 'crypto';
import { supabase } from './supabase-client.js';

/**
 * Live scheduling-intent detector.
 *
 * Watches final transcript segments as they arrive during a meeting and runs a
 * lightweight Groq check periodically. When scheduling intent is detected, it
 * persists a `scheduling_approvals` row in `pending_organizer` state and invokes
 * the callback so the backend can surface the approval to the organizer.
 */

const CHECK_INTERVAL_MS = 45 * 1000; // how often to run the intent check
const MIN_SEGMENTS = 4; // don't check until we have a few utterances
const DETECT_COOLDOWN_MS = 5 * 60 * 1000; // don't re-detect within 5 min

class LiveSchedulingDetector {
  constructor() {
    this._buffers = new Map(); // sessionId -> { segments: [], lastCheck: number, lastDetect: number }
  }

  /**
   * Appends a final transcript segment for a session.
   */
  ingest(sessionId, { speaker, text, timestamp }) {
    if (!sessionId || !text) return;
    let buf = this._buffers.get(sessionId);
    if (!buf) {
      buf = { segments: [], lastCheck: 0, lastDetect: 0 };
      this._buffers.set(sessionId, buf);
    }
    buf.segments.push({ speaker: speaker || 'Unknown', text, timestamp: timestamp || new Date().toISOString() });

    // Cap the buffer to avoid unbounded growth (keep last ~120 segments).
    if (buf.segments.length > 120) {
      buf.segments = buf.segments.slice(-120);
    }

    // Fire a check when enough new material has accumulated and the cooldown elapsed.
    const now = Date.now();
    if (buf.segments.length >= MIN_SEGMENTS && now - buf.lastCheck >= CHECK_INTERVAL_MS) {
      this._check(sessionId, buf);
    }
  }

  /**
   * Runs the Groq intent check on the current buffer and, on detection,
   * creates a proposal and calls onDetected.
   */
  async _check(sessionId, buf) {
    buf.lastCheck = Date.now();

    if (!process.env.GROQ_API_KEY) return;

    // Build a compact transcript tail (last ~40 segments) for the prompt.
    const tail = buf.segments.slice(-40)
      .map(s => `${s.speaker}: ${s.text}`)
      .join('\n');

    const tz = process.env.CALENDAR_TIMEZONE || 'Asia/Kolkata';
    const now = new Date();
    const referenceDate = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    const refDateStr = referenceDate.toISOString().slice(0, 10);

    const systemPrompt = `You are a scheduling-intent detector for a live meeting transcript.
You will receive the most recent utterances from an ongoing meeting.
Respond with a JSON object with exactly these keys:
{
  "scheduling_detected": true or false,
  "scheduling": {
    "date": "YYYY-MM-DD",
    "time": "HH:MM",
    "timezone": "IANA timezone string",
    "title": "Short, clean meeting title",
    "raw_mention": "The exact sentence that triggered detection"
  }
}

Rules:
- Set scheduling_detected to true if someone mentions scheduling/arranging/rescheduling a future meeting or event, OR any relative time like "in 5 days", "after 2 days", "next week" (e.g. "let's meet in 5 days", "can we schedule a follow-up next Tuesday", "we'll meet again in 2 days").
- Resolve relative dates like "tomorrow", "in 5 days", "after 2 days", "next Monday" to absolute dates using the Reference Date below. Compute the exact calendar date.
- If no specific date is mentioned (only a vague future reference like "let's schedule later"), set "date" to null and still set scheduling_detected to true.
- If no specific time is mentioned, set "time" to null.
- If no clean title can be inferred, set "title" to a generic label like "Follow-up Meeting".
- If scheduling_detected is false, set "scheduling" to null.

Reference Date (today, local meeting timezone): ${refDateStr}
Meeting timezone: ${tz}`;

    try {
      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
      const completion = await groq.chat.completions.create({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Recent transcript:\n${tail}` }
        ],
        model: 'openai/gpt-oss-120b',
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 800
      });

      const raw = completion.choices?.[0]?.message?.content || '{}';
      const result = JSON.parse(raw);

      if (result.scheduling_detected) {
        const nowMs = Date.now();
        // Cooldown: avoid duplicate proposals in quick succession.
        if (nowMs - buf.lastDetect < DETECT_COOLDOWN_MS) {
          console.log(`[LiveScheduler] Intent detected but within cooldown for session ${sessionId}; skipping.`);
          return;
        }
        buf.lastDetect = nowMs;

        // Dedupe: skip if this session already has a pending/organizer-approved proposal.
        try {
          const { data: existing, error: existingErr } = await supabase
            .from('scheduling_approvals')
            .select('id')
            .eq('session_id', sessionId)
            .in('status', ['pending_organizer', 'approved_by_organizer'])
            .limit(1);
          if (!existingErr && existing && existing.length > 0) {
            console.log(`[LiveScheduler] Session ${sessionId} already has an open proposal; skipping duplicate.`);
            return;
          }
        } catch (dedupeErr) {
          console.warn(`[LiveScheduler] Dedupe check failed for session ${sessionId}:`, dedupeErr.message);
        }

        await this._persistProposal(sessionId, result.scheduling, buf);
      }
    } catch (err) {
      console.warn(`[LiveScheduler] Detection check failed for session ${sessionId}:`, err.message);
    }
  }

  /**
   * Creates the pending_organizer proposal row in Supabase.
   */
  async _persistProposal(sessionId, scheduling, buf) {
    const token = crypto.randomBytes(24).toString('hex');

    const row = {
      session_id: sessionId,
      title: scheduling.title,
      date: scheduling.date,
      time: scheduling.time || null,
      timezone: scheduling.timezone || process.env.CALENDAR_TIMEZONE || 'Asia/Kolkata',
      raw_mention: scheduling.raw_mention || '',
      token,
      status: 'pending_organizer',
      approvals: []
    };

    const { data, error } = await supabase
      .from('scheduling_approvals')
      .insert(row)
      .select()
      .single();

    if (error) {
      console.error('[LiveScheduler] Failed to persist proposal:', error.message);
      return;
    }

    console.log(`[LiveScheduler] Scheduling intent detected for session ${sessionId}: "${scheduling.title}" on ${scheduling.date} at ${scheduling.time || 'TBD'}`);

    if (this.onDetected) {
      try {
        await this.onDetected(data);
      } catch (err) {
        console.error('[LiveScheduler] onDetected callback error:', err.message);
      }
    }
  }

  /**
   * Removes a session's buffer (call on session end).
   */
  clear(sessionId) {
    this._buffers.delete(sessionId);
  }
}

export const liveSchedulingDetector = new LiveSchedulingDetector();

// ---------------------------------------------------------------------------
// Live participant roster (names only, bot excluded)
// Populated from the bot's `roster` WebSocket events and served to the
// approval page so attendees can pick their real name instead of demo names.
// ---------------------------------------------------------------------------
const sessionRosters = new Map();

export function setSessionRoster(sessionId, names) {
  if (!sessionId) return;
  if (!Array.isArray(names)) return;
  sessionRosters.set(sessionId, names);
  console.log(`[LiveScheduler] Roster cached for session ${sessionId}: ${names.length} attendee(s)`);
}

export function getSessionRoster(sessionId) {
  if (!sessionId) return [];
  return sessionRosters.get(sessionId) || [];
}

export function clearSessionRoster(sessionId) {
  sessionRosters.delete(sessionId);
}
