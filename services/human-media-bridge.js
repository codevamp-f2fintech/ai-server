// Human Media Bridge
// Connects SIP RTP audio streams to frontend WebSocket for manual calls
// Acts as the equivalent of SipMediaBridge but streams audio directly to the browser

const { getInstance: getRecordingService } = require('./recording.service');
const Call = require('../models/Call');
const CampaignLead = require('../models/CampaignLead');
const Campaign = require('../models/Campaign');
const { GoogleGenerativeAI } = require('@google/generative-ai');

class HumanMediaBridge {
    constructor() {
        this.activeSessions = new Map(); // internalCallId -> session data
        this._endingSessions = new Set();
        this.recordingService = getRecordingService();

        console.log('[HumanMediaBridge] Initialized');
    }

    /**
     * Start a manual SIP media session
     * @param {string} internalCallId - Our internal call ID
     * @param {SipTrunkService} sipService - The SIP service instance
     * @param {string} sipCallId - SIP Call-ID
     * @param {Object} ws - Frontend WebSocket connection
     */
    async startSession(internalCallId, sipService, sipCallId, ws) {
        console.log(`[HumanMediaBridge] Starting manual session for call ${internalCallId}`);

        try {
            // Check if the session is pre-registered by the route
            let session = this.activeSessions.get(internalCallId);
            if (!session) {
                // If not pre-registered, create it
                session = {
                    internalCallId,
                    sipCallId,
                    sipService,
                    ws: null,
                    startTime: Date.now(),
                    audioPacketCount: 0,
                    wsPacketCount: 0
                };
                this.activeSessions.set(internalCallId, session);
            } else {
                session.sipService = sipService;
                session.sipCallId = sipCallId;
            }

            // Start recording
            this.recordingService.startRecording(internalCallId, {
                provider: 'sip-trunk',
                type: 'manual_human_call'
            });

            this.setupIncomingAudio(session);

            console.log(`[HumanMediaBridge] Manual Session started successfully for ${internalCallId}`);
        } catch (error) {
            console.error(`[HumanMediaBridge] Error starting session:`, error);
            throw error;
        }
    }

    attachWebSocket(internalCallId, ws) {
        let session = this.activeSessions.get(internalCallId);
        if (!session) {
            console.warn(`[HumanMediaBridge] Cannot attach WS, no active session for ${internalCallId}`);
            // Save temporary to buffer? No, if session is missing, call failed.
            return;
        }
        
        session.ws = ws;
        ws.manualSessionId = internalCallId;
        this.setupWebSocketAudio(session);
        console.log(`[HumanMediaBridge] WS Attached to manual session ${internalCallId}`);
    }

    /**
     * Listen to SIP Audio and send to WebSocket
     */
    setupIncomingAudio(session) {
        const { sipService, internalCallId, sipCallId, ws } = session;
        const alawmulaw = require('alawmulaw');

        const audioInHandler = ({ callId, audio, codec }) => {
            if (callId !== sipCallId) return;

            session.audioPacketCount++;

            // Debug occasionally
            if (session.audioPacketCount === 1 || session.audioPacketCount % 200 === 0) {
                console.log(`[HumanMediaBridge] SIP RTP in: packet #${session.audioPacketCount}, bytes: ${audio.length}`);
            }

            // The audio from SipTrunkService is usually A-law (codec 8) or PCMU (codec 0)
            let audioMuLaw = audio;
            if (codec === 8) {
                const pcm = alawmulaw.alaw.decode(audio);
                audioMuLaw = Buffer.from(alawmulaw.mulaw.encode(pcm));
            }

            // Record the caller's audio
            this.recordingService.addAudioChunk(internalCallId, audioMuLaw, 'caller');

            // Send to WebSocket (as raw mu-law base64 string or binary)
            if (ws && ws.readyState === 1) { // WebSocket.OPEN
                // Send as binary
                ws.send(audioMuLaw);
            }
        };

        sipService.on('audio_in', audioInHandler);
        session.audioInHandler = audioInHandler;

        // If the SIP call ends from the other side, tell the websocket
        const playbackCompleteHandler = (completedCallId) => {
             // We can optionally use this, but `ended` event is better
        };
        session.playbackCompleteHandler = playbackCompleteHandler;

        console.log(`[HumanMediaBridge] Incoming SIP audio handler set up for ${internalCallId}`);
    }

    /**
     * Listen to WebSocket Audio and send to SIP
     */
    setupWebSocketAudio(session) {
        const { ws, sipService, sipCallId, internalCallId } = session;

        ws.on('message', (message) => {
            // Assume the message is a raw buffer of mu-law audio
            // from the frontend microphone. 
            // In the frontend useManualCall, we'll convert microphone to 8kHz mu-law and send it via WS.
            
            if (Buffer.isBuffer(message)) {
                session.wsPacketCount++;
                
                if (session.wsPacketCount === 1 || session.wsPacketCount % 200 === 0) {
                    console.log(`[HumanMediaBridge] WS Audio in: packet #${session.wsPacketCount}, bytes: ${message.length}`);
                }

                // Record the agent's audio
                this.recordingService.addAudioChunk(internalCallId, message, 'agent');

                // Send to SIP
                sipService.sendAudio(sipCallId, message);
            } else if (typeof message === 'string') {
                try {
                    const data = JSON.parse(message);
                    if (data.event === 'end') {
                        this.endSession(internalCallId, 'agent_ended');
                    }
                } catch(e) {}
            }
        });

        ws.on('close', () => {
            console.log(`[HumanMediaBridge] WebSocket closed for ${internalCallId}`);
            this.endSession(internalCallId, 'ws_closed');
        });
    }

