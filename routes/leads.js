const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const CampaignLead = require('../models/CampaignLead');

/**
 * GET /api/leads
 * Get all leads across all campaigns for the authenticated user
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const { page = 1, limit = 10, status } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Filter by userId (leads are associated with campaigns, which belong to users)
    // For simplicity, we'll assume the Lead model should have a userId, 
    // but looking at the current CampaignLead schema, it uses campaignId.
    // We'll need to join or ensure the campaign belongs to the user.
    
    const query = { userId: req.userId };
    if (status) query.status = status;

    const [leads, total] = await Promise.all([
      CampaignLead.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      CampaignLead.countDocuments(query)
    ]);

    res.json({
      success: true,
      data: {
        customers: leads.map(lead => ({
          _id: lead._id,
          name: lead.name || 'Unknown',
          phone: lead.to,
          status: lead.status,
          campaignId: lead.campaignId,
          createdAt: lead.createdAt
        })),
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / parseInt(limit)),
        totalCustomers: total
      }
    });

  } catch (error) {
    console.error('[LeadsRoute] Fetch error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch leads' });
  }
});

module.exports = router;
