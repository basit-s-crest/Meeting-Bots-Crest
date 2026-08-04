import { getCalendarClient, loadRefreshToken, handleGoogleApiError } from './calendar-service.js';
import { extractMeetingLink } from './link-extractor.js';
import { upsertScheduledMeeting, reconcileDeletedMeetings } from './scheduled-meetings-db.js';

/**
 * Lists Google Calendar events for the next `lookAheadDays` days and
 * upserts each into scheduled_meetings. Also backfills any meeting link
 * found on the event (hangoutLink / location / description).
 *
 * Uses showDeleted:true so cancelled/deleted events are returned; they are
 * removed from DB. Reconciles by deleting DB rows whose event no longer
 * exists in Google.
 *
 * Returns { count, events, reconciled }
 */
export async function syncCalendarEvents({ lookAheadDays = 60 } = {}) {
  if (!loadRefreshToken()) {
    throw new Error('Google Calendar is not connected');
  }

  const calendar = await getCalendarClient();

  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + lookAheadDays * 24 * 60 * 60 * 1000).toISOString();

  const response = await calendar.events.list({
    calendarId: 'primary',
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    showDeleted: true
  });

  const events = response.data.items || [];
  let count = 0;
  const liveIds = [];

  for (const event of events) {
    const extracted = extractMeetingLink(event);
    if (extracted && !event.hangoutLink) {
      event.hangoutLink = extracted.url;
    }

    if (event.status !== 'cancelled') {
      liveIds.push(event.id);
    }

    const row = await upsertScheduledMeeting(event);
    if (row) count += 1;
  }

  // Remove rows whose events are gone from Google entirely in this window
  const reconciled = await reconcileDeletedMeetings(liveIds, timeMin, timeMax);

  return { count, events, reconciled };
}
