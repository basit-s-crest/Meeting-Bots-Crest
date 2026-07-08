// Core dashboard state
let activeSessionId = null;
let activeBotType = null;
let socket = null;
let visualizerTimeout = null;

// UI elements
const launchForm = document.getElementById('launchForm');
const botTypeSelect = document.getElementById('botType');
const meetingUrlInput = document.getElementById('meetingUrl');
const botNameInput = document.getElementById('botName');
const headlessCheckbox = document.getElementById('headless');
const submitBtn = document.getElementById('submitBtn');

const globalStatusDot = document.getElementById('globalStatusDot');
const globalStatusText = document.getElementById('globalStatusText');
const speakerAvatar = document.getElementById('speakerAvatar');
const speakerName = document.getElementById('speakerName');
const speakerStatus = document.getElementById('speakerStatus');
const visBars = document.querySelectorAll('.vis-bar');
const sessionActions = document.getElementById('sessionActions');
const stopBtn = document.getElementById('stopBtn');

const activeBotTypeBadge = document.getElementById('activeBotType');
const activeSessionIdDisplay = document.getElementById('activeSessionId');
const emptyTranscript = document.getElementById('emptyTranscript');
const liveTranscript = document.getElementById('liveTranscript');
const transcriptScrollContainer = document.getElementById('transcriptScrollContainer');

const historyList = document.getElementById('historyList');
const emptyHistory = document.getElementById('emptyHistory');

// Modal elements
const historyModal = document.getElementById('historyModal');
const modalTitle = document.getElementById('modalTitle');
const modalBody = document.getElementById('modalBody');
const modalCloseBtn = document.getElementById('modalCloseBtn');
const modalDownloadBtn = document.getElementById('modalDownloadBtn');

let currentViewedLines = [];

// Initialize Dashboard
document.addEventListener('DOMContentLoaded', () => {
  loadActiveSessions();
  loadTranscriptsHistory();
  
  // Bind events
  launchForm.addEventListener('submit', handleLaunch);
  stopBtn.addEventListener('click', handleStop);
  modalCloseBtn.addEventListener('click', () => historyModal.classList.add('hidden'));
  modalDownloadBtn.addEventListener('click', downloadCurrentTranscript);
  
  // Close modal on background click
  window.addEventListener('click', (e) => {
    if (e.target === historyModal) {
      historyModal.classList.add('hidden');
    }
  });
});

/**
 * Handle launching a bot process
 */
async function handleLaunch(e) {
  e.preventDefault();
  
  const payload = {
    botType: botTypeSelect.value,
    meetingUrl: meetingUrlInput.value.trim(),
    botName: botNameInput.value.trim(),
    isHeadless: headlessCheckbox.checked
  };

  setFormDisabled(true);
  updateStatus('starting', `Launching ${payload.botType} bot...`);
  
  try {
    const res = await fetch('/api/sessions/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || 'Failed to start bot');
    }

    activeSessionId = data.sessionId;
    activeBotType = data.botType;

    // Initialize state
    setupActiveSessionUI();
    connectWebSocket(activeSessionId);
    
  } catch (err) {
    updateStatus('error', err.message);
    alert(`Error: ${err.message}`);
    setFormDisabled(false);
  }
}

/**
 * Connect WebSocket to monitor live transcript updates
 */
