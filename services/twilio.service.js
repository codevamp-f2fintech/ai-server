// Twilio Integration Service
// Handles phone calls and media streaming

const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;

class TwilioService {
    constructor(accountSid, authToken, phoneNumber) {
        this.client = twilio(accountSid, authToken);
        this.phoneNumber = phoneNumber;
        this.activeCalls = new Map(); // callSid -> conversation session
    }

    /**
     * Create TwilioService from environment variables
     * @returns {TwilioService}
     */
    static createFromEnv() {
        return new TwilioService(
            process.env.TWILIO_ACCOUNT_SID,
            process.env.TWILIO_AUTH_TOKEN,
            process.env.TWILIO_PHONE_NUMBER
        );
    }

    /**
     * Create TwilioService from a PhoneNumber document
     * @param {Object} phoneNumber - PhoneNumber model instance
     * @returns {TwilioService}
     */
    static createFromPhoneNumber(phoneNumber) {
        if (!phoneNumber) {
            throw new Error('Phone number is required');
        }

        if (phoneNumber.provider !== 'twilio') {
            throw new Error(`Phone number provider is ${phoneNumber.provider}, expected twilio`);
        }

        if (!phoneNumber.twilioAccountSid || !phoneNumber.twilioAuthToken) {
            throw new Error('Phone number missing Twilio credentials');
        }

        return new TwilioService(
            phoneNumber.twilioAccountSid,
            phoneNumber.twilioAuthToken,
            phoneNumber.number
        );
    }

    /**
     * Create TwilioService from an Agent
     * Fetches the agent's phone number and creates service with those credentials
     * Falls back to .env if no phone number is configured
     * @param {Object} agent - Agent model instance
     * @returns {Promise<TwilioService>}
     */
    static async createFromAgent(agent) {
        if (!agent) {
            throw new Error('Agent is required');
        }

        // If agent has a phone number configured, use it
        if (agent.phoneNumberId) {
            const PhoneNumber = require('../models/PhoneNumber');
            const phoneNumber = await PhoneNumber.findById(agent.phoneNumberId);

            if (!phoneNumber) {
                console.warn(`[TwilioService] Agent ${agent._id} references non-existent phone number ${agent.phoneNumberId}, falling back to .env`);
                return TwilioService.createFromEnv();
            }

            if (phoneNumber.status !== 'active') {
                console.warn(`[TwilioService] Agent ${agent._id} phone number is inactive, falling back to .env`);
                return TwilioService.createFromEnv();
            }

            console.log(`[TwilioService] Using phone number ${phoneNumber.number} for agent ${agent._id}`);
            return TwilioService.createFromPhoneNumber(phoneNumber);
        }

        // Fallback to environment variables
        console.log(`[TwilioService] No phone number configured for agent ${agent._id}, using .env credentials`);
        return TwilioService.createFromEnv();
    }

    /**
     * Make an outbound call
     * @param {string} to - Phone number to call
     * @param {string} agentId - Agent ID to use
     * @param {string} webhookUrl - Base URL for webhooks
     * @returns {Promise<Object>} - Call object
     */
    async makeCall(to, agentId, webhookUrl) {
        try {
            console.log(`[Twilio] Making call to ${to} with agent ${agentId}`);

            const call = await this.client.calls.create({
                to,
                from: this.phoneNumber,
                url: `${webhookUrl}/webhooks/twilio/voice?agentId=${agentId}`,
                statusCallback: `${webhookUrl}/webhooks/twilio/status`,
                statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
                record: true, // Enable recording
                recordingStatusCallback: `${webhookUrl}/webhooks/twilio/recording`
            });

            console.log(`[Twilio] Call initiated: ${call.sid}`);
            return call;

        } catch (error) {
            console.error('[Twilio] Error making call:', error);
            throw error;
        }
    }

    /**
     * Generate TwiML response to connect call to media stream
     * @param {string} streamUrl - WebSocket URL for media stream
     * @param {Object} customParameters - Parameters to pass to stream
     * @returns {string} - TwiML XML
     */
    generateStreamTwiML(streamUrl, customParameters = {}) {
        const response = new VoiceResponse();

        // Start the stream
        const connect = response.connect();
        const stream = connect.stream({
            url: streamUrl
        });

        // Add custom parameters (must be added individually for TwiML)
        for (const [key, value] of Object.entries(customParameters)) {
            stream.parameter({ name: key, value: String(value) });
        }

        return response.toString();
    }

