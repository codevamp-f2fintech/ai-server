// Phone Number Routes - API endpoints for managing VAPI phone numbers
// REQUIRES AUTHENTICATION

const express = require('express');
const router = express.Router();
const VapiClient = require('../clients/vapi-client');
const { authenticate } = require('../middleware/auth');

// Apply authentication middleware to ALL routes
router.use(authenticate);

// Initialize VAPI client
const vapiClient = new VapiClient(process.env.VAPI_KEY);

/**
 * GET /vapi/phone-numbers
 * List all phone numbers with their assigned agents
 */
router.get('/', async (req, res) => {
    try {
        const phoneNumbers = await vapiClient.listPhoneNumbers();

        // Enrich with agent info if needed
        const enrichedNumbers = phoneNumbers.map(pn => ({
            id: pn.id,
            number: pn.number,
            name: pn.name,
            provider: pn.provider,
            status: pn.status,
            assistantId: pn.assistantId,
            sipUri: pn.sipUri,
            credentialId: pn.credentialId,
            createdAt: pn.createdAt
        }));

        res.json({
            success: true,
            phoneNumbers: enrichedNumbers,
            count: enrichedNumbers.length
        });
    } catch (error) {
        console.error('Error listing phone numbers:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /vapi/phone-numbers/:id
 * Get a specific phone number
 */
router.get('/:id', async (req, res) => {
    try {
        const phoneNumber = await vapiClient.getPhoneNumber(req.params.id);
        res.json({ success: true, phoneNumber });
    } catch (error) {
        console.error('Error getting phone number:', error);
        res.status(404).json({ success: false, message: 'Phone number not found' });
    }
});

/**
 * POST /vapi/phone-numbers/twilio
 * Import a Twilio phone number
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

        const config = {
            provider: 'twilio',
            number,
            twilioAccountSid,
            twilioAuthToken,
            name: name || `Twilio ${number}`
        };

        console.log('User', req.userId, 'importing Twilio number:', number);

        const phoneNumber = await vapiClient.createPhoneNumber(config);
        res.json({ success: true, phoneNumber });
    } catch (error) {
        console.error('Error importing Twilio number:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /vapi/phone-numbers/vapi-sip
 * Create a Free Vapi SIP number
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

        const config = {
            provider: 'vapi',
            sipUri: `sip:${sipIdentifier}@sip.vapi.ai`,
            name: name || sipIdentifier
        };

        // Add authentication if provided
        if (username && password) {
            config.authentication = { username, password };
        }

        console.log('User', req.userId, 'creating Vapi SIP:', sipIdentifier);

        const phoneNumber = await vapiClient.createPhoneNumber(config);
        res.json({ success: true, phoneNumber });
    } catch (error) {
        console.error('Error creating Vapi SIP:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /vapi/phone-numbers/sip-trunk
 * Create a BYO SIP Trunk phone number (requires credential first)
 */
router.post('/sip-trunk', async (req, res) => {
    try {
        const { number, credentialId, name, numberE164CheckEnabled } = req.body;

        if (!number || !credentialId) {
            return res.status(400).json({
                success: false,
                message: 'Phone number and SIP Trunk credential are required'
            });
        }

        const config = {
            provider: 'byo-phone-number',
            number,
            credentialId,
            name: name || `SIP ${number}`,
            numberE164CheckEnabled: numberE164CheckEnabled ?? false
        };

        console.log('User', req.userId, 'creating SIP trunk number:', number);

        const phoneNumber = await vapiClient.createPhoneNumber(config);
        res.json({ success: true, phoneNumber });
    } catch (error) {
        console.error('Error creating SIP Trunk number:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * PATCH /vapi/phone-numbers/:id/assign
 * Assign a phone number to an agent
 */
router.patch('/:id/assign', async (req, res) => {
    try {
        const { id } = req.params;
        const { assistantId } = req.body;

        const config = { assistantId: assistantId || null };
        const phoneNumber = await vapiClient.updatePhoneNumber(id, config);

        res.json({
            success: true,
            phoneNumber,
            message: assistantId ? 'Phone number assigned to agent' : 'Phone number unassigned'
        });
    } catch (error) {
        console.error('Error assigning phone number:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * DELETE /vapi/phone-numbers/:id
 * Delete a phone number
 */
router.delete('/:id', async (req, res) => {
    try {
        console.log('User', req.userId, 'deleting phone number:', req.params.id);
        await vapiClient.deletePhoneNumber(req.params.id);
        res.json({ success: true, message: 'Phone number deleted' });
    } catch (error) {
        console.error('Error deleting phone number:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
