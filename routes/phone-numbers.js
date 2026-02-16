// Phone Number Routes - API endpoints for managing ElevenLabs phone numbers
// REQUIRES AUTHENTICATION

const express = require('express');
const router = express.Router();
const ElevenLabsAgentClient = require('../clients/elevenlabs-agent-client');
const { authenticate } = require('../middleware/auth');
const Agent = require('../models/Agent');

// Apply authentication middleware to ALL routes
router.use(authenticate);

// Initialize ElevenLabs client
const elevenLabsClient = new ElevenLabsAgentClient(process.env.ELEVENLABS_API_KEY);

/**
 * GET /elevenlabs/phone-numbers
 * List all phone numbers with their assigned agents
 */
router.get('/', async (req, res) => {
    try {
        const phoneNumbers = await elevenLabsClient.getPhoneNumbers();

        // Enrich with agent info from our database
        const enrichedNumbers = await Promise.all(
            phoneNumbers.map(async (pn) => {
                let agentInfo = null;
                if (pn.agent_id) {
                    // Find agent in our database by elevenLabsAgentId
                    const agent = await Agent.findOne({
                        elevenLabsAgentId: pn.agent_id,
                        userId: req.userId
                    }).select('name _id');

                    if (agent) {
                        agentInfo = {
                            id: agent._id,
                            name: agent.name
                        };
                    }
                }

                return {
                    id: pn.phone_number_id,
                    number: pn.phone_number,
                    name: pn.name,
                    provider: pn.provider || 'twilio',
                    agentId: pn.agent_id,
                    agent: agentInfo,
                    createdAt: pn.created_at
                };
            })
        );

        res.json({
            success: true,
            phoneNumbers: enrichedNumbers,
            count: enrichedNumbers.length
        });
    } catch (error) {
        console.error('Error listing phone numbers:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /elevenlabs/phone-numbers/twilio
 * Import a Twilio phone number to ElevenLabs
 */
router.post('/twilio', async (req, res) => {
    try {
        const { number, twilioAccountSid, twilioAuthToken, name, agentId } = req.body;

        if (!number || !twilioAccountSid || !twilioAuthToken) {
            return res.status(400).json({
                success: false,
                message: 'Phone number, Twilio Account SID, and Auth Token are required'
            });
        }

        // If agentId is provided, verify ownership and get elevenLabsAgentId
        let elevenLabsAgentId = null;
        if (agentId) {
            const agent = await Agent.findOne({ _id: agentId, userId: req.userId });
            if (!agent) {
                return res.status(404).json({
                    success: false,
                    message: 'Agent not found'
                });
            }
            elevenLabsAgentId = agent.elevenLabsAgentId;

            // Update agent's phoneNumberId will be done after phone number creation
        }

        const config = {
            phone_number: number,
            twilioAccountSid,
            twilioAuthToken,
            name: name || `Twilio ${number}`,
            agent_id: elevenLabsAgentId
        };

        console.log('User', req.userId, 'importing Twilio number:', number);

        const phoneNumber = await elevenLabsClient.addPhoneNumber(config);

        // If we assigned to an agent, update the agent record
        if (agentId && phoneNumber.phone_number_id) {
            await Agent.findByIdAndUpdate(agentId, {
                phoneNumberId: phoneNumber.phone_number_id
            });
        }

        res.json({ success: true, phoneNumber });
    } catch (error) {
        console.error('Error importing Twilio number:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * PATCH /elevenlabs/phone-numbers/:id/assign
 * Assign a phone number to an agent
 */
router.patch('/:id/assign', async (req, res) => {
    try {
        const { id } = req.params;
        const { agentId } = req.body;

        let elevenLabsAgentId = null;
        let agent = null;

        if (agentId) {
            // Verify user owns this agent
            agent = await Agent.findOne({ _id: agentId, userId: req.userId });
            if (!agent) {
                return res.status(404).json({
                    success: false,
                    message: 'Agent not found'
                });
            }
            elevenLabsAgentId = agent.elevenLabsAgentId;
        }

        // Update in ElevenLabs
        const phoneNumber = await elevenLabsClient.updatePhoneNumber(id, {
            agent_id: elevenLabsAgentId
        });

        // Update agent record with phone number ID
        if (agent) {
            agent.phoneNumberId = id;
            await agent.save();
        }

        res.json({
            success: true,
            phoneNumber,
            message: agentId ? 'Phone number assigned to agent' : 'Phone number unassigned'
        });
    } catch (error) {
        console.error('Error assigning phone number:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * DELETE /elevenlabs/phone-numbers/:id
 * Delete a phone number
 */
router.delete('/:id', async (req, res) => {
    try {
        console.log('User', req.userId, 'deleting phone number:', req.params.id);

        // Also remove from any agent that has this phone number
        await Agent.updateMany(
            { phoneNumberId: req.params.id, userId: req.userId },
            { $unset: { phoneNumberId: 1 } }
        );

        await elevenLabsClient.deletePhoneNumber(req.params.id);
        res.json({ success: true, message: 'Phone number deleted' });
    } catch (error) {
        console.error('Error deleting phone number:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
