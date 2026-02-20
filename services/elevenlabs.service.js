// ElevenLabs Service - Text-to-Speech Integration
// Handles real-time voice synthesis with v3 model support

const { ElevenLabsClient, stream } = require("elevenlabs");
const { Readable } = require("stream");

// V3 model IDs - these do NOT support voice_settings (stability, speed, similarity)
const V3_MODELS = ['eleven_v3', 'eleven_ttv_v3'];

/**
 * Check if a model ID is a v3 model
 * @param {string} modelId
 * @returns {boolean}
 */
function isV3Model(modelId) {
    return V3_MODELS.includes(modelId);
}

class ElevenLabsService {
    constructor(apiKey) {
        if (!apiKey) {
            throw new Error('ElevenLabs API key is required');
        }
        this.client = new ElevenLabsClient({ apiKey });
        this.currentStream = null;
        this._stopped = false;
    }

    /**
     * Convert text to speech with streaming
     * @param {string} text - Text to convert
     * @param {Object} config - Voice configuration from agent
     * @param {Function} onAudioChunk - Callback for each audio chunk
     * @returns {Promise<void>}
     */
    async textToSpeechStream(text, config, onAudioChunk) {
        this._stopped = false;
        try {
            // Ensure config exists with defaults
            config = config || {};
            const voiceId = config.voiceId || process.env.ELEVENLABS_DEFAULT_VOICE_ID || 'pNInz6obpgDQGcFmaJgB'; // Default to Adam

            console.log(`[ElevenLabs] Converting to speech: ${text.substring(0, 50)}...`);
            console.log(`[ElevenLabs] Using voice ID: ${voiceId}`);

            // Use configured model or default to eleven_multilingual_v2 (supports Hindi)
            const modelId = config.model || 'eleven_multilingual_v2';
            const isV3 = isV3Model(modelId);

            // Build TTS request body
            const requestBody = {
                text,
                model_id: modelId,
                output_format: 'ulaw_8000' // μ-law 8kHz format - native for Twilio, no conversion needed
            };

            // V3 models do NOT support voice_settings (stability, speed, similarity)
            // Only add voice_settings for non-v3 models
            if (!isV3) {
                const voiceSettings = {
                    stability: config.stability || 0.5,
                    similarity_boost: config.similarity_boost || config.similarityBoost || 0.75,
                    use_speaker_boost: true,
                    style: 0
                };

                // Add speed if provided (range 0.7 to 1.2, default 1.0)
                if (config.speed) {
                    voiceSettings.speed = config.speed;
                }

                requestBody.voice_settings = voiceSettings;
            }

            // Add language_code for Hindi/Hinglish enforcement
            // This helps v3 models pronounce Hindi text correctly
            if (config.hinglish || config.language === 'hi') {
                requestBody.language_code = 'hi';
                console.log('[ElevenLabs] Hinglish/Hindi mode enabled - language_code: hi');
            } else if (config.language && config.language !== 'en') {
                requestBody.language_code = config.language;
                console.log(`[ElevenLabs] Language enforcement: ${config.language}`);
            }

            console.log(`[ElevenLabs] Model: ${modelId}, V3: ${isV3}, Request:`, JSON.stringify(requestBody).substring(0, 200));

            // Generate audio stream
            const audioStream = await this.client.textToSpeech.convertAsStream(
                voiceId,
                requestBody
            );

            // Process audio chunks
            for await (const chunk of audioStream) {
                // CRITICAL: Stop processing if call ended
                if (this._stopped) {
                    console.log('[ElevenLabs] Aborting TTS stream - call ended');
                    break;
                }
                if (onAudioChunk) {
                    // Ensure chunk is a proper Buffer (SDK may return Uint8Array)
                    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    onAudioChunk(bufferChunk);
                }
            }

            console.log('[ElevenLabs] Audio generation complete');
        } catch (error) {
            console.error('[ElevenLabs] Error generating speech:', error.message);

            // Try to extract more details from the error
            if (error.statusCode) {
                console.error('[ElevenLabs] Status code:', error.statusCode);
            }
            if (error.body) {
                console.error('[ElevenLabs] Error body:', JSON.stringify(error.body));
            }

            throw error;
        }
    }

