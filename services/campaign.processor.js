const Campaign = require('../models/Campaign');
const CampaignCache = require('./campaign.cache');
const CallService = require('./call.service');

let isProcessing = false;

async function processQueues() {
    if (isProcessing) return;
    isProcessing = true;

    try {
        const campaigns = await Campaign.find({ status: 'running' });

        for (const campaign of campaigns) {
            try {
                // Note: The status 'calling' indicates we've initiated the outbound call.
                // Since independent calls continue running outside the processor,
                // 'calling' means "handled by CallService". If we want to strictly limit 
                // concurrency of ACTIVE calls, we'd need to check the actual Call model status.
                // For bulk starting purposes, limiting the rate of initiation is usually sufficient,
                // but let's check true active calls if we want exact concurrency.
                const Call = require('../models/Call');
                const activeCallsCount = await Call.countDocuments({
                    campaignName: campaign.name,
                    userId: campaign.userId,
                    status: { $in: ['initiated', 'ringing', 'in-progress'] }
                });

                const availableSlots = campaign.concurrency - activeCallsCount;

                if (availableSlots <= 0) continue;

                const pendingLeads = CampaignCache.getPendingLeads(campaign._id.toString(), availableSlots);

                if (pendingLeads.length === 0 && activeCallsCount === 0) {
                    // Check if everything is done by checking if ANY are left pending in RAM
                    const hasPendingLeft = CampaignCache.getPendingLeads(campaign._id.toString(), 1).length > 0;
                    if (!hasPendingLeft) {
                        campaign.status = 'completed';
                        await campaign.save();
                        console.log(`[CampaignProcessor] Campaign ${campaign.name} completed.`);
                    }
                    continue;
                }

                // Initiate calls for pending leads
                for (const lead of pendingLeads) {
                    lead.status = 'calling'; // Quick sync update in RAM

                    // Fire immediately without blocking the event loop
                    (async () => {
                        try {
                            const callData = await CallService.makeOutboundCall({
                                to: lead.to,
                                agentId: campaign.agentId,
                                variables: lead.variables,
                                campaignName: campaign.name,
                                userId: campaign.userId
                            });
                            
                            lead.callSid = callData.sid;
                            lead.status = 'completed'; // Update in RAM
                            await Campaign.updateOne({ _id: campaign._id }, { $inc: { completedLeads: 1 } });
                        } catch (err) {
                            console.error(`[CampaignProcessor] Error calling ${lead.to}:`, err.message);
                            lead.status = 'failed';
                            lead.errorMessage = err.message || 'Call failed';
                            await Campaign.updateOne({ _id: campaign._id }, { $inc: { failedLeads: 1 } });
                        }
                    })();
                }
            } catch (err) {
                console.error(`[CampaignProcessor] Error processing campaign ${campaign._id}:`, err);
            }
        }
    } catch (error) {
        console.error('[CampaignProcessor] Overall error in processing queues:', error);
    } finally {
        isProcessing = false;
    }
}

function startProcessor() {
    console.log('[CampaignProcessor] Started background queue processor');
    // Run every 3 seconds
    setInterval(processQueues, 3000);
}

module.exports = { startProcessor };
