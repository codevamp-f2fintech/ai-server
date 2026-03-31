const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const Campaign = require('../models/Campaign');
const CampaignLead = require('../models/CampaignLead');

// POST /api/campaigns
router.post('/', authenticate, async (req, res) => {
    try {
        const { name, agentId, concurrency, leads } = req.body;
        
        if (!name || !agentId || !leads || !leads.length) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const campaign = new Campaign({
            userId: req.userId,
            name,
            agentId,
            concurrency: parseInt(concurrency, 10) || 3,
            totalLeads: leads.length,
            status: 'running'
        });
        await campaign.save();

        const leadDocs = leads.map(l => ({
            campaignId: campaign._id,
            to: l.to,
            name: l.name || '',
            variables: l.variables || {},
            status: 'pending'
        }));

        await CampaignLead.insertMany(leadDocs);

        res.status(201).json({ success: true, campaignId: campaign._id });
    } catch (err) {
        console.error('[CampaignRoutes] Create error:', err);
        res.status(500).json({ error: 'Failed to create campaign' });
    }
});

// GET /api/campaigns
router.get('/', authenticate, async (req, res) => {
    try {
        const campaigns = await Campaign.find({ userId: req.userId }).sort({ createdAt: -1 });
        res.json(campaigns);
    } catch (err) {
        res.status(500).json({ error: 'Failed to list campaigns' });
    }
});

// GET /api/campaigns/:id
router.get('/:id', authenticate, async (req, res) => {
    try {
        const campaign = await Campaign.findOne({ _id: req.params.id, userId: req.userId });
        if (!campaign) return res.status(404).json({ error: 'Not found' });

        const leads = await CampaignLead.find({ campaignId: campaign._id });
        
        res.json({
            campaign,
            leads
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch campaign details' });
    }
});

// POST /api/campaigns/:id/control
router.post('/:id/control', authenticate, async (req, res) => {
    try {
        const { action } = req.body; // 'pause', 'resume', 'cancel'
        const campaign = await Campaign.findOne({ _id: req.params.id, userId: req.userId });
        
        if (!campaign) return res.status(404).json({ error: 'Not found' });
        if (campaign.status === 'completed') return res.status(400).json({ error: 'Already completed' });

        if (action === 'pause') campaign.status = 'paused';
        else if (action === 'resume') campaign.status = 'running';
        else if (action === 'cancel') {
            campaign.status = 'canceled';
            // Optionally, mark pending leads as failed or just leave them
            await CampaignLead.updateMany({ campaignId: campaign._id, status: 'pending' }, { status: 'failed', errorMessage: 'Campaign canceled' });
        }
        else return res.status(400).json({ error: 'Invalid action' });

        await campaign.save();
        res.json({ success: true, status: campaign.status });
    } catch (err) {
        res.status(500).json({ error: 'Control action failed' });
    }
});

module.exports = router;
