require('dotenv').config();
const https = require('https');

const baseUrl = process.env.CHATTERBOX_BASE_URL;
const apiKey = process.env.CHATTERBOX_API_KEY;

function check(text, name) {
    const body = JSON.stringify({
        prompt: text,
        voice_key: "voices/orgs/org_3ASrrlpDoPNtccXHAIerfqce2XM/cmmitkvsn00002z9keaj75fq1",
        temperature: 0.8,
        top_p: 0.95,
        top_k: 1000,
        repetition_penalty: 1.2,
        norm_loudness: true,
        language: "hi" // Hindi
    });

    const req = https.request(baseUrl + '/generate', {
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
            console.log(name, '-> Status:', res.statusCode, 'Body:', raw.length < 500 ? raw.toString() : raw.length);
        });
    });
    req.write(body);
    req.end();
}

check("मैं Neha, Parth Gautam Foundation से बात कर रही हूँ।", "Part 2");
check("मैं आपकी किस तरह help कर सकती हूँ?", "Part 3");
check("हाँ, आपकी आवाज़ बिल्कुल साफ़ आ रही है", "Part 4");
