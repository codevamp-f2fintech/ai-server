// Agent Routes - API endpoints for ElevenLabs agent management
// ALL routes require authentication and are scoped to the authenticated user

const express = require('express');
const router = express.Router();
const ElevenLabsAgentClient = require('../clients/elevenlabs-agent-client');
const Agent = require('../models/Agent');
const { authenticate } = require('../middleware/auth');

// Initialize ElevenLabs client
const elevenLabsClient = new ElevenLabsAgentClient(process.env.ELEVENLABS_API_KEY);

// Apply authentication middleware to ALL routes
router.use(authenticate);

/**
 * POST /elevenlabs/agents
 * Create a new ElevenLabs agent for the authenticated user
 */
router.post('/', async (req, res) => {
    try {
        const config = req.body;

        // Validate configuration
        const validation = elevenLabsClient.validateConfig(config);
        if (!validation.valid) {
            return res.status(400).json({
                error: 'Invalid configuration',
                details: validation.errors
            });
        }

        // Create agent in ElevenLabs
        console.log('Creating ElevenLabs agent for user:', req.userId);
        const elevenLabsAgent = await elevenLabsClient.createAgent(config);

        // Save to MongoDB with userId
        const agent = new Agent({
            userId: req.userId, // Associate with authenticated user
            elevenLabsAgentId: elevenLabsAgent.agent_id,
            name: config.name || 'Unnamed Agent',
            configuration: config,
            status: 'active',
            phoneNumberId: config.phoneNumberId || null,
            metadata: {
                description: config.metadata?.description || '',
                tags: config.tags || [],
                createdBy: req.user.email || 'system',
                category: config.metadata?.category || 'other'
            }
        });

        await agent.save();

        console.log('Agent saved to database:', agent._id, 'for user:', req.userId);

        res.status(201).json({
            success: true,
            agent: {
                id: agent._id,
                elevenLabsAgentId: agent.elevenLabsAgentId,
                name: agent.name,
                status: agent.status,
                createdAt: agent.createdAt
            }
        });

    } catch (error) {
        console.error('Error creating agent:', error);
        res.status(500).json({
            error: 'Failed to create agent',
            message: error.message
        });
    }
});

/**
 * GET /elevenlabs/agents
 * List agents for the authenticated user only
 */
router.get('/', async (req, res) => {
    try {
        const {
            page = 1,
            limit = 20,
            status,
            category,
            search
        } = req.query;

        // CRITICAL: Filter by authenticated user's ID
        const query = { userId: req.userId };

        // Additional filters
        if (status) query.status = status;
        if (category) query['metadata.category'] = category;
        if (search) {
            query.$or = [
                { name: { $regex: search, $options: 'i' } },
                { 'metadata.description': { $regex: search, $options: 'i' } }
            ];
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const [agents, total] = await Promise.all([
            Agent.find(query)
                .sort({ 'statistics.lastUsed': -1, createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit))
                .select('-configuration'), // Exclude full config for list view
            Agent.countDocuments(query)
        ]);

        res.json({
            success: true,
            data: agents,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / parseInt(limit))
            }
        });

    } catch (error) {
        console.error('Error listing agents:', error);
        res.status(500).json({
            error: 'Failed to list agents',
            message: error.message
        });
    }
});

/**
 * GET /elevenlabs/agents/sync/from-elevenlabs
 * Fetch all agents directly from ElevenLabs API (not from our database)
 * This is useful for seeing agents created in ElevenLabs dashboard
 */
router.get('/sync/from-elevenlabs', async (req, res) => {
    try {
        console.log('Fetching all agents from ElevenLabs API...');

        // Fetch agents directly from ElevenLabs
        const elevenLabsAgents = await elevenLabsClient.listAgents();

        console.log(`Found ${elevenLabsAgents.length || 0} agents in ElevenLabs`);

        res.json({
            success: true,
            data: elevenLabsAgents,
            count: elevenLabsAgents.length || 0,
            message: 'Agents fetched from ElevenLabs successfully'
        });

    } catch (error) {
        console.error('Error fetching agents from ElevenLabs:', error);
        res.status(500).json({
            error: 'Failed to fetch agents from ElevenLabs',
            message: error.message
        });
    }
});

/**
 * GET /elevenlabs/agents/stats/overview
 * Get overall agent statistics for the authenticated user
 */
router.get('/stats/overview', async (req, res) => {
    try {
        // Filter by user
        const userFilter = { userId: req.userId };

        const [totalAgents, activeAgents, mostUsed] = await Promise.all([
            Agent.countDocuments(userFilter),
            Agent.countDocuments({ ...userFilter, status: 'active' }),
            Agent.find({ ...userFilter, status: 'active' })
                .sort({ 'statistics.totalCalls': -1 })
                .limit(5)
        ]);

        const totalCalls = await Agent.aggregate([
            { $match: userFilter },
            {
                $group: {
                    _id: null,
                    total: { $sum: '$statistics.totalCalls' },
                    successful: { $sum: '$statistics.successfulCalls' },
                    failed: { $sum: '$statistics.failedCalls' }
                }
            }
        ]);

        res.json({
            success: true,
            stats: {
                totalAgents,
                activeAgents,
                totalCalls: totalCalls[0]?.total || 0,
                successfulCalls: totalCalls[0]?.successful || 0,
                failedCalls: totalCalls[0]?.failed || 0,
                mostUsed: mostUsed.map(agent => ({
                    id: agent._id,
                    name: agent.name,
                    calls: agent.statistics.totalCalls
                }))
            }
        });

    } catch (error) {
        console.error('Error getting stats:', error);
        res.status(500).json({
            error: 'Failed to get stats',
            message: error.message
        });
    }
});

