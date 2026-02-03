// SIP Media Bridge
// Connects SIP RTP audio streams to ConversationOrchestrator
// Acts as the equivalent of MediaStreamServer but for SIP calls

const ConversationOrchestrator = require('./conversation.orchestrator');
const { getInstance: getRecordingService } = require('./recording.service');
const Agent = require('../models/Agent');
const Call = require('../models/Call');

class SipMediaBridge {
    constructor() {
        this.activeSessions = new Map(); // internalCallId -> session data
        this.recordingService = getRecordingService();

        console.log('[SipMediaBridge] Initialized');
    }

    /**
     * Start a SIP media session when call is answered
     * @param {string} internalCallId - Our internal call ID
     * @param {SipTrunkService} sipService - The SIP service instance
     * @param {string} sipCallId - SIP Call-ID header value
     * @param {Object} agent - Agent document from database
     * @param {Object} apiKeys - API keys for AI services
     */
    async startSession(internalCallId, sipService, sipCallId, agent, apiKeys) {
        console.log(`[SipMediaBridge] Starting session for call ${internalCallId}`);
        console.log(`[SipMediaBridge] Agent: ${agent.name}, SIP Call-ID: ${sipCallId}`);

        try {
            // Create ConversationOrchestrator with agent config
            const orchestrator = new ConversationOrchestrator(
                {
                    model: agent.model || {},
                    voice: agent.voice || {},
                    transcriber: agent.transcriber || {},
                    firstMessage: agent.firstMessage || 'Hello! How can I help you today?',
                    firstMessageMode: agent.firstMessageMode || 'assistant-speaks-first',
                    maxDurationSeconds: agent.maxDurationSeconds || 600,
                    silenceTimeoutSeconds: agent.silenceTimeoutSeconds || 30,
                    responseDelaySeconds: agent.responseDelaySeconds || 0.4
                },
                apiKeys
            );

            // Store session data
            const session = {
                internalCallId,
                sipCallId,
                sipService,
                orchestrator,
                agent,
                startTime: Date.now(),
                audioPacketCount: 0,
                ttsPacketCount: 0
            };

            this.activeSessions.set(internalCallId, session);

            // Start recording
            this.recordingService.startRecording(internalCallId, {
                agentId: agent._id.toString(),
                agentName: agent.name,
                provider: 'sip-trunk'
            });

            // Set up audio piping: SIP RTP → Orchestrator
            this.setupIncomingAudio(session);

            // Set up audio piping: Orchestrator TTS → SIP RTP
            this.setupOutgoingAudio(session);

            // Set up orchestrator event handlers
            this.setupOrchestratorEvents(session);

            // Start the conversation (this will trigger first message if configured)
            await orchestrator.start();

            console.log(`[SipMediaBridge] Session started successfully for ${internalCallId}`);

        } catch (error) {
            console.error(`[SipMediaBridge] Error starting session:`, error);
            throw error;
        }
    }

    /**
     * Set up incoming audio from SIP to Orchestrator
     */
    setupIncomingAudio(session) {
        const { sipService, orchestrator, internalCallId, sipCallId } = session;

        // Listen for audio_in events from SipTrunkService
        const audioInHandler = ({ callId, audio }) => {
            // Only process audio for this call
            if (callId !== sipCallId) return;

            session.audioPacketCount++;

            // Debug log every 100 packets (2 seconds of audio)
            if (session.audioPacketCount === 1 || session.audioPacketCount % 100 === 0) {
                console.log(`[SipMediaBridge] RTP audio in: packet #${session.audioPacketCount}, bytes: ${audio.length}`);
            }

            // Add to recording (caller audio)
            this.recordingService.addAudioChunk(internalCallId, audio, 'caller');

            // Send to orchestrator for speech-to-text
            orchestrator.processIncomingAudio(audio);
        };

        sipService.on('audio_in', audioInHandler);
        session.audioInHandler = audioInHandler;

        console.log(`[SipMediaBridge] Incoming audio handler set up for ${internalCallId}`);
    }

    /**
     * Set up outgoing audio from Orchestrator TTS to SIP
     */
    setupOutgoingAudio(session) {
        const { sipService, orchestrator, internalCallId, sipCallId } = session;

        // Listen for audio events from orchestrator (TTS output)
        orchestrator.on('audio', (audioChunk) => {
            session.ttsPacketCount++;

            // Debug log every 50 packets
            if (session.ttsPacketCount === 1 || session.ttsPacketCount % 50 === 0) {
                console.log(`[SipMediaBridge] TTS audio out: packet #${session.ttsPacketCount}, bytes: ${audioChunk.length}`);
            }

            // Add to recording (agent audio)
            this.recordingService.addAudioChunk(internalCallId, audioChunk, 'agent');

            // Send to SIP for RTP transmission
            // Note: audioChunk is already in μ-law format from ElevenLabs
            sipService.sendAudio(sipCallId, audioChunk);
        });

        console.log(`[SipMediaBridge] Outgoing audio handler set up for ${internalCallId}`);
    }

