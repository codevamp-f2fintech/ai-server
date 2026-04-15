// List all available voices and update agent with a valid voice
const { ElevenLabsClient } = require("elevenlabs");
const mongoose = require('mongoose');
const Agent = require('./models/Agent');
require('dotenv').config();

async function fixAgentVoice() {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const client = new ElevenLabsClient({ apiKey });

    console.log('[Fix] Getting all available voices...\n');

    // Get all voices
    const voicesResponse = await client.voices.getAll();
    const voices = voicesResponse.voices;

    console.log(`[Fix] Found ${voices.length} available voices:\n`);

    // Show first 10 voices
    voices.slice(0, 10).forEach((v, i) => {
        console.log(`${i + 1}. ${v.name}`);
        console.log(`   ID: ${v.voice_id}`);
        console.log(`   Category: ${v.category || 'N/A'}`);
        console.log('');
    });

    console.log('\n[Fix] Recommended voices for your agent:');
    console.log('─'.repeat(50));

    // Find good professional voices
    const recommendedVoices = [
        voices.find(v => v.name.toLowerCase().includes('adam')),
        voices.find(v => v.name.toLowerCase().includes('rachel')),
        voices.find(v => v.name.toLowerCase().includes('sarah')),
        voices[0] // First available voice as fallback
    ].filter(Boolean);

    recommendedVoices.forEach((v, i) => {
        console.log(`\n${i + 1}. ${v.name}`);
        console.log(`   Voice ID: ${v.voice_id}`);
        console.log(`   Category: ${v.category || 'General'}`);
    });

    console.log('\n' + '─'.repeat(50));
    console.log('\n💡 To update your agent voice:');
    console.log('   1. Choose a voice ID from above');
    console.log('   2. Update in the frontend UI, or');
    console.log('   3. I can update it automatically for you');
    console.log('\nDefault recommendation: ' + voicesResponse.voices[0].name);
    console.log('Voice ID: ' + voicesResponse.voices[0].voice_id);
}

fixAgentVoice().catch(console.error);
