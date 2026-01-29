// PhoneNumber Model - MongoDB Schema for storing phone numbers with Twilio credentials
// User-scoped phone numbers that can be assigned to agents

const mongoose = require('mongoose');

const phoneNumberSchema = new mongoose.Schema({
    // Owner user ID for multi-tenant isolation
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },

    // Phone number details
    number: {
        type: String,
        required: true,
        trim: true
    },

    name: {
        type: String,
        required: true,
        trim: true
    },

    // Provider type
    provider: {
        type: String,
        enum: ['twilio', 'vapi-sip', 'byo-sip'],
        required: true,
        default: 'twilio'
    },

    // Twilio credentials (for 'twilio' provider)
    twilioAccountSid: {
        type: String,
        required: function () { return this.provider === 'twilio'; }
    },

    twilioAuthToken: {
        type: String,
        required: function () { return this.provider === 'twilio'; }
        // TODO: Encrypt this field in production
    },

    // VAPI SIP details (for 'vapi-sip' provider)
    sipUri: {
        type: String,
        required: function () { return this.provider === 'vapi-sip'; }
    },

    sipAuthentication: {
        username: String,
        password: String
    },

    // BYO SIP details (for 'byo-sip' provider)
    sipCredentialId: {
        type: String,
        required: function () { return this.provider === 'byo-sip'; }
    },

    // Status
    status: {
        type: String,
        enum: ['active', 'inactive'],
        default: 'active'
    },

    // Optional: Reference to VAPI phone number ID (for migration/compatibility)
    vapiPhoneNumberId: {
        type: String,
        sparse: true
    },

    // Timestamps
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

// Indexes for performance
phoneNumberSchema.index({ userId: 1, provider: 1 });
phoneNumberSchema.index({ userId: 1, status: 1 });
phoneNumberSchema.index({ number: 1 });

// Instance methods
phoneNumberSchema.methods.canBeUsedForCalls = function () {
    return this.status === 'active' && this.provider === 'twilio';
};

phoneNumberSchema.methods.getTwilioCredentials = function () {
    if (this.provider !== 'twilio') {
        throw new Error('Phone number is not a Twilio provider');
    }
    return {
        accountSid: this.twilioAccountSid,
        authToken: this.twilioAuthToken,
        phoneNumber: this.number
    };
};

// Static methods
phoneNumberSchema.statics.findByUser = function (userId, filters = {}) {
    return this.find({ userId, ...filters }).sort({ createdAt: -1 });
};

phoneNumberSchema.statics.findTwilioNumbers = function (userId) {
    return this.find({ userId, provider: 'twilio', status: 'active' }).sort({ createdAt: -1 });
};

const PhoneNumber = mongoose.model('PhoneNumber', phoneNumberSchema);

module.exports = PhoneNumber;
