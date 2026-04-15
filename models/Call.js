// Call Model - Tracks phone call sessions
const mongoose = require('mongoose');

const callSchema = new mongoose.Schema({
    _id: { type: String, alias: 'id' },
    // Owner user ID for multi-tenant isolation
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    assistantId: String,
    phoneNumberId: String,
    type: String, // 'inbound' or 'outbound'
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
    status: String, // 'initiated', 'ringing', 'in-progress', 'completed', 'failed'
    endedReason: String,
    messages: [mongoose.Schema.Types.Mixed],
    phoneCallProvider: String, // 'twilio'
    phoneCallProviderId: String,
    phoneCallTransport: String, // 'pstn', 'sip'
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

module.exports = Call;
