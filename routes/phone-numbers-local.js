// Phone Number Routes - MongoDB-based phone number management
// NO VAPI API CALLS - All data stored in MongoDB
// REQUIRES AUTHENTICATION

const express = require('express');
const router = express.Router();
const PhoneNumber = require('../models/PhoneNumber');
const { authenticate } = require('../middleware/auth');

// Apply authentication middleware to ALL routes
router.use(authenticate);

/**
 * GET /api/phone-numbers
 * List all phone numbers for the authenticated user
 */
router.get('/', async (req, res) => {
    try {
        const phoneNumbers = await PhoneNumber.findByUser(req.userId);

        res.json({
            success: true,
            phoneNumbers: phoneNumbers.map(pn => ({
                id: pn._id,
                number: pn.number,
                name: pn.name,
                provider: pn.provider,
                status: pn.status,
                sipUri: pn.sipUri,
                createdAt: pn.createdAt,
                // Don't expose credentials in list view
                hasTwilioCredentials: !!(pn.twilioAccountSid && pn.twilioAuthToken)
            })),
            count: phoneNumbers.length
        });
    } catch (error) {
        console.error('Error listing phone numbers:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /api/phone-numbers/:id
 * Get a specific phone number (with masked credentials)
 */
router.get('/:id', async (req, res) => {
    try {
        const phoneNumber = await PhoneNumber.findOne({
            _id: req.params.id,
            userId: req.userId
        });

        if (!phoneNumber) {
            return res.status(404).json({
                success: false,
                message: 'Phone number not found'
            });
        }

        res.json({
            success: true,
            phoneNumber: {
                id: phoneNumber._id,
                number: phoneNumber.number,
                name: phoneNumber.name,
                provider: phoneNumber.provider,
                status: phoneNumber.status,
                sipUri: phoneNumber.sipUri,
                createdAt: phoneNumber.createdAt,
                // Mask auth token for security
                twilioAccountSid: phoneNumber.twilioAccountSid,
                hasTwilioAuthToken: !!phoneNumber.twilioAuthToken
            }
        });
    } catch (error) {
        console.error('Error getting phone number:', error);
        res.status(404).json({ success: false, message: 'Phone number not found' });
    }
});

/**
 * POST /api/phone-numbers/twilio
 * Create a Twilio phone number (stored in MongoDB)
 */
router.post('/twilio', async (req, res) => {
    try {
        const { number, twilioAccountSid, twilioAuthToken, name } = req.body;

        if (!number || !twilioAccountSid || !twilioAuthToken) {
            return res.status(400).json({
                success: false,
                message: 'Phone number, Twilio Account SID, and Auth Token are required'
            });
        }

        // Create phone number in MongoDB
        const phoneNumber = new PhoneNumber({
            userId: req.userId,
            number,
            name: name || `Twilio ${number}`,
            provider: 'twilio',
            twilioAccountSid,
            twilioAuthToken,
            status: 'active'
        });

        await phoneNumber.save();

        console.log('User', req.userId, 'created Twilio number:', number);

        res.json({
            success: true,
            phoneNumber: {
                id: phoneNumber._id,
                number: phoneNumber.number,
                name: phoneNumber.name,
                provider: phoneNumber.provider,
                status: phoneNumber.status,
                createdAt: phoneNumber.createdAt
            }
        });
    } catch (error) {
        console.error('Error creating Twilio number:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /api/phone-numbers/vapi-sip
 * Create a Free Vapi SIP number (stored in MongoDB)
 */
router.post('/vapi-sip', async (req, res) => {
    try {
        const { sipIdentifier, name, username, password } = req.body;

        if (!sipIdentifier) {
            return res.status(400).json({
                success: false,
                message: 'SIP Identifier is required'
            });
        }

        const sipUri = `sip:${sipIdentifier}@sip.vapi.ai`;

        const phoneNumber = new PhoneNumber({
            userId: req.userId,
            number: sipIdentifier,
            name: name || sipIdentifier,
            provider: 'vapi-sip',
            sipUri,
            sipAuthentication: username && password ? { username, password } : undefined,
            status: 'active'
        });

        await phoneNumber.save();

        console.log('User', req.userId, 'created Vapi SIP:', sipIdentifier);

        res.json({
            success: true,
            phoneNumber: {
                id: phoneNumber._id,
                number: phoneNumber.number,
                name: phoneNumber.name,
                provider: phoneNumber.provider,
                sipUri: phoneNumber.sipUri,
                status: phoneNumber.status,
                createdAt: phoneNumber.createdAt
            }
        });
    } catch (error) {
        console.error('Error creating Vapi SIP:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * DELETE /api/phone-numbers/:id
 * Delete a phone number
 */
router.delete('/:id', async (req, res) => {
    try {
        console.log('User', req.userId, 'deleting phone number:', req.params.id);

        const phoneNumber = await PhoneNumber.findOneAndDelete({
            _id: req.params.id,
            userId: req.userId
        });

        if (!phoneNumber) {
            return res.status(404).json({
                success: false,
                message: 'Phone number not found'
            });
        }

        res.json({ success: true, message: 'Phone number deleted' });
    } catch (error) {
        console.error('Error deleting phone number:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * PATCH /api/phone-numbers/:id
 * Update phone number (name, status, etc.)
 */
router.patch('/:id', async (req, res) => {
    try {
        const { name, status } = req.body;

        const phoneNumber = await PhoneNumber.findOne({
            _id: req.params.id,
            userId: req.userId
        });

        if (!phoneNumber) {
            return res.status(404).json({
                success: false,
                message: 'Phone number not found'
            });
        }

        if (name) phoneNumber.name = name;
        if (status) phoneNumber.status = status;

        await phoneNumber.save();

        res.json({
            success: true,
            phoneNumber: {
                id: phoneNumber._id,
                number: phoneNumber.number,
                name: phoneNumber.name,
                provider: phoneNumber.provider,
                status: phoneNumber.status,
                createdAt: phoneNumber.createdAt
            }
        });
    } catch (error) {
        console.error('Error updating phone number:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
