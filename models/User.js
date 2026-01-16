// User Model - Authentication and Profile
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
    email: {
        type: String,
        required: [true, 'Email is required'],
        unique: true,
        lowercase: true,
        trim: true,
        match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email']
    },
    password: {
        type: String,
        required: [true, 'Password is required'],
        minlength: [6, 'Password must be at least 6 characters'],
        select: false // Don't include password in queries by default
    },
    name: {
        type: String,
        required: [true, 'Name is required'],
        trim: true,
        maxlength: [100, 'Name cannot exceed 100 characters']
    },
    phone: {
        type: String,
        trim: true,
        match: [/^\+?[1-9]\d{1,14}$/, 'Please provide a valid phone number']
    },
    avatar: {
        type: String,
        default: null
    },
    preferredLanguage: {
        type: String,
        enum: ['en', 'hi', 'ta', 'te', 'mr', 'gu', 'bn', 'kn', 'ml', 'pa'],
        default: 'hi'
    },
    subscription: {
        tier: {
            type: String,
            enum: ['free', 'starter', 'pro', 'enterprise'],
            default: 'free'
        },
        expiresAt: {
            type: Date,
            default: null
        }
    },
    wallet: {
        balance: {
            type: Number,
            default: 0,
            min: 0
        },
        currency: {
            type: String,
            default: 'INR'
        }
    },
    settings: {
        notifications: {
            lowCreditAlert: { type: Boolean, default: true },
            callFailures: { type: Boolean, default: true },
            newTemplates: { type: Boolean, default: false }
        },
        twoFactorEnabled: { type: Boolean, default: false }
    },
    lastLoginAt: {
        type: Date,
        default: null
    },
    isActive: {
        type: Boolean,
        default: true
    },
    refreshToken: {
        type: String,
        select: false
    }
}, {
    timestamps: true
});

// Index for faster queries
userSchema.index({ email: 1 });
userSchema.index({ createdAt: -1 });

// Hash password before saving
userSchema.pre('save', async function (next) {
    if (!this.isModified('password')) return next();

    try {
        const salt = await bcrypt.genSalt(12);
        this.password = await bcrypt.hash(this.password, salt);
        next();
    } catch (error) {
        next(error);
    }
});

// Compare password method
userSchema.methods.comparePassword = async function (candidatePassword) {
    return bcrypt.compare(candidatePassword, this.password);
};

// Get public profile (exclude sensitive fields)
userSchema.methods.toPublicJSON = function () {
    return {
        id: this._id,
        email: this.email,
        name: this.name,
        phone: this.phone,
        avatar: this.avatar,
        preferredLanguage: this.preferredLanguage,
        subscription: this.subscription,
        wallet: this.wallet,
        settings: this.settings,
        lastLoginAt: this.lastLoginAt,
        createdAt: this.createdAt
    };
};

// Get initials for avatar fallback
userSchema.methods.getInitials = function () {
    const names = this.name.split(' ');
    if (names.length >= 2) {
        return (names[0][0] + names[names.length - 1][0]).toUpperCase();
    }
    return this.name.substring(0, 2).toUpperCase();
};

// Static method to find by email with password
userSchema.statics.findByEmailWithPassword = function (email) {
    return this.findOne({ email }).select('+password');
};

const User = mongoose.model('User', userSchema);

module.exports = User;
