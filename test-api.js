require('dotenv').config();
const https = require('https');
const fs = require('fs');

const data = JSON.stringify({
    prompt: "नमस्ते! मैं Neha, Parth Gautam Foundation से बात कर रही हूँ। मैं आपकी किस तरह help कर सकती हूँ?",
    voice_key: "voices/orgs/org_3ASrrlpDoPNtccXHAIerfqce2XM/cmmitkvsn00002z9keaj75fq1",
    language: "hi" // Hindi
});

const req = https.request(process.env.CHATTERBOX_BASE_URL + '/generate', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CHATTERBOX_API_KEY
    }
}, (res) => {
    console.log('Status:', res.statusCode);
    const file = fs.createWriteStream('out.wav');
    res.pipe(file);
    file.on('finish', () => console.log('WAV saved to out.wav'));
});
req.on('error', (e) => console.error(e));
req.write(data);
req.end();
