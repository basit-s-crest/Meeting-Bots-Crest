const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const KJUR = require('jsrsasign');

// Load environment variables from .env
require('dotenv').config();

// Helper to print usage info
function printUsage() {
  console.log('Usage: node run-bot.js [options]');
  console.log('Options:');
  console.log('  --meeting <number>   Zoom meeting number (defaults to TEST_MEETING_NUMBER in .env)');
  console.log('  --password <pwd>     Zoom meeting password (defaults to TEST_MEETING_PASSWORD in .env)');
  console.log('  --output <path>      Path to output playable .wav file (defaults to recording.wav)');
  console.log('  --name <bot_name>    Display name of the bot (defaults to "Zoom Bot")');
  console.log('  --help               Show this help message');
}

// Simple CLI arguments parsing
const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--help') {
    printUsage();
    process.exit(0);
  } else if (argv[i] === '--meeting' && argv[i + 1]) {
    args.meetingNumber = argv[i + 1].replace(/\s+/g, ''); // strip spaces
    i++;
  } else if (argv[i] === '--password' && argv[i + 1]) {
    args.password = argv[i + 1];
    i++;
  } else if (argv[i] === '--output' && argv[i + 1]) {
    args.outputPath = argv[i + 1];
    i++;
  } else if (argv[i] === '--name' && argv[i + 1]) {
    args.botName = argv[i + 1];
    i++;
  }
}

// Fallback to environment variables
const clientID = process.env.ZOOM_CLIENT_ID;
const clientSecret = process.env.ZOOM_CLIENT_SECRET;
const meetingNumber = args.meetingNumber || process.env.TEST_MEETING_NUMBER;
const password = args.password || process.env.TEST_MEETING_PASSWORD;
const outputPath = path.resolve(args.outputPath || 'recording.wav');
const botName = args.botName || 'Zoom Bot';

// Validation
if (!clientID || !clientSecret) {
  console.error('Error: ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET must be set in your .env file.');
  process.exit(1);
}
if (!meetingNumber) {
  console.error('Error: Meeting number must be provided via --meeting or TEST_MEETING_NUMBER in .env.');
  process.exit(1);
}

// Generate JWT signature for Zoom Meeting SDK
function generateSDKJWT(sdkKey, sdkSecret, meetingNum, role = 0) {
  const iat = Math.round(Date.now() / 1000) - 30; // 30s drift cushion
  const exp = iat + 60 * 60 * 2; // Token expires in 2 hours

  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    appKey: sdkKey,
    sdkKey: sdkKey,
    mn: meetingNum,
    role: role, // 0 for participant, 1 for host
    iat: iat,
    exp: exp,
    tokenExp: exp
  };

  const sHeader = JSON.stringify(header);
  const sPayload = JSON.stringify(payload);

  return KJUR.jws.JWS.sign('HS256', sHeader, sPayload, sdkSecret);
}

console.log('Generating JWT signature...');
const jwt = generateSDKJWT(clientID, clientSecret, meetingNumber, 0);
console.log('JWT generated successfully.');

// Locate built binary
let binaryPath = path.join(__dirname, 'build', 'zoomBot');
if (!fs.existsSync(binaryPath)) {
  // Check alternative binary output paths
  binaryPath = path.join(__dirname, 'zoomBot');
  if (!fs.existsSync(binaryPath)) {
    console.error('Error: Compiled C++ bot binary (zoomBot) not found.');
    console.error('Please build the project first:');
    console.error('  cmake -B build');
    console.error('  cmake --build build');
    process.exit(1);
  }
}

// Run bot binary
console.log('Starting Zoom C++ Bot...');
console.log(`- Meeting Number: ${meetingNumber}`);
console.log(`- Bot Display Name: ${botName}`);
console.log(`- Output File: ${outputPath}`);

const sdkLibPath = path.join(__dirname, 'lib', 'zoomsdk');

// Spawn C++ bot process
const child = spawn(binaryPath, [
  '--meeting', meetingNumber,
  '--password', password || '',
  '--jwt', jwt,
  '--output', outputPath,
  '--name', botName
], {
  env: {
    ...process.env,
    LD_LIBRARY_PATH: sdkLibPath + (process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : '')
  }
});

// Capture and pipe child process logs
child.stdout.on('data', (data) => {
  process.stdout.write(data.toString());
});

child.stderr.on('data', (data) => {
  process.stderr.write(data.toString());
});

child.on('close', (code) => {
  console.log(`Bot process exited with code ${code}`);
});

// Forward termination signals to bot process
const handleShutdown = () => {
  console.log('\nReceived shutdown signal. Requesting bot to leave meeting...');
  child.kill('SIGINT');
};

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
