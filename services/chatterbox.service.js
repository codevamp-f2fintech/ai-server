// Chatterbox TTS Service - resonanx-ai / Modal custom integration
// API: POST /generate  →  WAV response (voice cloning via Cloudflare R2)
// Auth: x-api-key header
//
// Full call flow:
//   Agent config: voice.provider = "chatterbox", voice.voice = "voices/system/<id>.wav"
//   textToSpeechStream(text, config)
//     → POST /generate { prompt: text, voice_key: "voices/system/<id>.wav" }
//     → Modal fetches audio from R2, generates WAV with voice cloning
//     → We receive WAV, transcode → μ-law 8kHz for telephony
//     → onAudioChunk(ulawBuffer) is called per chunk

const http = require('http');
const https = require('https');
const alawmulaw = require('alawmulaw');

class ChatterboxService {
    /**
     * @param {string} baseUrl  e.g. "https://aafaqthecoder--chatterbox-tts-chatterbox-serve.modal.run"
     * @param {string} [apiKey] x-api-key header value
     */
    constructor(baseUrl, apiKey) {
        if (!baseUrl) throw new Error('Chatterbox base URL is required (set CHATTERBOX_BASE_URL)');
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.apiKey = apiKey || null;
        this._stopped = false;
        this._currentReq = null;
        this.textBuffer = '';
    }

    // ──────────────────────────────────────────────────────────────
    //  AUDIO FORMAT HELPERS
    // ──────────────────────────────────────────────────────────────

    _parseWavHeader(buf) {
        if (buf.length < 44) return null;
        if (buf.toString('ascii', 0, 4) !== 'RIFF') return null;
        if (buf.toString('ascii', 8, 12) !== 'WAVE') return null;
        const numChannels = buf.readUInt16LE(22);
        const sampleRate = buf.readUInt32LE(24);
        const bitsPerSample = buf.readUInt16LE(34);
        let dataOffset = 12;
        while (dataOffset + 8 <= buf.length) {
            const chunkId = buf.toString('ascii', dataOffset, dataOffset + 4);
            const chunkSize = buf.readUInt32LE(dataOffset + 4);
            if (chunkId === 'data') return { sampleRate, bitsPerSample, numChannels, dataOffset: dataOffset + 8 };
            dataOffset += 8 + chunkSize;
        }
        return null;
    }

    _pcm16ToUlaw8000(int16Samples, srcRate, numChannels) {
        // Mix to mono
        let mono;
        if (numChannels === 2) {
            mono = new Int16Array(int16Samples.length / 2);
            for (let i = 0; i < mono.length; i++)
                mono[i] = Math.round((int16Samples[i * 2] + int16Samples[i * 2 + 1]) / 2);
        } else {
            mono = int16Samples;
        }
        // Downsample to 8000 Hz
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
        return Buffer.from(alawmulaw.mulaw.encode(resampled));
    }

    /**
     * Convert Float32 PCM samples → Int16 (clamp to [-32768, 32767]).
     * Chatterbox / torchaudio.save() outputs 32-bit IEEE float WAV by default.
     */
    _float32ToInt16(float32Samples) {
        const out = new Int16Array(float32Samples.length);
        for (let i = 0; i < float32Samples.length; i++) {
            const s = Math.max(-1, Math.min(1, float32Samples[i]));
            out[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
        }
        return out;
    }

    _processPcmChunk(pcmBuf, wavInfo, onAudioChunk) {
        if (!onAudioChunk || pcmBuf.length === 0) return;
        try {
            let int16Samples;
            if (wavInfo.bitsPerSample === 32) {
                // 32-bit IEEE float (torchaudio default) → convert to Int16 first
                const frameLen = pcmBuf.length - (pcmBuf.length % 4);
                if (frameLen === 0) return;
                // Need aligned buffer for Float32Array
                const alignedBuf = Buffer.allocUnsafe(frameLen);
                pcmBuf.copy(alignedBuf, 0, 0, frameLen);
                const float32 = new Float32Array(alignedBuf.buffer, alignedBuf.byteOffset, frameLen / 4);
                int16Samples = this._float32ToInt16(float32);
            } else {
                // 16-bit PCM (standard)
                const evenLen = pcmBuf.length - (pcmBuf.length % 2);
                if (evenLen === 0) return;
                int16Samples = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, evenLen / 2);
            }
            const ulawBuf = this._pcm16ToUlaw8000(int16Samples, wavInfo.sampleRate, wavInfo.numChannels);
            onAudioChunk(ulawBuf);
        } catch (err) {
            console.error('[Chatterbox] PCM→μ-law error:', err.message);
        }
    }

    // ──────────────────────────────────────────────────────────────
    //  HTTP HELPERS
    // ──────────────────────────────────────────────────────────────

    _buildHeaders(extra = {}) {
        const headers = { 'Content-Type': 'application/json', ...extra };
        if (this.apiKey) headers['x-api-key'] = this.apiKey;
        return headers;
    }

