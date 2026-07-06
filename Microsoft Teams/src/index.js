import readline from 'readline';
import { TeamsBot } from './join/teams-bot.js';
import { BotLifecycle } from './lifecycle/bot-lifecycle.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    meetingUrl: process.env.MEETING_URL || '',
    botName: process.env.BOT_NAME || 'Teams Bot',
    headless: process.env.HEADLESS !== 'false',
    channel: process.env.BROWSER_CHANNEL || null,
    login: false,
    capture: 'captions', // Default capture source
    outputPath: process.env.OUTPUT_PATH || './transcript.jsonl'
  };

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
      case '--headful':
        config.headless = false;
        break;
      case '--channel':
      case '-c':
        config.channel = args[++i];
        break;
      case '--login':
        config.login = true;
        config.headless = false;
        break;
      case '--capture':
        config.capture = args[++i]; // "captions" or "audio" (stub)
        break;
      case '--output':
      case '-o':
        config.outputPath = args[++i];
        break;
    }
  }

  return config;
}

function promptEnter() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question('Press [ENTER] once you have successfully signed in and see the Teams Dashboard...\n', () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  const config = parseArgs();

  if (config.login) {
    console.log('[TeamsBot] Starting manual login flow...');
    
    // In login mode, we go directly to the Microsoft Teams web portal
    const bot = new TeamsBot('https://teams.microsoft.com', config.botName, {
      headless: false,
      channel: config.channel || 'chrome',
      isLoginMode: true
    });

    try {
      await bot.launch();
      console.log('[TeamsBot] Opening Teams Login Page...');
      await bot.getPage().goto('https://teams.microsoft.com', { waitUntil: 'domcontentloaded' });
      
      console.log('\n==================================================================');
      console.log('1. A browser window has opened.');
      console.log('2. Please log into your Microsoft account (with MFA if enabled).');
      console.log('3. Once you see your main Teams channel/chat interface page,');
      console.log('   return to this terminal and press [ENTER].');
      console.log('==================================================================\n');
      
      await promptEnter();
      
      await bot.saveSession();
      console.log('[TeamsBot] Session captured and saved. Closing browser...');
      await bot.close();
      console.log('[TeamsBot] Login completed! You can now join meetings.');
      process.exit(0);
    } catch (err) {
      console.error('[TeamsBot] Login flow encountered an error:', err);
      await bot.close();
      process.exit(1);
    }
  }

  if (!config.meetingUrl) {
    console.error('Error: Meeting URL is required.');
    console.error('Usage: node src/index.js --url <teams-meeting-url> [--name <bot-name>] [--headful] [--capture <captions|audio>] [--output <path>] [--login]');
    process.exit(1);
  }

  // Initialize and run the lifecycle orchestrator
  const lifecycle = new BotLifecycle({
    meetingUrl: config.meetingUrl,
    botName: config.botName,
    headless: config.headless,
    channel: config.channel,
    captureSource: config.capture,
    outputPath: config.outputPath
  });

  process.on('SIGINT', async () => {
    console.log('[TeamsBot] Received SIGINT. Shutting down gracefully...');
    await lifecycle.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('[TeamsBot] Received SIGTERM. Shutting down gracefully...');
    await lifecycle.stop();
    process.exit(0);
  });

  try {
    await lifecycle.start();
  } catch (err) {
    console.error('[TeamsBot] Fatal runtime error during lifecycle run:', err.message);
    await lifecycle.stop();
    process.exit(1);
  }
}

main();