    /**
     * Generate TwiML for incoming call
     * @param {string} agentId - Agent to use
     * @param {string} streamUrl - WebSocket URL
     * @returns {string} - TwiML XML
     */
    generateIncomingCallTwiML(agentId, streamUrl, callSid) {
        const response = new VoiceResponse();

        // Optional: Play greeting before connecting stream
        // response.say({ voice: 'alice' }, 'Please wait while we connect you.');

        const connect = response.connect();
        connect.stream({
            url: streamUrl,
            parameters: {
                agentId,
                callSid,
                direction: 'inbound'
            }
        });

        return response.toString();
    }

    /**
     * Hangup a call
     * @param {string} callSid - Call SID
     */
    async hangupCall(callSid) {
        try {
            await this.client.calls(callSid).update({ status: 'completed' });
            console.log(`[Twilio] Call hung up: ${callSid}`);
        } catch (error) {
            console.error('[Twilio] Error hanging up call:', error);
            throw error;
        }
    }

    /**
     * Get call details
     * @param {string} callSid - Call SID
     * @returns {Promise<Object>} - Call details
     */
    async getCallDetails(callSid) {
        try {
            return await this.client.calls(callSid).fetch();
        } catch (error) {
            console.error('[Twilio] Error fetching call details:', error);
            throw error;
        }
    }

    /**
     * Get recording URL
     * @param {string} recordingSid - Recording SID
     * @returns {Promise<string>} - Recording URL
     */
    async getRecordingUrl(recordingSid) {
        try {
            const recording = await this.client.recordings(recordingSid).fetch();
            return `https://api.twilio.com${recording.uri.replace('.json', '.mp3')}`;
        } catch (error) {
            console.error('[Twilio] Error fetching recording:', error);
            throw error;
        }
    }

    /**
     * Convert μ-law audio to PCM
     * Twilio sends audio in μ-law format, need to convert to PCM for Deepgram
     * @param {Buffer} mulawBuffer - μ-law audio buffer
     * @returns {Buffer} - PCM audio buffer
     */
    convertMulawToPCM(mulawBuffer) {
        // μ-law to linear PCM conversion table
        const MULAW_TABLE = this.generateMulawTable();

        const pcmBuffer = Buffer.alloc(mulawBuffer.length * 2);

        for (let i = 0; i < mulawBuffer.length; i++) {
            const sample = MULAW_TABLE[mulawBuffer[i]];
            pcmBuffer.writeInt16LE(sample, i * 2);
        }

        return pcmBuffer;
    }

    /**
     * Convert PCM to μ-law
     * Need to send audio back to Twilio in μ-law format
     * @param {Buffer} pcmBuffer - PCM audio buffer
     * @returns {Buffer} - μ-law audio buffer
     */
    convertPCMToMulaw(pcmBuffer) {
        const mulawBuffer = Buffer.alloc(pcmBuffer.length / 2);

        for (let i = 0; i < mulawBuffer.length; i++) {
            const sample = pcmBuffer.readInt16LE(i * 2);
            mulawBuffer[i] = this.linearToMulaw(sample);
        }

        return mulawBuffer;
    }

    /**
     * Generate μ-law conversion table
     */
    generateMulawTable() {
        const table = new Int16Array(256);
        for (let i = 0; i < 256; i++) {
            table[i] = this.mulawToLinear(i);
        }
        return table;
    }

    /**
     * Convert μ-law to linear PCM
     */
    mulawToLinear(mulaw) {
        const BIAS = 0x84;
        const CLIP = 32635;

        mulaw = ~mulaw;
        const sign = mulaw & 0x80;
        const exponent = (mulaw >> 4) & 0x07;
        const mantissa = mulaw & 0x0F;

        let sample = mantissa << (exponent + 3);
        sample += BIAS << exponent;
        if (exponent === 0) sample += BIAS;

        return sign === 0 ? sample : -sample;
    }

    /**
     * Convert linear PCM to μ-law
     */
    linearToMulaw(sample) {
        const BIAS = 0x84;
        const CLIP = 32635;
        const TABLE = [0, 0, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3,
            4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4];

        const sign = sample < 0 ? 0x80 : 0;
        sample = Math.abs(sample);

        if (sample > CLIP) sample = CLIP;
        sample = sample + BIAS;

        const exponent = TABLE[(sample >> 7) & 0xFF];
        const mantissa = (sample >> (exponent + 3)) & 0x0F;
        const mulaw = ~(sign | (exponent << 4) | mantissa);

        return mulaw & 0xFF;
    }

    /**
     * Register active call session
     */
    registerCallSession(callSid, session) {
        this.activeCalls.set(callSid, session);
    }

    /**
     * Get active call session
     */
    getCallSession(callSid) {
        return this.activeCalls.get(callSid);
    }

    /**
     * Remove call session
     */
    removeCallSession(callSid) {
        this.activeCalls.delete(callSid);
    }
}

module.exports = TwilioService;
