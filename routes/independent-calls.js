// Independent Call Routes - Replaces VAPI dependency
// Handles outbound/inbound calls using our own voice pipeline

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const Agent = require('../models/Agent');
const TwilioService = require('../services/twilio.service');

// TwilioService instances are now created dynamically per request based on agent's phone number

/**
 * POST /api/independent-calls/outbound
 * Make an outbound call using independent voice pipeline (no VAPI)
 */
router.post('/outbound', authenticate, async (req, res) => {
    try {
        const { to, agentId } = req.body;

        if (!to) {
            return res.status(400).json({ error: 'Phone number is required' });
        }

        if (!agentId) {
            return res.status(400).json({ error: 'Agent ID is required' });
        }

        // Debug logging
        console.log('[IndependentCalls] Received agentId:', agentId, 'Type:', typeof agentId);

        // Validate ObjectId format
        if (!/^[0-9a-fA-F]{24}$/.test(agentId)) {
            console.log('[IndependentCalls] Invalid agentId format! Does not match MongoDB ObjectId pattern');
            return res.status(400).json({
                error: 'Invalid agent ID format',
                message: 'Agent ID must be a valid MongoDB ObjectId. Please select a valid agent from the dropdown.'
            });
        }

        // Verify agent exists and user owns it
        const agent = await Agent.findOne({ _id: agentId, userId: req.userId });
        console.log("[IndependentCalls] Agent found:", agent);
        if (!agent) {
            return res.status(404).json({ error: 'Agent not found or you do not have permission to use it' });
        }

        if (agent.status !== 'active') {
            return res.status(400).json({ error: 'Agent is not active' });
        }

        // Create TwilioService with agent's phone number credentials (or fallback to .env)
        const twilioService = await TwilioService.createFromAgent(agent);

        // Make call via Twilio
        const call = await twilioService.makeCall(
            to,
            agentId,
            process.env.BASE_URL
        );

        // Save call to database
        const Call = require('../models/Call');
        const callRecord = new Call({
            _id: call.sid,
            userId: req.userId,
            agentId: agent._id,
            agentName: agent.name,
            type: 'outbound',
            customer: { number: to },
            status: 'initiated',
            phoneCallProvider: 'twilio',
            phoneCallProviderId: call.sid,
            phoneCallTransport: 'pstn',
            startedAt: new Date(),
            createdAt: new Date()
        });

        await callRecord.save();

        // Update agent statistics
        agent.statistics.lastUsed = new Date();
        await agent.save();

        console.log(`[IndependentCalls] Outbound call initiated by user ${req.userId}: ${call.sid}`);

        res.json({
            success: true,
            call: {
                sid: call.sid,
                to: call.to,
                from: call.from,
                status: call.status,
                agentName: agent.name
            }
        });

    } catch (error) {
        console.error('[IndependentCalls] Error making outbound call:', error);
        res.status(500).json({
            error: 'Failed to make call',
            message: error.message
        });
    }
});

/**
 * POST /webhooks/twilio/voice
 * Twilio webhook for incoming/outbound call setup
 */
