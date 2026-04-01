const mongoose = require('mongoose');

const campaignLeadSchema = new mongoose.Schema({
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    to: { type: String, required: true },
    name: { type: String, default: '' },
    variables: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: {
        type: String,
        enum: ['pending', 'calling', 'completed', 'failed'],
        default: 'pending'
    },
    callSid: { type: String, default: null },
    errorMessage: { type: String, default: null },
    
    // AI Generated Fields
    leadType: { type: String, default: 'unknown' }, // Hot, Warm, Cold
    leadProfile: { type: String, default: 'unknown' }, // Profession/Role
    statusClassification: { type: String, default: 'unknown' }, // Interested, Not Interested, etc.
    remark: { type: String, default: null }, // AI Summary
    
    lastCalledAt: { type: Date, default: null }
}, { timestamps: true });

// Index for the processor to pull pending leads efficiently
campaignLeadSchema.index({ campaignId: 1, status: 1, createdAt: 1 });

const CampaignLead = mongoose.model('CampaignLead', campaignLeadSchema);

module.exports = CampaignLead;
