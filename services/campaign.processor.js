const Campaign = require('../models/Campaign');
const CampaignLead = require('../models/CampaignLead');
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
                // Limit concurrency by checking ACTIVE calls in the Call model
                const Call = require('../models/Call');
                const activeCallsCount = await Call.countDocuments({
                    campaignName: campaign.name,
                    userId: campaign.userId,
                    status: { $in: ['initiated', 'ringing', 'in-progress'] }
                });

                const availableSlots = campaign.concurrency - activeCallsCount;

                if (availableSlots <= 0) continue;

                // Pull pending leads from MongoDB instead of RAM
                const pendingLeads = await CampaignCache.getPendingLeads(campaign._id.toString(), availableSlots);

                if (pendingLeads.length === 0) {
                    // Check if everything is done by checking if ANY are left pending in DB
                    const hasPendingLeft = await CampaignLead.countDocuments({
                        campaignId: campaign._id,
                        status: 'pending'
                    }) > 0;

                    if (!hasPendingLeft && activeCallsCount === 0) {
                        campaign.status = 'completed';
                        await campaign.save();
                        console.log(`[CampaignProcessor] Campaign ${campaign.name} completed.`);
                    }
                    continue;
                }

                // Initiate calls for pending leads
                for (const lead of pendingLeads) {
                    // Mark as 'calling' in DB immediately to prevent double processing
                    lead.status = 'calling';
                    await lead.save();

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
                            // Note: 'completed' status for lead will be handled after call finishes
                            // in sip-media-bridge.js listeners or here as 'initiated'.
                            // For now, we update with SID.
                            await lead.save();

                            // We don't increment completedLeads here yet, 
                            // it should be done when the call actually ends.
                        } catch (err) {
                            console.error(`[CampaignProcessor] Error calling ${lead.to}:`, err.message);
                            lead.status = 'failed';
                            lead.errorMessage = err.message || 'Call failed';
                            await lead.save();
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
    console.log('[CampaignProcessor] Started background queue processor (MongoDB Persistence Mode)');
    // Run every 3 seconds
    setInterval(processQueues, 3000);
}

module.exports = { startProcessor };
