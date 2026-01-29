// Agent Model - MongoDB Schema for storing VAPI agent configurations

const mongoose = require('mongoose');

const agentSchema = new mongoose.Schema({
    // Owner user ID
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },

    // VAPI Assistant ID (optional - only for legacy VAPI integration)
    vapiAssistantId: {
        type: String,
        required: false,
        sparse: true, // Allow multiple null values
        index: true
    },

    // Phone Number ID - reference to PhoneNumber model
    // Used to determine which Twilio credentials to use for calls
    phoneNumberId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'PhoneNumber',
        required: false,
        index: true
    },

    // Agent name for display
    name: {
        type: String,
        required: true,
        trim: true
    },

    // Full configuration object as stored in VAPI
    configuration: {
        type: mongoose.Schema.Types.Mixed,
        required: true
    },

    // Agent status
    status: {
        type: String,
        enum: ['active', 'inactive', 'draft'],
        default: 'active'
    },

    // Statistics
    statistics: {
        totalCalls: {
            type: Number,
            default: 0
        },
        successfulCalls: {
            type: Number,
            default: 0
        },
        failedCalls: {
            type: Number,
            default: 0
        },
        averageDuration: {
            type: Number,
            default: 0
        },
        lastUsed: {
            type: Date,
            default: null
        }
    },

    // Metadata
    metadata: {
        description: {
            type: String,
            default: ''
        },
        tags: [{
            type: String,
            trim: true
        }],
        createdBy: {
            type: String,
            default: 'system'
        },
        version: {
            type: Number,
            default: 1
        },
        category: {
            type: String,
            enum: ['customer-support', 'sales', 'appointment', 'survey', 'other'],
            default: 'other'
        }
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
agentSchema.index({ name: 1 });
agentSchema.index({ status: 1 });
agentSchema.index({ 'metadata.category': 1 });
agentSchema.index({ 'statistics.lastUsed': -1 });

// Instance methods
agentSchema.methods.incrementCallCount = async function (success = true) {
    this.statistics.totalCalls += 1;
    if (success) {
        this.statistics.successfulCalls += 1;
    } else {
        this.statistics.failedCalls += 1;
    }
    this.statistics.lastUsed = new Date();
    await this.save();
};

agentSchema.methods.updateAverageDuration = async function (duration) {
    const totalCalls = this.statistics.totalCalls;
    const currentAvg = this.statistics.averageDuration;
    this.statistics.averageDuration = ((currentAvg * (totalCalls - 1)) + duration) / totalCalls;
    await this.save();
};

// Static methods
agentSchema.statics.findActive = function () {
    return this.find({ status: 'active' }).sort({ 'statistics.lastUsed': -1 });
};

agentSchema.statics.findByCategory = function (category) {
    return this.find({ 'metadata.category': category, status: 'active' });
};

agentSchema.statics.getMostUsed = function (limit = 5) {
    return this.find({ status: 'active' })
        .sort({ 'statistics.totalCalls': -1 })
        .limit(limit);
};

const Agent = mongoose.model('Agent', agentSchema);

module.exports = Agent;