router.post('/webhooks/twilio/voice', async (req, res) => {
    try {
        const { agentId } = req.query;
        const { CallSid, From, To, Direction } = req.body;

        console.log(`[IndependentCalls] Call webhook: ${CallSid}, Direction: ${Direction}, Agent: ${agentId}`);

        // Load agent
        const agent = await Agent.findById(agentId);
        if (!agent) {
            console.error(`[IndependentCalls] Agent not found: ${agentId}`);
            return res.status(404).send('Agent not found');
        }

        // Create TwilioService with agent's credentials
        const twilioService = await TwilioService.createFromAgent(agent);

        // Generate WebSocket URL from BASE_URL
        const baseUrl = process.env.BASE_URL || `http://${req.get('host')}`;
        const wsProtocol = baseUrl.startsWith('https') ? 'wss' : 'ws';
        const domain = baseUrl.replace(/^https?:\/\//, '');
        const streamUrl = `${wsProtocol}://${domain}/ws/media-stream`;

        console.log(`[IndependentCalls] WebSocket URL: ${streamUrl}`);

        // Generate TwiML to connect to media stream
        const twiml = twilioService.generateStreamTwiML(streamUrl, {
            agentId,
            callSid: CallSid,
            direction: Direction
        });

        res.type('text/xml');
        res.send(twiml);

    } catch (error) {
        console.error('[IndependentCalls] Error in voice webhook:', error);
        res.status(500).send('Error processing call');
    }
});

/**
 * POST /webhooks/twilio/status
 * Twilio webhook for call status updates
 */
router.post('/webhooks/twilio/status', async (req, res) => {
    try {
        const { CallSid, CallStatus, CallDuration } = req.body;

        console.log(`[IndependentCalls] Status update: ${CallSid} -> ${CallStatus}`);

        const Call = require('../models/Call');

        const updateData = {
            status: CallStatus.toLowerCase(),
            updatedAt: new Date()
        };

        if (CallStatus === 'completed' && CallDuration) {
            updateData.endedAt = new Date();
            updateData.cost = parseFloat(CallDuration) * 0.013; // Estimate cost
        }

        await Call.findByIdAndUpdate(CallSid, updateData);

        res.sendStatus(200);

    } catch (error) {
        console.error('[IndependentCalls] Error in status webhook:', error);
        res.sendStatus(200); // Always respond 200 to Twilio
    }
});

/**
 * POST /webhooks/twilio/recording
 * Twilio webhook for call recording
 */
router.post('/webhooks/twilio/recording', async (req, res) => {
    try {
        const { CallSid, RecordingSid, RecordingUrl } = req.body;

        console.log(`[IndependentCalls] Recording available: ${RecordingSid}`);

        const Call = require('../models/Call');
        await Call.findByIdAndUpdate(CallSid, {
            recordingUrl: RecordingUrl,
            updatedAt: new Date()
        });

        res.sendStatus(200);

    } catch (error) {
        console.error('[IndependentCalls] Error in recording webhook:', error);
        res.sendStatus(200);
    }
});

/**
 * GET /api/independent-calls/:callId
 * Get call details
 */
router.get('/:callId', authenticate, async (req, res) => {
    try {
        const Call = require('../models/Call');

        const call = await Call.findOne({
            _id: req.params.callId,
            userId: req.userId
        });

        if (!call) {
            return res.status(404).json({ error: 'Call not found' });
        }

        res.json({
            success: true,
            call
        });

    } catch (error) {
        console.error('[IndependentCalls] Error fetching call:', error);
        res.status(500).json({
            error: 'Failed to fetch call',
            message: error.message
        });
    }
});

/**
 * POST /api/independent-calls/:callId/end
 * End an active call
 */
router.post('/:callId/end', authenticate, async (req, res) => {
    try {
        const Call = require('../models/Call');

        const call = await Call.findOne({
            _id: req.params.callId,
            userId: req.userId
        });

        if (!call) {
            return res.status(404).json({ error: 'Call not found' });
        }

        // Load agent to get phone number credentials
        const agent = await Agent.findById(call.agentId);
        if (!agent) {
            return res.status(404).json({ error: 'Agent not found for this call' });
        }

        // Create TwilioService with agent's credentials
        const twilioService = await TwilioService.createFromAgent(agent);

        // Hangup via Twilio
        await twilioService.hangupCall(call._id);

        res.json({
            success: true,
            message: 'Call ended'
        });

    } catch (error) {
        console.error('[IndependentCalls] Error ending call:', error);
        res.status(500).json({
            error: 'Failed to end call',
            message: error.message
        });
    }
});

/**
 * GET /api/independent-calls/:callId/recording
 * Proxy endpoint to fetch Twilio recording without browser auth prompt
 */
router.get('/:callId/recording', authenticate, async (req, res) => {
    try {
        const Call = require('../models/Call');
        const axios = require('axios');

        const call = await Call.findOne({
            _id: req.params.callId,
            userId: req.userId
        });

        if (!call) {
            return res.status(404).json({ error: 'Call not found' });
        }

        if (!call.recordingUrl) {
            return res.status(404).json({ error: 'Recording not available' });
        }

        // Load agent to get phone number credentials
        const agent = await Agent.findById(call.agentId);
        if (!agent) {
            return res.status(404).json({ error: 'Agent not found for this call' });
        }

        // Get Twilio credentials from agent's phone number or fallback to .env
        let twilioAccountSid, twilioAuthToken;
        if (agent.phoneNumberId) {
            const PhoneNumber = require('../models/PhoneNumber');
            const phoneNumber = await PhoneNumber.findById(agent.phoneNumberId);

            if (phoneNumber && phoneNumber.provider === 'twilio') {
                twilioAccountSid = phoneNumber.twilioAccountSid;
                twilioAuthToken = phoneNumber.twilioAuthToken;
            } else {
                // Fallback to .env
                twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
                twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
            }
        } else {
            // No phone number configured, use .env
            twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
            twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
        }

        // Fetch recording from Twilio with authentication
        const response = await axios.get(call.recordingUrl, {
            auth: {
                username: process.env.TWILIO_ACCOUNT_SID,
                password: process.env.TWILIO_AUTH_TOKEN
            },
            responseType: 'stream'
        });

        // Set appropriate headers
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Disposition', `inline; filename="recording-${req.params.callId}.mp3"`);

        // Stream the recording to the client
        response.data.pipe(res);

    } catch (error) {
        console.error('[IndependentCalls] Error fetching recording:', error);
        res.status(500).json({
            error: 'Failed to fetch recording',
            message: error.message
        });
    }
});


module.exports = router;
