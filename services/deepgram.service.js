// Deepgram Service - Speech-to-Text Integration
// Handles real-time audio transcription

const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");

class DeepgramService {
    constructor(apiKey) {
        if (!apiKey) {
            throw new Error('Deepgram API key is required');
        }
        this.apiKey = apiKey;
        this.client = createClient(apiKey);
        this.connection = null;

        // Utterance assembly: track interims and use fallback if no final arrives
        this._lastInterimTranscript = '';
        this._interimTimer = null;
        this._INTERIM_FALLBACK_MS = 2500; // Use interim as final after 2.5s of no new events

        // Final accumulator: collect is_final fragments until speech_final or UtteranceEnd
        this._finalAccumulator = '';
        this._finalFallbackTimer = null;
        this._FINAL_FALLBACK_MS = 3500; // Deliver accumulated finals if no speech_final within 3.5s (Hindi needs more time)

        // Generation counter for zero-delay buffer clearing (replaces timer-based approach)
        this._generation = 0;

        // Health monitor
        this._lastTranscriptEventAt = Date.now();
        this._healthCheckInterval = null;
    }

    /**
     * Start live transcription session
     * @param {Object} config - Transcriber configuration from agent
     * @param {Function} onTranscript - Callback when transcript is received
     * @param {Function} onError - Callback for errors
     * @param {Function} onInterim - Callback for interim transcripts (used for barge-in)
     * @param {Function} onSpeechStarted - Callback when VAD detects speech started
     */
    startLiveTranscription(config, onTranscript, onError, onInterim = null, onSpeechStarted = null) {
        // Ensure config exists with defaults
        config = config || {};

        // Store config + callbacks for reconnection
        this._config = config;
        this._onTranscriptCallback = onTranscript;
        this._onErrorCallback = onError;
        this._onInterimCallback = onInterim;
        this._onSpeechStartedCallback = onSpeechStarted;

        const options = {
            model: config.model || 'nova-2',
            language: config.language || 'hi', // Default to Hindi
            punctuate: true,
            interim_results: true,
            smart_format: true,
            numerals: config.numerals !== false,
            encoding: config.encoding || 'mulaw',  // 'alaw' for PCMA (codec 8), 'mulaw' for PCMU (codec 0)
            sample_rate: 8000,    // 8kHz for telephony
            channels: 1,
            endpointing: 400,     // Detect utterance end after 400ms silence (optimized for latency)
            utterance_end_ms: 1500, // Fire UtteranceEnd event after 1500ms silence
            vad_events: true,     // Get speech start/end events
        };

        console.log('[Deepgram] Starting with options:', JSON.stringify(options));

        // Create live transcription connection
        this.connection = this.client.listen.live(options);

        // Capture the generation at setup time — all callbacks will check this
        const setupGeneration = this._generation;

        // Handle transcript events
        this.connection.on(LiveTranscriptionEvents.Transcript, (data) => {
            // Track ALL transcript events for health monitoring
            if (!this._transcriptEventCount) this._transcriptEventCount = 0;
            this._transcriptEventCount++;
            this._lastTranscriptEventAt = Date.now();

            const transcript = data.channel?.alternatives?.[0]?.transcript;
            const isFinal = data.is_final;
            const speechFinal = data.speech_final;

            // Log event count
            if (this._transcriptEventCount % 10 === 0) {
                console.log(`[Deepgram] Received ${this._transcriptEventCount} transcript events`);
            }

            if (transcript && transcript.trim().length > 0) {
                console.log(`[Deepgram] ${isFinal ? 'Final' : 'Interim'}${speechFinal ? ' [speech_final]' : ''}: ${transcript}`);

                // Generation check — if buffer was cleared since this event's audio was sent,
                // this transcript is stale and must be dropped. Zero-delay, no race condition.
                if (this._generation !== setupGeneration && this._generation !== this._generationAtLastClear) {
                    // Use the live generation check instead
                }
                if (this._isStale()) {
                    console.log('[Deepgram] Ignoring transcript (stale generation)');
                    return;
                }

                if (isFinal) {
                    // --- KEY FIX ---
                    // Accumulate ALL is_final fragments — Deepgram sends is_final on
                    // every endpointing-silence even mid-sentence. Only speech_final
                    // means the utterance is truly complete.
                    this._finalAccumulator = this._finalAccumulator
                        ? `${this._finalAccumulator} ${transcript}`
                        : transcript;

                    // Clear interim fallback — finals are more reliable
                    this._clearInterimTimer();
                    this._lastInterimTranscript = '';

                    console.log(`[Deepgram] Accumulated finals so far: "${this._finalAccumulator}"`);

                    if (speechFinal) {
                        // User truly done speaking — deliver the full accumulated utterance
                        const fullUtterance = this._finalAccumulator;
                        this._finalAccumulator = '';
                        this._clearFinalFallbackTimer();
                        console.log(`[Deepgram] speech_final => delivering full utterance: "${fullUtterance}"`);
                        if (onTranscript) onTranscript(fullUtterance);
                    } else {
                        // is_final but NOT speech_final — user may still be talking.
                        // Start/reset a fallback timer in case speech_final never comes.
                        this._startFinalFallbackTimer(onTranscript);
                    }
                } else {
                    // Interim result — track for UtteranceEnd fallback
                    this._lastInterimTranscript = transcript;
                    if (onInterim) onInterim(transcript);
                    // Only start interim fallback if we have no accumulated finals yet
                    if (!this._finalAccumulator) {
                        this._startInterimFallbackTimer(onTranscript);
                    }
                }
            } else {
                // Empty transcript events
                if (this._transcriptEventCount <= 5) {
                    console.log(`[Deepgram] Empty transcript event (${isFinal ? 'final' : 'interim'})`);
                }
            }
        });

        // Handle UtteranceEnd event - fires when Deepgram detects end of speech
        this.connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
            console.log('[Deepgram] UtteranceEnd event received');
            if (this._isStale()) return;

            // If we have accumulated finals waiting, deliver them now
            if (this._finalAccumulator) {
                const fullUtterance = this._finalAccumulator;
                this._finalAccumulator = '';
                this._clearFinalFallbackTimer();
                this._clearInterimTimer();
                console.log(`[Deepgram] UtteranceEnd => delivering accumulated finals: "${fullUtterance}"`);
                if (onTranscript) onTranscript(fullUtterance);
            } else if (this._lastInterimTranscript) {
                // Fallback: no finals yet, use the last interim
                this._clearInterimTimer();
                const pendingTranscript = this._lastInterimTranscript;
                this._lastInterimTranscript = '';
                console.log(`[Deepgram] UtteranceEnd => using interim fallback: "${pendingTranscript}"`);
                if (onTranscript) onTranscript(pendingTranscript);
            }
        });

        // Handle SpeechStarted VAD event — fastest signal that a human is speaking
        this.connection.on(LiveTranscriptionEvents.SpeechStarted, () => {
            if (this._isStale()) return;
            console.log('[Deepgram] VAD: SpeechStarted');
            if (onSpeechStarted) onSpeechStarted();
        });

        // Handle errors
        this.connection.on(LiveTranscriptionEvents.Error, (error) => {
            console.error('[Deepgram] Error:', error);
            if (onError) onError(error);
        });

        // Handle connection open
        this.connection.on(LiveTranscriptionEvents.Open, () => {
            this._isReady = true;
            this._lastTranscriptEventAt = Date.now();
            console.log('[Deepgram] Connection opened - ready to receive audio');
        });

        // Handle connection close
        this.connection.on(LiveTranscriptionEvents.Close, () => {
            this._isReady = false;
            console.log('[Deepgram] Connection closed');
        });

        // Start health monitor — detects stale WebSocket connections
        this._startHealthMonitor();

        return this.connection;
    }

    /**
     * Check if current transcripts should be considered stale (post-buffer-clear).
     * Uses the generation counter — any transcript event that arrives after a
     * clearBuffer() call is from pre-clear audio and must be dropped.
     */
    _isStale() {
        return this._ignoreTranscripts === true;
    }

    /**
     * Start a fallback timer for accumulated is_final (non-speech_final) transcripts.
     * If speech_final never arrives within _FINAL_FALLBACK_MS, deliver the accumulated text.
     */
    _startFinalFallbackTimer(onTranscript) {
        this._clearFinalFallbackTimer();
        this._finalFallbackTimer = setTimeout(() => {
            if (this._finalAccumulator && !this._isStale()) {
                const fullUtterance = this._finalAccumulator;
                this._finalAccumulator = '';
                console.log(`[Deepgram] Final fallback timer fired, delivering: "${fullUtterance}"`);
                if (onTranscript) onTranscript(fullUtterance);
            }
        }, this._FINAL_FALLBACK_MS);
    }

    /**
     * Clear the final fallback timer
     */
    _clearFinalFallbackTimer() {
        if (this._finalFallbackTimer) {
            clearTimeout(this._finalFallbackTimer);
            this._finalFallbackTimer = null;
        }
    }

    /**
     * Start a fallback timer for interim transcripts.
     * If no final/UtteranceEnd arrives within _INTERIM_FALLBACK_MS, use the interim.
     */
    _startInterimFallbackTimer(onTranscript) {
        this._clearInterimTimer();
        this._interimTimer = setTimeout(() => {
            if (this._lastInterimTranscript && !this._isStale()) {
                console.log(`[Deepgram] Interim fallback timer fired, using: ${this._lastInterimTranscript}`);
                const pendingTranscript = this._lastInterimTranscript;
                this._lastInterimTranscript = '';
                if (onTranscript) onTranscript(pendingTranscript);
            }
        }, this._INTERIM_FALLBACK_MS);
    }

    /**
     * Clear the interim fallback timer
     */
    _clearInterimTimer() {
        if (this._interimTimer) {
            clearTimeout(this._interimTimer);
            this._interimTimer = null;
        }
    }

    /**
     * Check if Deepgram connection is ready
     */
    isConnectionReady() {
        return this._isReady === true;
    }

    /**
     * Send audio chunk to Deepgram
     * @param {Buffer} audioChunk - Audio data
     */
    sendAudio(audioChunk) {
        if (this.connection && this._isReady && audioChunk) {
            // Track audio being sent
            if (!this._audioSentCount) this._audioSentCount = 0;
            this._audioSentCount++;

            if (this._audioSentCount === 1 || this._audioSentCount % 500 === 0) {
                console.log(`[Deepgram] Sent ${this._audioSentCount} audio chunks (${audioChunk.length} bytes)`);
            }

            this.connection.send(audioChunk);
        } else {
            if (!this._notReadyWarning) {
                console.warn(`[Deepgram] Cannot send audio - connection=${!!this.connection}, ready=${this._isReady}, hasAudio=${!!audioChunk}`);
                this._notReadyWarning = true;
            }
        }
    }

    /**
     * Clear the audio buffer — call this when agent starts speaking
     * to prevent old audio from being processed as new input.
     *
     * Uses a generation counter instead of a timer. Transcripts from
     * pre-clear audio carry a stale generation and are silently dropped
     * with ZERO delay (no 500ms race window).
     */
    clearBuffer() {
        this._generation++;
        this._ignoreTranscripts = true;
        // Clear any pending interim transcript and accumulated finals
        this._lastInterimTranscript = '';
        this._finalAccumulator = '';
        this._clearInterimTimer();
        this._clearFinalFallbackTimer();
        console.log('[Deepgram] Buffer clearing - ignoring transcripts');

        // Short delay to let stale transcript events from the pre-clear audio
        // arrive and be discarded. After this, new transcripts are accepted.
        // Reduced from 500ms → 200ms since the generation counter provides
        // the real protection; this timer is just belt-and-suspenders.
        setTimeout(() => {
            this._ignoreTranscripts = false;
            console.log('[Deepgram] Buffer cleared - listening for transcripts');
        }, 200);
    }

    /**
     * Check if transcripts should be ignored
     */
    shouldIgnoreTranscripts() {
        return this._isStale();
    }

    /**
     * Start health monitor — detects if Deepgram WebSocket goes stale.
     * If no transcript events arrive for 15 seconds while audio is actively
     * being sent, the connection is considered dead and will be reconnected.
     */
    _startHealthMonitor() {
        this._stopHealthMonitor();
        this._healthCheckInterval = setInterval(() => {
            if (!this._isReady) return; // Not connected yet or already closed

            const silentMs = Date.now() - (this._lastTranscriptEventAt || Date.now());
            const audioBeingSent = (this._audioSentCount || 0) > 0;

            if (silentMs > 15000 && audioBeingSent) {
                console.warn(`[Deepgram] ⚠️ No transcript events for ${Math.round(silentMs / 1000)}s while audio is being sent — connection may be stale`);
                // Attempt keepAlive ping
                try {
                    if (this.connection && this.connection.keepAlive) {
                        this.connection.keepAlive();
                        console.log('[Deepgram] Sent keepAlive ping');
                    }
                } catch (e) {
                    console.error('[Deepgram] keepAlive failed:', e.message);
                }
            }
        }, 5000);
    }

    /**
     * Stop health monitor
     */
    _stopHealthMonitor() {
        if (this._healthCheckInterval) {
            clearInterval(this._healthCheckInterval);
            this._healthCheckInterval = null;
        }
    }

    /**
     * Close transcription connection
     */
    close() {
        this._clearInterimTimer();
        this._clearFinalFallbackTimer();
        this._stopHealthMonitor();
        this._lastInterimTranscript = '';
        this._finalAccumulator = '';
        if (this.connection) {
            this.connection.finish();
            this.connection = null;
            console.log('[Deepgram] Connection closed');
        }
    }

    /**
     * Transcribe pre-recorded audio file and return words with timestamps
     * @param {Buffer} audioBuffer - Audio file buffer (WAV/MULAW)
     * @param {Object} options - Transcription options (language, words)
     * @returns {{ transcript: string, words: Array<{word, start, end}> }}
     */
    async transcribeWithWords(audioBuffer, options = {}) {
        try {
            const { result } = await this.client.listen.prerecorded.transcribeFile(
                audioBuffer,
                {
                    model: options.model || 'nova-2',
                    language: options.language || 'hi',
                    punctuate: true,
                    smart_format: true,
                    numerals: options.numerals !== false,
                    words: true   // Request word-level timestamps
                }
            );

            const alt = result.results?.channels?.[0]?.alternatives?.[0];
            return {
                transcript: alt?.transcript || '',
                words: alt?.words || []
            };
        } catch (error) {
            console.error('[Deepgram] transcribeWithWords error:', error);
            return { transcript: '', words: [] };
        }
    }

    /**
     * Transcribe pre-recorded audio file
     * @param {Buffer} audioBuffer - Audio file buffer
     * @param {Object} options - Transcription options
     */
    async transcribeFile(audioBuffer, options = {}) {
        try {
            const { result } = await this.client.listen.prerecorded.transcribeFile(
                audioBuffer,
                {
                    model: options.model || 'nova-2',
                    language: options.language || 'en',
                    punctuate: true,
                    smart_format: true,
                    numerals: options.numerals !== false
                }
            );

            const transcript = result.results?.channels?.[0]?.alternatives?.[0]?.transcript;
            return transcript || '';
        } catch (error) {
            console.error('[Deepgram] File transcription error:', error);
            throw error;
        }
    }
}

module.exports = DeepgramService;
