// WebSocket Server for Twilio Media Streams
// Handles real-time audio streaming from phone calls

const WebSocket = require('ws');
const ConversationOrchestrator = require('../services/conversation.orchestrator');
const TwilioService = require('../services/twilio.service');
const { getInstance: getRecordingService } = require('../services/recording.service');
const Agent = require('../models/Agent');

class MediaStreamServer {
    constructor(server) {
        this.wss = new WebSocket.Server({
            server,
            path: '/ws/media-stream'
        });

        this.twilioService = new TwilioService(
            process.env.TWILIO_ACCOUNT_SID,
            process.env.TWILIO_AUTH_TOKEN,
            process.env.TWILIO_PHONE_NUMBER
        );

        this.activeSessions = new Map(); // streamSid -> conversation orchestrator

        // Initialize recording service
        this.recordingService = getRecordingService();

        this.setupWebSocketServer();
    }

    setupWebSocketServer() {
        this.wss.on('connection', (ws) => {
            console.log('[MediaStream] Client connected');

            let streamSid = null;
            let callSid = null;
            let orchestrator = null;
            let sessionReady = false;
            const mediaBuffer = []; // Buffer for media events before session is ready

            ws.on('message', async (message) => {
                try {
                    const msg = JSON.parse(message);

                    switch (msg.event) {
                        case 'start':
                            await this.handleStart(ws, msg, (sid, cSid, orch) => {
                                streamSid = sid;
                                callSid = cSid;
                                orchestrator = orch;
                            });
                            // Session is now ready, process buffered media
                            sessionReady = true;
                            if (mediaBuffer.length > 0) {
                                console.log(`[MediaStream] Processing ${mediaBuffer.length} buffered audio packets`);
                                for (const bufferedMsg of mediaBuffer) {
                                    this.handleMedia(streamSid, bufferedMsg);
                                }
                                mediaBuffer.length = 0; // Clear buffer
                            }
                            break;

                        case 'media':
                            if (sessionReady) {
                                this.handleMedia(streamSid, msg);
                            } else {
                                // Buffer media until session is ready
                                if (mediaBuffer.length < 500) { // Limit buffer size
                                    mediaBuffer.push(msg);
                                }
                            }
                            break;

                        case 'stop':
                            this.handleStop(streamSid, callSid, orchestrator);
                            break;

                        default:
                            console.log('[MediaStream] Unknown event:', msg.event);
                    }
                } catch (error) {
                    console.error('[MediaStream] Error processing message:', error);
                }
            });

            ws.on('close', () => {
                console.log('[MediaStream] Client disconnected');
                if (orchestrator) {
                    orchestrator.end('connection_closed');
                }
                if (streamSid) {
                    this.activeSessions.delete(streamSid);
                }
            });

            ws.on('error', (error) => {
                console.error('[MediaStream] WebSocket error:', error);
            });
        });

        console.log('[MediaStream] WebSocket server initialized');
    }

    /**
     * Handle stream start event
     */
    async handleStart(ws, msg, setVars) {
        const { streamSid, callSid, customParameters } = msg.start;
        const agentId = customParameters?.agentId;

        console.log(`[MediaStream] Stream started: ${streamSid}, Call: ${callSid}, Agent: ${agentId}`);

        // Store streamSid on WebSocket for sending audio back
        ws.streamSid = streamSid;

        setVars(streamSid, callSid, null);

        try {
            // Load agent configuration
            const agent = await Agent.findById(agentId);
            if (!agent) {
                console.error('[MediaStream] Agent not found:', agentId);
                return;
            }

            // Debug: Log what's being passed
            console.log('[MediaStream] Agent loaded from DB:', agent.name);

            // Handle nested configuration structure
            // The actual config may be at agent.configuration.configuration due to how it was saved
            let actualConfig = agent.configuration;
            if (actualConfig && actualConfig.configuration && actualConfig.configuration.voice) {
                console.log('[MediaStream] Found nested configuration, unwrapping...');
                actualConfig = actualConfig.configuration;
            }

            console.log('[MediaStream] Configuration keys:', Object.keys(actualConfig || {}));
            console.log('[MediaStream] Voice config:', JSON.stringify(actualConfig?.voice || 'NONE'));
            console.log('[MediaStream] First message:', (actualConfig?.firstMessage || 'NONE').substring(0, 80));

            // Create conversation orchestrator with the correct config
            const orchestrator = new ConversationOrchestrator(
                actualConfig,
                {
                    deepgram: process.env.DEEPGRAM_API_KEY,
                    gemini: process.env.GEMINI_API_KEY,
                    elevenlabs: process.env.ELEVENLABS_API_KEY
                }
            );

            // Start recording for this call
            this.recordingService.startRecording(callSid, {
                agentId: agent._id.toString(),
                agentName: agent.name
            });

            // Store session
            this.activeSessions.set(streamSid, {
                orchestrator,
                ws,
                agent,
                callSid,
                startTime: Date.now()
            });

            setVars(streamSid, callSid, orchestrator);

            // Handle audio output from orchestrator
            orchestrator.on('audio', (audioChunk) => {
                this.sendAudioToTwilio(ws, audioChunk);
            });

            // Handle conversation events
            orchestrator.on('user_speech', (transcript) => {
                console.log(`[MediaStream] User: ${transcript}`);
            });

            orchestrator.on('assistant_speech', (text) => {
                console.log(`[MediaStream] Assistant: ${text}`);
            });

            orchestrator.on('ended', async (data) => {
                console.log('[MediaStream] Conversation ended:', data.reason);

                // Save conversation log to database
                await this.saveConversationLog(callSid, agent._id, data);

                // Clean up
                this.activeSessions.delete(streamSid);
            });

            orchestrator.on('error', (error) => {
                console.error('[MediaStream] Orchestrator error:', error);
            });

            // Start conversation
            await orchestrator.start();

        } catch (error) {
            console.error('[MediaStream] Error starting conversation:', error);
        }
    }

