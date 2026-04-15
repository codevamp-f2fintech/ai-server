// Voice Routes - ElevenLabs voices & models API

const express = require('express');
const router = express.Router();
const ElevenLabsService = require('../services/elevenlabs.service');

/**
 * GET /vapi/voices
 * Get all available voices from ElevenLabs (user's added voices + defaults)
 */
router.get('/', async (req, res) => {
    try {
        if (!process.env.ELEVENLABS_API_KEY) {
            return res.status(400).json({
                error: 'ElevenLabs API key not configured',
                message: 'Please set ELEVENLABS_API_KEY in environment variables'
            });
        }

        const elevenLabsService = new ElevenLabsService(process.env.ELEVENLABS_API_KEY);
        const voices = await elevenLabsService.getVoices();

        res.json({
            success: true,
            voices: voices.map(v => ({
                voiceId: v.voice_id,
                name: v.name,
                category: v.category || 'generated',  // 'cloned', 'premade', 'generated', 'professional'
                labels: v.labels || {},
                description: v.description || '',
                previewUrl: v.preview_url || null,
                preview_url: v.preview_url || null,
                settings: v.settings || null,
                provider: '11labs',
                // Include fine tuning status for user's custom voices
                fineTuning: v.fine_tuning ? {
                    isAllowedToFineTune: v.fine_tuning.is_allowed_to_fine_tune,
                    state: v.fine_tuning.state
                } : null
            })),
            count: voices.length
        });

    } catch (error) {
        console.error('[Voices] Error fetching voices:', error);
        res.status(500).json({
            error: 'Failed to fetch voices',
            message: error.message
        });
    }
});

/**
 * GET /vapi/voices/models
 * Get available TTS models from ElevenLabs
 */
router.get('/models', async (req, res) => {
    try {
        if (!process.env.ELEVENLABS_API_KEY) {
            return res.status(400).json({
                error: 'ElevenLabs API key not configured'
            });
        }

        const elevenLabsService = new ElevenLabsService(process.env.ELEVENLABS_API_KEY);
        const models = await elevenLabsService.getModels();

        res.json({
            success: true,
            models,
            count: models.length
        });

    } catch (error) {
        console.error('[Voices] Error fetching models:', error);
        res.status(500).json({
            error: 'Failed to fetch models',
            message: error.message
        });
    }
});

/**
 * GET /vapi/voices/validate/:voiceId
 * Validate that a voice ID exists in your account
 */
router.get('/validate/:voiceId', async (req, res) => {
    try {
        if (!process.env.ELEVENLABS_API_KEY) {
            return res.json({
                success: true,
                valid: false,
                message: 'ElevenLabs API key not configured'
            });
        }

        const { voiceId } = req.params;
        const elevenLabsService = new ElevenLabsService(process.env.ELEVENLABS_API_KEY);

        try {
            const voice = await elevenLabsService.getVoice(voiceId);
            res.json({
                success: true,
                valid: true,
                voice: {
                    voiceId: voice.voice_id,
                    name: voice.name,
                    category: voice.category
                }
            });
        } catch (error) {
            res.json({
                success: true,
                valid: false,
                message: 'Voice ID not found in your ElevenLabs account'
            });
        }

    } catch (error) {
        console.error('[Voices] Error validating voice:', error);
        res.status(500).json({
            error: 'Failed to validate voice',
            message: error.message
        });
    }
});

/**
 * GET /vapi/voices/:voiceId
 * Get detailed information about a specific voice
 */
router.get('/:voiceId', async (req, res) => {
    try {
        if (!process.env.ELEVENLABS_API_KEY) {
            return res.status(400).json({
                error: 'ElevenLabs API key not configured'
            });
        }

        const { voiceId } = req.params;
        const elevenLabsService = new ElevenLabsService(process.env.ELEVENLABS_API_KEY);
        const voice = await elevenLabsService.getVoice(voiceId);

        res.json({
            success: true,
            voice: {
                voiceId: voice.voice_id,
                name: voice.name,
                category: voice.category || 'generated',
                labels: voice.labels || {},
                description: voice.description || '',
                previewUrl: voice.preview_url || null,
                settings: voice.settings || null,
                provider: '11labs'
            }
        });

    } catch (error) {
        console.error(`[Voices] Error fetching voice ${req.params.voiceId}:`, error);
        res.status(404).json({
            error: 'Voice not found',
            message: error.message
        });
    }
});

module.exports = router;
