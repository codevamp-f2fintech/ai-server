// Fix agent voice configuration - properly update nested structure
const mongoose = require('mongoose');
const Agent = require('./models/Agent');
require('dotenv').config();

async function fixVoiceConfig() {
    await mongoose.connect(process.env.MONGODB_URI);

    const agent = await Agent.findOne({ name: 'new latest agent' });

    if (!agent) {
        console.error('❌ Agent not found!');
        process.exit(1);
    }

    console.log('[Fix] Current voice config:', agent.configuration.voice);

    // Update voice configuration directly
    agent.configuration.voice = {
        provider: '11labs',
        voiceId: 'EXAVITQu4vr4xnSDxMaL', // Sarah
        model: 'eleven_multilingual_v2', // Multilingual model for Hindi
        stability: 0.5,
        similarityBoost: 0.75
    };

    // Mark as modified to ensure save works
    agent.markModified('configuration');
    agent.markModified('configuration.voice');

    await agent.save();

    console.log('\n✅ Voice configuration updated!');
    console.log('[Fix] New voice config:', agent.configuration.voice);
    console.log('\n💡 Configuration saved to database');
    console.log('📞 Make a new test call to use the updated configuration\n');

    process.exit(0);
}

fixVoiceConfig().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
