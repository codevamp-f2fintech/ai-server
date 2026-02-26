// Agent Routes - Independent (No VAPI dependency)
// Agents are stored in MongoDB and used directly by the independent voice pipeline

const express = require('express');
const router = express.Router();
const Agent = require('../models/Agent');
const { authenticate } = require('../middleware/auth');
const https = require('https');
const http = require('http');

/**
 * Re-fetch and extract text from S3 URL for a KB entry that has empty text.
 * Returns the extracted text string, or '' on failure.
 */
async function refetchKbText(s3Url, fileName) {
    return new Promise((resolve) => {
        try {
            const urlObj = new URL(s3Url);
            const proto = urlObj.protocol === 'https:' ? https : http;
            proto.get(s3Url, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', async () => {
                    const buffer = Buffer.concat(chunks);
                    try {
                        const ext = (fileName || '').split('.').pop()?.toLowerCase();
                        if (ext === 'pdf') {
                            // Polyfill browser-only globals before loading pdf-parse
                            if (typeof global.DOMMatrix === 'undefined') {
                                global.DOMMatrix = class DOMMatrix {
                                    constructor() { this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0; }
                                };
                            }
                            if (typeof global.ImageData === 'undefined') {
                                global.ImageData = class ImageData {
                                    constructor(w, h) { this.width = w || 0; this.height = h || 0; this.data = new Uint8ClampedArray(w * h * 4); }
                                };
                            }
                            if (typeof global.Path2D === 'undefined') {
                                global.Path2D = class Path2D { moveTo() { } lineTo() { } arc() { } closePath() { } };
                            }
                            // Use raw lib path to avoid browser-only polyfills (DOMMatrix etc.)
                            const pdfParse = require('pdf-parse');
                            const data = await pdfParse(buffer);
                            const text = data.text || '';
                            console.log(`[Agents] Re-extracted ${text.length} chars from S3 KB: ${fileName}`);
                            resolve(text);
                        } else {
                            resolve(buffer.toString('utf-8'));
                        }
                    } catch (parseErr) {
                        console.error('[Agents] KB re-extraction parse error:', parseErr.message);
                        resolve('');
                    }
                });
                res.on('error', (e) => { console.error('[Agents] KB S3 fetch error:', e.message); resolve(''); });
            }).on('error', (e) => { console.error('[Agents] KB S3 request error:', e.message); resolve(''); });
        } catch (e) {
            console.error('[Agents] KB refetch setup error:', e.message);
            resolve('');
        }
    });
}

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
                phoneNumberId: agent.phoneNumberId,
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
                phoneNumberId: agent.phoneNumberId,
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
        const newConfig = config.configuration || config;

        // Re-fetch KB text from S3 for any KB entry that has an empty text field
        if (newConfig.knowledgeBase && Array.isArray(newConfig.knowledgeBase)) {
            console.log(`[Agents PUT] KB entries received: ${newConfig.knowledgeBase.length}`);
            for (const kbEntry of newConfig.knowledgeBase) {
                console.log(`[Agents PUT] KB entry "${kbEntry.name}": text length=${kbEntry.text?.length || 0}, s3Url=${kbEntry.s3Url || 'none'}`);
                if ((!kbEntry.text || kbEntry.text.trim().length === 0) && kbEntry.s3Url) {
                    console.log(`[Agents PUT] ⚠️ KB text empty for "${kbEntry.name}" — re-fetching from S3...`);
                    kbEntry.text = await refetchKbText(kbEntry.s3Url, kbEntry.name);
                    console.log(`[Agents PUT] ✅ Re-fetched KB text: ${kbEntry.text.length} chars`);
                }
            }
        }

        agent.configuration = newConfig;
        // CRITICAL: Mongoose Mixed fields require markModified() to detect deep changes
        agent.markModified('configuration');
        agent.status = config.status || agent.status;
        agent.metadata = {
            description: config.metadata?.description || agent.metadata.description,
            tags: config.metadata?.tags || agent.metadata.tags,
            category: config.metadata?.category || agent.metadata.category,
            createdBy: agent.metadata.createdBy
        };

        // Update phone number ID if provided
        if (config.phoneNumberId !== undefined) {
            agent.phoneNumberId = config.phoneNumberId || undefined;
        }

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
                phoneNumberId: agent.phoneNumberId,
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

        // DEBUG: Log what we're receiving
        console.log('[Agents PATCH] Received config:', JSON.stringify(config, null, 2));
        console.log('[Agents PATCH] phoneNumberId in config:', config.phoneNumberId);

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
        const newConfig = config.configuration || config;

        // Re-fetch KB text from S3 for any KB entry that has an empty text field
        if (newConfig.knowledgeBase && Array.isArray(newConfig.knowledgeBase)) {
            console.log(`[Agents PATCH] KB entries received: ${newConfig.knowledgeBase.length}`);
            for (const kbEntry of newConfig.knowledgeBase) {
                console.log(`[Agents PATCH] KB entry "${kbEntry.name}": text length=${kbEntry.text?.length || 0}, s3Url=${kbEntry.s3Url || 'none'}`);
                if ((!kbEntry.text || kbEntry.text.trim().length === 0) && kbEntry.s3Url) {
                    console.log(`[Agents PATCH] ⚠️ KB text empty for "${kbEntry.name}" — re-fetching from S3...`);
                    kbEntry.text = await refetchKbText(kbEntry.s3Url, kbEntry.name);
                    console.log(`[Agents PATCH] ✅ Re-fetched KB text: ${kbEntry.text.length} chars`);
                }
            }
        }

        agent.configuration = newConfig;
        // CRITICAL: Mongoose Mixed fields require markModified() to detect deep changes
        agent.markModified('configuration');
        agent.status = config.status || agent.status;
        agent.metadata = {
            description: config.metadata?.description || agent.metadata.description,
            tags: config.metadata?.tags || agent.metadata.tags,
            category: config.metadata?.category || agent.metadata.category,
            createdBy: agent.metadata.createdBy
        };

        // Update phone number ID if provided
        if (config.phoneNumberId !== undefined) {
            agent.phoneNumberId = config.phoneNumberId || undefined;
        }

        await agent.save();

        console.log(`[Agents] Updated agent ${agent._id} for user ${req.userId}`);
        console.log(`[Agents PATCH] Agent phoneNumberId after save:`, agent.phoneNumberId);
        // Log KB state after save for debugging
        const savedKb = agent.configuration?.knowledgeBase || [];
        savedKb.forEach(kb => console.log(`[Agents PATCH] Saved KB "${kb.name}": text length=${kb.text?.length || 0}`));

        res.json({
            success: true,
            agent: {
                _id: agent._id,
                name: agent.name,
                status: agent.status,
                configuration: agent.configuration,
                metadata: agent.metadata,
                phoneNumberId: agent.phoneNumberId,
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