    /**
     * Convert text to speech and return full audio buffer
     * @param {string} text - Text to convert
     * @param {Object} config - Voice configuration
     * @returns {Promise<Buffer>} - Complete audio buffer
     */
    async textToSpeechBuffer(text, config) {
        try {
            const chunks = [];

            await this.textToSpeechStream(text, config, (chunk) => {
                chunks.push(chunk);
            });

            return Buffer.concat(chunks);
        } catch (error) {
            console.error('[ElevenLabs] Error generating audio buffer:', error);
            throw error;
        }
    }

    /**
     * Stream text chunks to speech with sentence buffering
     * Accumulates text until punctuation boundary, then generates speech
     * @param {string} textChunk - Partial text from LLM
     * @param {Object} config - Voice configuration
     * @param {Function} onAudioChunk - Callback for audio chunks
     */
    async streamTextChunk(textChunk, config, onAudioChunk) {
        if (!this.textBuffer) {
            this.textBuffer = '';
        }

        this.textBuffer += textChunk;

        // Check for punctuation boundaries
        const boundaries = config.inputPunctuationBoundaries || ['.', '!', '?', ':', ','];
        const hasBoundary = boundaries.some(p => this.textBuffer.includes(p));

        if (hasBoundary) {
            // Find last punctuation
            let lastPuncIndex = -1;
            let lastPunc = '';

            for (const punc of boundaries) {
                const index = this.textBuffer.lastIndexOf(punc);
                if (index > lastPuncIndex) {
                    lastPuncIndex = index;
                    lastPunc = punc;
                }
            }

            if (lastPuncIndex > -1) {
                // Extract sentence to speak
                const toSpeak = this.textBuffer.substring(0, lastPuncIndex + 1).trim();
                this.textBuffer = this.textBuffer.substring(lastPuncIndex + 1).trim();

                if (toSpeak.length > 0) {
                    // Generate speech for this sentence
                    await this.textToSpeechStream(toSpeak, config, onAudioChunk);
                }
            }
        }
    }

    /**
     * Flush remaining text buffer
     * @param {Object} config - Voice configuration
     * @param {Function} onAudioChunk - Callback for audio chunks
     */
    async flushTextBuffer(config, onAudioChunk) {
        if (this.textBuffer && this.textBuffer.trim().length > 0) {
            await this.textToSpeechStream(this.textBuffer.trim(), config, onAudioChunk);
            this.textBuffer = '';
        }
    }

    /**
     * Get list of available voices
     * @returns {Promise<Array>} - List of voices
     */
    async getVoices() {
        try {
            const response = await this.client.voices.getAll();
            return response.voices || [];
        } catch (error) {
            console.error('[ElevenLabs] Error fetching voices:', error);
            throw error;
        }
    }

    /**
     * Get specific voice details
     * @param {string} voiceId - Voice ID
     * @returns {Promise<Object>} - Voice details
     */
    async getVoice(voiceId) {
        try {
            return await this.client.voices.get(voiceId);
        } catch (error) {
            console.error('[ElevenLabs] Error fetching voice:', error);
            throw error;
        }
    }

    /**
     * Get list of available TTS models
     * @returns {Promise<Array>} - List of models
     */
    async getModels() {
        try {
            const response = await this.client.models.getAll();
            // Filter to only TTS-capable models
            const ttsModels = (response || []).filter(m => m.can_do_text_to_speech);
            return ttsModels.map(m => ({
                modelId: m.model_id,
                name: m.name,
                description: m.description,
                languages: m.languages || [],
                isV3: isV3Model(m.model_id),
                canDoTTS: m.can_do_text_to_speech
            }));
        } catch (error) {
            console.error('[ElevenLabs] Error fetching models:', error);
            throw error;
        }
    }

    /**
     * Stop current audio stream
     */
    stop() {
        this._stopped = true; // Signal the for-await loop to break
        if (this.currentStream) {
            this.currentStream.destroy();
            this.currentStream = null;
        }
        this.textBuffer = '';
    }
}

module.exports = ElevenLabsService;