    /**
     * End a manual session
     */
    async endSession(internalCallId, reason = 'unknown') {
        if (this._endingSessions.has(internalCallId)) return;

        const session = this.activeSessions.get(internalCallId);
        if (!session) return;

        this._endingSessions.add(internalCallId);
        console.log(`[HumanMediaBridge] Ending manual session ${internalCallId}, reason: ${reason}`);

        try {
            if (session.audioInHandler) {
                session.sipService.removeListener('audio_in', session.audioInHandler);
            }

            // Attempt to Hang up SIP
            try {
                if (session.sipService && reason !== 'call_ended') {
                    await session.sipService.hangup(session.sipCallId);
                }
            } catch (err) {
                console.error(`[HumanMediaBridge] Error hanging up SIP:`, err);
            }

            // Close WS if not already closed
            if (session.ws && session.ws.readyState === 1 && reason !== 'ws_closed') {
                session.ws.send(JSON.stringify({ event: 'call_ended', reason }));
                session.ws.close();
            }

            // Stop recording and upload to S3
            let recordingUrl = null;
            try {
                recordingUrl = await this.recordingService.stopAndUpload(internalCallId);
                console.log(`[HumanMediaBridge] Recording uploaded: ${recordingUrl || 'None'}`);
            } catch (err) {
                console.error(`[HumanMediaBridge] Recording upload error:`, err);
            }

            const duration = (Date.now() - session.startTime) / 1000;

            // Generate Call Summary from the final recording directly
            let callInfo = {
                summary: 'Manual Call Summary unavailable',
                leadStatus: 'unknown',
                leadType: 'unknown',
                leadProfile: 'unknown',
                statusClassification: 'unknown'
            };

            // Post-call Transcribe + Summary
            if (recordingUrl) {
                 callInfo = await this.analyzeRecording(recordingUrl);
            }

            // Update call DB
            try {
                const callRecord = await Call.findByIdAndUpdate(
                    internalCallId,
                    {
                        status: 'ended',
                        endedAt: new Date(),
                        endedReason: reason,
                        durationSeconds: Math.round(duration),
                        recordingUrl: recordingUrl || undefined,
                        summary: callInfo.summary,
                        leadStatus: callInfo.leadStatus
                    },
                    { upsert: false }
                );

                if (callRecord && callRecord.campaignName) {
                    const campaignIds = await Campaign.find({ name: callRecord.campaignName, userId: callRecord.userId }).distinct('_id');

                    await Campaign.updateOne(
                        { name: callRecord.campaignName, userId: callRecord.userId },
                        { $inc: { completedLeads: 1 } }
                    );

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
                console.error(`[HumanMediaBridge] Error updating DB:`, err);
            }

            this.activeSessions.delete(internalCallId);
            this._endingSessions.delete(internalCallId);

        } catch (error) {
            console.error(`[HumanMediaBridge] Session end error:`, error);
            this.activeSessions.delete(internalCallId);
            this._endingSessions.delete(internalCallId);
        }
    }

    async analyzeRecording(recordingUrl) {
        try {
            const DeepgramService = require('./deepgram.service');
            const dgService = new DeepgramService(process.env.DEEPGRAM_API_KEY);
            
            console.log(`[HumanMediaBridge] Fetching recording for transcription: ${recordingUrl}`);
            const axios = require('axios');
            const audioData = await axios.get(recordingUrl, { responseType: 'arraybuffer' });
            
            const transcript = await dgService.transcribeFile(audioData.data, { language: 'hi' });
            console.log(`[HumanMediaBridge] Full call transcript: ${transcript}`);

            if (!transcript) {
                return { summary: 'No speech detected.', leadStatus: 'unknown', leadType: 'unknown', leadProfile: 'unknown', statusClassification: 'unknown' };
            }

            const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
            const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
            
            const prompt = `
                Analyze this phone call transcript (which may contain both the human agent and the customer talking). 
                Return ONLY a JSON object with:
                "leadType": "Hot", "Warm", or "Cold".
                "leadProfile": Professions or demographic (e.g. "Doctor").
                "statusClassification": "Interested", "Not Interested", "Follow-up", etc.
                "summary": 1-2 sentence recap.
                
                Transcript:
                ${transcript}
            `;
            const result = await model.generateContent(prompt);
            const text = result.response.text().replace(/\`\`\`json/g, '').replace(/\`\`\`/g, '').trim();
            return JSON.parse(text);
        } catch (error) {
            console.error(`[HumanMediaBridge] Error analyzing recording:`, error);
            return {
                summary: 'Analysis failed',
                leadStatus: 'unknown',
                leadType: 'unknown',
                leadProfile: 'unknown',
                statusClassification: 'unknown'
            };
        }
    }

    async onCallEnded(internalCallId) {
        await this.endSession(internalCallId, 'call_ended');
    }
}

// Singleton
let instance = null;
function getInstance() {
    if (!instance) instance = new HumanMediaBridge();
    return instance;
}

module.exports = { HumanMediaBridge, getInstance };
