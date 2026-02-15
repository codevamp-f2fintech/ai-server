// Test script to verify ElevenLabs API key and test TTS
const { ElevenLabsClient } = require("elevenlabs");
require('dotenv').config();

async function testElevenLabs() {
    console.log('[Test] Testing ElevenLabs API...');

    const apiKey = process.env.ELEVENLABS_API_KEY;
    console.log('[Test] API Key:', apiKey ? `${apiKey.substring(0, 10)}...` : 'MISSING');

    if (!apiKey) {
        console.error('[Test] ERROR: No API key found!');
        return;
    }

    const client = new ElevenLabsClient({ apiKey });

    try {
        // Test 1: Get voices to verify API key works
        console.log('\n[Test 1] Fetching voices...');
        const voices = await client.voices.getAll();
        console.log(`[Test 1] ✅ Successfully fetched ${voices.voices.length} voices`);
        console.log('[Test 1] Sample voices:', voices.voices.slice(0, 3).map(v => ({ id: v.voice_id, name: v.name })));

        // Test 2: Try TTS with minimal parameters
        console.log('\n[Test 2] Testing TTS with default parameters...');
        const defaultVoice = 'pNInz6obpgDQGcFmaJgB'; // Adam voice
        try {
            const audioStream = await client.textToSpeech.convertAsStream(
                defaultVoice,
                {
                    text: "Hello, this is a test.",
                    model_id: "eleven_turbo_v2"
                }
            );
            console.log('[Test 2] ✅ TTS with defaults succeeded!');
        } catch (error) {
            console.error('[Test 2] ❌ TTS with defaults failed:', error.message);
            console.error('[Test 2] Status code:', error.statusCode);
            if (error.body) {
                // Try to read the body if it's a stream
                try {
                    const reader = error.body.readableStream.getReader();
                    const { value } = await reader.read();
                    const bodyText = new TextDecoder().decode(value);
                    console.error('[Test 2] Error body:', bodyText);
                } catch (readError) {
                    console.error('[Test 2] Could not read error body');
                }
            }
        }

        // Test 3: Try TTS with voice_settings
        console.log('\n[Test 3] Testing TTS with voice_settings...');
        try {
            const audioStream = await client.textToSpeech.convertAsStream(
                defaultVoice,
                {
                    text: "Hello, this is a test with settings.",
                    model_id: "eleven_turbo_v2",
                    voice_settings: {
                        stability: 0.5,
                        similarity_boost: 0.75,
                        use_speaker_boost: true
                    }
                }
            );
            console.log('[Test 3] ✅ TTS with voice_settings succeeded!');
        } catch (error) {
            console.error('[Test 3] ❌ TTS with voice_settings failed:', error.message);
            console.error('[Test 3] Status code:', error.statusCode);
        }

        // Test 4: Try TTS with pcm_16000 output format
        console.log('\n[Test 4] Testing TTS with pcm_16000 output format...');
        try {
            const audioStream = await client.textToSpeech.convertAsStream(
                defaultVoice,
                {
                    text: "Hello, this is a test with PCM format.",
                    model_id: "eleven_turbo_v2",
                    voice_settings: {
                        stability: 0.5,
                        similarity_boost: 0.75,
                        use_speaker_boost: true
                    },
                    output_format: "pcm_16000"
                }
            );
            console.log('[Test 4] ✅ TTS with pcm_16000 succeeded!');
        } catch (error) {
            console.error('[Test 4] ❌ TTS with pcm_16000 failed:', error.message);
            console.error('[Test 4] Status code:', error.statusCode);
        }

    } catch (error) {
        console.error('[Test] Fatal error:', error);
    }
}

testElevenLabs();
