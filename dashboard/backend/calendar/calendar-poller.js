import { processUpcomingEvents, setupWatchChannel, getActiveWatchChannel } from './calendar-webhook.js';
import { loadRefreshToken } from './calendar-service.js';

let renewalInterval = null;

/**
 * Sets up the watch channel and runs an initial scan on boot.
 * Does NOT poll — relies entirely on push notifications from Google.
 * Runs a once-per-hour check only to renew the watch channel before it expires.
 */
export function startCalendarPoller() {
  if (renewalInterval) return;

  console.log('[Calendar Poller] Setting up Google Calendar watch channel...');

  // Setup initial push watch channel if possible
  setupWatchChannel().catch(err => {
    console.warn('[Calendar Poller] Watch channel setup warning:', err.message);
  });

  // Initial scan on boot to catch events starting right now or already in progress
  if (loadRefreshToken()) {
    processUpcomingEvents().catch(err => {
      console.error('[Calendar Poller] Initial scan error:', err.message);
    });
  }

  // Hourly check just to renew the watch channel before it expires (7 day max)
  // No event polling — relies on Google push notifications for real-time updates
  renewalInterval = setInterval(() => {
    const channel = getActiveWatchChannel();
    if (channel && channel.expiration - Date.now() < 24 * 60 * 60 * 1000) {
      console.log('[Calendar Poller] Watch channel near expiration. Renewing...');
      setupWatchChannel().catch(err => {
        console.error('[Calendar Poller] Failed to renew watch channel:', err.message);
      });
    }
  }, 60 * 60 * 1000); // once per hour
}

export function stopCalendarPoller() {
  if (renewalInterval) {
    clearInterval(renewalInterval);
    renewalInterval = null;
    console.log('[Calendar Poller] Stopped watch channel renewal.');
  }
}
