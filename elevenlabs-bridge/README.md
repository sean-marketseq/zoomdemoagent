# ElevenLabs Zoom Bridge

Node.js server that dials an ElevenLabs conversational AI agent into a Zoom meeting using Twilio as the telephony bridge.

## Features
- Programmatically dials Zoom meetings via Twilio
- Auto-enters Meeting ID and Passcode
- Bridges audio between Zoom (Twilio) and ElevenLabs via WebSockets
- Handles real-time audio format conversion (μ-law 8kHz <-> Base64)

## Prerequisites
- Node.js v18+
- Twilio Account (Account SID, Auth Token, Phone Number)
- ElevenLabs Account (Agent ID, API Key)
- Zoom Meeting Details
- [ngrok](https://ngrok.com/) (for local development)

## Setup

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd zoom-elevenlabs-bridge
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure Environment Variables**
   Copy `.env.example` to `.env` and fill in your credentials:
   ```bash
   cp .env.example .env
   ```
   
   **Important**: `SERVER_URL` must be your public ngrok URL (e.g., `https://xyz.ngrok-free.app`) without a trailing slash.

4. **Start ngrok**
   ```bash
   ngrok http 3000
   ```
   Copy the forwarding URL to `SERVER_URL` in your `.env` file.

5. **Start the Server**
   ```bash
   npm start
   ```
   (Or `node server.js`)

## Usage

### Trigger the Call
Send a POST request to `/initiate-call` to start the flow.

```bash
curl -X POST http://localhost:3000/initiate-call \
  -H "Content-Type: application/json" \
  -d '{
    "meetingId": "1234567890",
    "passcode": "123456"
  }'
```
*Note: If body is omitted, it defaults to values in `.env`.*

### Flow
1. Server initiates Twilio call to Zoom dial-in number.
2. Twilio enters meeting credentials via DTMF tones.
3. Twilio connects to `/media-stream` WebSocket.
4. Server connects to ElevenLabs WebSocket.
5. Audio is bridged bi-directionally.

## Troubleshooting
- **No Audio**: Check if `SERVER_URL` is correct and publicly accessible.
- **Call Fails**: Verify Twilio credentials and Zoom dial-in numbers.
- **Latency**: Audio bridging adds some latency; ensure stable internet connection.

## Deployment (Railway)

This project is ready for deployment on [Railway](https://railway.app/).

1.  **Create a New Project**: Connect your GitHub repository to Railway.
2.  **Add Variables**: Go to the "Variables" tab and add the following:
    - `TWILIO_ACCOUNT_SID`
    - `TWILIO_AUTH_TOKEN`
    - `TWILIO_PHONE_NUMBER`
    - `ZOOM_DIAL_IN_NUMBER`
    - `ZOOM_MEETING_ID`
    - `ZOOM_PASSCODE`
    - `ELEVENLABS_API_KEY`
    - `ELEVENLABS_AGENT_ID`
    - `SERVER_URL`: This will be your Railway public domain (e.g., `https://your-app.up.railway.app`). *Note: Railway generates this after the first deployment, or you can set a custom domain.*
3.  **Deploy**: Railway will automatically detect the `Procfile` and start the server.
4.  **Update Twilio**: Ensure your Twilio phone number's Voice Webhook is updated to point to your Railway URL (e.g., `https://your-app.up.railway.app/call/twiml`).
