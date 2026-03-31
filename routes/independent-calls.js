// Independent Call Routes - Replaces VAPI dependency
// Handles outbound/inbound calls using our own voice pipeline

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const Agent = require('../models/Agent');
const TwilioService = require('../services/twilio.service');

// TwilioService instances are now created dynamically per request based on agent's phone number
// SipTrunkService is used for SIP trunk providers

const PhoneNumber = require('../models/PhoneNumber');
const SipTrunkService = require('../services/sip-trunk.service');

/**
 * POST /api/independent-calls/outbound
 * Make an outbound call using independent voice pipeline (no VAPI)
 * Supports both Twilio and SIP Trunk providers
 */
router.post('/outbound', authenticate, async (req, res) => {
    try {
        const { to, agentId, variables, campaignName } = req.body;
        const CallService = require('../services/call.service');

        const callData = await CallService.makeOutboundCall({
            to,
            agentId,
            variables,
            campaignName,
            userId: req.userId
        });

        res.json({
            success: true,
            call: callData
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
        const { agentId, variables: variablesParam } = req.query;
        const { CallSid, From, To, Direction } = req.body;

        console.log(`[IndependentCalls] Call webhook: ${CallSid}, Direction: ${Direction}, Agent: ${agentId}`);

        // Parse variables from query string if present
        let variables = {};
        if (variablesParam) {
            try { variables = JSON.parse(variablesParam); } catch (e) { /* ignore */ }
        }

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

        // Generate TwiML to connect to media stream (pass variables as custom params)
        const customParams = {
            agentId,
            callSid: CallSid,
            direction: Direction
        };
        if (Object.keys(variables).length > 0) {
            customParams.variables = JSON.stringify(variables);
        }
        const twiml = twilioService.generateStreamTwiML(streamUrl, customParams);

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
