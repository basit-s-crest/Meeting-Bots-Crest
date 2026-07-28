import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { supabase } from '../supabase-client.js';
import { processManager } from '../process-manager.js';
import { listUpcomingEvents, extractMeetingDetails } from './calendar-service.js';
import { getFreePort } from '../server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getCandidateConfigPaths() {
  return [
    path.resolve(__dirname, '../auto_join_config.json'),
    path.resolve(process.cwd(), 'dashboard/backend/auto_join_config.json'),
    path.resolve(process.cwd(), 'auto_join_config.json')
  ];
}

class AutoJoinScheduler {
  constructor() {
    this.intervalId = null;
    this.isActive = false;
    this.targetProjectId = null;
    this.scheduledEvents = new Set(); // in-memory eventId tracking for current session
    
    // Load persisted state
    this.loadPersistedState();
  }

  /**
   * Loads auto-join toggle state from local config file.
   */
  loadPersistedState() {
    try {
      for (const configPath of getCandidateConfigPaths()) {
        if (fs.existsSync(configPath)) {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          if (config.projectId) {
            this.targetProjectId = config.projectId;
          }
          if (config.enabled) {
            setTimeout(() => this.start(config.projectId), 2000);
            return;
          }
        }
      }
    } catch (err) {
      console.warn('[AutoJoinScheduler] Failed to load auto-join config:', err.message);
    }
  }

  /**
   * Persists auto-join toggle state to local config file.
   */
  persistState(enabled, projectId) {
    try {
      const targetPath = getCandidateConfigPaths()[0];
      fs.writeFileSync(targetPath, JSON.stringify({ enabled, projectId: projectId || this.targetProjectId }), 'utf8');
    } catch (err) {
      console.error('[AutoJoinScheduler] Failed to save auto-join config:', err.message);
    }
  }

  /**
   * Start the scheduler background loop (polling Google Calendar every 30 seconds).
   */
  start(projectId) {
    if (projectId) this.targetProjectId = projectId;
    this.persistState(true, projectId);
    if (!this.isActive) {
      this.isActive = true;
      console.log('[AutoJoinScheduler] Starting background Google Calendar polling...');
      this.intervalId = setInterval(() => this.poll(), 30 * 1000);
    }
    this.poll();
  }

  /**
   * Stop the scheduler background loop.
   */
  stop() {
    this.isActive = false;
    this.persistState(false);
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.log('[AutoJoinScheduler] Stopped background Google Calendar polling.');
  }

  /**
   * Poll Google Calendar for events starting within 15 minutes or currently ongoing.
   */
  async poll() {
    if (!this.isActive) return;

    try {
      const now = new Date();
      // Look for events from past 30 minutes to next 24 hours
      const timeMin = new Date(now.getTime() - 30 * 60 * 1000);
      const timeMax = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      const events = await listUpcomingEvents(timeMin, timeMax);
      if (events.length === 0) return;

      const projectId = await this.getOrCreateDefaultProject();

      for (const event of events) {
        const eventId = event.id;

        // Skip if already scheduled or joined in this server run
        if (this.scheduledEvents.has(eventId)) continue;

        // Extract meeting info
        const meeting = extractMeetingDetails(event);
        if (!meeting || !meeting.url) continue;

        const eventStart = event.start.dateTime ? new Date(event.start.dateTime) : new Date(event.start.date);
        const eventEnd = event.end?.dateTime ? new Date(event.end.dateTime) : new Date(eventStart.getTime() + 60 * 60 * 1000);

        // Skip if meeting already ended
        if (eventEnd < now) continue;

        // If meeting starts more than 15 minutes in the future, wait for future poll
        if (eventStart.getTime() - now.getTime() > 15 * 60 * 1000) continue;

        // Safe Session ID creation
        const safeId = eventId.replace(/[^a-zA-Z0-9]/g, '').substring(0, 20);
        const sessionId = `cal_${safeId}`;

        // DB Check: Skip if the database already has a session with this sessionId
        const { data: dbSession } = await supabase
          .from('meeting_sessions')
          .select('session_id')
          .eq('session_id', sessionId)
          .maybeSingle();

        if (dbSession) {
          this.scheduledEvents.add(eventId); // Mark as processed
          continue;
        }

        // Mark as scheduled in memory
        this.scheduledEvents.add(eventId);

        const delay = Math.max(0, eventStart.getTime() - Date.now());
        console.log(`[AutoJoinScheduler] Triggering auto-join for "${event.summary}" (${meeting.type}) at ${meeting.url} (delay: ${delay}ms)`);

        setTimeout(async () => {
          try {
            // Verify session isn't running
            if (processManager.activeSessions.has(sessionId)) {
              console.log(`[AutoJoinScheduler] Session ${sessionId} is already active, skipping spawn.`);
              return;
            }

            const wsPort = await getFreePort(8090);
            console.log(`[AutoJoinScheduler] Spawning bot for meeting: "${event.summary}" (${meeting.type})`);

            // Spawn bot!
            await processManager.spawnBot(sessionId, {
              botType: meeting.type,
              meetingUrl: meeting.url,
              botName: 'Meeting Assistant Bot',
              isHeadless: true,
              wsPort,
              projectId
            });
          } catch (spawnErr) {
            console.error(`[AutoJoinScheduler] Failed to spawn bot for "${event.summary}":`, spawnErr.message);
          }
        }, delay);
      }
    } catch (err) {
      if (err.message.includes('No refresh token') || err.message.includes('auth')) {
        console.warn('[AutoJoinScheduler] Google Calendar authentication pending. Will retry on next poll.');
      } else {
        console.error('[AutoJoinScheduler] Error during calendar polling:', err.message);
      }
    }
  }

  /**
   * Retrieves or creates a default project to hold the auto-joined meetings.
   */
  async getOrCreateDefaultProject() {
    if (this.targetProjectId) {
      return this.targetProjectId;
    }

    try {
      const { data: existingProj } = await supabase
        .from('projects')
        .select('id')
        .eq('name', 'Google Calendar Autojoin')
        .maybeSingle();

      if (existingProj) {
        return existingProj.id;
      }

      const { data: newProj, error } = await supabase
        .from('projects')
        .insert({ 
          name: 'Google Calendar Autojoin', 
          description: 'Automatically joined calendar meetings' 
        })
        .select('id')
        .single();

      if (error) throw error;
      return newProj.id;
    } catch (err) {
      console.error('[AutoJoinScheduler] Failed to get/create default project:', err.message);
      const { data: fallback } = await supabase.from('projects').select('id').limit(1);
      if (fallback && fallback[0]) return fallback[0].id;
      throw new Error('No projects found in database to link auto-joined session.');
    }
  }
}

export const autoJoinScheduler = new AutoJoinScheduler();
