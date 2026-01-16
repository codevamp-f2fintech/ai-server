// Authentication Middleware - JWT verification
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET || 'vani-voice-ai-secret-key-change-in-production';

/**
 * Middleware to verify JWT token and attach user to request
 */
const authenticate = async (req, res, next) => {
    try {
        // Get token from header
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                error: 'Authentication required',
                message: 'Please provide a valid token'
            });
        }

        const token = authHeader.split(' ')[1];

        // Verify token
        const decoded = jwt.verify(token, JWT_SECRET);

        // Find user
        const user = await User.findById(decoded.userId);

        if (!user) {
            return res.status(401).json({
                error: 'User not found',
                message: 'The user associated with this token no longer exists'
            });
        }

        if (!user.isActive) {
            return res.status(401).json({
                error: 'Account deactivated',
                message: 'Your account has been deactivated'
            });
        }

        // Attach user to request
        req.user = user;
        req.userId = user._id;

        next();
    } catch (error) {
        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({
                error: 'Invalid token',
                message: 'The provided token is invalid'
            });
        }
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({
                error: 'Token expired',
                message: 'Your session has expired. Please log in again'
            });
        }

        console.error('Auth middleware error:', error);
        return res.status(500).json({
            error: 'Authentication error',
            message: error.message
        });
    }
};

/**
 * Optional authentication - allows both authenticated and unauthenticated requests
 */
const optionalAuth = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return next();
        }

        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await User.findById(decoded.userId);

        if (user && user.isActive) {
            req.user = user;
            req.userId = user._id;
        }

        next();
    } catch (error) {
        // Silently continue without authentication
        next();
    }
};

/**
 * Require specific subscription tier
 */
const requireSubscription = (minTier) => {
    const tierOrder = ['free', 'starter', 'pro', 'enterprise'];

    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                error: 'Authentication required'
            });
        }

        const userTierIndex = tierOrder.indexOf(req.user.subscription.tier);
        const requiredTierIndex = tierOrder.indexOf(minTier);

        if (userTierIndex < requiredTierIndex) {
            return res.status(403).json({
                error: 'Subscription required',
                message: `This feature requires ${minTier} subscription or higher`
            });
        }

        next();
    };
};

/**
 * Generate JWT tokens
 */
const generateTokens = (userId) => {
    const accessToken = jwt.sign(
        { userId },
        JWT_SECRET,
        { expiresIn: '7d' }
    );

    const refreshToken = jwt.sign(
        { userId, type: 'refresh' },
        JWT_SECRET,
        { expiresIn: '30d' }
    );

    return { accessToken, refreshToken };
};

module.exports = {
    authenticate,
    optionalAuth,
    requireSubscription,
    generateTokens,
    JWT_SECRET
};
