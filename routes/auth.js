// Authentication Routes - Register, Login, Profile
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { authenticate, generateTokens } = require('../middleware/auth');

/**
 * POST /auth/register
 * Register a new user
 */
router.post('/register', async (req, res) => {
    try {
        const { email, password, name, phone } = req.body;

        // Validate required fields
        if (!email || !password || !name) {
            return res.status(400).json({
                error: 'Missing required fields',
                message: 'Email, password, and name are required'
            });
        }

        // Check if user already exists
        const existingUser = await User.findOne({ email: email.toLowerCase() });
        if (existingUser) {
            return res.status(409).json({
                error: 'Email already registered',
                message: 'An account with this email already exists. Please log in.'
            });
        }

        // Create new user
        const user = new User({
            email: email.toLowerCase(),
            password,
            name,
            phone: phone || null,
            wallet: {
                balance: 100, // Welcome bonus ₹100
                currency: 'INR'
            }
        });

        await user.save();

        // Generate tokens
        const { accessToken, refreshToken } = generateTokens(user._id);

        // Save refresh token
        user.refreshToken = refreshToken;
        user.lastLoginAt = new Date();
        await user.save();

        console.log('New user registered:', user.email);

        res.status(201).json({
            success: true,
            message: 'Registration successful',
            user: user.toPublicJSON(),
            accessToken,
            refreshToken
        });

    } catch (error) {
        console.error('Registration error:', error);

        if (error.name === 'ValidationError') {
            const messages = Object.values(error.errors).map(e => e.message);
            return res.status(400).json({
                error: 'Validation error',
                message: messages.join(', ')
            });
        }

        res.status(500).json({
            error: 'Registration failed',
            message: error.message
        });
    }
});

/**
 * POST /auth/login
 * Login user with email and password
 */
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // Validate required fields
        if (!email || !password) {
            return res.status(400).json({
                error: 'Missing credentials',
                message: 'Email and password are required'
            });
        }

        // Find user with password
        const user = await User.findByEmailWithPassword(email.toLowerCase());

        if (!user) {
            return res.status(401).json({
                error: 'Invalid credentials',
                message: 'No account found with this email'
            });
        }

        // Check if account is active
        if (!user.isActive) {
            return res.status(401).json({
                error: 'Account deactivated',
                message: 'Your account has been deactivated. Please contact support.'
            });
        }

        // Verify password
        const isMatch = await user.comparePassword(password);

        if (!isMatch) {
            return res.status(401).json({
                error: 'Invalid credentials',
                message: 'Incorrect password'
            });
        }

        // Generate tokens
        const { accessToken, refreshToken } = generateTokens(user._id);

        // Update user
        user.refreshToken = refreshToken;
        user.lastLoginAt = new Date();
        await user.save();

        console.log('User logged in:', user.email);

        res.json({
            success: true,
            message: 'Login successful',
            user: user.toPublicJSON(),
            accessToken,
            refreshToken
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({
            error: 'Login failed',
            message: error.message
        });
    }
});

/**
 * POST /auth/logout
 * Logout user and invalidate refresh token
 */
router.post('/logout', authenticate, async (req, res) => {
    try {
        req.user.refreshToken = null;
        await req.user.save();

        res.json({
            success: true,
            message: 'Logged out successfully'
        });

    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({
            error: 'Logout failed',
            message: error.message
        });
    }
});

/**
 * POST /auth/refresh
 * Refresh access token using refresh token
 */
router.post('/refresh', async (req, res) => {
    try {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            return res.status(400).json({
                error: 'Refresh token required'
            });
        }

        // Find user with this refresh token
        const user = await User.findOne({ refreshToken }).select('+refreshToken');

        if (!user) {
            return res.status(401).json({
                error: 'Invalid refresh token'
            });
        }

        // Generate new tokens
        const tokens = generateTokens(user._id);

        // Update refresh token
        user.refreshToken = tokens.refreshToken;
        await user.save();

        res.json({
            success: true,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken
        });

    } catch (error) {
        console.error('Token refresh error:', error);
        res.status(500).json({
            error: 'Token refresh failed',
            message: error.message
        });
    }
});

/**
 * GET /auth/me
 * Get current user profile
 */
router.get('/me', authenticate, async (req, res) => {
    try {
        res.json({
            success: true,
            user: req.user.toPublicJSON()
        });
    } catch (error) {
        console.error('Get profile error:', error);
        res.status(500).json({
            error: 'Failed to get profile',
            message: error.message
        });
    }
});

/**
 * PATCH /auth/me
 * Update current user profile
 */
router.patch('/me', authenticate, async (req, res) => {
    try {
        const allowedUpdates = ['name', 'phone', 'avatar', 'preferredLanguage', 'settings'];
        const updates = {};

        // Filter allowed updates
        for (const key of allowedUpdates) {
            if (req.body[key] !== undefined) {
                updates[key] = req.body[key];
            }
        }

        // Apply updates
        Object.assign(req.user, updates);
        await req.user.save();

        res.json({
            success: true,
            message: 'Profile updated successfully',
            user: req.user.toPublicJSON()
        });

    } catch (error) {
        console.error('Update profile error:', error);

        if (error.name === 'ValidationError') {
            const messages = Object.values(error.errors).map(e => e.message);
            return res.status(400).json({
                error: 'Validation error',
                message: messages.join(', ')
            });
        }

        res.status(500).json({
            error: 'Failed to update profile',
            message: error.message
        });
    }
});

/**
 * PATCH /auth/password
 * Change password
 */
router.patch('/password', authenticate, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({
                error: 'Both current and new password are required'
            });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({
                error: 'New password must be at least 6 characters'
            });
        }

        // Get user with password
        const user = await User.findById(req.user._id).select('+password');

        // Verify current password
        const isMatch = await user.comparePassword(currentPassword);
        if (!isMatch) {
            return res.status(401).json({
                error: 'Current password is incorrect'
            });
        }

        // Update password
        user.password = newPassword;
        await user.save();

        res.json({
            success: true,
            message: 'Password changed successfully'
        });

    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({
            error: 'Failed to change password',
            message: error.message
        });
    }
});

/**
 * GET /auth/wallet
 * Get wallet balance and history
 */
router.get('/wallet', authenticate, async (req, res) => {
    try {
        res.json({
            success: true,
            wallet: req.user.wallet
        });
    } catch (error) {
        console.error('Get wallet error:', error);
        res.status(500).json({
            error: 'Failed to get wallet',
            message: error.message
        });
    }
});

module.exports = router;
