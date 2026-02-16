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
const phoneNumberRoutes = require('./routes/phone-numbers');
const authRoutes = require('./routes/auth');
const { authenticate } = require('./middleware/auth');
const ElevenLabsAgentClient = require('./clients/elevenlabs-agent-client');

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

// Mount routes
app.use('/elevenlabs/agents', agentRoutes);
app.use('/elevenlabs/voices', voiceRoutes);
app.use('/elevenlabs/phone-numbers', phoneNumberRoutes);
app.use('/auth', authRoutes);

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
if (!ELEVENLABS_API_KEY) {
  console.error('FATAL: ELEVENLABS_API_KEY environment variable is not set.');
  process.exit(1);
}

// Initialize ElevenLabs client
const elevenLabsClient = new ElevenLabsAgentClient(ELEVENLABS_API_KEY);

// SECURED: Outbound call endpoint requires authentication
app.post('/outbound-call', authenticate, async (req, res) => {
  try {
    const { to, agentId } = req.body;
    if (!to) return res.status(400).json({ error: 'missing "to" phone number' });

    let elevenLabsAgentId;
    let agentName = 'Default Agent';
    let agentDbId = null;

    // Agent is required for ElevenLabs
    if (!agentId) {
      return res.status(400).json({ error: 'agentId is required' });
    }

    const Agent = require('./models/Agent');

    // Check if this is a direct ElevenLabs agent ID or a MongoDB ID
    const isElevenLabsDirectId = agentId.startsWith('agent_');

    if (isElevenLabsDirectId) {
      // Using an agent directly from ElevenLabs dashboard (not in our database)
      console.log(`Using ElevenLabs agent directly: ${agentId}`);
      elevenLabsAgentId = agentId;
      agentName = 'ElevenLabs Agent (Direct)';
      agentDbId = null; // Not in our database
    } else {
      // SECURITY: Verify user owns this agent from database
      const agent = await Agent.findOne({ _id: agentId, userId: req.userId });

      if (!agent) {
        return res.status(404).json({ error: 'Agent not found in your account' });
      }

      if (agent.status !== 'active') {
        return res.status(400).json({ error: 'Agent is not active' });
      }

      elevenLabsAgentId = agent.elevenLabsAgentId;
      agentName = agent.name;
      agentDbId = agent._id;

      // Update agent statistics
      agent.statistics.lastUsed = new Date();
      await agent.save();
    }


    console.log(`User ${req.userId} initiating call with agent: ${agentName} (${elevenLabsAgentId})`);

    // Get ElevenLabs phone number ID from environment
    const phoneNumberId = process.env.ELEVENLABS_PHONE_NUMBER_ID;
    if (!phoneNumberId) {
      return res.status(500).json({ error: 'ELEVENLABS_PHONE_NUMBER_ID not configured in environment variables' });
    }

    // Initiate call via ElevenLabs with phone number ID
    const callData = await elevenLabsClient.initiateOutboundCall(elevenLabsAgentId, to, phoneNumberId);


    // Save to MongoDB with agent info AND userId
    callData.userId = req.userId; // Associate call with user
    callData.agentId = agentDbId;
    callData.agentName = agentName;
    callData._id = callData.conversation_id; // Use ElevenLabs conversation_id as our ID
    callData.startedAt = new Date();
    callData.customer = { number: to };
    callData.status = 'initiated';

    const call = new Call(callData);
    await call.save();

    return res.status(200).json(callData);
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

    // Fetch call from our database
    const call = await Call.findById(id);

    // Verify call exists and user owns it
    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }

    if (call.userId && !call.userId.equals(req.userId)) {
      return res.status(404).json({ error: 'Call not found' }); // Don't reveal it exists
    }

    // Return the call data from our database
    return res.status(200).json(call);
  } catch (err) {
    console.error('Error fetching call info:', err.message);
    return res.status(500).json({ error: 'Failed to fetch call info', detail: err.message });
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
    // Get calls from our own database filtered by user
    const calls = await Call.find({ userId: req.userId, type: 'inbound' })
      .sort({ createdAt: -1 })
      .limit(100);

    console.log('User', req.userId, 'fetched inbound calls');
    res.status(200).json(calls);
  } catch (err) {
    console.error('Failed to fetch inbound calls', err.message);
    res.status(500).json({ error: 'Failed to fetch inbound calls', detail: err.message });
  }
});

// Webhook endpoint for ElevenLabs conversation events
app.post('/elevenlabs/webhook', async (req, res) => {
  try {
    const event = req.body;
    console.log('ElevenLabs webhook event:', event.type || event.event_type);

    // Handle conversation end events
    if (event.type === 'conversation.end' || event.event_type === 'conversation_end') {
      const conversationId = event.conversation_id;

      await Call.findByIdAndUpdate(conversationId, {
        status: 'ended',
        endedAt: new Date(),
        transcript: event.transcript,
        summary: event.summary,
        recordingUrl: event.recording_url
      });

      return res.status(200).send('ok');
    }

    // Handle conversation updates
    if (event.type === 'conversation.update' || event.event_type === 'conversation_update') {
      const conversationId = event.conversation_id;

      await Call.findByIdAndUpdate(conversationId, {
        transcript: event.transcript,
        messages: event.messages,
        status: event.status
      });

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
