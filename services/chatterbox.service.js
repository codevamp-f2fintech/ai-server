// Chatterbox TTS Service - Self-hosted Text-to-Speech Integration
// Chatterbox is an OpenAI-compatible TTS server (https://github.com/travisvn/chatterbox-tts-api)
// API: POST /v1/audio/speech/stream  → chunked WAV (PCM 16-bit 24kHz)
// We transcode WAV PCM → μ-law 8kHz in real-time for telephony compatibility.

const http = require('http');
const https = require('https');

// alawmulaw is already installed in this project (used by sip-media-bridge.js)
const alawmulaw = require('alawmulaw');

class ChatterboxService {
    /**
     * @param {string} baseUrl  e.g. "https://aafaqthecoder--chatterbox-tts-chatterbox-serve.modal.run"
     * @param {string} [apiKey] Optional API key sent as Authorization: Bearer <key>
     */
    constructor(baseUrl, apiKey) {
        if (!baseUrl) {
            throw new Error('Chatterbox base URL is required (set CHATTERBOX_BASE_URL)');
        }
        // Normalise — strip trailing slash
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.apiKey = apiKey || null;
        this._stopped = false;
        this._currentReq = null;
        this.textBuffer = '';
    }

    // ──────────────────────────────────────────────────────────────
    //  AUDIO FORMAT HELPERS
    // ──────────────────────────────────────────────────────────────

    /**
     * Parse minimal WAV header from a Buffer.
     * Returns { sampleRate, bitsPerSample, numChannels, dataOffset }
     * or null if signature is missing / buffer too short.
     */
    _parseWavHeader(buf) {
        // WAV header is at least 44 bytes; starts with "RIFF" at offset 0
        if (buf.length < 44) return null;
        if (buf.toString('ascii', 0, 4) !== 'RIFF') return null;
        if (buf.toString('ascii', 8, 12) !== 'WAVE') return null;

        const numChannels = buf.readUInt16LE(22);
        const sampleRate = buf.readUInt32LE(24);
        const bitsPerSample = buf.readUInt16LE(34);

        // Find "data" sub-chunk
        let dataOffset = 12;
        while (dataOffset + 8 <= buf.length) {
            const chunkId = buf.toString('ascii', dataOffset, dataOffset + 4);
            const chunkSize = buf.readUInt32LE(dataOffset + 4);
            if (chunkId === 'data') {
                return { sampleRate, bitsPerSample, numChannels, dataOffset: dataOffset + 8 };
            }
            dataOffset += 8 + chunkSize;
        }
        return null;
    }

    /**
     * Down-sample PCM16 stereo/mono from srcRate to 8000 Hz (μ-law).
     * Accepts Int16Array of samples (mono already mixed if needed).
     * Returns Buffer of μ-law bytes.
     */
    _pcm16ToUlaw8000(int16Samples, srcRate, numChannels) {
        // Step 1: mix to mono if stereo
        let mono;
        if (numChannels === 2) {
            mono = new Int16Array(int16Samples.length / 2);
            for (let i = 0; i < mono.length; i++) {
                mono[i] = Math.round((int16Samples[i * 2] + int16Samples[i * 2 + 1]) / 2);
            }
        } else {
            mono = int16Samples;
        }

        // Step 2: down-sample to 8000 Hz (linear interpolation)
        const ratio = srcRate / 8000;
        const outLen = Math.floor(mono.length / ratio);
        const resampled = new Int16Array(outLen);
        for (let i = 0; i < outLen; i++) {
            const srcIdx = i * ratio;
            const lo = Math.floor(srcIdx);
            const hi = Math.min(lo + 1, mono.length - 1);
            const frac = srcIdx - lo;
            resampled[i] = Math.round(mono[lo] * (1 - frac) + mono[hi] * frac);
        }

        // Step 3: PCM16 → μ-law using alawmulaw
        const ulawBytes = alawmulaw.mulaw.encode(resampled);
        return Buffer.from(ulawBytes);
    }

    // ──────────────────────────────────────────────────────────────
    //  HTTP HELPERS
    // ──────────────────────────────────────────────────────────────

    /**
     * Make a POST request to the Chatterbox server.
     * Returns a Node.js IncomingMessage (readable stream).
     */
    _post(path, bodyObj) {
        const body = JSON.stringify(bodyObj);
        const url = new URL(path, this.baseUrl);
        const isHttps = url.protocol === 'https:';
        const lib = isHttps ? https : http;

        // Build headers — add Authorization if API key is set
        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
        };
        if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

