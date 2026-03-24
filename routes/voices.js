// Voice Routes - ElevenLabs voices & models API + Chatterbox voices

const express = require('express');
const router = express.Router();
const ElevenLabsService = require('../services/elevenlabs.service');
const ChatterboxService = require('../services/chatterbox.service');
const db = require('../db');

/**
 * GET /vapi/voices/chatterbox
 * Fetch system and custom voices from resonanx-ai database
 */
router.get('/chatterbox', async (req, res) => {
    try {
        if (!process.env.RESONANX_DATABASE_URL) {
            return res.json({ success: true, voices: [], count: 0, serverUrl: process.env.CHATTERBOX_BASE_URL });
        }

        // We fetch voices from resonanx-ai db
        // voice.voice is what is sent to Chatterbox TTS as voice_key. Resonanx stores audio in R2 as:
        // voices/system/<id>.wav or voices/custom/<id>.wav
        const result = await db.query('SELECT * FROM "Voice" ORDER BY name ASC');
        const dbVoices = result.rows;

        const voices = dbVoices.map(v => {
            const path = v.variant === 'SYSTEM' ? `voices/system/${v.id}.wav` : `voices/custom/${v.id}.wav`;
            return {
                voiceId: v.r2ObjectKey || path, // If r2ObjectKey is filled, use it, else fallback
                name: v.name,
                language: v.language,
                category: v.category,
                variant: v.variant, // SYSTEM | CUSTOM
                provider: 'chatterbox'
            };
        });

        res.json({
            success: true,
            voices,
            count: voices.length,
            serverUrl: process.env.CHATTERBOX_BASE_URL || ''
        });
    } catch (error) {
        console.error('[Voices/Chatterbox] Error fetching voices from DB:', error.message);
        res.status(500).json({
            error: 'Failed to fetch Chatterbox voices',
            message: error.message,
            hint: 'Ensure RESONANX_DATABASE_URL is set'
        });
    }
});

/**
 * GET /vapi/voices/chatterbox/health
 * Health check for the Chatterbox TTS server
 */
router.get('/chatterbox/health', async (req, res) => {
    try {
        const baseUrl = process.env.CHATTERBOX_BASE_URL;
        const apiKey = process.env.CHATTERBOX_API_KEY;
        if (!baseUrl) return res.json({ success: false, status: 'Not configured' });

        const service = new ChatterboxService(baseUrl, apiKey);
        const health = await service.healthCheck();

        res.json({
            success: health.ok,
            status: health.status,
            serverUrl: baseUrl,
            data: health.data || null,
            error: health.error || null
        });
    } catch (error) {
        res.json({
            success: false,
            status: 'unreachable',
            error: error.message
        });
    }
});

/**
 * POST /vapi/voices/chatterbox/warmup
 * Warm up the Chatterbox Modal model by sending a lightweight TTS request.
 * Modal serverless containers go cold — this pre-warms them before a live call.
 */
router.post('/chatterbox/warmup', async (req, res) => {
    try {
        const baseUrl = process.env.CHATTERBOX_BASE_URL;
        const apiKey = process.env.CHATTERBOX_API_KEY;
        if (!baseUrl) {
            return res.status(400).json({ success: false, error: 'CHATTERBOX_BASE_URL not configured' });
        }

        const service = new ChatterboxService(baseUrl, apiKey);
        const t0 = Date.now();

        console.log('[Voices/Warmup] Sending warm-up request to Chatterbox Modal...');

        // Send a minimal TTS request — just enough to boot the container.
        // We discard the audio; we only care about the round-trip time.
        const warmupText = 'Hello.';
        const warmupVoice = req.body?.voice_key || 'voices/system/default.wav';

        // Wrap in a timeout — Modal cold-starts can take up to 60s
        const TIMEOUT_MS = 90_000;
        let timedOut = false;
        const timeoutHandle = setTimeout(() => { timedOut = true; }, TIMEOUT_MS);

        try {
            await service.textToSpeechBuffer(warmupText, {
                voice: warmupVoice,
                temperature: 0.5,
            });
        } finally {
            clearTimeout(timeoutHandle);
        }

        if (timedOut) {
            return res.status(504).json({
                success: false,
                error: 'Warm-up timed out after 90 seconds. Modal container may still be starting up.',
            });
        }

        const responseTimeMs = Date.now() - t0;
        console.log(`[Voices/Warmup] Modal warmed up in ${responseTimeMs}ms`);

        res.json({
            success: true,
            warmedUp: true,
            responseTimeMs,
            message: `Modal is warm (${responseTimeMs}ms)`,
        });
    } catch (error) {
        console.error('[Voices/Warmup] Error warming up Chatterbox:', error.message);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to warm up Modal',
        });
    }
});

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