    /**
     * Set up orchestrator event handlers for logging and call lifecycle
     */
    setupOrchestratorEvents(session) {
        const { orchestrator, internalCallId } = session;

        orchestrator.on('started', () => {
            console.log(`[SipMediaBridge] [${internalCallId}] Conversation started`);
        });

        orchestrator.on('user_speech', (transcript) => {
            console.log(`[SipMediaBridge] [${internalCallId}] User said: ${transcript}`);
        });

        orchestrator.on('thinking', () => {
            console.log(`[SipMediaBridge] [${internalCallId}] AI thinking...`);
        });

        orchestrator.on('speaking', (text) => {
            console.log(`[SipMediaBridge] [${internalCallId}] AI speaking: ${text.substring(0, 100)}...`);
        });

        orchestrator.on('assistant_speech', (text) => {
            console.log(`[SipMediaBridge] [${internalCallId}] AI response: ${text.substring(0, 100)}...`);
        });

        orchestrator.on('error', (error) => {
            console.error(`[SipMediaBridge] [${internalCallId}] Orchestrator error:`, error);
        });

        orchestrator.on('ended', async (data) => {
            console.log(`[SipMediaBridge] [${internalCallId}] Orchestrator ended: ${data.reason}`);
            // The orchestrator ended on its own (timeout, max duration, etc.)
            // End the SIP call
            await this.endSession(internalCallId, data.reason);
        });
    }

    /**
     * End a SIP media session
     * @param {string} internalCallId - Our internal call ID
     * @param {string} reason - Reason for ending
     */
    async endSession(internalCallId, reason = 'unknown') {
        const session = this.activeSessions.get(internalCallId);
        if (!session) {
            console.warn(`[SipMediaBridge] No session found for ${internalCallId}`);
            return;
        }

        console.log(`[SipMediaBridge] Ending session ${internalCallId}, reason: ${reason}`);

        try {
            // 1. End orchestrator if still running
            if (session.orchestrator && session.orchestrator.state !== 'ended') {
                session.orchestrator.end(reason);
            }

            // 2. Remove audio_in listener
            if (session.audioInHandler) {
                session.sipService.removeListener('audio_in', session.audioInHandler);
            }

            // 3. Stop recording and upload to S3
            let recordingUrl = null;
            try {
                recordingUrl = await this.recordingService.stopAndUpload(internalCallId);
                console.log(`[SipMediaBridge] Recording uploaded: ${recordingUrl || 'None'}`);
            } catch (err) {
                console.error(`[SipMediaBridge] Recording upload error:`, err);
            }

            // 4. Calculate duration and get conversation log
            const duration = (Date.now() - session.startTime) / 1000;
            const conversationLog = session.orchestrator?.getConversationLog() || [];

            // 5. Update Call record in database
            try {
                await Call.findByIdAndUpdate(
                    internalCallId,
                    {
                        status: 'completed',
                        endedAt: new Date(),
                        endedReason: reason,
                        durationSeconds: Math.round(duration),
                        transcript: conversationLog,
                        recordingUrl: recordingUrl || undefined,
                        summary: this.generateCallSummary(conversationLog)
                    },
                    { upsert: false }
                );
                console.log(`[SipMediaBridge] Call record updated: ${internalCallId}`);
            } catch (err) {
                console.error(`[SipMediaBridge] Error updating call record:`, err);
            }

            // 6. Hangup SIP call if still connected
            try {
                if (session.sipService && reason !== 'call_ended') {
                    await session.sipService.hangup(session.sipCallId);
                }
            } catch (err) {
                console.error(`[SipMediaBridge] Error hanging up SIP:`, err);
            }

            // 7. Cleanup session
            this.activeSessions.delete(internalCallId);
            console.log(`[SipMediaBridge] Session ${internalCallId} cleaned up`);

        } catch (error) {
            console.error(`[SipMediaBridge] Error ending session:`, error);
            this.activeSessions.delete(internalCallId);
        }
    }

    /**
     * Generate a simple call summary from conversation log
     */
    generateCallSummary(conversationLog) {
        const userMessages = conversationLog.filter(m => m.role === 'user');
        const assistantMessages = conversationLog.filter(m => m.role === 'assistant');

        if (userMessages.length === 0 && assistantMessages.length === 0) {
            return 'No conversation recorded';
        }

        return `Conversation with ${userMessages.length} user messages and ${assistantMessages.length} assistant responses`;
    }

    /**
     * Get session by internal call ID
     */
    getSession(internalCallId) {
        return this.activeSessions.get(internalCallId);
    }

    /**
     * Get all active sessions
     */
    getActiveSessions() {
        return Array.from(this.activeSessions.keys());
    }

    /**
     * Handle call ended event from SipTrunkService
     */
    async onCallEnded(internalCallId) {
        await this.endSession(internalCallId, 'call_ended');
    }
}

// Singleton instance
let instance = null;

function getInstance() {
    if (!instance) {
        instance = new SipMediaBridge();
    }
    return instance;
}

module.exports = { SipMediaBridge, getInstance };
