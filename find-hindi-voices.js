// Find Hindi voices in the account
const { ElevenLabsClient } = require("elevenlabs");
require('dotenv').config();

async function findHindiVoices() {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const client = new ElevenLabsClient({ apiKey });

    console.log('[Search] Looking for Hindi voices...\n');

    const voicesResponse = await client.voices.getAll();
    const voices = voicesResponse.voices;

    // Filter for Hindi voices
    const hindiVoices = voices.filter(v => {
        const name = v.name.toLowerCase();
        const labels = (v.labels || {});

        // Check if voice is Hindi or Indian
        return name.includes('hindi') ||
            name.includes('india') ||
            labels.language === 'hi' ||
            labels.accent === 'indian' ||
            (v.description && v.description.toLowerCase().includes('hindi'));
    });

    console.log(`[Search] Found ${hindiVoices.length} potential Hindi voices:\n`);

    if (hindiVoices.length > 0) {
        hindiVoices.forEach((v, i) => {
            console.log(`${i + 1}. ${v.name}`);
            console.log(`   Voice ID: ${v.voice_id}`);
            console.log(`   Labels:`, v.labels || 'None');
            console.log(`   Description:`, v.description || 'N/A');
            console.log('');
        });
    } else {
        console.log('❌ No Hindi-specific voices found in premade voices.\n');
        console.log('💡 Checking for multilingual voices that support Hindi...\n');

        // Look for multilingual voices (they usually support Hindi)
        const multilingualVoices = voices.filter(v => {
            const name = v.name.toLowerCase();
            return name.includes('multilingual') || v.labels?.use_case === 'multilingual';
        });

        if (multilingualVoices.length > 0) {
            console.log(`[Search] Found ${multilingualVoices.length} multilingual voices (support Hindi):\n`);
            multilingualVoices.forEach((v, i) => {
                console.log(`${i + 1}. ${v.name}`);
                console.log(`   Voice ID: ${v.voice_id}`);
                console.log('');
            });
        }

        // Show all female voices as fallback
        console.log('\n[Search] All female voices (can be used for Hindi with multilingual models):\n');
        const femaleVoices = voices.filter(v => {
            const name = v.name.toLowerCase();
            const gender = v.labels?.gender;
            return gender === 'female' ||
                name.includes('she') ||
                ['sarah', 'rachel', 'laura', 'charlotte', 'alice', 'jessica', 'lily', 'grace'].some(n => name.includes(n));
        });

        femaleVoices.slice(0, 10).forEach((v, i) => {
            console.log(`${i + 1}. ${v.name}`);
            console.log(`   Voice ID: ${v.voice_id}`);
            console.log('');
        });

        console.log('\n💡 Recommendation: Use Sarah or Rachel with eleven_multilingual_v2 model');
        console.log('   These female voices work well with Hindi text using multilingual model');
    }
}

findHindiVoices().catch(console.error);
