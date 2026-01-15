// Voice Routes - API endpoints for fetching ElevenLabs voices

const express = require('express');
const router = express.Router();
const { ElevenLabsClient, getDefaultVoices } = require('../clients/elevenlabs-client');

/**
 * GET /vapi/voices
 * Get all available voices (from ElevenLabs linked account + default)
 */
router.get('/', async (req, res) => {
    try {
        const { source = 'all' } = req.query; // 'all', 'elevenlabs', 'default'

        let voices = [];

        // Get default VAPI voices
        if (source === 'all' || source === 'default') {
            const defaultVoices = getDefaultVoices();
            voices.push(...defaultVoices.map(v => ({ ...v, source: 'default' })));
        }

        // Get ElevenLabs voices if API key is available
        if ((source === 'all' || source === 'elevenlabs') && process.env.ELEVENLABS_API_KEY) {
            try {
                const elevenLabsClient = new ElevenLabsClient(process.env.ELEVENLABS_API_KEY);
                const elevenLabsVoices = await elevenLabsClient.getVoices();
                voices.push(...elevenLabsVoices.map(v => ({ ...v, source: 'elevenlabs' })));
            } catch (error) {
                console.error('Error fetching ElevenLabs voices:', error.message);
            }
        }

        res.json({
            success: true,
            voices,
            count: voices.length,
            sources: {
                hasElevenLabsKey: !!process.env.ELEVENLABS_API_KEY,
                defaultVoicesCount: getDefaultVoices().length
            }
        });

    } catch (error) {
        console.error('Error getting voices:', error);
        res.status(500).json({
            error: 'Failed to fetch voices',
            message: error.message
        });
    }
});

/**
 * GET /vapi/voices/elevenlabs
 * Get voices from your linked ElevenLabs account only
 */
router.get('/elevenlabs', async (req, res) => {
    try {
        if (!process.env.ELEVENLABS_API_KEY) {
            return res.status(400).json({
                error: 'ElevenLabs API key not configured',
                message: 'Please set ELEVENLABS_API_KEY in your environment variables'
            });
        }

        const elevenLabsClient = new ElevenLabsClient(process.env.ELEVENLABS_API_KEY);
        const voices = await elevenLabsClient.getVoices();

        res.json({
            success: true,
            voices,
            count: voices.length
        });

    } catch (error) {
        console.error('Error fetching ElevenLabs voices:', error);
        res.status(500).json({
            error: 'Failed to fetch ElevenLabs voices',
            message: error.message
        });
    }
});

/**
 * GET /vapi/voices/default
 * Get default VAPI-provided voices (no API key needed)
 */
router.get('/default', (req, res) => {
    try {
        const voices = getDefaultVoices();
        res.json({
            success: true,
            voices,
            count: voices.length
        });
    } catch (error) {
        res.status(500).json({
            error: 'Failed to get default voices',
            message: error.message
        });
    }
});

/**
 * GET /vapi/voices/info/:voiceId
 * Get detailed information about a specific voice by ID
 */
router.get('/info/:voiceId', async (req, res) => {
    try {
        const { voiceId } = req.params;

        // Check default voices first
        const defaultVoices = getDefaultVoices();
        const defaultVoice = defaultVoices.find(v => v.voiceId === voiceId);

        if (defaultVoice) {
            return res.json({
                success: true,
                voice: {
                    voice_id: defaultVoice.voiceId,
                    name: defaultVoice.name,
                    category: defaultVoice.category,
                    labels: {
                        gender: defaultVoice.gender,
                        accent: defaultVoice.accent
                    },
                    description: defaultVoice.description
                },
                source: 'default'
            });
        }

        // Fetch from ElevenLabs
        if (!process.env.ELEVENLABS_API_KEY) {
            return res.status(400).json({
                success: false,
                message: 'Voice not found in default list and ElevenLabs API key not configured'
            });
        }

        const elevenLabsClient = new ElevenLabsClient(process.env.ELEVENLABS_API_KEY);
        const voice = await elevenLabsClient.getVoice(voiceId);

        res.json({
            success: true,
            voice,
            source: 'elevenlabs'
        });

    } catch (error) {
        console.error('Error fetching voice info:', error);
        res.status(404).json({
            success: false,
            message: 'Voice not found or invalid voice ID'
        });
    }
});

/**
 * GET /vapi/voices/validate/:voiceId
 * Validate that a voice ID exists
 */
router.get('/validate/:voiceId', async (req, res) => {
    try {
        const { voiceId } = req.params;

        // Check default voices first
        const defaultVoices = getDefaultVoices();
        const isDefault = defaultVoices.some(v => v.voiceId === voiceId);

        if (isDefault) {
            return res.json({
                success: true,
                valid: true,
                source: 'default',
                voice: defaultVoices.find(v => v.voiceId === voiceId)
            });
        }

        // Check ElevenLabs account
        if (!process.env.ELEVENLABS_API_KEY) {
            return res.json({
                success: true,
                valid: false,
                message: 'Voice not in default list and ElevenLabs API key not configured'
            });
        }

        const elevenLabsClient = new ElevenLabsClient(process.env.ELEVENLABS_API_KEY);
        const isValid = await elevenLabsClient.validateVoiceId(voiceId);

        res.json({
            success: true,
            valid: isValid,
            source: isValid ? 'elevenlabs' : null
        });

    } catch (error) {
        console.error('Error validating voice:', error);
        res.status(500).json({
            error: 'Failed to validate voice',
            message: error.message
        });
    }
});

module.exports = router;
