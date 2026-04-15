// Test with MP3 format instead of PCM to see if it's a format restriction issue
const { ElevenLabsClient } = require("elevenlabs");
require('dotenv').config();

async function testFormats() {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const client = new ElevenLabsClient({ apiKey });
    const defaultVoice = 'pNInz6obpgDQGcFmaJgB';

    console.log('[Test] Testing different output formats...\n');

    // Test 1: MP3 format (default)
    console.log('[Test 1] Testing with mp3_44100_128 (default)...');
    try {
        const audioStream1 = await client.textToSpeech.convertAsStream(
            defaultVoice,
            {
                text: "Hello, this is a test with MP3 format.",
                model_id: "eleven_turbo_v2",
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75,
                    use_speaker_boost: true
                }
                // output_format defaults to mp3_44100_128
            }
        );
        console.log('[Test 1] ✅ MP3 format succeeded!\n');
    } catch (error) {
        console.error('[Test 1] ❌ MP3 format failed:', error.statusCode, error.message, '\n');
    }

    // Test 2: PCM 16kHz
    console.log('[Test 2] Testing with pcm_16000...');
    try {
        const audioStream2 = await client.textToSpeech.convertAsStream(
            defaultVoice,
            {
                text: "Hello, this is a test with PCM 16kHz format.",
                model_id: "eleven_turbo_v2",
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75,
                    use_speaker_boost: true
                },
                output_format: "pcm_16000"
            }
        );
        console.log('[Test 2] ✅ PCM 16kHz format succeeded!\n');
    } catch (error) {
        console.error('[Test 2] ❌ PCM 16kHz format failed:', error.statusCode, error.message, '\n');
    }

    // Test 3: μ-law format (Twilio native)
    console.log('[Test 3] Testing with ulaw_8000 (Twilio native)...');
    try {
        const audioStream3 = await client.textToSpeech.convertAsStream(
            defaultVoice,
            {
                text: "Hello, this is a test with mu-law format.",
                model_id: "eleven_turbo_v2",
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75,
                    use_speaker_boost: true
                },
                output_format: "ulaw_8000"
            }
        );
        console.log('[Test 3] ✅ μ-law format succeeded!\n');
    } catch (error) {
        console.error('[Test 3] ❌ μ-law format failed:', error.statusCode, error.message, '\n');
    }
}

testFormats();
