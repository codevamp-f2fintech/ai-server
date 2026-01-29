// Agent Routes - Independent (No VAPI dependency)
// Agents are stored in MongoDB and used directly by the independent voice pipeline

const express = require('express');
const router = express.Router();
const Agent = require('../models/Agent');
const { authenticate } = require('../middleware/auth');

// Apply authentication middleware to ALL routes
router.use(authenticate);

/**
 * POST /vapi/agents
 * Create a new agent (stored in MongoDB only)
 */
router.post('/', async (req, res) => {
    try {
        const config = req.body;

        // Basic validation
        if (!config.name) {
            return res.status(400).json({
                error: 'Agent name is required'
            });
        }

        // Save to MongoDB with userId
        const agent = new Agent({
            userId: req.userId, // Associate with authenticated user
            vapiAssistantId: null, // Not using VAPI anymore
            name: config.name,
            configuration: config,
            status: 'active',
            metadata: {
                description: config.metadata?.description || '',
                tags: config.metadata?.tags || [],
                createdBy: req.user.email || 'system',
                category: config.metadata?.category || 'other'
            },
            statistics: {
                totalCalls: 0,
                successfulCalls: 0,
                averageDuration: 0,
                lastUsed: null
            }
        });

        await agent.save();

        console.log(`[Agents] Created agent ${agent._id} for user ${req.userId}`);

        res.status(201).json({
            success: true,
            agent: {
                _id: agent._id,
                name: agent.name,
                status: agent.status,
                createdAt: agent.createdAt,
                configuration: agent.configuration
            }
        });

    } catch (error) {
        console.error('[Agents] Error creating agent:', error);
        res.status(500).json({
            error: 'Failed to create agent',
            message: error.message
        });
    }
});

/**
 * GET /vapi/agents
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
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit))
                .select('-__v'),
            Agent.countDocuments(query)
        ]);

        res.json({
            success: true,
            agents: agents.map(agent => ({
                _id: agent._id,
                name: agent.name,
                status: agent.status,
                configuration: agent.configuration,
                metadata: agent.metadata,
                statistics: agent.statistics,
                createdAt: agent.createdAt,
                updatedAt: agent.updatedAt
            })),
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                pages: Math.ceil(total / parseInt(limit))
            }
        });

    } catch (error) {
        console.error('[Agents] Error listing agents:', error);
        res.status(500).json({
            error: 'Failed to list agents',
            message: error.message
        });
    }
});

/**
 * GET /vapi/agents/stats/overview
 * Get agent statistics overview for dashboard
 */
router.get('/stats/overview', async (req, res) => {
    try {
        const userId = req.userId;

        // Get total agents
        const totalAgents = await Agent.countDocuments({ userId });

        // Get active agents
        const activeAgents = await Agent.countDocuments({ userId, status: 'active' });

        // Get agents by category
        const categories = await Agent.aggregate([
            { $match: { userId: req.userId } },
            { $group: { _id: '$metadata.category', count: { $sum: 1 } } }
        ]);

        // Get recent agents
        const recentAgents = await Agent.find({ userId })
            .sort({ createdAt: -1 })
            .limit(5)
            .select('name status createdAt metadata');

        res.json({
            success: true,
            stats: {
                totalAgents,
                activeAgents,
                inactiveAgents: totalAgents - activeAgents,
                categories: categories.map(c => ({
                    category: c._id || 'uncategorized',
                    count: c.count
                })),
                recentAgents: recentAgents.map(a => ({
                    _id: a._id,
                    name: a.name,
                    status: a.status,
                    category: a.metadata.category,
                    createdAt: a.createdAt
                }))
            }
        });

    } catch (error) {
        console.error('[Agents] Error fetching stats:', error);
        res.status(500).json({
            error: 'Failed to fetch statistics',
            message: error.message
        });
    }
});

/**
 * GET /vapi/agents/:id
 * Get agent by ID (user-scoped)
 */
