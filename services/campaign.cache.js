const crypto = require('crypto');

// In-Memory map to hold campaign leads.
// Key: campaignId (string) -> Value: Array of lead objects
const memoryCache = new Map();

/**
 * Initialize a campaign queue in memory.
 * @param {string} campaignId 
 * @param {Array} leads - Array of {to, name, variables}
 */
const initCampaign = (campaignId, leads) => {
    const queue = leads.map(l => ({
        _id: crypto.randomUUID(), // for React list keys
        to: l.to,
        name: l.name || '',
        variables: l.variables || {},
        status: 'pending',
        callSid: null,
        errorMessage: null
    }));
    memoryCache.set(campaignId.toString(), queue);
};

/**
 * Get all leads for a campaign.
 * @param {string} campaignId 
 */
const getLeads = (campaignId) => {
    return memoryCache.get(campaignId.toString()) || [];
};

/**
 * Fetch a slice of pending leads.
 * @param {string} campaignId 
 * @param {number} limit 
 */
const getPendingLeads = (campaignId, limit) => {
    const queue = memoryCache.get(campaignId.toString());
    if (!queue) return [];
    
    // Find all pendings
    const pendings = queue.filter(l => l.status === 'pending');
    return pendings.slice(0, limit);
};

/**
 * Update the status of a specific lead by phone number.
 * @param {string} campaignId 
 * @param {string} to - The phone number
 * @param {Object} updates - { status, callSid, errorMessage }
 */
const updateLead = (campaignId, to, updates) => {
    const queue = memoryCache.get(campaignId.toString());
    if (!queue) return;

    const lead = queue.find(l => l.to === to);
    if (lead) {
        Object.assign(lead, updates);
    }
};

/**
 * Delete a campaign from RAM to free up memory.
 * @param {string} campaignId 
 */
const deleteCampaign = (campaignId) => {
    memoryCache.delete(campaignId.toString());
};

module.exports = {
    initCampaign,
    getLeads,
    getPendingLeads,
    updateLead,
    deleteCampaign
};
