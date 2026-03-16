require('dotenv').config();
const https = require('https');

const baseUrl = process.env.CHATTERBOX_BASE_URL;
const apiKey = process.env.CHATTERBOX_API_KEY;

const text = "नमस्ते! मैं Neha, Parth Gautam Foundation से बात कर रही हूँ। मैं आपकी किस तरह help कर सकती हूँ?";

const bodyObj = {
    prompt: text,
    voice_key: "voices/orgs/org_3ASrrlpDoPNtccXHAIerfqce2XM/cmmitkvsn00002z9keaj75fq1",
    temperature: 0.8,
    top_p: 0.95,
    top_k: 1000,
    repetition_penalty: 1.2,
    norm_loudness: true,
    language: "hi" // Hindi
};
const body = JSON.stringify(bodyObj);
const url = new URL('/generate', baseUrl);

const req = https.request({
    hostname: url.hostname,
    port: 443,
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'Content-Length': Buffer.byteLength(body)
    }
}, (res) => {
    let raw = Buffer.alloc(0);
    res.on('data', (d) => { raw = Buffer.concat([raw, d]); });
    res.on('end', () => {
        console.log('Status:', res.statusCode);
        console.log('Content-Type:', res.headers['content-type']);
        console.log('Length:', raw.length);
        if (raw.length < 1000) {
            console.log('Body:', raw.toString());
        } else {
            console.log('Body starts with:', raw.slice(0, 100).toString('hex'));
        }
    });
});
req.write(body);
req.end();