/**
 * GET /elevenlabs/agents/schema/template
 * Get configuration schema template
 */
router.get('/schema/template', (req, res) => {
    try {
        const schema = elevenLabsClient.getConfigSchema();
        res.json({
            success: true,
            schema
        });
    } catch (error) {
        res.status(500).json({
            error: 'Failed to get schema',
            message: error.message
        });
    }
});

/**
 * GET /elevenlabs/agents/:id
 * Get a specific agent by ID (only if owned by authenticated user)
 */
router.get('/:id', async (req, res) => {
    try {
        // CRITICAL: Find by ID AND userId to ensure ownership
        const agent = await Agent.findOne({
            _id: req.params.id,
            userId: req.userId
        });

        if (!agent) {
            return res.status(404).json({
                error: 'Agent not found'
            });
        }

        // Optionally fetch latest data from ElevenLabs
        try {
            const elevenLabsAgent = await elevenLabsClient.getAgent(agent.elevenLabsAgentId);
            // Update configuration if changed
            if (JSON.stringify(elevenLabsAgent) !== JSON.stringify(agent.configuration)) {
                agent.configuration = elevenLabsAgent;
                await agent.save();
            }
        } catch (elevenLabsError) {
            console.error('Error syncing with ElevenLabs:', elevenLabsError.message);
            // Continue with local data
        }

        res.json({
            success: true,
            agent
        });

    } catch (error) {
        console.error('Error getting agent:', error);
        res.status(500).json({
            error: 'Failed to get agent',
            message: error.message
        });
    }
});

/**
 * PATCH /elevenlabs/agents/:id
 * Update an existing agent (only if owned by authenticated user)
 */
router.patch('/:id', async (req, res) => {
    try {
        // CRITICAL: Find by ID AND userId to ensure ownership
        const agent = await Agent.findOne({
            _id: req.params.id,
            userId: req.userId
        });

        if (!agent) {
            return res.status(404).json({
                error: 'Agent not found'
            });
        }

        const updates = req.body;

        // Validate if configuration is being updated
        if (updates.configuration) {
            const validation = elevenLabsClient.validateConfig(updates.configuration);
            if (!validation.valid) {
                return res.status(400).json({
                    error: 'Invalid configuration',
                    details: validation.errors
                });
            }

            // Update in ElevenLabs
            await elevenLabsClient.updateAgent(agent.elevenLabsAgentId, updates.configuration);
        }

        // Update local record
        if (updates.name) agent.name = updates.name;
        if (updates.status) agent.status = updates.status;
        if (updates.configuration) agent.configuration = updates.configuration;
        if (updates.phoneNumberId !== undefined) agent.phoneNumberId = updates.phoneNumberId;
        if (updates.metadata) {
            agent.metadata = { ...agent.metadata, ...updates.metadata };
        }

        agent.metadata.version += 1;
        await agent.save();

        res.json({
            success: true,
            agent
        });

    } catch (error) {
        console.error('Error updating agent:', error);
        res.status(500).json({
            error: 'Failed to update agent',
            message: error.message
        });
    }
});

/**
 * DELETE /elevenlabs/agents/:id
 * Delete an agent (only if owned by authenticated user)
 */
router.delete('/:id', async (req, res) => {
    try {
        // CRITICAL: Find by ID AND userId to ensure ownership
        const agent = await Agent.findOne({
            _id: req.params.id,
            userId: req.userId
        });

        if (!agent) {
            return res.status(404).json({
                error: 'Agent not found'
            });
        }

        // Delete from ElevenLabs
        try {
            await elevenLabsClient.deleteAgent(agent.elevenLabsAgentId);
        } catch (elevenLabsError) {
            console.error('Error deleting from ElevenLabs:', elevenLabsError.message);
            // Continue with local deletion
        }

        // Delete from MongoDB
        await Agent.findByIdAndDelete(req.params.id);

        res.json({
            success: true,
            message: 'Agent deleted successfully'
        });

    } catch (error) {
        console.error('Error deleting agent:', error);
        res.status(500).json({
            error: 'Failed to delete agent',
            message: error.message
        });
    }
});

/**
 * POST /elevenlabs/agents/:id/test-call
 * Make a test call with this agent (only if owned by authenticated user)
 */
router.post('/:id/test-call', async (req, res) => {
    try {
        // CRITICAL: Find by ID AND userId to ensure ownership
        const agent = await Agent.findOne({
            _id: req.params.id,
            userId: req.userId
        });

        if (!agent) {
            return res.status(404).json({
                error: 'Agent not found'
            });
        }

        const { to } = req.body;

        if (!to) {
            return res.status(400).json({
                error: 'Phone number required'
            });
        }

        // Initiate outbound call via ElevenLabs
        const callData = await elevenLabsClient.initiateOutboundCall(agent.elevenLabsAgentId, to);

        res.json({
            success: true,
            message: 'Test call initiated',
            agentId: agent._id,
            conversationId: callData.conversation_id,
            to
        });

    } catch (error) {
        console.error('Error making test call:', error);
        res.status(500).json({
            error: 'Failed to make test call',
            message: error.message
        });
    }
});

module.exports = router;
