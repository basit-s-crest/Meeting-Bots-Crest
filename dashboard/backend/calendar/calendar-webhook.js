import crypto from 'crypto';
import { getCalendarClient, loadRefreshToken } from './calendar-service.js';
import { extractMeetingLink } from './link-extractor.js';
import { autoJoinStore } from './auto-join-store.js';
import { processManager, getFreePort } from '../process-manager.js';
import { supabase } from '../supabase-client.js';
import { upsertScheduledMeeting, reconcileDeletedMeetings } from './scheduled-meetings-db.js';



let activeChannel = null;

/**
 * Registers Google Calendar Push Notification (events.watch).
 * Requires PUBLIC_BACKEND_URL to be set in environment variables (e.g. ngrok or production domain).
 */
export async function setupWatchChannel() {
  if (!loadRefreshToken()) {
    console.log('[Calendar Webhook] Cannot setup watch channel: Google Calendar not authenticated.');
    return null;
  }

  const publicUrl = process.env.PUBLIC_BACKEND_URL;
  if (!publicUrl) {
    console.log('[Calendar Webhook] PUBLIC_BACKEND_URL not set in .env. Webhook push channel disabled. Using polling fallback.');
    return null;
  }

  try {
    const calendar = await getCalendarClient();
    const channelId = `channel-${crypto.randomBytes(8).toString('hex')}`;
    const webhookUrl = `${publicUrl.replace(/\/$/, '')}/api/calendar/webhook`;

    // 7 days expiration max
    const expiration = Date.now() + 7 * 24 * 60 * 60 * 1000;

    const response = await calendar.events.watch({
      calendarId: 'primary',
      requestBody: {
        id: channelId,
        type: 'web_hook',
        address: webhookUrl,
        expiration: String(expiration)
      }
    });

    activeChannel = {
      channelId,
      resourceId: response.data.resourceId,
      expiration,
      webhookUrl
    };

    console.log(`[Calendar Webhook] Watch channel setup successful:
  - Channel ID: ${channelId}
  - Webhook URL: ${webhookUrl}
  - Expiration: ${new Date(expiration).toISOString()}`);

    return activeChannel;
  } catch (err) {
    console.error('[Calendar Webhook] Failed to setup watch channel:', err.message);
    return null;
  }
}

/**
 * Fetches upcoming events and schedules bots for eligible Google Meet meetings.
 */
export async function processUpcomingEvents() {
  if (!loadRefreshToken()) {
    return;
  }

  try {
    const calendar = await getCalendarClient();
    const now = new Date();
    const timeMin = now.toISOString();
    // Look ahead 15 minutes for auto-join scheduling, but sync a wider window
    // so the calendar page stays populated.
    const timeMax = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
    const syncMax = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000).toISOString();

    // 1. Sync events into scheduled_meetings for the custom calendar.
    try {
      const syncResponse = await calendar.events.list({
        calendarId: 'primary',
        timeMin,
        timeMax: syncMax,
        singleEvents: true,
        orderBy: 'startTime',
        showDeleted: true
      });
      const syncEvents = syncResponse.data.items || [];
      let synced = 0;
      const liveIds = [];
      for (const event of syncEvents) {
        const extracted = extractMeetingLink(event);
        if (extracted && !event.hangoutLink) {
          event.hangoutLink = extracted.url;
        }
        if (event.status !== 'cancelled') {
          liveIds.push(event.id);
        }
        const row = await upsertScheduledMeeting(event);
        if (row) synced += 1;
      }
      // Remove rows whose events are gone from Google entirely.
      const reconciled = await reconcileDeletedMeetings(liveIds, timeMin, syncMax);
      if (synced > 0 || reconciled > 0) {
        console.log(`[Calendar Webhook] Synced ${synced} upcoming events (reconciled ${reconciled} deleted) into scheduled_meetings.`);
      }
    } catch (syncErr) {
      console.error('[Calendar Webhook] Error syncing events into scheduled_meetings:', syncErr.message);
    }

    // 2. Auto-join scheduling (unchanged, next 15 minutes).
    if (!autoJoinStore.isEnabled()) {
      return;
    }

    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime'
    });

    const events = response.data.items || [];
    if (events.length > 0) {
      console.log(`[Calendar Webhook] Found ${events.length} upcoming calendar events in next 15 mins.`);
    }


    for (const event of events) {
      if (event.status === 'cancelled') continue;

      const eventId = event.id;
      if (autoJoinStore.hasJoined(eventId)) continue;

      const extracted = extractMeetingLink(event);
      if (!extracted) continue;

      const { platform: botType, url: meetingUrl } = extracted;

      const startDateTime = event.start?.dateTime || event.start?.date;
      if (!startDateTime) continue;

      const startTimeMs = new Date(startDateTime).getTime();
      const leadTimeMs = autoJoinStore.getLeadTimeMinutes() * 60 * 1000;
      const targetJoinTimeMs = startTimeMs - leadTimeMs;
      const delayMs = Math.max(0, targetJoinTimeMs - Date.now());

      if (autoJoinStore.hasScheduled(eventId)) continue;

      const meetingTitle = event.summary || `${botType} Meeting`;

      console.log(`[Calendar Webhook] Scheduling auto-join for ${botType}:
  - Event ID: ${eventId}
  - Title: "${meetingTitle}"
  - URL: ${meetingUrl}
  - Meeting Start: ${new Date(startTimeMs).toLocaleTimeString()}
  - Bot Join Time: ${new Date(targetJoinTimeMs).toLocaleTimeString()} (in ${(delayMs / 1000).toFixed(0)}s)`);

      const timerObj = setTimeout(() => {
        triggerBotJoin(eventId, meetingUrl, meetingTitle, botType);
      }, delayMs);

      autoJoinStore.scheduleTimer(eventId, timerObj);
    }
  } catch (err) {
    console.error('[Calendar Webhook] Error fetching upcoming events:', err.message);
  }
}

