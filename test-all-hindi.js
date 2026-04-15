// Test ALL Hindi voices to find which ones work with current plan
const { ElevenLabsClient } = require("elevenlabs");
require('dotenv').config();

async function testAllHindiVoices() {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const client = new ElevenLabsClient({ apiKey });

    const hindiVoices = [
        { name: 'Saavi – Customer Care', id: 'DpnM70iDHNHZ0Mguv6GJ' },
        { name: 'Tarini - Narrator', id: 'FFmp1h1BMl0iVHA0JxrI' },
        { name: 'Charu IVC', id: 'HLYW5olfpQbnOdq6mpFn' },
        { name: 'Saavi - Recovery', id: 'LWFgMHXb8m0uANBUpzlq' },
        { name: 'Anjali - Soothing', id: 'gHu9GtaHOXcSqFTK06ux' },
        { name: 'Anika - Insurance', id: 'jUjRbhZWoMK4aDciW36V' },
        { name: 'Tarini - Recovery Agent', id: 'kiaJRdXJzloFWi6AtFBf' },
        { name: 'Charu', id: 'zlO2jbmy7nvySZTqfoe2' }
    ];

    console.log('[Test] Testing all Hindi voices for accessibility...\n');

    const workingVoices = [];
    const restrictedVoices = [];

    for (const voice of hindiVoices) {
        try {
            const audioStream = await client.textToSpeech.convertAsStream(
                voice.id,
                {
                    text: "नमस्ते",
                    model_id: "eleven_turbo_v2",
                    voice_settings: {
                        stability: 0.5,
                        similarity_boost: 0.75,
                        use_speaker_boost: true
                    },
                    output_format: "pcm_16000"
                }
            );
            console.log(`✅ ${voice.name} - WORKS!`);
            workingVoices.push(voice);
        } catch (error) {
            if (error.statusCode === 402) {
                console.log(`❌ ${voice.name} - Requires paid plan (402)`);
                restrictedVoices.push(voice);
            } else {
                console.log(`❌ ${voice.name} - Error: ${error.statusCode}`);
            }
        }
    }

    console.log('\n' + '='.repeat(60));
    console.log(`\n✅ Working Hindi voices (${workingVoices.length}):`);
    workingVoices.forEach(v => {
        console.log(`   - ${v.name} (${v.id})`);
    });

    console.log(`\n❌ Restricted voices (${restrictedVoices.length}):`);
    restrictedVoices.forEach(v => {
        console.log(`   - ${v.name} (requires upgrade)`);
    });

    if (workingVoices.length > 0) {
        console.log(`\n💡 Recommended: ${workingVoices[0].name}`);
        console.log(`   Voice ID: ${workingVoices[0].id}\n`);
    } else {
        console.log('\n⚠️  No Hindi voices available on current plan.');
        console.log('💡 Consider using multilingual female English voices for Hindi content.\n');
    }
}

testAllHindiVoices();
