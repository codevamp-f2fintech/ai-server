// Credentials Routes - API endpoints for managing SIP Trunk credentials
// REQUIRES AUTHENTICATION

const express = require('express');
const router = express.Router();
const VapiClient = require('../clients/vapi-client');
const { authenticate } = require('../middleware/auth');

// Apply authentication middleware to ALL routes
router.use(authenticate);

const vapiClient = new VapiClient(process.env.VAPI_KEY);

/**
 * GET /vapi/credentials
 * List all credentials (filtered to SIP trunk only)
 */
router.get('/', async (req, res) => {
    try {
        const credentials = await vapiClient.listCredentials();

        // Filter to only show SIP trunk credentials
        const sipCredentials = credentials.filter(c => c.provider === 'byo-sip-trunk');

        res.json({
            success: true,
            credentials: sipCredentials.map(c => ({
                id: c.id,
                name: c.name,
                provider: c.provider,
                gateways: c.gateways,
                createdAt: c.createdAt
            })),
            count: sipCredentials.length
        });
    } catch (error) {
        console.error('Error listing credentials:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /vapi/credentials/sip-trunk
 * Create a new SIP Trunk credential
 */
router.post('/sip-trunk', async (req, res) => {
    try {
        const { name, gatewayIp, inboundEnabled, authUsername, authPassword } = req.body;

        if (!name || !gatewayIp) {
            return res.status(400).json({
                success: false,
                message: 'Name and Gateway IP are required'
            });
        }

        const config = {
            provider: 'byo-sip-trunk',
            name,
            gateways: [{
                ip: gatewayIp,
                inboundEnabled: inboundEnabled ?? true
            }]
        };

        // Add authentication if provided
        if (authUsername && authPassword) {
            config.outboundAuthenticationPlan = {
                authUsername,
                authPassword
            };
        }

        console.log('User', req.userId, 'creating SIP trunk credential:', name);

        const credential = await vapiClient.createCredential(config);
        res.json({ success: true, credential });
    } catch (error) {
        console.error('Error creating SIP trunk credential:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * DELETE /vapi/credentials/:id
 * Delete a credential
 */
router.delete('/:id', async (req, res) => {
    try {
        console.log('User', req.userId, 'deleting credential:', req.params.id);
        await vapiClient.deleteCredential(req.params.id);
        res.json({ success: true, message: 'Credential deleted' });
    } catch (error) {
        console.error('Error deleting credential:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
