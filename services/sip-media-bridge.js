// SIP Media Bridge
// Connects SIP RTP audio streams to ConversationOrchestrator
// Acts as the equivalent of MediaStreamServer but for SIP calls

const ConversationOrchestrator = require('./conversation.orchestrator');
const { getInstance: getRecordingService } = require('./recording.service');
const Agent = require('../models/Agent');
const Call = require('../models/Call');
const CampaignLead = require('../models/CampaignLead');
const Campaign = require('../models/Campaign');

class SipMediaBridge {
    constructor() {
        this.activeSessions = new Map(); // internalCallId -> session data
        this._endingSessions = new Set(); // Guard against duplicate endSession calls
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
     * @param {Object} [variables] - Optional dynamic variables for first message substitution
     */
    async startSession(internalCallId, sipService, sipCallId, agent, apiKeys, variables) {
        console.log(`[SipMediaBridge] Starting session for call ${internalCallId}`);
        console.log(`[SipMediaBridge] Agent: ${agent.name}, SIP Call-ID: ${sipCallId}`);

        try {
            // Create ConversationOrchestrator with agent config
            // Agent settings are stored under agent.configuration (MongoDB schema)
            const cfg = agent.configuration || {};
            const transcriberConfig = { ...(cfg.transcriber || {}) };

            // Apply {{variable}} substitution to firstMessage
            let firstMessage = cfg.firstMessage || 'Hello! How can I help you today?';
            if (variables && typeof variables === 'object') {
                for (const [key, value] of Object.entries(variables)) {
                    firstMessage = firstMessage.replace(
                        new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value)
                    );
                }
                console.log('[SipMediaBridge] firstMessage after substitution:', firstMessage);
            }
            // Strip any unresolved {{...}} placeholders
            firstMessage = firstMessage.replace(/\{\{\w+\}\}/g, '').replace(/\s{2,}/g, ' ').trim();

            const orchestrator = new ConversationOrchestrator(
                {
                    model: cfg.model || {},
                    voice: cfg.voice || {},
                    transcriber: transcriberConfig,
                    knowledgeBase: cfg.knowledgeBase || [],   // ← KB text for Gemini injection
                    firstMessage,
                    firstMessageMode: cfg.firstMessageMode || 'assistant-speaks-first',
                    maxDurationSeconds: cfg.maxDurationSeconds || 600,
                    silenceTimeoutSeconds: cfg.silenceTimeoutSeconds || 30,
                    responseDelaySeconds: cfg.responseDelaySeconds ?? 0
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
                transcriberConfig,  // mutable ref so setupIncomingAudio can patch it
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

            // Deepgram nova-2 with Hindi (language=hi) only accepts encoding=mulaw.
            // Inbound SIP audio is A-law (codec 8) from the provider.
            // We convert A-law → μ-law in the audioInHandler below before sending to Deepgram.
            transcriberConfig.encoding = 'mulaw';
            console.log(`[SipMediaBridge] Deepgram encoding: 'mulaw' (inbound A-law will be converted before STT)`);

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

        // alawmulaw for clean A-law → μ-law conversion (Deepgram requires mulaw for Hindi)
        const alawmulaw = require('alawmulaw');

        // Listen for audio_in events from SipTrunkService
        const audioInHandler = ({ callId, audio, codec }) => {
            // Only process audio for this call
            if (callId !== sipCallId) return;

            session.audioPacketCount++;

            // Debug log every 100 packets (2 seconds of audio)
            if (session.audioPacketCount === 1 || session.audioPacketCount % 100 === 0) {
                console.log(`[SipMediaBridge] RTP audio in: packet #${session.audioPacketCount}, bytes: ${audio.length}`);
            }

            // Convert A-law → μ-law before sending to Deepgram and recording.
            // Deepgram nova-2 (Hindi) only accepts mulaw encoding.
            // Recording also needs consistent μ-law so mixing doesn't produce noise.
            let audioForStt = audio;
            if (codec === 8) {
                const pcm = alawmulaw.alaw.decode(audio);
                audioForStt = Buffer.from(alawmulaw.mulaw.encode(pcm));
            }

            // Add to recording AFTER conversion so caller audio is μ-law (same as agent)
            this.recordingService.addAudioChunk(internalCallId, audioForStt, 'caller');

            // Send to orchestrator for speech-to-text
            // NOTE: the third argument in older versions was onError, now we need to make sure
            // orchestrator routes the VAD event correctly. We don't actually need to hook it here;
            // orchestrator registers its own callbacks in startListening.
            orchestrator.processIncomingAudio(audioForStt);
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
            // Check if session still exists before sending audio
            if (!this.activeSessions.has(internalCallId)) {
                return;
            }

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

        // When TTS stream ends, flush any remaining carry-buffer bytes as a final padded packet
        orchestrator.on('audio_flush', () => {
            if (!this.activeSessions.has(internalCallId)) return;
            sipService.flushCarryBuffer(sipCallId);
        });
        // Listen for actual playback completion from the RTP stack
        const playbackCompleteHandler = (completedCallId) => {
            if (completedCallId === sipCallId && this.activeSessions.has(internalCallId)) {
                orchestrator.emit('playback_complete');
            }
        };
        sipService.on('playback_complete', playbackCompleteHandler);
        session.playbackCompleteHandler = playbackCompleteHandler;

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
            if (session.sipService && session.sipCallId) {
                session.sipService.clearAudioQueue(session.sipCallId);
            }
        });

        // Barge-in: user interrupted while agent was speaking — clear outgoing audio immediately
        orchestrator.on('barge_in', () => {
            console.log(`[SipMediaBridge] [${internalCallId}] Barge-in! Clearing audio queue`);
            if (session.sipService && session.sipCallId) {
                session.sipService.clearAudioQueue(session.sipCallId, true); // force=true bypasses anti-echo
            }
            if (this.recordingService && this.recordingService.clearUnplayedAgentAudio) {
                this.recordingService.clearUnplayedAgentAudio(internalCallId);
            }
        });

        orchestrator.on('thinking', () => {
            console.log(`[SipMediaBridge] [${internalCallId}] AI thinking...`);
            // NOTE: Do NOT clear the audio queue here.
            // The `thinking` event always fires right after `user_speech`, which already
            // cleared the queue. Clearing again here races with audio that is still being
            // drained and causes the tail of the AI's previous response to be cut off.
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
        // Guard against duplicate endSession calls
        if (this._endingSessions.has(internalCallId)) {
            console.log(`[SipMediaBridge] endSession already in progress for ${internalCallId}, skipping`);
            return;
        }

        const session = this.activeSessions.get(internalCallId);
        if (!session) {
            console.warn(`[SipMediaBridge] No session found for ${internalCallId}`);
            return;
        }

        this._endingSessions.add(internalCallId);

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
            if (session.playbackCompleteHandler) {
                session.sipService.removeListener('playback_complete', session.playbackCompleteHandler);
            }

            // --- HANGUP FIRST (before any slow async ops) ---
            // Send SIP BYE immediately so the call line is released right away.
            // The recording upload and AI summary happen AFTER the call is hung up.
            try {
                if (session.sipService && reason !== 'call_ended') {
                    console.log(`[SipMediaBridge] Sending SIP BYE immediately (reason: ${reason})`);
                    await session.sipService.hangup(session.sipCallId);
                    console.log(`[SipMediaBridge] SIP BYE sent for ${internalCallId}`);
                }
            } catch (err) {
                console.error(`[SipMediaBridge] Error hanging up SIP:`, err);
            }

            // 3. Stop recording (but don't block the cleanup on S3 upload)
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

            // 5. Update Call record in database (AI summary + DB update)
            try {
                const callInfo = await this.generateCallSummary(conversationLog, reason);

                await Call.findByIdAndUpdate(
                    internalCallId,
                    {
                        status: 'ended',
                        endedAt: new Date(),
                        endedReason: reason,
                        durationSeconds: Math.round(duration),
                        transcript: JSON.stringify(conversationLog),
                        recordingUrl: recordingUrl || undefined,
                        summary: callInfo.summary,
                        leadStatus: callInfo.leadStatus
                    },
                    { upsert: false }
                );
                console.log(`[SipMediaBridge] Call record updated: ${internalCallId}`);

                // 5.5 Update CampaignLead if this was a campaign call
                const callRecord = await Call.findById(internalCallId);
                if (callRecord && callRecord.campaignName) {
                    console.log(`[SipMediaBridge] Updating CampaignLead for campaign: ${callRecord.campaignName}`);
                    
                    // Find the campaign
                    const campaignIds = await Campaign.find({ name: callRecord.campaignName, userId: callRecord.userId }).distinct('_id');

                    // Always increment completedLeads for every call that finishes
                    await Campaign.updateOne(
                        { name: callRecord.campaignName, userId: callRecord.userId },
                        { $inc: { completedLeads: 1 } }
                    );

                    // Update the specific lead record
                    await CampaignLead.updateOne(
                        { 
                            campaignId: { $in: campaignIds },
                            to: callRecord.customer.number,
                            status: 'calling'
                        },
                        {
                            $set: {
                                status: 'completed',
                                callSid: internalCallId,
                                leadType: callInfo.leadType || 'unknown',
                                leadProfile: callInfo.leadProfile || 'unknown',
                                statusClassification: callInfo.statusClassification || callInfo.leadStatus,
                                remark: callInfo.summary,
                                lastCalledAt: new Date()
                            }
                        }
                    );
                }
            } catch (err) {
                console.error(`[SipMediaBridge] Error updating call/campaign records:`, err);
            }

            // 7. Cleanup session
            this.activeSessions.delete(internalCallId);
            this._endingSessions.delete(internalCallId);
            console.log(`[SipMediaBridge] Session ${internalCallId} cleaned up`);

        } catch (error) {
            console.error(`[SipMediaBridge] Error ending session:`, error);
            this.activeSessions.delete(internalCallId);
            this._endingSessions.delete(internalCallId);
        }
    }

    /**
     * Generate AI call summary and determine lead status using Gemini
     */
    async generateCallSummary(conversationLog, reason) {
        if (reason === 'voicemail') {
            return {
                summary: 'Call went to Voicemail / Automated system.',
                leadStatus: 'voicemail',
                leadType: 'Cold',
                leadProfile: 'Unknown',
                statusClassification: 'Voicemail'
            };
        }

        if (!conversationLog || conversationLog.length === 0) {
            return { summary: 'No conversation recorded', leadStatus: 'unknown', leadType: 'Cold', leadProfile: 'Unknown' };
        }

        try {
            // Use the analyzeConversation method from GeminiService (already accessible via orchestrator.gemini)
            // Or create a local orchestrator if we don't have one (though we usually do here)
            const transcriptText = conversationLog
                .map(m => `${m.role === 'user' ? 'Customer' : 'AI Agent'}: ${m.content}`)
                .join('\n');

            const result = await this.recordingService.gemini?.analyzeConversation(conversationLog) || 
                          await this._getStandaloneAnalysis(conversationLog);

            console.log('[SipMediaBridge] AI Call Analysis generated:', result);
            return {
                summary: result.summary || 'Summary unavailable',
                leadStatus: (result.statusClassification || 'unknown').toLowerCase(),
                leadType: result.leadType || 'unknown',
                leadProfile: result.leadProfile || 'unknown',
                statusClassification: result.statusClassification || 'unknown'
            };
        } catch (err) {
            console.error('[SipMediaBridge] Failed to generate AI summary:', err.message);
            return {
                summary: 'Analysis failed',
                leadStatus: 'unknown',
                leadType: 'Unknown',
                leadProfile: 'Unknown'
            };
        }
    }

    async _getStandaloneAnalysis(history) {
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        
        const transcript = history.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
        const prompt = `
            Analyze this phone call transcript. Return ONLY a JSON object with:
            "leadType": "Hot", "Warm", or "Cold".
            "leadProfile": Professions or demographic (e.g. "Doctor").
            "statusClassification": "Interested", "Not Interested", "Follow-up", etc.
            "summary": 1-sentence recap.
            
            Transcript:
            ${transcript}
        `;
        const result = await model.generateContent(prompt);
        const text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(text);
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
