require('dotenv').config();
const https = require('https');

const baseUrl = process.env.CHATTERBOX_BASE_URL;
const apiKey = process.env.CHATTERBOX_API_KEY;

function check(text, name, withContentLength) {
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

    const headers = {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
    };
    if (withContentLength) {
        headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = https.request(baseUrl + '/generate', {
        method: 'POST',
        headers
    }, (res) => {
        let len = 0;
        res.on('data', (d) => { len += d.length; });
        res.on('end', () => {
            console.log(name, '-> Size:', len, 'Status:', res.statusCode);
        });
    });
    req.write(body);
    req.end();
}

const text = "नमस्ते! मैं Neha, Parth Gautam Foundation से बात कर रही हूँ। मैं आपकी किस तरह help कर सकती हूँ?";
check(text, "WITH Content-Length", true);
check(text, "WITHOUT Content-Length", false);
