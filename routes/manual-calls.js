const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const mongoose = require('mongoose');
const Agent = require('../models/Agent');
const Call = require('../models/Call');
const PhoneNumber = require('../models/PhoneNumber');
const SipTrunkService = require('../services/sip-trunk.service');
const { getInstance: getHumanMediaBridge } = require('../services/human-media-bridge');

/**
 * POST /api/manual-calls/start
 * Starts a manual call. Bridges to WebSocket instead of AI orchestrator.
 */
router.post('/start', authenticate, async (req, res) => {
    try {
        const { to, agentId, variables, campaignName } = req.body;
        
        if (!to) throw new Error('Phone number is required');
        if (!agentId) throw new Error('Agent ID is required');

        // Verify agent exists and user owns it
        const agent = await Agent.findOne({ _id: agentId, userId: req.userId });
        if (!agent) {
            throw new Error('Agent not found or you do not have permission to use it');
        }

        if (agent.status !== 'active') {
            throw new Error('Agent is not active');
        }

        let phoneNumber = null;
        if (agent.phoneNumberId) {
            phoneNumber = await PhoneNumber.findById(agent.phoneNumberId);
        }

        if (!phoneNumber || phoneNumber.provider !== 'sip-trunk') {
            throw new Error('Agent must be configured with a SIP Trunk for manual calls');
        }

        console.log('[ManualCall] Starting manual call to', to);

        const sipService = SipTrunkService.createFromPhoneNumber(phoneNumber);
        const internalCallId = new mongoose.Types.ObjectId().toString();
        const humanMediaBridge = getHumanMediaBridge();

        // Register answered event — initialize the bridge session so audio_in listener is active
        sipService.on('answered', async ({ callId: sipCallId, internalCallId: iCallId }) => {
            console.log(`[ManualCall] SIP Answered for ${iCallId}, starting HumanMediaBridge session`);
            try {
                // startSession sets up the audio_in handler (SIP → WS).
                // WS is null here — it will be attached later via attachWebSocket() when the
                // frontend opens the WebSocket and sends the init frame.
                await humanMediaBridge.startSession(iCallId, sipService, sipCallId, null);
            } catch (err) {
                console.error('[ManualCall] Failed to start HumanMediaBridge session:', err);
            }
        });

        sipService.on('ended', async ({ callId, internalCallId: iCallId }) => {
            await humanMediaBridge.onCallEnded(iCallId);
        });

        // Make call via SIP trunk
        const call = await sipService.makeCall(to, internalCallId);

        // Pre-register the session in bridge so websocket can attach to it
        humanMediaBridge.activeSessions.set(internalCallId, {
            internalCallId,
            sipCallId: call.sipCallId,
            sipService,
            ws: null, // Will be set when WS connects
            startTime: Date.now(),
            audioPacketCount: 0,
            wsPacketCount: 0
        });

        // Save call to database
        const callRecord = new Call({
            _id: internalCallId,
            userId: req.userId,
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

        await callRecord.save();
        
        // Update agent statistics
        agent.statistics.lastUsed = new Date();
        await agent.save();

        res.json({
            success: true,
            internalCallId,
            sipCallId: call.sipCallId,
            to: call.to || to
        });
    } catch (error) {
        console.error('[ManualCall] Error starting manual call:', error);
        res.status(500).json({ error: 'Failed to start manual call', message: error.message });
    }
});

/**
 * POST /api/manual-calls/end
 * Hang up the manual call
 */
router.post('/end', authenticate, async (req, res) => {
    try {
        const { internalCallId } = req.body;
        if (!internalCallId) throw new Error('Missing internalCallId');

        const humanMediaBridge = getHumanMediaBridge();
        await humanMediaBridge.endSession(internalCallId, 'agent_ended');

        res.json({ success: true });
    } catch(err) {
        console.error('[ManualCall] Error ending call:', err);
        res.status(500).json({ error: 'Failed to end call', message: err.message });
    }
});

module.exports = router;
