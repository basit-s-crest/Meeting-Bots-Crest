import { processUpcomingEvents, setupWatchChannel, getActiveWatchChannel } from './calendar-webhook.js';
import { loadRefreshToken } from './calendar-service.js';

let pollerInterval = null;

/**
 * Starts the background calendar poller / watchdog.
 * Runs processUpcomingEvents every 60 seconds as a fallback.
 */
export function startCalendarPoller() {
  if (pollerInterval) return;

  console.log('[Calendar Poller] Starting Google Calendar background poller...');

  // Setup initial push watch channel if possible
  setupWatchChannel().catch(err => {
    console.warn('[Calendar Poller] Watch channel setup warning:', err.message);
  });

  // Initial check on boot
  if (loadRefreshToken()) {
    processUpcomingEvents().catch(err => {
      console.error('[Calendar Poller] Initial scan error:', err.message);
    });
  }

  // Poll every 60 seconds
  pollerInterval = setInterval(() => {
    if (loadRefreshToken()) {
      processUpcomingEvents().catch(err => {
        console.error('[Calendar Poller] Interval scan error:', err.message);
      });

      // Renew watch channel if near expiration (under 1 day remaining)
      const channel = getActiveWatchChannel();
      if (channel && channel.expiration - Date.now() < 24 * 60 * 60 * 1000) {
        console.log('[Calendar Poller] Watch channel near expiration. Renewing...');
        setupWatchChannel().catch(err => {
          console.error('[Calendar Poller] Failed to renew watch channel:', err.message);
        });
      }
    }
  }, 60000);
}

export function stopCalendarPoller() {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    console.log('[Calendar Poller] Stopped Google Calendar background poller.');
  }
}
