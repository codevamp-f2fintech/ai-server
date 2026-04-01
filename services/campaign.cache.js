const CampaignLead = require('../models/CampaignLead');

/**
 * Initialize a campaign queue in MongoDB.
 * @param {string} campaignId 
 * @param {string} userId
 * @param {Array} leads - Array of {to, name, variables}
 */
const initCampaign = async (campaignId, userId, leads) => {
    const bulkLeads = leads.map(l => ({
        campaignId,
        userId,
        to: l.to,
        name: l.name || '',
        variables: l.variables || {},
        status: 'pending'
    }));

    // Use bulkWrite for efficiency if many leads
    if (bulkLeads.length > 0) {
        await CampaignLead.insertMany(bulkLeads);
    }
};

/**
 * Get all leads for a campaign.
 * @param {string} campaignId 
 */
const getLeads = async (campaignId) => {
    return await CampaignLead.find({ campaignId });
};

/**
 * Get only "active" leads (calling) for a campaign.
 * @param {string} campaignId 
 */
const getActiveLeads = async (campaignId) => {
    return await CampaignLead.find({
        campaignId,
        status: 'calling'
    });
};

/**
 * Fetch a slice of pending leads.
 * @param {string} campaignId 
 * @param {number} limit 
 */
const getPendingLeads = async (campaignId, limit) => {
    return await CampaignLead.find({
        campaignId,
        status: 'pending'
    }).limit(limit).sort({ createdAt: 1 });
};

/**
 * Update the status of a specific lead by phone number.
 * @param {string} campaignId 
 * @param {string} to - The phone number
 * @param {Object} updates - { status, callSid, errorMessage }
 */
const updateLead = async (campaignId, to, updates) => {
    await CampaignLead.updateOne(
        { campaignId, to },
        { 
            $set: updates,
            $set: { lastCalledAt: new Date(), ...updates }
        }
    );
};

/**
 * Update the status of a specific lead by ID.
 */
const updateLeadById = async (leadId, updates) => {
    await CampaignLead.findByIdAndUpdate(leadId, updates);
};

/**
 * Find all leads with status 'calling' and reset to 'pending'
 * (Call this at server start to resume interrupted campaigns)
 */
const rescueHangingLeads = async () => {
    const result = await CampaignLead.updateMany(
        { status: 'calling' },
        { 
            $set: { 
                status: 'pending',
                errorMessage: 'interrupted_by_server_restart'
            }
        }
    );
    if (result.modifiedCount > 0) {
        console.log(`[CampaignCache] Rescued ${result.modifiedCount} hanging leads from 'calling' to 'pending'`);
    }
    return result.modifiedCount;
};

/**
 * Delete a campaign's leads from database.
 * @param {string} campaignId 
 */
const deleteCampaign = async (campaignId) => {
    await CampaignLead.deleteMany({ campaignId });
};

module.exports = {
    initCampaign,
    getLeads,
    getPendingLeads,
    updateLead,
    updateLeadById,
    getActiveLeads,
    rescueHangingLeads,
    deleteCampaign
};