    _post(path, bodyObj) {
        const body = JSON.stringify(bodyObj);
        const url = new URL(path, this.baseUrl);
        const isHttps = url.protocol === 'https:';
        const lib = isHttps ? https : http;
        const headers = this._buildHeaders({ 'Content-Length': Buffer.byteLength(body) });

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
                    res.on('end', () => reject(new Error(`[Chatterbox] HTTP ${res.statusCode}: ${errBody.substring(0, 300)}`)));
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

    _get(path) {
        const url = new URL(path, this.baseUrl);
        const isHttps = url.protocol === 'https:';
        const lib = isHttps ? https : http;
        const headers = this._buildHeaders();

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
    //  PUBLIC TTS API
    // ──────────────────────────────────────────────────────────────

    /**
     * Stream text → speech using resonanx-ai / Modal Chatterbox.
     * config.voice should be the R2 object key, e.g. "voices/system/abc123.wav"
     */
    async textToSpeechStream(text, config, onAudioChunk) {
        this._stopped = false;
        config = config || {};

        // voice field holds the R2 object key (e.g. "voices/system/<id>.wav")
        const voiceKey = config.voice || config.voiceId || 'voices/system/default.wav';
        const temperature = typeof config.temperature === 'number' ? config.temperature : 0.8;
        const exaggeration = typeof config.exaggeration === 'number' ? config.exaggeration : 0.7;
        // Map exaggeration → cfg_weight equivalent (repetition_penalty acts as guide)
        const topP = typeof config.cfg_weight === 'number' ? config.cfg_weight : 0.95;
        const language = config.language || null;

        console.log(`[Chatterbox] TTS: "${text.substring(0, 60)}..." voice_key="${voiceKey}"`);

        const requestBody = {
            prompt: text,
            voice_key: voiceKey,
            temperature,
            top_p: topP,
            top_k: 1000,
            repetition_penalty: 1.2,
            norm_loudness: true,
        };
        if (language) requestBody.language = language;

        try {
            const res = await this._post('/generate', requestBody);

            let headerParsed = false;
            let wavInfo = null;
            let headerBuf = Buffer.alloc(0);

            await new Promise((resolve, reject) => {
                res.on('data', (chunk) => {
                    if (this._stopped) return;

                    if (!headerParsed) {
                        headerBuf = Buffer.concat([headerBuf, chunk]);
                        if (headerBuf.length < 128) return;

                        wavInfo = this._parseWavHeader(headerBuf);
                        if (!wavInfo) {
                            console.warn('[Chatterbox] No WAV header — assuming 24kHz 16-bit mono PCM');
                            wavInfo = { sampleRate: 24000, bitsPerSample: 16, numChannels: 1, dataOffset: 0 };
                        }
                        headerParsed = true;
                        console.log(`[Chatterbox] WAV: ${wavInfo.sampleRate}Hz, ${wavInfo.bitsPerSample}-bit, ${wavInfo.numChannels}ch`);

                        const pcmBytes = headerBuf.slice(wavInfo.dataOffset);
                        if (pcmBytes.length > 0) this._processPcmChunk(pcmBytes, wavInfo, onAudioChunk);
                        headerBuf = Buffer.alloc(0);
                        return;
                    }
                    this._processPcmChunk(chunk, wavInfo, onAudioChunk);
                });
                res.on('end', resolve);
                res.on('error', reject);
            });

            console.log('[Chatterbox] Audio generation complete');
        } catch (error) {
            if (this._stopped) return;
            console.error('[Chatterbox] Error generating speech:', error.message);
            throw error;
        }
    }

    async textToSpeechBuffer(text, config) {
        const chunks = [];
        await this.textToSpeechStream(text, config, (chunk) => chunks.push(chunk));
        return Buffer.concat(chunks);
    }

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
                if (toSpeak.length > 0) await this.textToSpeechStream(toSpeak, config, onAudioChunk);
            }
        }
    }

    async flushTextBuffer(config, onAudioChunk) {
        if (this.textBuffer && this.textBuffer.trim().length > 0) {
            await this.textToSpeechStream(this.textBuffer.trim(), config, onAudioChunk);
            this.textBuffer = '';
        }
    }

    /**
     * Health check — hits GET /docs (Modal FastAPI docs endpoint) as a lightweight ping
     */
    async healthCheck() {
        try {
            // /docs returns HTML — we just need a 200
            const url = new URL('/health', this.baseUrl);
            const isHttps = url.protocol === 'https:';
            const lib = isHttps ? https : http;
            return await new Promise((resolve) => {
                lib.get({ hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: '/health', headers: this._buildHeaders() }, (res) => {
                    resolve({ ok: res.statusCode < 400, status: String(res.statusCode) });
                }).on('error', (err) => resolve({ ok: false, status: 'unreachable', error: err.message }));
            });
        } catch (err) {
            return { ok: false, status: 'unreachable', error: err.message };
        }
    }

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
