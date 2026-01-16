// server.js
// Catch unhandled errors and promise rejections
process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('unhandledRejection', { reason, promise });
});

// Load environment variables from .env file
require('dotenv').config();

// Requires: npm i express axios body-parser
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const cors = require('cors');

// Import routes
const agentRoutes = require('./routes/agents');
const voiceRoutes = require('./routes/voices');
const fileRoutes = require('./routes/files');
const phoneNumberRoutes = require('./routes/phone-numbers');
const credentialRoutes = require('./routes/credentials');
const authRoutes = require('./routes/auth');
const { authenticate } = require('./middleware/auth');

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/ai-telecaller')
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// Mongoose Call Schema and Model
const callSchema = new mongoose.Schema({
  _id: { type: String, alias: 'id' },
  // Owner user ID for multi-tenant isolation
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  assistantId: String,
  phoneNumberId: String,
  type: String,
  startedAt: Date,
  endedAt: Date,
  transcript: String,
  recordingUrl: String,
  summary: String,
  createdAt: Date,
  updatedAt: Date,
  orgId: String,
  cost: Number,
  customer: {
    number: String
  },
  status: String,
  endedReason: String,
  messages: [mongoose.Schema.Types.Mixed],
  phoneCallProvider: String,
  phoneCallProviderId: String,
  phoneCallTransport: String,
  monitor: {
    listenUrl: String,
    controlUrl: String
  },
  transport: {
    callSid: String,
    provider: String,
    accountSid: String
  },
  // Agent tracking
  agentId: String, // Reference to Agent._id
  agentName: String // Agent name at time of call
}, { _id: false, timestamps: true });

const Call = mongoose.model('Call', callSchema);

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Mount agent routes
app.use('/vapi/agents', agentRoutes);
app.use('/vapi/voices', voiceRoutes);
app.use('/vapi/files', fileRoutes);
app.use('/vapi/phone-numbers', phoneNumberRoutes);
app.use('/vapi/credentials', credentialRoutes);
app.use('/auth', authRoutes);

const VAPI_KEY = process.env.VAPI_KEY;
if (!VAPI_KEY) {
  console.error('FATAL: VAPI_KEY environment variable is not set.');
  process.exit(1);
}
const BASE = 'https://api.vapi.ai';

