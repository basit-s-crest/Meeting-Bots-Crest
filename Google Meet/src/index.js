import { BotLifecycle } from './lifecycle/bot-lifecycle.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    meetingUrl: process.env.MEETING_URL,
    botName: process.env.BOT_NAME || 'Meeting Bot',
    outputType: process.env.OUTPUT_TYPE || 'websocket',
    outputPort: parseInt(process.env.OUTPUT_PORT || '8080'),
    headless: process.env.HEADLESS !== 'false',
    channel: process.env.BROWSER_CHANNEL || 'chrome',
    userDataDir: process.env.USER_DATA_DIR || null,
    login: false,
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
      case '--persist':
        config.userDataDir = config.userDataDir || './.user_data';
        break;
      case '--user-data-dir':
        config.userDataDir = args[++i];
        break;
      case '--login':
        config.login = true;
        config.headless = false;
        break;
    }
  }

  return config;
}

import { MeetBot } from './join/meet-bot.js';

async function main() {
  const config = parseArgs();

  if (config.login) {
    console.log('Starting Google login session...');
    const bot = new MeetBot('https://accounts.google.com/', 'Login Session', {
      headless: false,
      channel: config.channel || 'chrome',
      userDataDir: config.userDataDir || './.user_data'
    });
    
    try {
      await bot.launch();
      console.log('Navigating to Google accounts page...');
      await bot.getPage().goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded' });
      
      console.log('\n==================================================================');
      console.log('1. A Google Chrome window has opened.');
      console.log('2. Please log in to your Google Account in that window.');
      console.log('3. Once you are successfully signed in, return here and press ENTER.');
      console.log('==================================================================\n');
      
      await new Promise((resolve) => {
        process.stdin.once('data', () => {
          resolve();
        });
      });
      
      console.log('Closing browser and saving session...');
      await bot.close();
      console.log('Session saved! You can now run the bot normally.');
      process.exit(0);
    } catch (err) {
      console.error('Login session failed:', err);
      await bot.close();
      process.exit(1);
    }
  }

  if (!config.meetingUrl) {
    console.error('Usage: node src/index.js --url <meeting-url> [--name <bot-name>] [--output <websocket|callback>] [--port <port>] [--headful] [--channel <chrome|msedge>] [--persist] [--user-data-dir <path>] [--login]');
    console.error('Or set MEETING_URL environment variable');
    process.exit(1);
  }

  const lifecycle = new BotLifecycle({
    meetingUrl: config.meetingUrl,
    botName: config.botName,
    outputType: config.outputType,
    outputConfig: { port: config.outputPort },
    headless: config.headless,
    channel: config.channel,
    userDataDir: config.userDataDir,
  });

  // Monitor parent process death
  const parentPid = parseInt(process.env.PARENT_PID || process.ppid, 10);
  if (parentPid) {
    const checkParentInterval = setInterval(async () => {
      try {
        process.kill(parentPid, 0);
      } catch (err) {
        console.warn(`[Bot] Parent process ${parentPid} detected dead. Shutting down gracefully...`);
        clearInterval(checkParentInterval);
        if (lifecycle) {
          await lifecycle.stop().catch(() => {});
        }
        process.exit(0);
      }
    }, 2000);
    checkParentInterval.unref();
  }

  // Listen for graceful stop command on stdin
  if (!config.login) {
    process.stdin.on('data', async (data) => {
      const text = data.toString().trim();
      if (text === 'stop') {
        console.log('[Bot] Received stop command on stdin. Shutting down gracefully...');
        if (lifecycle) {
          await lifecycle.stop().catch(() => {});
        }
        process.exit(0);
      }
    });
  }

  lifecycle.onStateChange((state) => console.log(`State: ${state}`));

  process.on('SIGINT', async () => {
    console.log('Shutting down...');
    await lifecycle.stop();
    process.exit(0);
  });

  try {
    await lifecycle.start();
    console.log(`Bot joined, streaming chunks on ws://localhost:${config.outputPort}`);
  } catch (err) {
    console.error('Failed to start:', err);
    await lifecycle.stop();
    process.exit(1);
  }
}

main();