const mongoose = require('mongoose');
const Agent = require('../models/Agent');
const Call = require('../models/Call');
const PhoneNumber = require('../models/PhoneNumber');
const SipTrunkService = require('./sip-trunk.service');
const TwilioService = require('./twilio.service');
const { getInstance: getSipMediaBridge } = require('./sip-media-bridge');

class CallService {
    /**
     * Executes the outbound calling pipeline for a given user and agent, optionally
     * with variable bindings
     */
    static async makeOutboundCall({ to, agentId, variables, campaignName, userId }) {
        if (!to) throw new Error('Phone number is required');
        if (!agentId) throw new Error('Agent ID is required');

        // Validate ObjectId format
        if (!/^[0-9a-fA-F]{24}$/.test(agentId)) {
            throw new Error('Invalid agent ID format. Must be a valid MongoDB ObjectId.');
        }

        // Verify agent exists and user owns it
        const agent = await Agent.findOne({ _id: agentId, userId });
        if (!agent) {
            throw new Error('Agent not found or you do not have permission to use it');
        }

        if (agent.status !== 'active') {
            throw new Error('Agent is not active');
        }

        // Get the phone number to determine which provider to use
        let phoneNumber = null;
        if (agent.phoneNumberId) {
            phoneNumber = await PhoneNumber.findById(agent.phoneNumberId);
        }

        // Resolve nested configuration and apply {{variable}} substitution
        let actualConfig = agent.configuration || {};
        if (actualConfig.configuration && actualConfig.configuration.voice) {
            actualConfig = actualConfig.configuration;
        }
        if (variables && typeof variables === 'object' && actualConfig.firstMessage) {
            for (const [key, value] of Object.entries(variables)) {
                actualConfig.firstMessage = actualConfig.firstMessage.replace(
                    new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value)
                );
            }
        }
        // Strip any unresolved {{...}} placeholders so agent doesn't say them literally
        if (actualConfig.firstMessage) {
            actualConfig.firstMessage = actualConfig.firstMessage.replace(/\{\{\w+\}\}/g, '').replace(/\s{2,}/g, ' ').trim();
        }

        // --- PRE-FLIGHT TTS HEALTH CHECK ---
        const voiceProvider = (actualConfig.voice?.provider || '11labs').toLowerCase();
        if (voiceProvider === 'chatterbox') {
            const ChatterboxService = require('./chatterbox.service');
            const chatterboxUrl = process.env.CHATTERBOX_BASE_URL || 'http://localhost:4123';
            const chatterboxKey = process.env.CHATTERBOX_API_KEY || null;
            const tts = new ChatterboxService(chatterboxUrl, chatterboxKey);
            const health = await tts.healthCheck();
            if (!health.ok) {
                throw new Error(`TTS Service is currently unavailable. Status: ${health.status}. Call aborted.`);
            }
        } else {
            const ElevenLabsService = require('./elevenlabs.service');
            const elevenlabsKey = process.env.ELEVENLABS_API_KEY;
            if (elevenlabsKey) {
                const tts = new ElevenLabsService(elevenlabsKey);
                const health = await tts.healthCheck();
                if (!health.ok) {
                    throw new Error(`ElevenLabs TTS Service is currently unavailable. Error: ${health.error}. Call aborted.`);
                }
            }
        }

        let call, callRecord;

        // Check if using SIP Trunk
        if (phoneNumber && phoneNumber.provider === 'sip-trunk') {
            console.log('[CallService] Using SIP Trunk provider for outbound call to', to);

            // Create SipTrunkService
            const sipService = SipTrunkService.createFromPhoneNumber(phoneNumber);

            // Generate a unique call ID
            const internalCallId = new mongoose.Types.ObjectId().toString();

            // Get SipMediaBridge instance
            const sipMediaBridge = getSipMediaBridge();

            // Set up event handlers for call lifecycle BEFORE making the call
            sipService.on('answered', async ({ callId, internalCallId: iCallId }) => {
                const apiKeys = {
                    deepgram: process.env.DEEPGRAM_API_KEY,
                    gemini: process.env.GEMINI_API_KEY,
                    elevenlabs: process.env.ELEVENLABS_API_KEY
                };

                try {
                    await sipMediaBridge.startSession(iCallId, sipService, callId, agent, apiKeys, variables);
                } catch (err) {
                    console.error('[CallService] Failed to start media bridge:', err);
                }
            });

            sipService.on('ended', async ({ callId, internalCallId: iCallId }) => {
                await sipMediaBridge.onCallEnded(iCallId);
            });

            // Make call via SIP trunk
            call = await sipService.makeCall(to, internalCallId);

            // Save call to database
            callRecord = new Call({
                _id: internalCallId,
                userId: userId,
                agentId: agent._id,
                agentName: agent.name,
                type: 'outbound',
                customer: { number: to },
                status: 'initiated',
                phoneCallProvider: 'sip-trunk',
                phoneCallProviderId: call.sipCallId,
                phoneCallTransport: 'sip',
                variables: variables || undefined,
                campaignName: campaignName || undefined,
                startedAt: new Date(),
                createdAt: new Date()
            });

        } else {
            console.log('[CallService] Using Twilio provider for outbound call to', to);

            // Create TwilioService with agent's phone number credentials (or fallback to .env)
            const twilioService = await TwilioService.createFromAgent(agent);

            // Make call via Twilio (pass variables as custom params)
            call = await twilioService.makeCall(
                to,
                agentId,
                process.env.BASE_URL,
                variables
            );

            // Save call to database
            callRecord = new Call({
                _id: call.sid,
                userId: userId,
                agentId: agent._id,
                agentName: agent.name,
                type: 'outbound',
                customer: { number: to },
                status: 'initiated',
                phoneCallProvider: 'twilio',
                phoneCallProviderId: call.sid,
                phoneCallTransport: 'pstn',
                variables: variables || undefined,
                campaignName: campaignName || undefined,
                startedAt: new Date(),
                createdAt: new Date()
            });
        }

        await callRecord.save();

        // Update agent statistics
        agent.statistics.lastUsed = new Date();
        await agent.save();

        console.log(`[CallService] Outbound call initiated by user ${userId}: ${callRecord._id}`);

        return {
            sid: callRecord._id,
            to: call.to || to,
            from: call.from || phoneNumber?.number,
            status: call.status,
            agentName: agent.name,
            provider: phoneNumber ? phoneNumber.provider : 'twilio'
        };
    }
}

module.exports = CallService;