// SECURED: Outbound call endpoint requires authentication
app.post('/outbound-call', authenticate, async (req, res) => {
  try {
    const { to, agentId } = req.body;
    if (!to) return res.status(400).json({ error: 'missing "to" phone number' });

    let assistantId = process.env.VAPI_ASSISTANT_ID;
    let agentName = 'Default Agent';
    let agentDbId = null;

    // If custom agent is specified, verify ownership and use it
    if (agentId) {
      const Agent = require('./models/Agent');
      // SECURITY: Verify user owns this agent
      const agent = await Agent.findOne({ _id: agentId, userId: req.userId });

      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      if (agent.status !== 'active') {
        return res.status(400).json({ error: 'Agent is not active' });
      }

      assistantId = agent.vapiAssistantId;
      agentName = agent.name;
      agentDbId = agent._id;

      console.log(`User ${req.userId} using agent: ${agentName} (${assistantId})`);
    } else {
      console.log(`User ${req.userId} using default agent`);
    }

    const payload = {
      assistantId: assistantId,
      phoneNumberId: process.env.VAPI_PHONE_ID,
      customer: { number: to }
    };

    const r = await axios.post(`${BASE}/call`, payload, {
      headers: {
        Authorization: `Bearer ${VAPI_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    // Save to MongoDB with agent info AND userId
    const callData = r.data;
    callData.userId = req.userId; // Associate call with user
    callData.agentId = agentDbId;
    callData.agentName = agentName;

    const call = new Call(callData);
    await call.save();

    // Update agent statistics if custom agent was used
    if (agentDbId) {
      const Agent = require('./models/Agent');
      const agent = await Agent.findById(agentDbId);
      if (agent) {
        agent.statistics.lastUsed = new Date();
        await agent.save();
      }
    }

    return res.status(200).json(r.data);
  } catch (err) {
    console.error('call error', err.response?.data || err.message);
    return res.status(500).json({ error: 'call failed', detail: err.response?.data || err.message });
  }
});

// SECURED: Get call info requires authentication and ownership check
app.get('/outbound-call-info/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'missing call "id"' });

    // First verify user owns this call
    const existingCall = await Call.findById(id);
    if (existingCall && existingCall.userId && !existingCall.userId.equals(req.userId)) {
      return res.status(404).json({ error: 'Call not found' });
    }

    const r = await axios.get(`${BASE}/call/${id}`, {
      headers: {
        Authorization: `Bearer ${VAPI_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    // Update and save to MongoDB
    await Call.findByIdAndUpdate(id, r.data, { upsert: true, new: true });

    return res.status(200).json(r.data);
  } catch (err) {
    console.error('call error', err.response?.data || err.message);
    return res.status(500).json({ error: 'call failed', detail: err.response?.data || err.message });
  }
});

// SECURED: Get all calls for the authenticated user only
app.get('/calls/list', authenticate, async (req, res) => {
  try {
    // SECURITY: Filter by userId to only show user's calls
    const calls = await Call.find({ userId: req.userId }).sort({ createdAt: -1 });
    res.status(200).json(calls);
  } catch (err) {
    console.error('Failed to fetch calls', err);
    res.status(500).json({ error: 'Failed to fetch calls' });
  }
});

// SECURED: Inbound calls list requires authentication
app.get('/inbound-calls/list', authenticate, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const r = await axios.get(`${BASE}/call`, {
      headers: {
        Authorization: `Bearer ${VAPI_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    console.log('User', req.userId, 'fetched inbound calls');
    res.status(200).json(r.data);
  } catch (err) {
    console.error('Failed to fetch inbound calls', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch inbound calls', detail: err.response?.data || err.message });
  }
});

// 2) Webhook endpoint for Vapi server events & function/tool calls
// Set this URL as the assistant/tool/server URL in dashboard or via API
app.post('/vapi/webhook', async (req, res) => {
  try {
    const msg = req.body.message || {};
    // Tool calls
    if (msg.type === 'tool-calls') {
      const toolCalls = msg.toolCallList || [];
      const results = [];

      for (const tc of toolCalls) {
        // Example: implement your own logic per tc.name and tc.arguments
        if (tc.name === 'lookup_customer') {
          const email = tc.arguments?.email;
          // lookup in your DB...
          const customer = { name: 'Jane Doe', preferred_language: 'fr', accountStatus: 'active' };
          results.push({ toolCallId: tc.id, result: customer });
        } else {
          // default/no-op
          results.push({ toolCallId: tc.id, result: null });
        }
      }

      // IMPORTANT: reply with results array so Vapi can resume conversation
      return res.json({ results });
    }

    // End-of-call report (store transcript/summary, etc)
    if (msg.type === 'end-of-call-report') {
      const call = msg.call || {};
      console.log('call ended', call.id, 'summary:', msg.artifact?.summary);
      // persist call metadata to DB...
      await Call.findByIdAndUpdate(call.id, {
        status: 'ended',
        summary: msg.artifact?.summary,
        endedAt: new Date(),
        transcript: msg.artifact?.transcript,
        recordingUrl: msg.artifact?.recordingUrl,
      });
      return res.status(200).send('ok');
    }

    // Status updates, transcript updates, other event types
    if (msg.type === 'status-update' || msg.type === 'transcript-update') {
      // handle as needed
      console.log('vapi event', msg.type, req.body);
      return res.status(200).send('ok');
    }

    // Default acknowledge
    res.status(200).send('ok');
  } catch (err) {
    console.error('webhook error', err);
    return res.status(500).json({ error: 'webhook failed' });
  }
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`Listening on ${PORT}`));

server.on('error', (err) => {
  console.error('Server error:', err);
});

process.on('exit', (code) => {
  console.log(`About to exit with code: ${code}`);
});
