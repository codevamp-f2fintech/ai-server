const mongoose = require('mongoose');

const campaignSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true },
    agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Agent', required: true },
    status: {
        type: String,
        enum: ['pending', 'running', 'paused', 'completed', 'canceled'],
        default: 'pending'
    },
    concurrency: { type: Number, default: 3 },
    totalLeads: { type: Number, default: 0 },
    completedLeads: { type: Number, default: 0 },
    failedLeads: { type: Number, default: 0 },
}, { timestamps: true });

const Campaign = mongoose.model('Campaign', campaignSchema);

module.exports = Campaign;