    /**
     * Handle incoming media (audio from caller)
     */
    handleMedia(streamSid, msg) {
        const session = this.activeSessions.get(streamSid);
        if (!session) {
            // Only log occasionally to avoid spam
            if (!this._mediaWarningLogged) {
                console.log('[MediaStream] No session found for streamSid:', streamSid);
                this._mediaWarningLogged = true;
            }
            return;
        }

        // Log first few audio packets
        if (!session._audioPacketCount) session._audioPacketCount = 0;
        session._audioPacketCount++;
        if (session._audioPacketCount <= 3 || session._audioPacketCount % 100 === 0) {
            console.log(`[MediaStream] Audio packet #${session._audioPacketCount}, size: ${msg.media?.payload?.length || 0} base64 chars`);
        }

        // Decode audio from base64
        const audioBuffer = Buffer.from(msg.media.payload, 'base64');

        // Add to recording (caller audio)
        if (session.callSid) {
            this.recordingService.addAudioChunk(session.callSid, audioBuffer, 'caller');
        }

        // Send raw μ-law audio directly to orchestrator (Deepgram configured for mulaw)
        session.orchestrator.processIncomingAudio(audioBuffer);

        // DEBUG: Check for silence
        // Calculate approximate energy (RMS) of the packet
        // We can access twilioService from the instance
        if (this.twilioService && session._audioPacketCount % 50 === 0) {
            let sumSquares = 0;
            // Sample every 4th byte to save CPU
            for (let i = 0; i < audioBuffer.length; i += 4) {
                const byte = audioBuffer[i];
                // Convert mu-law byte to linear PCM (approximate) using helper
                // We need to access the helper from TwilioService instance
                const pcm = this.twilioService.mulawToLinear(byte);
                sumSquares += pcm * pcm;
            }
            const rms = Math.sqrt(sumSquares / (audioBuffer.length / 4));

            const isSilent = rms < 100; // Threshold for silence (adjustable)

            console.log(`[MediaStream] Audio packet #${session._audioPacketCount} energy (RMS): ${Math.round(rms)} - ${isSilent ? 'SILENCE' : 'VOICE/NOISE'}`);
        }
    }

    /**
     * Handle stream stop event
     */
    handleStop(streamSid, callSid, orchestrator) {
        console.log(`[MediaStream] Stream stopped: ${streamSid}`);

        if (orchestrator) {
            orchestrator.end('call_ended');
        }

        this.activeSessions.delete(streamSid);
    }

    /**
     * Send audio to Twilio
     * Audio from ElevenLabs is in μ-law 8kHz format - Twilio's native format
     */
    sendAudioToTwilio(ws, audioChunk) {
        if (ws.readyState !== WebSocket.OPEN) return;

        // Ensure we have streamSid
        if (!ws.streamSid) {
            console.error('[MediaStream] Cannot send audio - no streamSid on WebSocket');
            return;
        }

        // Audio is already in μ-law 8kHz from ElevenLabs - send directly to Twilio
        const payload = audioChunk.toString('base64');

        // Add to recording (agent audio) - find callSid from active sessions
        for (const [streamSid, session] of this.activeSessions) {
            if (session.ws === ws && session.callSid) {
                this.recordingService.addAudioChunk(session.callSid, audioChunk, 'agent');
                break;
            }
        }

        // Send to Twilio
        ws.send(JSON.stringify({
            event: 'media',
            streamSid: ws.streamSid,
            media: {
                payload
            }
        }));
    }

    /**
     * Save conversation log to database
     */
    async saveConversationLog(callSid, agentId, data) {
        try {
            const Call = require('../models/Call');

            // Stop recording and upload to S3
            const recordingUrl = await this.recordingService.stopAndUpload(callSid);
            console.log('[MediaStream] Recording URL:', recordingUrl || 'None');

            await Call.findByIdAndUpdate(
                callSid,
                {
                    status: 'completed',
                    endedReason: data.reason,
                    transcript: JSON.stringify(data.conversationLog),
                    messages: data.conversationLog,
                    recordingUrl: recordingUrl || undefined,
                    endedAt: new Date(),
                    updatedAt: new Date()
                },
                { upsert: true }
            );

            console.log('[MediaStream] Conversation log saved with recording');
        } catch (error) {
            console.error('[MediaStream] Error saving conversation log:', error);
        }
    }

    /**
     * Get active session count
     */
    getActiveSessionCount() {
        return this.activeSessions.size;
    }

    /**
     * Get session by streamSid
     */
    getSession(streamSid) {
        return this.activeSessions.get(streamSid);
    }
}

module.exports = MediaStreamServer;
