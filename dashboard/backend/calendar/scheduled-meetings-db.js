import { supabase } from '../supabase-client.js';

/**
 * Upserts one Google Calendar event into the scheduled_meetings table.
 * Keyed by calendar_event_id so re-syncing never creates duplicates.
 *
 * Handles deleted events: Google returns them with status 'cancelled'.
 * If cancelled, we delete the row from DB so deletions propagate immediately.
 */
export async function upsertScheduledMeeting(event) {
  if (!event || !event.id) return null;

  const cancelled = event.status === 'cancelled';

  // If event is cancelled/deleted in Google Calendar, remove it from our DB
  if (cancelled) {
    try {
      await supabase
        .from('scheduled_meetings')
        .delete()
        .eq('calendar_event_id', event.id);
      console.log(`[ScheduledMeetings] Removed deleted event ${event.id} from DB.`);
    } catch (err) {
      console.warn(`[ScheduledMeetings] Failed to delete cancelled event ${event.id}:`, err.message);
    }
    return null;
  }

  const startRaw = event.start?.dateTime || event.start?.date;
  const endRaw = event.end?.dateTime || event.end?.date;
  if (!startRaw) return null;

  const isAllDay = !event.start?.dateTime;

  // Normalize all-day (date-only) events to midnight UTC
  const startTime = startRaw
    ? isAllDay
      ? `${startRaw}T00:00:00Z`
      : startRaw
    : null;
  const endTime = endRaw
    ? isAllDay
      ? `${endRaw}T00:00:00Z`
      : endRaw
    : null;

  const row = {
    calendar_event_id: event.id,
    title: event.summary || 'Untitled meeting',
    description: event.description || null,
    meeting_url: event.hangoutLink || null,
    start_time: startTime,
    end_time: endTime,
    timezone: event.start?.timeZone || null,
    status: 'upcoming',
    auto_join: false,
    html_link: event.htmlLink || null
  };

  // Preserve existing project assignment + session link on re-sync.
  try {
    const { data: existing } = await supabase
      .from('scheduled_meetings')
      .select('project_id, session_id, status')
      .eq('calendar_event_id', event.id)
      .maybeSingle();
    if (existing) {
      row.project_id = existing.project_id;
      row.session_id = existing.session_id;
      if (existing.status && existing.status !== 'upcoming') {
        row.status = existing.status;
      }
    }
  } catch (err) {
    console.warn(`[ScheduledMeetings] Failed to load existing row for ${event.id}:`, err.message);
  }

  try {
    const { data, error } = await supabase
      .from('scheduled_meetings')
      .upsert(row, { onConflict: 'calendar_event_id' })
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (err) {
    console.error(`[ScheduledMeetings] Upsert failed for event ${event.id}:`, err.message);
    return null;
  }
}

/**
 * Deletes scheduled_meetings rows in a date range whose calendar_event_id
 * is NOT in the given set of live Google event IDs.
 */
export async function reconcileDeletedMeetings(liveEventIds, timeMin, timeMax) {
  try {
    let query = supabase
      .from('scheduled_meetings')
      .select('id, calendar_event_id, start_time');

    if (timeMin && timeMax) {
      query = query.gte('start_time', timeMin).lte('start_time', timeMax);
    }

    const { data: rows, error: fetchErr } = await query;

    if (fetchErr) throw fetchErr;
    if (!rows || rows.length === 0) return 0;

    const liveSet = new Set(liveEventIds || []);
    const staleIds = rows
      .filter((r) => !liveSet.has(r.calendar_event_id))
      .map((r) => r.id);

    if (staleIds.length === 0) return 0;

    const { error: delErr } = await supabase
      .from('scheduled_meetings')
      .delete()
      .in('id', staleIds);

    if (delErr) throw delErr;
    console.log(`[ScheduledMeetings] Reconciled ${staleIds.length} deleted events from DB.`);
    return staleIds.length;
  } catch (err) {
    console.error('[ScheduledMeetings] Reconcile failed:', err.message);
    return 0;
  }
}

/**
 * Lists scheduled meetings from the DB, newest first, excluding cancelled ones.
 */
export async function listScheduledMeetings({ includePast = false } = {}) {
  try {
    let query = supabase
      .from('scheduled_meetings')
      .select('*')
      .neq('status', 'cancelled')
      .order('start_time', { ascending: true });

    if (!includePast) {
      const now = new Date().toISOString();
      query = query.gte('start_time', now);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error('[ScheduledMeetings] List failed:', err.message);
    return [];
  }
}

/**
 * Assigns a scheduled meeting to a project (project_id must belong to the user).
 */
export async function assignScheduledMeeting(meetingId, projectId, userId) {
  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select('id, user_id')
    .eq('id', projectId)
    .maybeSingle();

  if (projectError) throw new Error(`Failed to look up project: ${projectError.message}`);
  if (!project) throw new Error('Project not found');
  if (project.user_id && project.user_id !== userId) {
    throw new Error('Project does not belong to the current user');
  }

  const { data, error } = await supabase
    .from('scheduled_meetings')
    .update({ project_id: projectId })
    .eq('id', meetingId)
    .select()
    .single();

  if (error) throw new Error(`Failed to assign meeting: ${error.message}`);
  return data;
}