function connectWebSocket(sessionId) {
  if (socket) {
    socket.close();
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/transcripts?sessionId=${sessionId}`;
  
  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    console.log('[WebSocket] Connection established to backend server.');
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'status') {
        handleStatusUpdate(msg.data.status);
      } else if (msg.type === 'transcript') {
        handleIncomingTranscript(msg.data);
      } else if (msg.type === 'visualizer') {
        handleVisualizerPulse(msg.data);
      }
    } catch (e) {
      console.error('[WebSocket] Parsing error:', e);
    }
  };

  socket.onclose = () => {
    console.log('[WebSocket] Connection closed.');
    if (activeSessionId === sessionId) {
      // Unexpected disconnect from backend
      handleStatusUpdate('stopped');
    }
  };

  socket.onerror = (err) => {
    console.error('[WebSocket] Error:', err);
  };
}

/**
 * Handle stop action
 */
async function handleStop() {
  if (!activeSessionId) return;

  stopBtn.disabled = true;
  updateStatus('stopping', 'Stopping bot session...');

  try {
    const res = await fetch('/api/sessions/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: activeSessionId })
    });

    if (!res.ok) {
      throw new Error('Failed to terminate process');
    }

    // Clean up
    if (socket) {
      socket.close();
      socket = null;
    }
    
    handleStatusUpdate('stopped');
  } catch (err) {
    alert(`Error stopping bot: ${err.message}`);
    stopBtn.disabled = false;
  }
}

/**
 * Update UI for status changes
 */
function handleStatusUpdate(status) {
  console.log(`[Status] ${status}`);
  updateStatus(status);

  if (status === 'stopped') {
    activeSessionId = null;
    activeBotType = null;
    setFormDisabled(false);
    sessionActions.classList.add('hidden');
    activeBotTypeBadge.classList.add('hidden');
    activeSessionIdDisplay.classList.add('hidden');
    resetSpeakerDisplay();
    loadTranscriptsHistory(); // Refresh history log list
  } else {
    sessionActions.classList.remove('hidden');
    stopBtn.disabled = false;
  }
}

/**
 * Handle incoming transcript message and draw/render interim vs final text
 */
let lastSpeaker = null;
let currentInterimElement = null;

function handleIncomingTranscript({ speaker, text, timestamp, isFinal }) {
  if (emptyTranscript) {
    emptyTranscript.style.display = 'none';
  }

  // Remove old interim texts if this is a final chunk
  if (isFinal) {
    if (currentInterimElement) {
      currentInterimElement.remove();
      currentInterimElement = null;
    }

    // Clean up same speaker grouping or create a fresh row
    const row = document.createElement('div');
    row.className = 'transcript-row';

    const meta = document.createElement('div');
    meta.className = 'transcript-meta';

    const badge = document.createElement('span');
    badge.className = 'speaker-badge';
    badge.textContent = speaker;
    badge.style.backgroundColor = getSpeakerColor(speaker);
    badge.style.borderColor = getSpeakerBorderColor(speaker);

    const time = document.createElement('span');
    time.className = 'timestamp';
    time.textContent = new Date(timestamp).toLocaleTimeString();

    meta.appendChild(badge);
    meta.appendChild(time);

    const textEl = document.createElement('div');
    textEl.className = 'transcript-text';
    textEl.textContent = text;

    row.appendChild(meta);
    row.appendChild(textEl);
    liveTranscript.appendChild(row);
    
    // Auto scroll to bottom
    transcriptScrollContainer.scrollTop = transcriptScrollContainer.scrollHeight;
    
    // Pulse speaker card
    triggerSpeakerSpeech(speaker, true);
    lastSpeaker = speaker;
  } else {
    // Interim transcript update
    if (!currentInterimElement) {
      currentInterimElement = document.createElement('div');
      currentInterimElement.className = 'transcript-row interim-row';
      
      const meta = document.createElement('div');
      meta.className = 'transcript-meta';
      
      const badge = document.createElement('span');
      badge.className = 'speaker-badge';
      badge.textContent = speaker;
      badge.style.backgroundColor = getSpeakerColor(speaker);
      badge.style.borderColor = getSpeakerBorderColor(speaker);
      
      meta.appendChild(badge);
      currentInterimElement.appendChild(meta);
      
      const textEl = document.createElement('div');
      textEl.className = 'transcript-text interim';
      currentInterimElement.appendChild(textEl);
      
      liveTranscript.appendChild(currentInterimElement);
    }
    
    // Update the interim text content
    const textEl = currentInterimElement.querySelector('.transcript-text.interim');
    if (textEl) {
      textEl.textContent = text + '...';
    }
    
    // Auto scroll to bottom
    transcriptScrollContainer.scrollTop = transcriptScrollContainer.scrollHeight;
    triggerSpeakerSpeech(speaker, false);
  }
}

/**
 * Handle audio visualizer update from backend
 */
function handleVisualizerPulse({ rms, speaker }) {
  if (rms > 50) { // Speech detected threshold
    triggerSpeakerSpeech(speaker, true);
    
    // Scale visualizer bar heights dynamically
    const maxRms = 1000;
    const ratio = Math.min(rms / maxRms, 1);
    
    visBars.forEach((bar, idx) => {
      // Add slight variety to visualizer bars
      const variance = 0.5 + Math.sin(idx + Date.now() / 100) * 0.5;
      const height = Math.max(4, Math.round(ratio * 35 * variance));
      bar.style.height = `${height}px`;
      bar.style.backgroundColor = 'var(--accent-success)';
    });

    if (visualizerTimeout) {
      clearTimeout(visualizerTimeout);
    }
    visualizerTimeout = setTimeout(resetVisualizerBars, 300);
  }
}

function resetVisualizerBars() {
  visBars.forEach(bar => {
    bar.style.height = '4px';
    bar.style.backgroundColor = 'rgba(255, 255, 255, 0.08)';
  });
}

function triggerSpeakerSpeech(speaker, isSpeaking) {
  if (speaker && speaker !== 'Silence/Noise') {
    speakerAvatar.textContent = speaker[0].toUpperCase();
    speakerAvatar.className = 'speaker-avatar speaking';
    speakerAvatar.style.boxShadow = `0 0 25px ${getSpeakerBorderColor(speaker)}`;
    speakerAvatar.style.background = `linear-gradient(135deg, ${getSpeakerBorderColor(speaker)}, rgba(0,0,0,0.6))`;
    speakerName.textContent = speaker;
    speakerStatus.textContent = 'Speaking...';
  } else {
    resetSpeakerDisplay();
  }
}

function resetSpeakerDisplay() {
  speakerAvatar.textContent = '?';
  speakerAvatar.className = 'speaker-avatar';
  speakerAvatar.style.boxShadow = '';
  speakerAvatar.style.background = '';
  speakerName.textContent = 'No Active Speaker';
  speakerStatus.textContent = 'Idle';
}

/**
 * Hash speaker name to color palettes
 */
function getSpeakerColor(speaker) {
  if (!speaker || speaker === 'Silence/Noise') return 'rgba(156, 163, 175, 0.1)';
  let hash = 0;
  for (let i = 0; i < speaker.length; i++) {
    hash = speaker.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash % 360);
  return `hsla(${hue}, 65%, 45%, 0.2)`;
}

function getSpeakerBorderColor(speaker) {
  if (!speaker || speaker === 'Silence/Noise') return 'rgba(156, 163, 175, 0.2)';
  let hash = 0;
  for (let i = 0; i < speaker.length; i++) {
    hash = speaker.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash % 360);
  return `hsla(${hue}, 70%, 60%, 0.5)`;
}

/**
 * Fetch and load active running sessions on page load
 */
async function loadActiveSessions() {
  try {
    const res = await fetch('/api/sessions');
    const data = await res.json();
    if (data.sessions && data.sessions.length > 0) {
      // Hook up to first active session
      const active = data.sessions[0];
      activeSessionId = active.sessionId;
      activeBotType = active.type;
      
      setupActiveSessionUI();
      handleStatusUpdate(active.status);
      connectWebSocket(activeSessionId);
    }
  } catch (err) {
    console.error('Failed to load active sessions:', err);
  }
}

/**
 * Populate list of past saved transcripts
 */
async function loadTranscriptsHistory() {
  try {
    const res = await fetch('/api/transcripts');
    const data = await res.json();
    
    if (data.transcripts && data.transcripts.length > 0) {
      emptyHistory.style.display = 'none';
      historyList.innerHTML = '';
      
      data.transcripts.forEach(item => {
        const fileRow = document.createElement('div');
        fileRow.className = 'history-item';
        
        const details = document.createElement('div');
        details.className = 'history-details';
        
        const title = document.createElement('span');
        title.className = 'history-title';
        title.textContent = item.fileName;
        
        const date = document.createElement('span');
        date.className = 'history-date';
        date.textContent = `${new Date(item.created).toLocaleString()} | ${(item.size / 1024).toFixed(1)} KB`;
        
        details.appendChild(title);
        details.appendChild(date);
        
        const actions = document.createElement('div');
        actions.className = 'history-actions';
        
        const viewBtn = document.createElement('button');
        viewBtn.className = 'btn btn-secondary btn-sm';
        viewBtn.textContent = 'View';
        viewBtn.onclick = () => viewTranscriptFile(item.fileName);
        
        actions.appendChild(viewBtn);
        fileRow.appendChild(details);
        fileRow.appendChild(actions);
        historyList.appendChild(fileRow);
      });
    } else {
      emptyHistory.style.display = 'flex';
      historyList.innerHTML = '';
    }
  } catch (err) {
    console.error('Failed to load transcripts history:', err);
  }
}

/**
 * Modal viewer for historical log files
 */
async function viewTranscriptFile(fileName) {
  try {
    const res = await fetch(`/api/transcripts/${fileName}`);
    const data = await res.json();
    
    if (!res.ok || data.error) {
      throw new Error(data.error || 'Failed to read file');
    }
    
    currentViewedLines = data.lines;
    modalTitle.textContent = fileName;
    modalBody.innerHTML = '';
    
    if (data.lines.length === 0) {
      modalBody.innerHTML = '<div class="empty-state"><p>Empty log file.</p></div>';
    } else {
      const list = document.createElement('div');
      list.className = 'transcript-log';
      
      data.lines.forEach(line => {
        const row = document.createElement('div');
        row.className = 'transcript-row';
        
        const meta = document.createElement('div');
        meta.className = 'transcript-meta';
        
        const badge = document.createElement('span');
        badge.className = 'speaker-badge';
        badge.textContent = line.speaker;
        badge.style.backgroundColor = getSpeakerColor(line.speaker);
        badge.style.borderColor = getSpeakerBorderColor(line.speaker);
        
        const time = document.createElement('span');
        time.className = 'timestamp';
        time.textContent = new Date(line.timestamp).toLocaleTimeString();
        
        meta.appendChild(badge);
        meta.appendChild(time);
        
        const text = document.createElement('div');
        text.className = 'transcript-text';
        text.textContent = line.text;
        
        row.appendChild(meta);
        row.appendChild(text);
        list.appendChild(row);
      });
      
      modalBody.appendChild(list);
    }
    
    historyModal.classList.remove('hidden');
  } catch (err) {
    alert(`Failed to load log file: ${err.message}`);
  }
}

/**
 * Trigger text file download for modal transcripts
 */
function downloadCurrentTranscript() {
  if (currentViewedLines.length === 0) return;
  
  const textContent = currentViewedLines
    .map(line => `[${new Date(line.timestamp).toLocaleTimeString()}] [${line.speaker}]: ${line.text}`)
    .join('\n');
    
  const blob = new Blob([textContent], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = modalTitle.textContent.replace('.jsonl', '.txt');
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Helpers
function setFormDisabled(disabled) {
  botTypeSelect.disabled = disabled;
  meetingUrlInput.disabled = disabled;
  botNameInput.disabled = disabled;
  headlessCheckbox.disabled = disabled;
  submitBtn.disabled = disabled;
}

function updateStatus(status, customText = '') {
  globalStatusDot.className = 'status-dot';
  
  if (status === 'idle' || status === 'stopped') {
    globalStatusDot.classList.add('idle');
    globalStatusText.textContent = 'Dashboard Ready';
  } else if (status === 'starting' || status === 'joining' || status === 'in_lobby') {
    globalStatusDot.classList.add('connecting');
    globalStatusDot.style.backgroundColor = '#f59e0b';
    globalStatusDot.style.boxShadow = '0 0 10px #f59e0b';
    globalStatusText.textContent = customText || 'Connecting...';
  } else if (status === 'in_call' || status === 'capturing') {
    globalStatusDot.classList.add('active');
    globalStatusText.textContent = customText || 'Capturing Call Live';
  } else if (status === 'error') {
    globalStatusDot.classList.add('error');
    globalStatusText.textContent = customText || 'Error';
  }
}

function setupActiveSessionUI() {
  activeBotTypeBadge.textContent = activeBotType.replace('-', ' ');
  activeBotTypeBadge.classList.remove('hidden');
  
  activeSessionIdDisplay.textContent = `Session ID: ${activeSessionId}`;
  activeSessionIdDisplay.classList.remove('hidden');
  
  emptyTranscript.style.display = 'none';
  liveTranscript.innerHTML = '';
}