router.get('/:id', async (req, res) => {
    try {
        // CRITICAL: Must match both ID and userId
        const agent = await Agent.findOne({
            _id: req.params.id,
            userId: req.userId
        });

        if (!agent) {
            return res.status(404).json({
                error: 'Agent not found'
            });
        }

        res.json({
            success: true,
            agent: {
                _id: agent._id,
                name: agent.name,
                status: agent.status,
                configuration: agent.configuration,
                metadata: agent.metadata,
                statistics: agent.statistics,
                createdAt: agent.createdAt,
                updatedAt: agent.updatedAt
            }
        });

    } catch (error) {
        console.error('[Agents] Error fetching agent:', error);
        res.status(500).json({
            error: 'Failed to fetch agent',
            message: error.message
        });
    }
});

/**
 * PUT /vapi/agents/:id
 * Update agent (user-scoped, no VAPI sync)
 */
router.put('/:id', async (req, res) => {
    try {
        const config = req.body;

        // Find agent and verify ownership
        const agent = await Agent.findOne({
            _id: req.params.id,
            userId: req.userId
        });

        if (!agent) {
            return res.status(404).json({
                error: 'Agent not found'
            });
        }

        // Update agent in MongoDB
        agent.name = config.name || agent.name;
        // Extract configuration if it's nested (new format) or use config directly (old format)
        agent.configuration = config.configuration || config;
        agent.status = config.status || agent.status;
        agent.metadata = {
            description: config.metadata?.description || agent.metadata.description,
            tags: config.metadata?.tags || agent.metadata.tags,
            category: config.metadata?.category || agent.metadata.category,
            createdBy: agent.metadata.createdBy
        };

        await agent.save();

        console.log(`[Agents] Updated agent ${agent._id} for user ${req.userId}`);

        res.json({
            success: true,
            agent: {
                _id: agent._id,
                name: agent.name,
                status: agent.status,
                configuration: agent.configuration,
                metadata: agent.metadata,
                updatedAt: agent.updatedAt
            }
        });

    } catch (error) {
        console.error('[Agents] Error updating agent:', error);
        res.status(500).json({
            error: 'Failed to update agent',
            message: error.message
        });
    }
});

/**
 * PATCH /vapi/agents/:id
 * Update agent (same as PUT, for frontend compatibility)
 */
router.patch('/:id', async (req, res) => {
    try {
        const config = req.body;

        // Find agent and verify ownership
        const agent = await Agent.findOne({
            _id: req.params.id,
            userId: req.userId
        });

        if (!agent) {
            return res.status(404).json({
                error: 'Agent not found'
            });
        }

        // Update agent in MongoDB
        agent.name = config.name || agent.name;
        // Extract configuration if it's nested (new format) or use config directly (old format)
        agent.configuration = config.configuration || config;
        agent.status = config.status || agent.status;
        agent.metadata = {
            description: config.metadata?.description || agent.metadata.description,
            tags: config.metadata?.tags || agent.metadata.tags,
            category: config.metadata?.category || agent.metadata.category,
            createdBy: agent.metadata.createdBy
        };

        await agent.save();

        console.log(`[Agents] Updated agent ${agent._id} for user ${req.userId}`);

        res.json({
            success: true,
            agent: {
                _id: agent._id,
                name: agent.name,
                status: agent.status,
                configuration: agent.configuration,
                metadata: agent.metadata,
                updatedAt: agent.updatedAt
            }
        });

    } catch (error) {
        console.error('[Agents] Error updating agent:', error);
        res.status(500).json({
            error: 'Failed to update agent',
            message: error.message
        });
    }
});

/**
 * DELETE /vapi/agents/:id
 * Delete agent (user-scoped, no VAPI sync)
 */
router.delete('/:id', async (req, res) => {
    try {
        // Find and delete only if user owns it
        const agent = await Agent.findOneAndDelete({
            _id: req.params.id,
            userId: req.userId
        });

        if (!agent) {
            return res.status(404).json({
                error: 'Agent not found'
            });
        }

        console.log(`[Agents] Deleted agent ${agent._id} for user ${req.userId}`);

        res.json({
            success: true,
            message: 'Agent deleted successfully'
        });

    } catch (error) {
        console.error('[Agents] Error deleting agent:', error);
        res.status(500).json({
            error: 'Failed to delete agent',
            message: error.message
        });
    }
});

module.exports = router;
