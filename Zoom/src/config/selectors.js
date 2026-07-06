export const SELECTORS = {
  join: {
    nameInput: 'input#input-displayname, input[name="input-displayname"], input#inputname, input[placeholder="Your Name"]',
    passcodeInput: 'input#input-passcode, input[name="input-passcode"], input#inputpasscode, input[placeholder="Meeting Passcode"]',
    joinBtn: 'button.button-join, button[type="submit"], button:has-text("Join")',
  },
  audioDialog: {
    joinAudioBtn: 'button:has-text("Join Audio by Computer"), button:has-text("Computer Audio"), button:has-text("Join Audio"), .join-audio-by-computer',
    closeAudioModalBtn: 'button[aria-label="Close"], button.close',
  },
  inCall: {
    // Zoom uses footer buttons for controls
    participantsToggle: 'button[aria-label*="participant" i], button:has-text("Participants"), .footer-button__participants',
    participantList: '.participant-list, .participant-list-container, [role="list"][aria-label*="participant" i]',
    participantRow: '.participant-list-item, .participant-item, [role="listitem"]',
    participantName: '.participant-name, span[class*="name"], [class*="participant-name"]',
    // Active speaking indicators: look for active speaker container border, active indicator icon, or active microphone status
    activeSpeakerBorder: '[class*="active-speaker"], [class*="speaking"], [style*="border"], .active-main',
    speakingMicIcon: '[class*="speaking-mic"], [class*="active-mic"], [aria-label*="speaking" i], svg[class*="speaking"]',
    leaveBtn: 'button[aria-label*="leave" i], button:has-text("Leave"), .footer-button__leave',
  },
  preJoin: {
    joinBrowserLink: 'a:has-text("Join from your browser"), a[href*="wc/join"]',
  }
};

export const TIMEOUTS = {
  navigation: 30000,
  join: 60000,
  element: 10000,
  speakerDebounce: 150,
};

export const AUDIO_CONFIG = {
  sampleRate: 16000,
  chunkSizeMs: 500,
  channels: 1,
};
