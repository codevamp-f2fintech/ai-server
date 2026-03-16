require('dotenv').config();
const https = require('https');

const baseUrl = process.env.CHATTERBOX_BASE_URL;
const apiKey = process.env.CHATTERBOX_API_KEY;

function check(text, name, lang) {
    const bodyObj = {
        prompt: text,
        voice_key: "voices/orgs/org_3ASrrlpDoPNtccXHAIerfqce2XM/cmmitkvsn00002z9keaj75fq1",
        temperature: 0.8,
        top_p: 0.95,
        top_k: 1000,
        repetition_penalty: 1.2,
        norm_loudness: true,
    };
    if (lang) bodyObj.language = lang;

    const body = JSON.stringify(bodyObj);
    const req = https.request(baseUrl + '/generate', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'Content-Length': Buffer.byteLength(body)
        }
    }, (res) => {
        let len = 0;
        let errStr = '';
        res.on('data', (d) => { len += d.length; errStr += d.toString(); });
        res.on('end', () => {
            console.log(name, '-> Size:', len, 'Status:', res.statusCode);
            if (res.statusCode !== 200) console.log(errStr);
        });
    });
    req.write(body);
    req.end();
}

const t1 = "नमस्ते! मैं Neha, Parth Gautam Foundation से बात कर रही हूँ। मैं आपकी किस तरह help कर सकती हूँ?";
check(t1, "With lang=hi", "hi");
check(t1, "Without lang", null);
check("मैं Neha, Parth Gautam Foundation से बात कर रही हूँ।", "Part 2 without lang", null);
