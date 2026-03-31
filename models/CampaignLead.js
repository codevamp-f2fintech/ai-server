const mongoose = require('mongoose');

const campaignLeadSchema = new mongoose.Schema({
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
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
}, { timestamps: true });

const CampaignLead = mongoose.model('CampaignLead', campaignLeadSchema);

module.exports = CampaignLead;
