const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const Campaign = require('../models/Campaign');
const CampaignLead = require('../models/CampaignLead');
const CampaignCache = require('../services/campaign.cache');
const Agent = require('../models/Agent');
const Call = require('../models/Call');

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
            status: 'pending'
        });
        await campaign.save();

        // Store leads in MongoDB permanently
        await CampaignCache.initCampaign(campaign._id.toString(), req.userId, leads);

        campaign.status = 'running';
        await campaign.save();
 
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
 
        const activeLeads = await CampaignCache.getActiveLeads(campaign._id.toString());
        const recentLeads = await CampaignLead.find({ 
            campaignId: req.params.id,
            status: { $in: ['completed', 'failed'] }
        }).sort({ updatedAt: -1 }).limit(10); // Show last 10 finished calls in the queue UI
        
        // Return activeLeads as 'leads' for backward compatibility with the frontend table
        res.json({
            campaign,
            leads: activeLeads,
            recentLeads
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
            // Mark leads as failed in DB
            await CampaignLead.updateMany(
                { campaignId: req.params.id, status: 'pending' },
                { $set: { status: 'failed', errorMessage: 'Canceled' } }
            );
        }
        else return res.status(400).json({ error: 'Invalid action' });

        await campaign.save();
        res.json({ success: true, status: campaign.status });
    } catch (err) {
        res.status(500).json({ error: 'Control action failed' });
    }
});

// GET /api/campaigns/:id/export
router.get('/:id/export', authenticate, async (req, res) => {
    try {
        const campaign = await Campaign.findOne({ _id: req.params.id, userId: req.userId });
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

        const agent = await Agent.findById(campaign.agentId);
        const leads = await CampaignLead.find({ campaignId: req.params.id }).sort({ createdAt: 1 });

        // CSV Header
        let csv = 'SN,Phone,Lead Name,Lead Type,Allocated To,Allocation Status,Allocated Date-time,Update Status,Status,Lead Profile,Remark\n';

        leads.forEach((lead, index) => {
            const sn = index + 1;
            const phone = lead.to;
            const name = lead.name || '';
            const type = lead.leadType || lead.variables?.type || '';
            const allocatedTo = agent ? agent.name : 'Unknown';
            const allocationStatus = 'Allocated';
            const allocatedTime = lead.createdAt ? new Date(lead.createdAt).toLocaleString('en-IN') : '';
            const updateStatus = lead.status === 'completed' ? 'Updated' : 'Pending';
            const status = lead.statusClassification || lead.status;
            const profile = lead.leadProfile || lead.variables?.profile || '';
            const remark = (lead.remark || '').replace(/,/g, ';').replace(/\n/g, ' '); // Clean for CSV

            csv += `${sn},${phone},"${name}","${type}","${allocatedTo}","${allocationStatus}","${allocatedTime}","${updateStatus}","${status}","${profile}","${remark}"\n`;
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=campaign_export_${campaign.name.replace(/\s+/g, '_')}.csv`);
        res.status(200).send(csv);
    } catch (err) {
        console.error('[CampaignRoutes] Export error:', err);
        res.status(500).json({ error: 'Failed to export campaign data' });
    }
});

module.exports = router;
