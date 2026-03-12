// Chatterbox TTS Service - resonanx-ai / Modal custom integration
// API: POST /generate  →  WAV response (voice cloning via Cloudflare R2)
// Auth: x-api-key header
//
// Full call flow:
//   Agent config: voice.provider = "chatterbox", voice.voice = "voices/system/<id>.wav"
//   textToSpeechStream(text, config)
//     → POST /generate { prompt: text, voice_key: "voices/system/<id>.wav" }
//     → Modal generates WAV (24kHz, 32-bit float, mono)
//     → We pipe WAV through ffmpeg → μ-law 8kHz raw PCM for telephony
//     → onAudioChunk(ulawBuffer) is called per chunk

const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');
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
    //  AUDIO CONVERSION VIA FFMPEG
    //  Input:  WAV (any sample rate, any bit depth, mono/stereo)
    //  Output: raw μ-law 8000 Hz mono (PCMU) chunks via onAudioChunk
    // ──────────────────────────────────────────────────────────────

    /**
     * Pipe an http.IncomingMessage (WAV stream) through ffmpeg,
     * emitting μ-law 8kHz chunks to onAudioChunk as they arrive.
     */
    _convertWithFfmpeg(httpRes, onAudioChunk) {
        return new Promise((resolve, reject) => {
            // ffmpeg reads WAV from stdin, outputs raw μ-law PCM to stdout
            // -ar 8000   → resample to 8 kHz
            // -ac 1      → mono
            // -acodec pcm_mulaw → μ-law encoding
            // -f mulaw   → raw output (no container)
            const ffmpeg = spawn(ffmpegStatic, [
                '-loglevel', 'error',
                '-i', 'pipe:0',       // read WAV from stdin
                '-ar', '8000',        // resample to 8kHz
                '-ac', '1',           // mono
                '-acodec', 'pcm_mulaw',
                '-f', 'mulaw',        // raw mulaw output
                'pipe:1'              // write to stdout
            ]);

            ffmpeg.on('error', (err) => {
                console.error('[Chatterbox] ffmpeg spawn error:', err.message);
                reject(new Error('ffmpeg not found. Install it: sudo apt-get install ffmpeg'));
            });

            // Collect ffmpeg stderr for debugging
            let ffmpegErr = '';
            ffmpeg.stderr.on('data', (d) => { ffmpegErr += d.toString(); });

            // Stream ffmpeg stdout as μ-law chunks
            ffmpeg.stdout.on('data', (chunk) => {
                if (!this._stopped) {
                    onAudioChunk(chunk);
                }
            });

            ffmpeg.on('close', (code) => {
                if (code !== 0) {
                    console.error(`[Chatterbox] ffmpeg exited ${code}: ${ffmpegErr}`);
                    reject(new Error(`ffmpeg conversion failed (exit ${code})`));
                } else {
                    resolve();
                }
            });

            // Pipe HTTP response (WAV) into ffmpeg stdin
            httpRes.pipe(ffmpeg.stdin);

            // If HTTP response errors, kill ffmpeg
            httpRes.on('error', (err) => {
                ffmpeg.kill();
                reject(err);
            });

            // If stopped externally, kill ffmpeg
            this._killFfmpeg = () => {
                try { ffmpeg.kill(); } catch (_) {}
            };
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
        this._killFfmpeg = null;
        config = config || {};

        // voice field holds the R2 object key (e.g. "voices/system/<id>.wav")
        const voiceKey = config.voice || config.voiceId || 'voices/system/default.wav';
        const temperature = typeof config.temperature === 'number' ? config.temperature : 0.8;
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
            console.log('[Chatterbox] WAV response received, piping through ffmpeg...');
            await this._convertWithFfmpeg(res, onAudioChunk);
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
     * Health check — hits GET /health as a lightweight ping
     */
    async healthCheck() {
        try {
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
        if (this._killFfmpeg) {
            this._killFfmpeg();
            this._killFfmpeg = null;
        }
        if (this._currentReq) {
            try { this._currentReq.destroy(); } catch (_) { }
            this._currentReq = null;
        }
        this.textBuffer = '';
    }
}

module.exports = ChatterboxService;
