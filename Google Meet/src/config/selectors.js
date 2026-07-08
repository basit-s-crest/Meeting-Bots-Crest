export const SELECTORS = {
  join: {
    guestNameInput: 'input[placeholder="Your name"]',
    askToJoinBtn: 'button:has-text("Ask to join")',
    joinNowBtn: 'button:has-text("Join now")',
    continueBtn: 'button:has-text("Continue")',
    gotItBtn: 'button:has-text("Got it")',
    micToggle: 'button[aria-label*="microphone" i], button[aria-label*="mic" i]',
    camToggle: 'button[aria-label*="camera" i], button[aria-label*="video" i]',
    dismissBtn: 'button:has-text("Dismiss")',
  },
  inCall: {
    participantGrid: '[role="list"][aria-label*="participant" i], [data-participant-list]',
    participantTile: '[role="listitem"], [data-participant-id]',
    speakingIndicator: '[aria-label*="speaking" i], [data-speaking="true"], .speaking',
    participantName: '[data-participant-name], .participant-name, [aria-label*="name" i]',
    leaveBtn: 'button[aria-label*="leave" i], button:has-text("Leave call")',
  },
  preJoin: {
    previewVideo: 'video[autoplay][muted]',
    joinScreen: '[data-prejoin-screen], .prejoin-screen',
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