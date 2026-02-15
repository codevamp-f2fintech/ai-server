// Update agent with Hindi female voice
const mongoose = require('mongoose');
const Agent = require('./models/Agent');
require('dotenv').config();

async function updateAgentVoice() {
    await mongoose.connect(process.env.MONGODB_URI);

    console.log('[Update] Updating agent "new latest agent" with Hindi voice...\n');

    // The best Hindi female voice for customer care
    const newVoiceId = 'DpnM70iDHNHZ0Mguv6GJ'; // Saavi – Natural Hindi Customer Care Agent
    const voiceName = 'Saavi – Natural Hindi Customer Care Agent';

    // Find and update the agent
    const agent = await Agent.findOne({ name: 'new latest agent' });

    if (!agent) {
        console.error('❌ Agent not found!');
        process.exit(1);
    }

    console.log(`[Update] Current voice ID: ${agent.configuration?.voice?.voiceId || agent.configuration?.configuration?.voice?.voiceId || 'NOT SET'}`);
    console.log(`[Update] New voice ID: ${newVoiceId}`);
    console.log(`[Update] Voice name: ${voiceName}\n`);

    // Update the voice configuration
    // Handle both nested and non-nested configuration structures
    if (agent.configuration.configuration && agent.configuration.configuration.voice) {
        agent.configuration.configuration.voice.voiceId = newVoiceId;
        agent.configuration.configuration.voice.provider = 'elevenlabs';
    } else if (agent.configuration.voice) {
        agent.configuration.voice.voiceId = newVoiceId;
        agent.configuration.voice.provider = 'elevenlabs';
    } else {
        // Create voice config if it doesn't exist
        agent.configuration.voice = {
            voiceId: newVoiceId,
            provider: 'elevenlabs'
        };
    }

    // Save the agent
    await agent.save();

    console.log('✅ Agent updated successfully!');
    console.log('\n📞 You can now make a test call and the agent will speak in Hindi with Saavi\'s voice.');
    console.log('💡 Make sure to use Hindi text in your agent\'s prompts and responses for best results.\n');

    process.exit(0);
}

updateAgentVoice().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
