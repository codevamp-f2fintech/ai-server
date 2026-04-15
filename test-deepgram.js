require('dotenv').config();
const DeepgramService = require('./services/deepgram.service');
const deepgram = new DeepgramService(process.env.DEEPGRAM_API_KEY);
console.log('Deepgram initialized successfully!');
console.log('API Key:', process.env.DEEPGRAM_API_KEY ? 'Set ✓' : 'Missing ✗');