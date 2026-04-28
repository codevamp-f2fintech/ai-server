require('dotenv').config({ override: true });
const mongoose = require('mongoose');
const CallService = require('./services/call.service');
const Agent = require('./models/Agent');

async function main() {
    const args = process.argv.slice(2);
    
    // Workaround for Windows/ISP SRV ECONNREFUSED bugs
    require('dns').setServers(['8.8.8.8', '8.8.4.4']);
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    
    if (args.length < 2) {
        console.log("==========================================");
        console.log("Usage: node make-call-cli.js <agent-id> <phone-number>");
        console.log("==========================================\n");
        console.log("Available Active Agents:");
        const agents = await Agent.find({ status: 'active' }).select('name _id').limit(10);
        if (agents.length === 0) {
            console.log("No active agents found.");
        } else {
            agents.forEach(a => console.log(`- ${a.name} (ID: ${a._id})`));
        }
        console.log("\nExample:");
        console.log(`node make-call-cli.js ${agents.length > 0 ? agents[0]._id : '66f...'} +919876543210`);
        process.exit(1);
    }

    const agentId = args[0];
    const to = args[1];

    try {
        const agent = await Agent.findById(agentId);
        if (!agent) {
            console.error("Error: Agent not found with ID", agentId);
            process.exit(1);
        }

        console.log(`Initiating call to ${to} using agent: ${agent.name}...`);
        
        const result = await CallService.makeOutboundCall({
            to,
            agentId,
            userId: agent.userId // Automatically use the agent's owner
        });
        
        console.log("\n✅ Call initiated successfully!");
        console.log("Call Details:");
        console.log(result);
        
        console.log("\n📞 Call is now active! The script will stay open to stream audio and logs.");
        console.log("Press Ctrl+C to hang up and exit.");
        
        // We removed process.exit(0) here so the Node process stays alive 
        // to handle the SIP RTP audio streaming and WebSocket bridge.
    } catch (error) {
        console.error("\n❌ Failed to make call:", error.message);
        process.exit(1);
    }
}

main();