/**
 * Launches the bot process for the detected platform.
 */
async function triggerBotJoin(eventId, meetingUrl, meetingTitle, botType) {
  if (autoJoinStore.hasJoined(eventId)) return;

  // Mark as processed immediately to prevent duplicate triggers
  autoJoinStore.markJoined(eventId);

  const prefix = botType === 'zoom' ? 'zoom' : botType === 'teams' ? 'teams' : 'meet';
  const sessionId = `${prefix}_auto_${eventId.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}`;
  console.log(`[Calendar Auto-Join] Launching ${botType} bot for: "${meetingTitle}" (Session: ${sessionId})`);

  let projectId = autoJoinStore.getProjectId() || process.env.DEFAULT_PROJECT_ID || null;


  try {
    const wsPort = await getFreePort(8090);
    processManager.spawnBot(sessionId, {
      botType,
      meetingUrl,
      botName: process.env.AUTO_JOIN_BOT_NAME || 'Meeting Assistant Bot',
      isHeadless: true,
      wsPort,
      projectId,
      joinMethod: 'automatic'
    });

    // Backfill the scheduled_meetings row so the calendar event traces to the session.
    try {
      const { error: sessErr } = await supabase
        .from('scheduled_meetings')
        .update({ session_id: sessionId, status: 'joined', project_id: projectId })
        .eq('calendar_event_id', eventId);
      if (sessErr) {
        console.warn(`[Calendar Auto-Join] Failed to link scheduled meeting to session ${sessionId}:`, sessErr.message);
      }
    } catch (linkErr) {
      console.warn('[Calendar Auto-Join] Error linking scheduled meeting:', linkErr.message);
    }

    console.log(`[Calendar Auto-Join] Bot process launched successfully on port ${wsPort} for event: ${eventId} (Project: ${projectId})`);
  } catch (err) {
    console.error(`[Calendar Auto-Join] Failed to spawn bot for event ${eventId}:`, err.message);
  }
}



/**
 * Handles incoming push notification POST from Google Calendar.
 */
export async function handleWebhookNotification(req, res) {
  const resourceState = req.headers['x-goog-resource-state'];
  const channelId = req.headers['x-goog-channel-id'];

  console.log(`[Calendar Webhook Received] State: ${resourceState}, Channel: ${channelId}`);

  // Initial channel sync check from Google
  if (resourceState === 'sync') {
    return res.status(200).send('OK');
  }

  // Event added, changed, or starting
  if (resourceState === 'exists') {
    res.status(200).send('OK'); // Respond immediately to Google
    processUpcomingEvents().catch(err => {
      console.error('[Calendar Webhook] Error processing event alert:', err.message);
    });
    return;
  }

  return res.status(200).send('OK');
}

export function getActiveWatchChannel() {
  return activeChannel;
}
