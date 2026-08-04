export function generateAnnouncementMessage(options = {}) {
  const inviterName = options.inviterName || process.env.INVITER_NAME || 'Ishita Bhojani';
  const botName = options.botName || process.env.BOT_NAME || 'Meeting Bot';
  const privacyUrl = options.privacyUrl || process.env.PRIVACY_URL || 'http://localhost:3000/privacy';
  const liveNotesUrl = options.liveNotesUrl || process.env.LIVE_NOTES_URL || 'http://localhost:3000/projects/meeting';
  const cmdPrefix = options.cmdPrefix || process.env.CMD_PREFIX || 'bot';

  return `${inviterName} invited ${botName} here to record & take notes. By continuing, you agree to ${privacyUrl}.

Type:
'/${cmdPrefix} pause' - pause recording
'/${cmdPrefix} resume' - resume recording
'/${cmdPrefix} leave' - stop recording & leave meeting

View Realtime notes here: ${liveNotesUrl}`;
}

export function parseChatCommand(text, options = {}) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  const cmdPrefix = (options.cmdPrefix || process.env.CMD_PREFIX || 'bot').toLowerCase();
  
  // Match /bot pause, /ff pause, /bot resume, /ff resume, /bot leave, /ff leave, /bot stop, /ff stop
  const pattern = new RegExp(`^\\/(${cmdPrefix}|ff|bot)\\s+(pause|resume|leave|stop)\\b`, 'i');
  const match = trimmed.match(pattern);
  if (match) {
    const action = match[2].toLowerCase();
    return action === 'stop' ? 'leave' : action;
  }
  return null;
}
