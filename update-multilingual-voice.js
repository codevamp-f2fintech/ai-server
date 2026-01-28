// Find best female English voice that can speak Hindi using multilingual model
const { ElevenLabsClient } = require("elevenlabs");
const mongoose = require('mongoose');
const Agent = require('./models/Agent');
require('dotenv').config();

async function findAndUpdateMultilingualVoice() {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const client = new ElevenLabsClient({ apiKey });

    console.log('[Search] Finding female English voices that work with multilingual model...\n');

    // Test Sarah - she's a free female voice
    const testVoices = [
        { name: 'Sarah - Mature, Reassuring, Confident', id: 'EXAVITQu4vr4xnSDxMaL' },
        { name: 'Rachel - Calm', id: '21m00Tcm4TlvDq8ikWAM' },
        { name: 'Dorothy - Pleasant', id: 'ThT5KcBeYPX3keUQqHPh' }
    ];

    let bestVoice = null;

    for (const voice of testVoices) {
        console.log(`Testing ${voice.name}...`);
        try {
            // Test with Hindi text using multilingual model
            const audioStream = await client.textToSpeech.convertAsStream(
                voice.id,
                {
                    text: "नमस्ते, मैं आपकी सहायता के लिए यहां हूं।",
                    model_id: "eleven_multilingual_v2", // Multilingual model supports Hindi
                    voice_settings: {
                        stability: 0.5,
                        similarity_boost: 0.75,
                        use_speaker_boost: true
                    },
                    output_format: "pcm_16000"
                }
            );
            console.log(`✅ ${voice.name} - WORKS with Hindi + multilingual model!\n`);
            bestVoice = voice;
            break; // Use first working voice
        } catch (error) {
            console.log(`❌ ${voice.name} - Error: ${error.statusCode}\n`);
        }
    }

    if (!bestVoice) {
        console.error('❌ No suitable voice found');
        process.exit(1);
    }

    console.log('='.repeat(60));
    console.log(`\n✅ Best choice: ${bestVoice.name}`);
    console.log(`   Voice ID: ${bestVoice.id}`);
    console.log(`   Model: eleven_multilingual_v2 (supports Hindi)`);
    console.log(`   This voice can speak Hindi fluently!\n`);

    // Update the agent
    console.log('[Update] Updating agent configuration...\n');
    await mongoose.connect(process.env.MONGODB_URI);

    const agent = await Agent.findOne({ name: 'new latest agent' });

    if (!agent) {
        console.error('❌ Agent not found!');
        process.exit(1);
    }

    // Update voice configuration
    if (agent.configuration.configuration && agent.configuration.configuration.voice) {
        agent.configuration.configuration.voice.voiceId = bestVoice.id;
        agent.configuration.configuration.voice.provider = 'elevenlabs';
        // Also update model to multilingual
        if (agent.configuration.configuration.voice) {
            agent.configuration.configuration.voice.model = 'eleven_multilingual_v2';
        }
    } else if (agent.configuration.voice) {
        agent.configuration.voice.voiceId = bestVoice.id;
        agent.configuration.voice.provider = 'elevenlabs';
        agent.configuration.voice.model = 'eleven_multilingual_v2';
    }

    await agent.save();

    console.log('✅ Agent updated successfully!');
    console.log(`\n🎉 Your agent will now use ${bestVoice.name} with multilingual model`);
    console.log('💡 This voice can speak Hindi naturally!');
    console.log('📞 Make a test call to try it out!\n');

    process.exit(0);
}

findAndUpdateMultilingualVoice().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
