import fs from 'fs';
import path from 'path';

const STORE_PATH = path.join(process.cwd(), 'auto_join_settings.json');

class AutoJoinStore {
  constructor() {
    this.enabled = true;
    this.leadTimeMinutes = 2;
    this.projectId = null;
    this.joinedEventIds = new Set();
    this.scheduledTimers = new Map(); // eventId -> Timeout object
    this.loadState();
  }

  loadState() {
    if (fs.existsSync(STORE_PATH)) {
      try {
        const raw = fs.readFileSync(STORE_PATH, 'utf8');
        const data = JSON.parse(raw);
        this.enabled = data.enabled !== undefined ? Boolean(data.enabled) : true;
        this.leadTimeMinutes = data.leadTimeMinutes || 2;
        this.projectId = data.projectId || null;
        if (Array.isArray(data.joinedEventIds)) {
          this.joinedEventIds = new Set(data.joinedEventIds);
        }
      } catch (err) {
        console.error('[AutoJoin Store] Failed to load store file:', err.message);
      }
    }
  }

  saveState() {
    try {
      const payload = {
        enabled: this.enabled,
        leadTimeMinutes: this.leadTimeMinutes,
        projectId: this.projectId,
        joinedEventIds: Array.from(this.joinedEventIds)
      };
      fs.writeFileSync(STORE_PATH, JSON.stringify(payload, null, 2), 'utf8');
    } catch (err) {
      console.error('[AutoJoin Store] Failed to save store file:', err.message);
    }
  }

  getProjectId() {
    return this.projectId;
  }

  setProjectId(id) {
    if (id) {
      this.projectId = id;
      this.saveState();
    }
  }

  isEnabled() {
    return this.enabled;
  }


  setEnabled(val) {
    this.enabled = Boolean(val);
    this.saveState();
  }

  getLeadTimeMinutes() {
    return this.leadTimeMinutes;
  }

  setLeadTimeMinutes(minutes) {
    this.leadTimeMinutes = Math.max(1, Math.min(15, parseInt(minutes, 10) || 2));
    this.saveState();
  }

  hasJoined(eventId) {
    return this.joinedEventIds.has(eventId);
  }

  markJoined(eventId) {
    this.joinedEventIds.add(eventId);
    this.saveState();
  }

  scheduleTimer(eventId, timeoutObj) {
    if (this.scheduledTimers.has(eventId)) {
      clearTimeout(this.scheduledTimers.get(eventId));
    }
    this.scheduledTimers.set(eventId, timeoutObj);
  }

  hasScheduled(eventId) {
    return this.scheduledTimers.has(eventId);
  }
}

export const autoJoinStore = new AutoJoinStore();
