# Centralized Meeting Bots & Transcription Dashboard

This repository contains a centralized orchestration dashboard and bots for **Microsoft Teams**, **Google Meet**, and **Zoom** that automate joining meetings, extracting transcripts/live captions, generating AI summaries (reports, speaker analytics, and Microsoft Word document exports), and syncing files to Supabase Storage and Google Drive folders.

---

## Folder Structure

* **`Microsoft Teams/`**: Playwright-based Teams bot that bypasses app landing pages, toggles off camera/microphone switches, and utilizes a robust DOM-based caption scraper with a `MutationObserver`.
* **`Google Meet/`**: Playwright-based Google Meet bot that intercepts WebRTC `RTCPeerConnection` natively to mix and downsample meeting audio, mapping active speakers via DOM speaker indicators.
* **`Zoom/`**: Playwright-based Zoom Web Client bot that streams audio buffers to the server.
* **`dashboard/`**:
  * **`backend/`**: Express.js server that spawns bots as child processes, exposes a WebSocket proxy, manages Deepgram transcription streams, generates Word Document summaries (`docx` library), and handles Google Drive OAuth2 flows.
  * **`frontend/`**: Vanilla JS, HTML, and CSS public dashboard with glassmorphism styling, speaker visualizers, and report download buttons.

---

## Prerequisites

1. **Node.js**: Version 18 or higher is recommended.
2. **Google Chrome**: Real Google Chrome installation is required on the host system to run bots under the `--channel chrome` flag.
3. **Playwright**: Browser dependencies must be installed.
4. **Google Cloud Console Project**: Needed to configure client credentials for Google Drive integrations.

---

## 1. Environment Configuration

Create a `.env` file in the **root folder** of the project and populate the following variables:

```ini
# Deepgram API Key (Required for Zoom & Google Meet audio transcription)
DEEPGRAM_API_KEY="your_deepgram_api_key"

# Groq API Key (Required for AI report generation & executive summaries)
GROQ_API_KEY="your_groq_api_key"

# Gemini API Key (Optional / LLM fallback)
GEMINI_API_KEY="your_gemini_api_key"

# Supabase Configurations (Required for database session state & cloud storage)
SUPABASE_URL="https://your-project.supabase.co"
SUPABASE_ANON_KEY="your_supabase_anon_key"

# Google OAuth2 Credentials (Required for Google Drive Transcript & Report Sync)
GOOGLE_CLIENT_ID="your_google_client_id.apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="your_google_client_secret"
GOOGLE_REDIRECT_URI="http://localhost:3000/api/auth/google/callback"
```

---

## 2. Installation

Install dependencies across all directories in a single command from the root folder (uses npm workspaces):

```bash
# Install dependencies for all subfolders recursively
npm install
```

Make sure browser drivers are installed via Playwright:
```bash
npx playwright install chrome
```

### First-Time Bot Authentication (First-time Login)
To ensure the bots can access meetings under authenticated accounts, you must run the login setup once before running them in the background.

* **Google Meet Bot:**
  Run the following command to log in manually. This opens a headful browser and saves the persistent `auth.json` file:
  ```bash
  cd "Google Meet"
  node src/index.js --login
  ```
  *(Log in in the browser, then return to the terminal and press ENTER to save the session).*

* **Microsoft Teams Bot:**
  Run the following command to log in manually. This creates the persistent `auth.json` file:
  ```bash
  cd "Microsoft Teams"
  node src/index.js --login
  ```
  *(Log in in the browser, then return to the terminal and press ENTER to save the session).*

---

## 3. Running the Dashboard Local Server

Start the centralized dashboard backend server from the `dashboard/backend` directory:

```bash
cd dashboard/backend
npm start
```

The server will launch on **`http://localhost:3000/`**. Open this URL in your web browser to access the control panel.

---

## 4. Platform Bot Execution Details

### A. Microsoft Teams Bot
* **Mechanism**: Automates anonymous guest joining. Utilizes custom script injections to spoof `document.visibilityState` to `'visible'` (avoiding headless loader freezes), toggles FluentUI camera/microphone selectors, and observes `.fui-ChatMessageCompact` blocks for live caption strings.
* **Requirements**: Captions **must** be enabled on the host side of the meeting for transcription to work. The bot will automatically trigger "Turn on live captions" inside the meeting.

### B. Google Meet Bot
* **Mechanism**: Intercepts the RTCPeerConnection to stream meeting audio to Node.js, downsamples PCM to 16kHz, and uploads it to the Deepgram API for transcription. 
* **Speaker Detection**: Polls the DOM for `.KUNJSe` classes to detect active speaker boundaries.

### C. Zoom Bot
* **Mechanism**: Connects to the Zoom meeting via the web client, intercepts audio channels, and streams data over WebSockets for backend Deepgram transcription.

---

## 5. Google Drive Transcript & Report Sync

To automatically save raw transcripts (`.jsonl`), timestamped readable transcripts (`_readable.txt`), and summaries (`_report.md` & `_report.docx`) to your Google Drive folders:

### GCP Project Setup
1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Enable the **Google Drive API** in your project:
   * Navigate to **API & Services > Library**.
   * Search for `Google Drive API` and click **Enable**.
3. Configure the **OAuth Consent Screen**:
   * Set user type and register your app.
   * Add the scope: `https://www.googleapis.com/auth/drive.file` (this scope restricts the bot to only read/write files it has created or opened).
4. Create **Credentials**:
   * Create an OAuth 2.0 Client ID.
   * Set Authorized Redirect URIs to: `http://localhost:3000/api/auth/google/callback`.
   * Add the Client ID, Secret, and Redirect URI to your root `.env` file.

### Syncing in Dashboard
1. Open the dashboard homepage (`http://localhost:3000/`).
2. Click **Connect Google Drive** on the left panel.
3. Authenticate and approve the scopes on Google's consent page.
4. Once redirected back, the status badge will update to **Connected**.
5. When starting a bot session, paste a folder link (e.g. `https://drive.google.com/drive/folders/FOLDER_ID`) in the **Google Drive Folder URL (optional)** text input.
6. The transcripts and reports will automatically sync to that folder on session completion!

---

