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
        this._INTERIM_FALLBACK_MS = 1000; // Use interim as final after 1s of no new events

        // Final accumulator: collect is_final fragments until speech_final or UtteranceEnd
        this._finalAccumulator = '';
        this._finalFallbackTimer = null;
        this._FINAL_FALLBACK_MS = 1200; // Deliver accumulated finals if no speech_final within 1.2s
    }

    /**
     * Start live transcription session
     * @param {Object} config - Transcriber configuration from agent
     * @param {Function} onTranscript - Callback when transcript is received
     * @param {Function} onError - Callback for errors
     */
    startLiveTranscription(config, onTranscript, onError, onInterim = null) {
        // Ensure config exists with defaults
        config = config || {};

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
            endpointing: 200,      // Detect utterance end after 200ms silence (low-latency)
            utterance_end_ms: 1000, // Minimum allowed by Deepgram API (< 1000 returns HTTP 400)
            vad_events: true,     // Get speech start/end events
        };

        console.log('[Deepgram] Starting with options:', JSON.stringify(options));

        // Create live transcription connection
        this.connection = this.client.listen.live(options);

        // Store transcript callback for utterance assembly
        this._onTranscriptCallback = onTranscript;

        // Handle transcript events
        this.connection.on(LiveTranscriptionEvents.Transcript, (data) => {
            // Track ALL transcript events
            if (!this._transcriptEventCount) this._transcriptEventCount = 0;
            this._transcriptEventCount++;

            const transcript = data.channel?.alternatives?.[0]?.transcript;
            const isFinal = data.is_final;
            const speechFinal = data.speech_final;

            // Log event count
            if (this._transcriptEventCount % 10 === 0) {
                console.log(`[Deepgram] Received ${this._transcriptEventCount} transcript events`);
            }

            if (transcript && transcript.trim().length > 0) {
                console.log(`[Deepgram] ${isFinal ? 'Final' : 'Interim'}${speechFinal ? ' [speech_final]' : ''}: ${transcript}`);

                // Skip if we're ignoring transcripts (agent is speaking)
                if (this._ignoreTranscripts) {
                    console.log('[Deepgram] Ignoring transcript (agent speaking)');
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
            if (this._ignoreTranscripts) return;

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

        // Handle errors
        this.connection.on(LiveTranscriptionEvents.Error, (error) => {
            console.error('[Deepgram] Error:', error);
            if (onError) onError(error);
        });

        // Handle connection open
        this.connection.on(LiveTranscriptionEvents.Open, () => {
            this._isReady = true;
            console.log('[Deepgram] Connection opened - ready to receive audio');
        });

        // Handle connection close
        this.connection.on(LiveTranscriptionEvents.Close, () => {
            this._isReady = false;
            console.log('[Deepgram] Connection closed');
        });

        return this.connection;
    }

    /**
     * Start a fallback timer for accumulated is_final (non-speech_final) transcripts.
     * If speech_final never arrives within _FINAL_FALLBACK_MS, deliver the accumulated text.
     */
    _startFinalFallbackTimer(onTranscript) {
        this._clearFinalFallbackTimer();
        this._finalFallbackTimer = setTimeout(() => {
            if (this._finalAccumulator && !this._ignoreTranscripts) {
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
            if (this._lastInterimTranscript && !this._ignoreTranscripts) {
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
     * Clear the audio buffer - call this when agent starts speaking
     * to prevent old audio from being processed as new input
     */
    clearBuffer() {
        // Flag to ignore incoming transcripts temporarily
        this._ignoreTranscripts = true;
        // Clear any pending interim transcript and accumulated finals
        this._lastInterimTranscript = '';
        this._finalAccumulator = '';
        this._clearInterimTimer();
        this._clearFinalFallbackTimer();
        console.log('[Deepgram] Buffer clearing - ignoring transcripts');

        // Reset after a short delay to allow pending transcripts to be discarded.
        // CRITICAL: Keep this window as short as possible — a long window swallows
        // speech_final events and forces the slow fallback timer path (was 3500ms).
        setTimeout(() => {
            this._ignoreTranscripts = false;
            console.log('[Deepgram] Buffer cleared - listening for transcripts');
        }, 150);
    }

    /**
     * Check if transcripts should be ignored
     */
    shouldIgnoreTranscripts() {
        return this._ignoreTranscripts;
    }

    /**
     * Close transcription connection
     */
    close() {
        this._clearInterimTimer();
        this._clearFinalFallbackTimer();
        this._lastInterimTranscript = '';
        this._finalAccumulator = '';
        if (this.connection) {
            this.connection.finish();
            this.connection = null;
            console.log('[Deepgram] Connection closed');
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
