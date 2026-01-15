// ElevenLabs Client Module
// Handles fetching voices from ElevenLabs API

const axios = require('axios');

const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io';

class ElevenLabsClient {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.client = axios.create({
            baseURL: ELEVENLABS_BASE_URL,
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json'
            }
        });
    }

    /**
     * Fetch all voices from your ElevenLabs account
     * @returns {Promise<Array>} List of available voices
     */
    async getVoices() {
        try {
            console.log('Fetching ElevenLabs voices...');
            const response = await this.client.get('/v2/voices', {
                params: {
                    page_size: 100
                }
            });

            const voices = response.data.voices || [];
            console.log(`Fetched ${voices.length} voices from ElevenLabs`);

            return voices.map(voice => ({
                voiceId: voice.voice_id,
                name: voice.name,
                category: voice.category || 'unknown',
                labels: voice.labels || {},
                previewUrl: voice.preview_url || null,
                description: voice.description || '',
                gender: voice.labels?.gender || 'unknown',
                accent: voice.labels?.accent || 'unknown',
                age: voice.labels?.age || 'unknown'
            }));
        } catch (error) {
            console.error('Error fetching ElevenLabs voices:', error.response?.data || error.message);
            throw new Error(error.response?.data?.detail?.message || 'Failed to fetch voices. Check your API key.');
        }
    }

    /**
     * Get a specific voice by ID
     * @param {string} voiceId - Voice ID to fetch
     * @returns {Promise<Object>} Voice details
     */
    async getVoice(voiceId) {
        try {
            const response = await this.client.get(`/v1/voices/${voiceId}`);
            return response.data;
        } catch (error) {
            console.error('Error fetching voice:', error.response?.data || error.message);
            throw new Error('Failed to fetch voice details');
        }
    }

    /**
     * Validate that a voice ID exists in the account
     * @param {string} voiceId - Voice ID to validate
     * @returns {Promise<boolean>} True if voice exists
     */
    async validateVoiceId(voiceId) {
        try {
            await this.getVoice(voiceId);
            return true;
        } catch (error) {
            return false;
        }
    }
}

/**
 * Get default VAPI-provided voices (no ElevenLabs API key needed)
 * These are bundled voices that work without your own credentials
 * @returns {Array} List of default voices
 */
function getDefaultVoices() {
    return [
        {
            voiceId: '21m00Tcm4TlvDq8ikWAM',
            name: 'Rachel',
            category: 'premade',
            description: 'Female, American, Calm',
            gender: 'female',
            accent: 'American',
            previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/21m00Tcm4TlvDq8ikWAM/df6788f9-5c96-470d-8571-2a2d60b4e1a1.mp3'
        },
        {
            voiceId: 'pNInz6obpgDQGcFmaJgB',
            name: 'Adam',
            category: 'premade',
            description: 'Male, American, Deep',
            gender: 'male',
            accent: 'American',
            previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/pNInz6obpgDQGcFmaJgB/e0b45450-78db-49b9-aaa4-d5358a6871bd.mp3'
        },
        {
            voiceId: 'EXAVITQu4vr4xnSDxMaL',
            name: 'Bella',
            category: 'premade',
            description: 'Female, American, Soft',
            gender: 'female',
            accent: 'American',
            previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/EXAVITQu4vr4xnSDxMaL/04f0c203-9fd0-43f0-a566-bc6d6c89cd1c.mp3'
        },
        {
            voiceId: 'yoZ06aMxZJJ28mfd3POQ',
            name: 'Sam',
            category: 'premade',
            description: 'Male, American, Raspy',
            gender: 'male',
            accent: 'American',
            previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/yoZ06aMxZJJ28mfd3POQ/5da19cb8-8e86-4d7b-9f6d-07aa0ac8d65f.mp3'
        },
        {
            voiceId: 'onwK4e9ZLuTAKqWW03F9',
            name: 'Charlie',
            category: 'premade',
            description: 'Male, Australian',
            gender: 'male',
            accent: 'Australian',
            previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/onwK4e9ZLuTAKqWW03F9/03d4d1a9-9a90-4e24-bc95-d7eed2e01b59.mp3'
        },
        {
            voiceId: 'XB0fDUnXU5powFXDhCwa',
            name: 'Charlotte',
            category: 'premade',
            description: 'Female, Swedish',
            gender: 'female',
            accent: 'Swedish',
            previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/XB0fDUnXU5powFXDhCwa/c89d9f26-e51f-49a6-ac6e-f8a92f0e5a59.mp3'
        },
        {
            voiceId: 'XrExE9yKIg1WjnnlVkGX',
            name: 'Matilda',
            category: 'premade',
            description: 'Female, American, Warm',
            gender: 'female',
            accent: 'American',
            previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/XrExE9yKIg1WjnnlVkGX/b7c6d0e0-cece-4acf-9cf5-fb8cd8a77a2c.mp3'
        },
        {
            voiceId: 'pFZP5JQG7iQjIQuC4Bku',
            name: 'Lily',
            category: 'premade',
            description: 'Female, British, Warm',
            gender: 'female',
            accent: 'British',
            previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/pFZP5JQG7iQjIQuC4Bku/d10f7534-b9d9-4d56-8c38-4c3f6a3fe709.mp3'
        },
    ];
}

module.exports = { ElevenLabsClient, getDefaultVoices };
