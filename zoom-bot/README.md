# Zoom Audio Capture Bot

A headless Zoom Meeting bot that programmatically joins a meeting, captures mixed audio (PCM), and writes it to a playable `.wav` file on disk.

## Setup Requirements

Target OS: Ubuntu Linux (or containerised headless Linux).

### 1. System Dependencies
Install the required tools, PulseAudio server, ALSA, and build tools:
```bash
sudo apt-get update
sudo apt-get install -y build-essential cmake libssl-dev libcurl4-openssl-dev pulseaudio pulseaudio-utils dbus-x11 libasound2-dev libpulse-dev
```

### 2. Node.js Runner Setup
Ensure Node.js is installed, then install the bot runner script dependencies:
```bash
cd zoom-bot
npm install
```

### 3. SDK Setup & Symlink
Run the SDK setup script to configure the required symlinks inside the SDK directory:
```bash
chmod +x setup-sdk.sh
./setup-sdk.sh
```
*Note: This script creates the symlink `libmeetingsdk.so.1 -> libmeetingsdk.so` required by the SDK binary loader to function.*

### 4. Headless Virtual Sound Card Configuration
In headless systems lacking a physical sound card (e.g. servers, docker instances, cloud VMs), you must initialize a virtual PulseAudio sound device before running the bot:
```bash
chmod +x setup-pulseaudio.sh
./setup-pulseaudio.sh
```

---

## Configuration

1. Copy `.env.template` to a new `.env` file:
   ```bash
   cp .env.template .env
   ```
2. Fill in your Zoom Meeting SDK App credentials and test meeting details in the `.env` file:
   * `ZOOM_CLIENT_ID`: Your Zoom Marketplace general/user-managed app Client ID.
   * `ZOOM_CLIENT_SECRET`: Your general/user-managed app Client Secret.
   * `TEST_MEETING_NUMBER`: (Optional default) A meeting number to join.
   * `TEST_MEETING_PASSWORD`: (Optional default) The password for the meeting.

---

## Build and Run

### 1. Compile C++ Code
Build the C++ bot executable using CMake:
```bash
cmake -B build
cmake --build build
```
This builds the binary `zoomBot` inside the `build` directory.

### 2. Execute Bot
Run the orchestration script `run-bot.js` which automatically generates the JWT token, resolves shared libraries, and spawns the C++ bot:
```bash
node run-bot.js --meeting <MEETING_NUMBER> --password <PASSWORD> --output recording.wav
```
*(Leave out `--meeting` and `--password` flags to use the defaults defined in your `.env` file).*

---

## Recording Privilege Approval (Critical)

> [!IMPORTANT]
> To access raw audio streams, the Zoom Meeting SDK requires **local recording privileges**.
> 
> * **Host Approval**: When the bot joins the meeting, it will automatically send a request to the host. The host must **click Approve** in the dialog popup on their Zoom client to authorize the bot.
> * **Alternative (Auto-Approve)**: The host can enable "Automatic local recording approval" in their Zoom Account Settings before the meeting so that the bot gets privilege instantly upon joining.
> 
> You can monitor the terminal output for:
> `[Recording Service] Callback: Recording permission changed. CanRecord = TRUE`
> once permission is granted, the bot will begin writing the raw PCM audio to your specified output file.

---

## Saving the Output
Press `Ctrl+C` in your terminal to request the bot to leave the meeting. This will cleanly close and finalize the `.wav` file header on disk, saving a fully playable audio track.