        return new Promise((resolve, reject) => {
            const req = lib.request({
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname + url.search,
                method: 'POST',
                headers,
            }, (res) => {
                if (res.statusCode >= 400) {
                    let errBody = '';
                    res.on('data', d => (errBody += d));
                    res.on('end', () => {
                        reject(new Error(`[Chatterbox] HTTP ${res.statusCode}: ${errBody.substring(0, 200)}`));
                    });
                    return;
                }
                resolve(res);
            });

            req.on('error', reject);
            this._currentReq = req;
            req.write(body);
            req.end();
        });
    }

    /**
     * Make a GET request to the Chatterbox server and return parsed JSON.
     */
    _get(path) {
        const url = new URL(path, this.baseUrl);
        const isHttps = url.protocol === 'https:';
        const lib = isHttps ? https : http;

        // Build headers — add Authorization if API key is set
        const headers = {};
        if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

        return new Promise((resolve, reject) => {
            lib.get({
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname + url.search,
                headers,
            }, (res) => {
                let data = '';
                res.on('data', d => (data += d));
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { reject(new Error('Invalid JSON from Chatterbox: ' + data.substring(0, 100))); }
                });
            }).on('error', reject);
        });
    }

    // ──────────────────────────────────────────────────────────────
    //  PUBLIC TTS API  (mirrors ElevenLabsService interface)
    // ──────────────────────────────────────────────────────────────

    /**
     * Stream text to speech.
     * Calls POST /v1/audio/speech/stream, reads chunked WAV,
     * transcodes to μ-law 8 kHz, and invokes onAudioChunk per chunk.
     *
     * @param {string}   text         Text to synthesize
     * @param {Object}   config       Voice config from agentConfig.voice
     * @param {Function} onAudioChunk Callback receiving μ-law Buffer chunks
     */
    async textToSpeechStream(text, config, onAudioChunk) {
        this._stopped = false;
        config = config || {};

        const voiceName = config.voice || config.voiceId || 'default';
        const exaggeration = typeof config.exaggeration === 'number' ? config.exaggeration : 0.7;
        const cfgWeight = typeof config.cfg_weight === 'number' ? config.cfg_weight : 0.5;
        const temperature = typeof config.temperature === 'number' ? config.temperature : 0.8;

        console.log(`[Chatterbox] TTS: "${text.substring(0, 60)}..." voice="${voiceName}"`);

        const requestBody = {
            input: text,
            voice: voiceName,
            exaggeration,
            cfg_weight: cfgWeight,
            temperature,
        };

        if (config.language && config.language !== 'en') {
            requestBody.language = config.language;
            console.log(`[Chatterbox] Language: ${config.language}`);
        }

        try {
            const res = await this._post('/v1/audio/speech/stream', requestBody);

            // Accumulate incoming bytes — Chatterbox streams WAV.
            // The first response chunk contains the WAV header; subsequent
            // chunks are raw PCM continuation.
            let headerParsed = false;
            let wavInfo = null;   // { sampleRate, bitsPerSample, numChannels, dataOffset }
            let headerBuf = Buffer.alloc(0);

            await new Promise((resolve, reject) => {
                res.on('data', (chunk) => {
                    if (this._stopped) return;

                    if (!headerParsed) {
                        // Accumulate until we have at least 128 bytes (covers typical WAV header)
                        headerBuf = Buffer.concat([headerBuf, chunk]);
                        if (headerBuf.length < 128) return;

                        wavInfo = this._parseWavHeader(headerBuf);

                        if (!wavInfo) {
                            // Chatterbox might stream raw PCM without a WAV header in some modes.
                            // Assume 24kHz 16-bit mono as a sensible fallback.
                            console.warn('[Chatterbox] No WAV header found — assuming 24kHz 16-bit mono PCM');
                            wavInfo = { sampleRate: 24000, bitsPerSample: 16, numChannels: 1, dataOffset: 0 };
                        }

                        headerParsed = true;
                        console.log(`[Chatterbox] WAV: ${wavInfo.sampleRate}Hz, ${wavInfo.bitsPerSample}-bit, ${wavInfo.numChannels}ch, data@${wavInfo.dataOffset}`);

                        // Process any PCM bytes that came after the header
                        const pcmBytes = headerBuf.slice(wavInfo.dataOffset);
                        if (pcmBytes.length > 0) {
                            this._processPcmChunk(pcmBytes, wavInfo, onAudioChunk);
                        }
                        headerBuf = Buffer.alloc(0);
                        return;
                    }

                    // After header parsed — every chunk is raw PCM
                    this._processPcmChunk(chunk, wavInfo, onAudioChunk);
                });

                res.on('end', resolve);
                res.on('error', reject);
            });

            console.log('[Chatterbox] Audio generation complete');

        } catch (error) {
            if (this._stopped) return; // Expected abort
            console.error('[Chatterbox] Error generating speech:', error.message);
            throw error;
        }
    }

    /**
     * Internal: transcode a raw PCM Buffer chunk and call onAudioChunk.
     */
    _processPcmChunk(pcmBuf, wavInfo, onAudioChunk) {
        if (!onAudioChunk || pcmBuf.length === 0) return;

        try {
            // Build Int16Array from the raw bytes
            // pcmBuf may have an odd length; trim to even boundary
            const evenLen = pcmBuf.length - (pcmBuf.length % 2);
            if (evenLen === 0) return;

            const int16 = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, evenLen / 2);
            const ulawBuf = this._pcm16ToUlaw8000(int16, wavInfo.sampleRate, wavInfo.numChannels);

            onAudioChunk(ulawBuf);
        } catch (err) {
            console.error('[Chatterbox] PCM→μ-law conversion error:', err.message);
        }
    }

    /**
     * Convert text to speech and return full μ-law audio buffer.
     * @param {string} text
     * @param {Object} config
     * @returns {Promise<Buffer>}
     */
    async textToSpeechBuffer(text, config) {
        const chunks = [];
        await this.textToSpeechStream(text, config, (chunk) => chunks.push(chunk));
        return Buffer.concat(chunks);
    }

    /**
     * Accumulate LLM text chunks and speak at sentence boundaries.
     * Identical interface to ElevenLabsService.streamTextChunk.
     */
    async streamTextChunk(textChunk, config, onAudioChunk) {
        this.textBuffer += textChunk;
        const boundaries = config.inputPunctuationBoundaries || ['.', '!', '?', ':', ','];
        const hasBoundary = boundaries.some(p => this.textBuffer.includes(p));

        if (hasBoundary) {
            let lastPuncIndex = -1;
            for (const punc of boundaries) {
                const idx = this.textBuffer.lastIndexOf(punc);
                if (idx > lastPuncIndex) lastPuncIndex = idx;
            }
            if (lastPuncIndex > -1) {
                const toSpeak = this.textBuffer.substring(0, lastPuncIndex + 1).trim();
                this.textBuffer = this.textBuffer.substring(lastPuncIndex + 1).trim();
                if (toSpeak.length > 0) {
                    await this.textToSpeechStream(toSpeak, config, onAudioChunk);
                }
            }
        }
    }

    /**
     * Flush remaining text buffer.
     */
    async flushTextBuffer(config, onAudioChunk) {
        if (this.textBuffer && this.textBuffer.trim().length > 0) {
            await this.textToSpeechStream(this.textBuffer.trim(), config, onAudioChunk);
            this.textBuffer = '';
        }
    }

    /**
     * List available voices from the Chatterbox server.
     * Returns array of { voiceId, name, category, provider } objects.
     */
    async getVoices() {
        try {
            const data = await this._get('/voices');
            // Chatterbox returns either an array or { voices: [...] }
            const rawVoices = Array.isArray(data) ? data : (data.voices || []);

            return rawVoices.map(v => ({
                voiceId: v.name || v.voice_name || v.id || 'default',
                name: v.name || v.voice_name || v.id || 'Default Voice',
                category: v.language ? `cloned` : 'premade',
                language: v.language || null,
                provider: 'chatterbox',
                previewUrl: null,  // Chatterbox doesn't expose preview URLs via API
            }));
        } catch (error) {
            console.error('[Chatterbox] Error fetching voices:', error.message);
            throw error;
        }
    }

    /**
     * Health check — returns { ok: boolean, status: string }
     */
    async healthCheck() {
        try {
            const data = await this._get('/health');
            return { ok: true, status: data.status || 'ok', data };
        } catch (error) {
            return { ok: false, status: 'unreachable', error: error.message };
        }
    }

    /**
     * Stop current audio stream.
     */
    stop() {
        this._stopped = true;
        if (this._currentReq) {
            try { this._currentReq.destroy(); } catch (_) { }
            this._currentReq = null;
        }
        this.textBuffer = '';
    }
}

module.exports = ChatterboxService;
