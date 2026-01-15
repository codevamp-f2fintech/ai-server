// Agent Routes - API endpoints for VAPI agent management

const express = require('express');
const router = express.Router();
const VapiClient = require('../clients/vapi-client');
const Agent = require('../models/Agent');

// Initialize VAPI client
const vapiClient = new VapiClient(process.env.VAPI_KEY);

/**
 * POST /vapi/agents
 * Create a new VAPI agent
 */
router.post('/', async (req, res) => {
    try {
        const config = req.body;

        // Validate configuration
        const validation = vapiClient.validateConfig(config);
        if (!validation.valid) {
            return res.status(400).json({
                error: 'Invalid configuration',
                details: validation.errors
            });
        }

        // Create a VAPI-specific config object by removing internal fields
        const vapiConfig = { ...config };
        delete vapiConfig.status;

        // Create assistant in VAPI
        console.log('Creating VAPI assistant...');
        const vapiAssistant = await vapiClient.createAssistant(vapiConfig);

        // Save to MongoDB
        const agent = new Agent({
            vapiAssistantId: vapiAssistant.id,
            name: config.name || 'Unnamed Agent',
            configuration: config,
            status: 'active',
            metadata: {
                description: config.metadata?.description || '',
                tags: config.metadata?.tags || [],
                createdBy: config.metadata?.createdBy || 'system',
                category: config.metadata?.category || 'other'
            }
        });

        await agent.save();

        console.log('Agent saved to database:', agent._id);

        res.status(201).json({
            success: true,
            agent: {
                id: agent._id,
                vapiAssistantId: agent.vapiAssistantId,
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
 * GET /vapi/agents
 * List all agents with pagination and filters
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

        const query = {};

        // Filters
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
 * GET /vapi/agents/:id
 * Get a specific agent by ID
 */
router.get('/:id', async (req, res) => {
    try {
        const agent = await Agent.findById(req.params.id);

        if (!agent) {
            return res.status(404).json({
                error: 'Agent not found'
            });
        }

        // Optionally fetch latest data from VAPI
        try {
            const vapiAssistant = await vapiClient.getAssistant(agent.vapiAssistantId);
            // Update configuration if changed
            if (JSON.stringify(vapiAssistant) !== JSON.stringify(agent.configuration)) {
                agent.configuration = vapiAssistant;
                await agent.save();
            }
        } catch (vapiError) {
            console.error('Error syncing with VAPI:', vapiError.message);
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
 * PATCH /vapi/agents/:id
 * Update an existing agent
 */
router.patch('/:id', async (req, res) => {
    try {
        const agent = await Agent.findById(req.params.id);

        if (!agent) {
            return res.status(404).json({
                error: 'Agent not found'
            });
        }

        const updates = req.body;

        // Validate if configuration is being updated
        if (updates.configuration) {
            const validation = vapiClient.validateConfig(updates.configuration);
            if (!validation.valid) {
                return res.status(400).json({
                    error: 'Invalid configuration',
                    details: validation.errors
                });
            }

            // Update in VAPI
            await vapiClient.updateAssistant(agent.vapiAssistantId, updates.configuration);
        }

        // Update local record
        if (updates.name) agent.name = updates.name;
        if (updates.status) agent.status = updates.status;
        if (updates.configuration) agent.configuration = updates.configuration;
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
 * DELETE /vapi/agents/:id
 * Delete an agent
 */
router.delete('/:id', async (req, res) => {
    try {
        const agent = await Agent.findById(req.params.id);

        if (!agent) {
            return res.status(404).json({
                error: 'Agent not found'
            });
        }

        // Delete from VAPI
        try {
            await vapiClient.deleteAssistant(agent.vapiAssistantId);
        } catch (vapiError) {
            console.error('Error deleting from VAPI:', vapiError.message);
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
 * GET /vapi/agents/schema/template
 * Get configuration schema template
 */
router.get('/schema/template', (req, res) => {
    try {
        const schema = vapiClient.getConfigSchema();
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
 * POST /vapi/agents/:id/test-call
 * Make a test call with this agent
 */
router.post('/:id/test-call', async (req, res) => {
    try {
        const agent = await Agent.findById(req.params.id);

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

        // Use the existing outbound call logic with this agent
        // This will be integrated with the main call endpoint
        res.json({
            success: true,
            message: 'Test call initiated',
            agentId: agent._id,
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

/**
 * GET /vapi/agents/stats/overview
 * Get overall agent statistics
 */
router.get('/stats/overview', async (req, res) => {
    try {
        const [totalAgents, activeAgents, mostUsed] = await Promise.all([
            Agent.countDocuments(),
            Agent.countDocuments({ status: 'active' }),
            Agent.getMostUsed(5)
        ]);

        const totalCalls = await Agent.aggregate([
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

module.exports = router;
