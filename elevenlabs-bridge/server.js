import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import WebSocket from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import Twilio from 'twilio';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const fastify = Fastify({ logger: true });

// In-memory store for call sessions
// Map<sessionId, { twilioAccountSid, twilioAuthToken, elevenLabsApiKey, elevenLabsAgentId, serverUrl }>
const sessionStore = new Map();

// Register plugins
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

fastify.register(fastifyStatic, {
    root: path.join(__dirname, 'public'),
    prefix: '/',
});

// Root route for health check
fastify.get('/health', async (request, reply) => {
    return { status: 'ok', message: 'ElevenLabs Zoom Bridge Server is running' };
});

// Initiate Call Endpoint
fastify.post('/initiate-call', async (request, reply) => {
    const {
        twilioAccountSid,
        twilioAuthToken,
        twilioPhoneNumber,
        elevenLabsApiKey,
        elevenLabsAgentId,
        zoomDialIn,
        meetingId,
        passcode
    } = request.body || {};

    let serverUrl = request.body?.serverUrl;
    if (serverUrl && !serverUrl.startsWith('http')) {
        serverUrl = `https://${serverUrl}`;
    }

    if (!serverUrl || !twilioAccountSid || !twilioAuthToken || !twilioPhoneNumber || !elevenLabsApiKey || !elevenLabsAgentId || !zoomDialIn) {
        return reply.code(400).send({ error: 'All fields (except Meeting ID/Passcode) are required' });
    }

    // Create a session ID to track this call's configuration
    const sessionId = uuidv4();
    sessionStore.set(sessionId, {
        twilioAccountSid,
        twilioAuthToken,
        elevenLabsApiKey,
        elevenLabsAgentId,
        serverUrl
    });

    // Clean up session after 1 hour to prevent memory leaks
    setTimeout(() => sessionStore.delete(sessionId), 3600000);

    try {
        const twilioClient = new Twilio(twilioAccountSid, twilioAuthToken);

        // Construct sendDigits string for Zoom
        // If meetingId/passcode are provided, wait and enter them. Otherwise just wait.
        let sendDigits = 'wwww';
        if (meetingId) {
            sendDigits += `${meetingId}#`;
            if (passcode) {
                sendDigits += `wwww${passcode}#`;
            } else {
                // If no passcode, usually just # or wait
                sendDigits += `wwww#`;
            }
        }

        const call = await twilioClient.calls.create({
            url: `${serverUrl}/call/twiml?sessionId=${sessionId}`,
            to: zoomDialIn,
            from: twilioPhoneNumber,
            sendDigits: sendDigits
        });

        request.log.info(`Call initiated: ${call.sid} (Session: ${sessionId})`);
        return { success: true, callSid: call.sid, sessionId };
    } catch (error) {
        request.log.error(error);
        return reply.code(500).send({
            error: 'Failed to initiate call',
            details: error.message,
            code: error.code, // Twilio error code
            moreInfo: error.moreInfo // Twilio link
        });
    }
});

// Hangup Call Endpoint
fastify.post('/hangup-call', async (request, reply) => {
    const { callSid } = request.body || {};

    if (!callSid) {
        return reply.code(400).send({ error: 'Call SID is required' });
    }

    // Find the session for this call (we'll need to store callSid -> sessionId mapping)
    // For now, we'll try to use the most recent session's credentials
    // This is a limitation - ideally we'd track callSid -> sessionId
    let sessionData = null;
    for (const [sid, data] of sessionStore.entries()) {
        sessionData = data;
        break; // Use the first (most recent) session
    }

    if (!sessionData) {
        return reply.code(404).send({ error: 'No active session found' });
    }

    try {
        const twilioClient = new Twilio(sessionData.twilioAccountSid, sessionData.twilioAuthToken);
        await twilioClient.calls(callSid).update({ status: 'completed' });

        request.log.info(`Call ${callSid} terminated`);
        return { success: true, message: 'Call ended' };
    } catch (error) {
        request.log.error(error);
        return reply.code(500).send({
            error: 'Failed to hang up call',
            details: error.message
        });
    }
});

