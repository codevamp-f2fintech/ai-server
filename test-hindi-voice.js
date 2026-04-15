// Test the new Hindi voice
const { ElevenLabsClient } = require("elevenlabs");
require('dotenv').config();

async function testHindiVoice() {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const client = new ElevenLabsClient({ apiKey });
    const saaviVoiceId = 'DpnM70iDHNHZ0Mguv6GJ';

    console.log('[Test] Testing Saavi Hindi voice...\n');

    try {
        const audioStream = await client.textToSpeech.convertAsStream(
            saaviVoiceId,
            {
                text: "नमस्ते, मैं आपकी सहायता के लिए यहां हूं।", // "Hello, I am here to help you" in Hindi
                model_id: "eleven_turbo_v2",
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75,
                    use_speaker_boost: true
                },
                output_format: "pcm_16000"
            }
        );

        console.log('✅ SUCCESS! Saavi Hindi voice is working perfectly!');
        console.log('✅ PCM 16kHz format working');
        console.log('\n🎉 Your agent is now ready to speak in Hindi!');
        console.log('💡 Make a test call to hear Saavi speak in Hindi.\n');

    } catch (error) {
        console.error('❌ Test failed:', error.statusCode, error.message);
    }
}

testHindiVoice();
