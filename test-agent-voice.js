// Test with the EXACT voice ID from the agent configuration
const { ElevenLabsClient } = require("elevenlabs");
require('dotenv').config();

async function testAgentVoice() {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const client = new ElevenLabsClient({ apiKey });
    const agentVoiceId = 'zmh5xhBvMzqR4ZlXgcgL'; // Voice from agent config

    console.log(`[Test] Testing with agent's configured voice: ${agentVoiceId}\n`);

    // Test 1: With agent voice + PCM format
    console.log('[Test 1] Testing agent voice with pcm_16000...');
    try {
        const audioStream = await client.textToSpeech.convertAsStream(
            agentVoiceId,
            {
                text: "Hello, this is a test with the agent's voice.",
                model_id: "eleven_turbo_v2",
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75,
                    use_speaker_boost: true
                },
                output_format: "pcm_16000"
            }
        );
        console.log('[Test 1] ✅ Agent voice with PCM succeeded!\n');
    } catch (error) {
        console.error('[Test 1] ❌ Failed:', error.statusCode, error.message);
        if (error.statusCode === 402) {
            console.error('           💡 402 = Payment Required');
            console.error('           This voice might not be available on your current plan\n');
        }
    }

    // Test 2: With agent voice + MP3 format
    console.log('[Test 2] Testing agent voice with MP3 (default)...');
    try {
        const audioStream = await client.textToSpeech.convertAsStream(
            agentVoiceId,
            {
                text: "Hello, this is a test with the agent's voice in MP3.",
                model_id: "eleven_turbo_v2",
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75,
                    use_speaker_boost: true
                }
            }
        );
        console.log('[Test 2] ✅ Agent voice with MP3 succeeded!\n');
    } catch (error) {
        console.error('[Test 2] ❌ Failed:', error.statusCode, error.message);
        if (error.statusCode === 402) {
            console.error('           💡 This voice requires payment/different plan\n');
        }
    }

    // Test 3: Get voice details
    console.log('[Test 3] Getting voice details...');
    try {
        const voice = await client.voices.get(agentVoiceId);
        console.log('[Test 3] ✅ Voice details:');
        console.log('           Name:', voice.name);
        console.log('           Category:', voice.category);
        console.log('           Preview URL:', voice.preview_url || 'N/A');
    } catch (error) {
        console.error('[Test 3] ❌ Failed to get voice details:', error.message);
    }
}

testAgentVoice();
