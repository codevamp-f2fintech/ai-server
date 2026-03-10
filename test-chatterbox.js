// Test script for Chatterbox TTS Service
// Usage: node test-chatterbox.js
// Requires: CHATTERBOX_BASE_URL in .env (or defaults to http://localhost:4123)

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ChatterboxService = require('./services/chatterbox.service');

const BASE_URL = process.env.CHATTERBOX_BASE_URL || 'http://localhost:4123';
const API_KEY = process.env.CHATTERBOX_API_KEY || null;

async function main() {
    console.log('\n🎙  Chatterbox TTS — Test Script');
    console.log('=====================================');
    console.log(`Server URL : ${BASE_URL}`);
    console.log(`Auth       : ${API_KEY ? '✅ API key set' : '⚠️  No API key'}\n`);

    const service = new ChatterboxService(BASE_URL, API_KEY);

    // ── 1. Health check ──────────────────────────────────────────
    console.log('1️⃣  Health check...');
    const health = await service.healthCheck();
    if (health.ok) {
        console.log(`   ✅ Server is healthy (status: ${health.status})`);
    } else {
        console.error(`   ❌ Server unreachable: ${health.error}`);
        console.error('   → Make sure the Chatterbox server is running at:', BASE_URL);
        process.exit(1);
    }

    // ── 2. List voices ───────────────────────────────────────────
    console.log('\n2️⃣  Listing voices...');
    try {
        const voices = await service.getVoices();
        if (voices.length === 0) {
            console.log('   ℹ️  No custom voices found (only default voice available)');
        } else {
            console.log(`   ✅ Found ${voices.length} voice(s):`);
            voices.forEach(v => console.log(`      - ${v.name} (lang: ${v.language || 'auto'})`));
        }
    } catch (err) {
        console.warn(`   ⚠️  Could not list voices: ${err.message}`);
    }

    // ── 3. TTS stream → μ-law buffer ────────────────────────────
    console.log('\n3️⃣  Generating speech (streaming WAV → μ-law 8kHz)...');
    const testText = 'Hello! This is a test of Chatterbox TTS integration. The audio has been transcoded for telephony.';

    const chunks = [];
    const startMs = Date.now();
    let firstChunkMs = null;

    try {
        await service.textToSpeechStream(
            testText,
            { voice: 'default', exaggeration: 0.7, cfg_weight: 0.5 },
            (chunk) => {
                if (firstChunkMs === null) firstChunkMs = Date.now() - startMs;
                chunks.push(chunk);
            }
        );

        const totalMs = Date.now() - startMs;
        const ulawBuf = Buffer.concat(chunks);
        const durationS = (ulawBuf.length / 8000).toFixed(2); // μ-law = 1 byte / sample @ 8kHz

        console.log(`   ✅ Success!`);
        console.log(`      First byte latency : ${firstChunkMs}ms`);
        console.log(`      Total generation   : ${totalMs}ms`);
        console.log(`      μ-law buffer size  : ${ulawBuf.length} bytes (~${durationS}s of audio)`);

        // Save to temp/
        const outDir = path.join(__dirname, 'temp');
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
        const outFile = path.join(outDir, 'chatterbox-test.ulaw');
        fs.writeFileSync(outFile, ulawBuf);
        console.log(`      Saved to           : ${outFile}`);
        console.log('      (Play with: ffplay -f mulaw -ar 8000 -ac 1 temp/chatterbox-test.ulaw)');

    } catch (err) {
        console.error(`   ❌ TTS generation failed: ${err.message}`);
        process.exit(1);
    }

    console.log('\n✅  All tests passed! Chatterbox is ready to use.');
    console.log('\nTo use Chatterbox as TTS in an agent, set:');
    console.log('  voice.provider = "chatterbox"');
    console.log('  voice.voice    = "default"  (or any named voice on your server)\n');
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
