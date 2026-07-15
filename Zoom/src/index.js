import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BotLifecycle } from './lifecycle/bot-lifecycle.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to load env variables from .env file without external dependencies
function loadEnv() {
  const envPath = path.resolve(__dirname, '../.env');
  if (fs.existsSync(envPath)) {
    console.log('[Orchestrator] Loading environment variables from .env...');
    const content = fs.readFileSync(envPath, 'utf8');
    content.split(/\r?\n/).forEach(line => {
      // Ignore comments and empty lines
      if (line.trim().startsWith('#') || !line.trim()) return;
      const index = line.indexOf('=');
      if (index > 0) {
        const key = line.substring(0, index).trim();
        let val = line.substring(index + 1).trim();
        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
        if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
        process.env[key] = val;
      }
    });
  }
}

function parseArgs() {
  loadEnv();

  const config = {
    meetingUrl: process.env.MEETING_URL,
    botName: process.env.BOT_NAME || 'Zoom Meeting Bot',
    passcode: process.env.MEETING_PASSCODE || null,
    outputType: process.env.OUTPUT_TYPE || 'file', // default to file output
    outputPort: parseInt(process.env.OUTPUT_PORT || '8080'),
    headless: process.env.HEADLESS !== 'false',
    channel: process.env.BROWSER_CHANNEL || null,
    userDataDir: process.env.USER_DATA_DIR || null,
    // Audio processing options
    enableAudioProcessing: process.env.ENABLE_AUDIO_PROCESSING !== 'false',
    enableVAD: process.env.ENABLE_VAD !== 'false',
    enableNoiseReduction: process.env.ENABLE_NOISE_REDUCTION !== 'false',
    enableNormalization: process.env.ENABLE_NORMALIZATION !== 'false',
    enableAntiAliasing: process.env.ENABLE_ANTI_ALIASING !== 'false',
    enableAudioDiarization: process.env.ENABLE_AUDIO_DIARIZATION !== 'false'
  };

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--url':
      case '-u':
        config.meetingUrl = args[++i];
        break;
      case '--name':
      case '-n':
        config.botName = args[++i];
        break;
      case '--passcode':
      case '-s':
        config.passcode = args[++i];
        break;
      case '--output':
      case '-o':
        config.outputType = args[++i];
        break;
      case '--port':
      case '-p':
        config.outputPort = parseInt(args[++i]);
        break;
      case '--headful':
        config.headless = false;
        break;
      case '--channel':
      case '-c':
        config.channel = args[++i];
        break;
      case '--user-data-dir':
        config.userDataDir = args[++i];
        break;
      case '--disable-audio-processing':
        config.enableAudioProcessing = false;
        break;
      case '--disable-vad':
        config.enableVAD = false;
        break;
      case '--disable-noise-reduction':
        config.enableNoiseReduction = false;
        break;
      case '--disable-normalization':
        config.enableNormalization = false;
        break;
      case '--disable-anti-aliasing':
        config.enableAntiAliasing = false;
        break;
      case '--disable-audio-diarization':
        config.enableAudioDiarization = false;
        break;
    }
  }

  return config;
}

async function main() {
  const config = parseArgs();

  if (!config.meetingUrl) {
    console.error('Usage: node src/index.js --url <meeting-url> [--name <bot-name>] [--passcode <pwd>] [--output <file|websocket>] [--port <port>] [--headful] [--channel <chrome>] [--user-data-dir <path>]');
    console.error('Or configure MEETING_URL in the Zoom/.env file.');
    process.exit(1);
  }

  const meetingIdMatch = config.meetingUrl.match(/\/j\/(\d+)/) || config.meetingUrl.match(/\/wc\/join\/(\d+)/) || config.meetingUrl.match(/\/wc\/(\d+)\/join/);
  const meetingId = meetingIdMatch ? meetingIdMatch[1] : 'unknown_meeting';

  const lifecycle = new BotLifecycle({
    meetingUrl: config.meetingUrl,
    botName: config.botName,
    passcode: config.passcode,
    outputType: config.outputType,
    outputConfig: {
      port: config.outputPort,
      meetingId: meetingId,
    },
    headless: config.headless,
    channel: config.channel,
    userDataDir: config.userDataDir,
    // Audio processing configuration
    enableAudioProcessing: config.enableAudioProcessing,
    enableVAD: config.enableVAD,
    enableNoiseReduction: config.enableNoiseReduction,
    enableNormalization: config.enableNormalization,
    enableAntiAliasing: config.enableAntiAliasing,
    enableAudioDiarization: config.enableAudioDiarization
  });

  lifecycle.onStateChange((state) => console.log(`[Lifecycle State Change] => ${state}`));

  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) {
      console.log('[Orchestrator] Shutdown already in progress, ignoring duplicate signal...');
      return;
    }
    isShuttingDown = true;
    console.log('\n[Orchestrator] SIGINT/SIGTERM received. Starting graceful cleanup...');
    try {
      await lifecycle.stop();
      console.log('[Orchestrator] Shutdown complete. Exiting.');
      process.exit(0);
    } catch (e) {
      console.error('[Orchestrator] Error during cleanup:', e.message);
      process.exit(1);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    console.log('[Orchestrator] Starting Bot Lifecycle...');
    await lifecycle.start();
    console.log('[Orchestrator] Bot joined call and capturing audio successfully.');
    console.log('Press Ctrl+C to stop the bot and flush outputs.');
  } catch (err) {
    console.error('[Orchestrator] Failed to run bot:', err.message);
    try {
      await lifecycle.stop();
    } catch {}
    process.exit(1);
  }
}

main();
