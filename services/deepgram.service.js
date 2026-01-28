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
            encoding: 'mulaw',    // Twilio sends μ-law audio directly
            sample_rate: 8000,    // Twilio uses 8kHz
            channels: 1,
            keepAlive: true       // Keep connection alive during silence
        };

        console.log('Starting Deepgram with options:', options);

        // Create live transcription connection
        this.connection = this.client.listen.live(options);

        // Handle transcript events
        this.connection.on(LiveTranscriptionEvents.Transcript, (data) => {
            // Track ALL transcript events
            if (!this._transcriptEventCount) this._transcriptEventCount = 0;
            this._transcriptEventCount++;

            const transcript = data.channel?.alternatives?.[0]?.transcript;
            const isFinal = data.is_final;

            // Log event count
            if (this._transcriptEventCount % 10 === 0) {
                console.log(`[Deepgram] Received ${this._transcriptEventCount} transcript events`);
            }

            if (transcript && transcript.trim().length > 0) {
                console.log(`[Deepgram] ${isFinal ? 'Final' : 'Interim'}: ${transcript}`);

                // Skip if we're ignoring transcripts (agent is speaking)
                if (this._ignoreTranscripts) {
                    console.log('[Deepgram] Ignoring transcript (agent speaking)');
                    return;
                }

                if (isFinal && onTranscript) {
                    onTranscript(transcript);
                } else if (!isFinal && onInterim) {
                    // Call interim callback to reset silence timer
                    onInterim(transcript);
                }
            } else {
                // Also log when we get empty transcripts
                if (this._transcriptEventCount <= 5) {
                    console.log(`[Deepgram] Empty transcript event (${isFinal ? 'final' : 'interim'})`);
                }
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
        console.log('[Deepgram] Buffer clearing - ignoring transcripts');

        // Reset after a short delay to allow pending transcripts to be discarded
        setTimeout(() => {
            this._ignoreTranscripts = false;
            console.log('[Deepgram] Buffer cleared - listening for transcripts');
        }, 500);
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
