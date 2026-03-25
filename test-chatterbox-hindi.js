require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ChatterboxService = require('./services/chatterbox.service');

const BASE_URL = process.env.CHATTERBOX_BASE_URL || 'http://localhost:4123';
const API_KEY = process.env.CHATTERBOX_API_KEY || null;

async function testPhrases() {
    const service = new ChatterboxService(BASE_URL, API_KEY);
    const voiceKey = "voices/orgs/org_3AWTzKf8mkDJvMqBkM4PwTrjb2G/cmmkeyhwd0000wgwcxuq22r7l";

    const phrases = [
        "नमस्ते मैं Neha Parth Gautam Foundation से बात कर रही हूँ मैं आपकी किस तरह help कर सकती हूँ?",
        "Parth Gautam Foundation एक social welfare organization है जो education, healthcare और community welfare initiatives के ज़रिए जरूरतमंद लोगों की help करता है।"
    ];

    for (let i = 0; i < phrases.length; i++) {
        let text = phrases[i];
        console.log(`\nTesting Phrase ${i+1}: ${text}`);
        
        let sanitizedText = text.replace(/[,;:!?।|.\n]/g, ' ');
        console.log(`Sanitized: ${sanitizedText}`);
        
        const chunks = [];
        try {
            await service.textToSpeechStream(
                text,
                { voice: voiceKey, language: 'hi' },
                (chunk) => chunks.push(chunk)
            );
            
            const ulawBuf = Buffer.concat(chunks);
            console.log(`Result: ${ulawBuf.length} bytes`);
        } catch (err) {
            console.error(`Error: ${err.message}`);
        }
    }
}

testPhrases().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