// TwiML Endpoint
fastify.post('/call/twiml', async (request, reply) => {
    const sessionId = request.query.sessionId;
    const session = sessionStore.get(sessionId);

    if (!session) {
        request.log.error(`Session not found for TwiML: ${sessionId}`);
        return reply.code(404).send('Session not found');
    }

    const { serverUrl } = session;
    const twiml = new Twilio.twiml.VoiceResponse();

    const connect = twiml.connect();
    const stream = connect.stream({
        url: `${serverUrl.replace(/^https/, 'wss')}/media-stream?sessionId=${sessionId}`
    });

    reply.type('text/xml');
    return twiml.toString();
});

// Call Status Callback Endpoint
fastify.post('/call/status', async (request, reply) => {
    const callStatus = request.body.CallStatus;
    const callSid = request.body.CallSid;
    request.log.info(`Call Status Update: ${callSid} is ${callStatus}`);
    return { status: 'ok' };
});

// WebSocket Media Stream Endpoint
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        // Parse sessionId from URL query string
        const url = new URL(req.url, `http://${req.headers.host}`);
        const sessionId = url.searchParams.get('sessionId');

        fastify.log.info(`WebSocket connection attempt with sessionId: ${sessionId}`);

        const session = sessionStore.get(sessionId);

        if (!session) {
            fastify.log.error(`Session not found for WebSocket: ${sessionId}`);
            connection.socket.close();
            return;
        }

        const { elevenLabsApiKey, elevenLabsAgentId } = session;

        fastify.log.info(`Twilio media stream connected (Session: ${sessionId})`);

        let streamSid = null;
        let elevenLabsWs = null;
        let isElevenLabsConnected = false;

        // Connect to ElevenLabs
        const elevenLabsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${elevenLabsAgentId}`;
        elevenLabsWs = new WebSocket(elevenLabsUrl, {
            headers: {
                'xi-api-key': elevenLabsApiKey
            }
        });

        elevenLabsWs.on('open', () => {
            fastify.log.info('Connected to ElevenLabs');
            isElevenLabsConnected = true;
        });

        elevenLabsWs.on('message', (data) => {
            try {
                const message = JSON.parse(data);
                handleElevenLabsMessage(message, connection, streamSid);
            } catch (error) {
                fastify.log.error('Error parsing ElevenLabs message:', error);
            }
        });

        elevenLabsWs.on('error', (error) => {
            fastify.log.error('ElevenLabs WebSocket error:', error);
        });

        elevenLabsWs.on('close', (code, reason) => {
            fastify.log.info(`ElevenLabs disconnected. Code: ${code}, Reason: ${reason}`);
            isElevenLabsConnected = false;
        });

        // Handle messages from Twilio
        connection.socket.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'start':
                        streamSid = data.start.streamSid;
                        fastify.log.info(`Stream started: ${streamSid}`);
                        break;

                    case 'media':
                        if (isElevenLabsConnected && elevenLabsWs.readyState === WebSocket.OPEN) {
                            const audioPayload = {
                                user_audio_chunk: data.media.payload
                            };
                            elevenLabsWs.send(JSON.stringify(audioPayload));
                        }
                        break;

                    case 'stop':
                        fastify.log.info(`Stream stopped: ${streamSid}`);
                        if (elevenLabsWs.readyState === WebSocket.OPEN) {
                            elevenLabsWs.close();
                        }
                        break;
                }
            } catch (error) {
                fastify.log.error('Error parsing Twilio message:', error);
            }
        });

        connection.socket.on('close', () => {
            fastify.log.info('Twilio media stream disconnected');
            if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                elevenLabsWs.close();
            }
        });
    });
});

function handleElevenLabsMessage(message, twilioConnection, streamSid) {
    switch (message.type) {
        case 'conversation_initiation_metadata':
            console.log('ElevenLabs conversation initiated');
            break;

        case 'audio':
            if (message.audio_event?.audio_base_64) {
                const audioData = {
                    event: 'media',
                    streamSid: streamSid,
                    media: {
                        payload: message.audio_event.audio_base_64
                    }
                };
                twilioConnection.socket.send(JSON.stringify(audioData));
            }
            break;

        case 'ping':
            if (message.ping_event?.event_id) {
                // Pong if needed
            }
            break;
    }
}

// Start server
const start = async () => {
    try {
        await fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' });
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

start();
