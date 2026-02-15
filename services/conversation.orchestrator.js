// Conversation Orchestrator
// Coordinates the entire voice conversation pipeline

const DeepgramService = require('./deepgram.service');
const GeminiService = require('./gemini.service');
const ElevenLabsService = require('./elevenlabs.service');
const EventEmitter = require('events');

class ConversationOrchestrator extends EventEmitter {
    constructor(agentConfig, apiKeys) {
        super();

        // Use agent config directly, apply defaults only for missing properties
        this.agentConfig = agentConfig || {};

        // Apply defaults for missing top-level properties
        if (!this.agentConfig.model) this.agentConfig.model = {};
        if (!this.agentConfig.voice) this.agentConfig.voice = {};
        if (!this.agentConfig.transcriber) this.agentConfig.transcriber = {};
        if (!this.agentConfig.firstMessage) this.agentConfig.firstMessage = 'Hello! How can I help you today?';
        if (!this.agentConfig.firstMessageMode) this.agentConfig.firstMessageMode = 'assistant-speaks-first';
        if (!this.agentConfig.maxDurationSeconds) this.agentConfig.maxDurationSeconds = 600;
        if (!this.agentConfig.silenceTimeoutSeconds) this.agentConfig.silenceTimeoutSeconds = 30;
        if (!this.agentConfig.responseDelaySeconds) this.agentConfig.responseDelaySeconds = 0.4;

        console.log('[Orchestrator] Agent config loaded:');
        console.log('  - Voice ID:', this.agentConfig.voice?.voiceId || 'MISSING - will use default');
        console.log('  - Voice Model:', this.agentConfig.voice?.model || 'MISSING');
        console.log('  - First Message:', (this.agentConfig.firstMessage || '').substring(0, 80) + '...');
        console.log('  - First Message Mode:', this.agentConfig.firstMessageMode);
        console.log('  - Transcriber Language:', this.agentConfig.transcriber?.language || 'MISSING');

        this.state = 'idle'; // idle, listening, thinking, speaking, ended
        this._aborted = false; // Hard stop flag - once set, pipeline must stop
        this.startTime = Date.now();
        this.conversationLog = [];

        // Initialize services
        this.deepgram = new DeepgramService(apiKeys.deepgram);
        this.gemini = new GeminiService(apiKeys.gemini);
        this.elevenlabs = new ElevenLabsService(apiKeys.elevenlabs);

        // Timers
        this.silenceTimer = null;
        this.maxDurationTimer = null;

        // Audio buffer for TTS
        this.audioQueue = [];
        this.isSpeaking = false;
    }

    /**
     * Start the conversation
     */
    async start() {
        console.log('[Orchestrator] Starting conversation');

        // Initialize Gemini with agent configuration
        this.gemini.initializeConversation(this.agentConfig.model);

        // Set up max duration timer
        if (this.agentConfig.maxDurationSeconds) {
            this.maxDurationTimer = setTimeout(() => {
                console.log('[Orchestrator] Max duration reached');
                this.end('max_duration');
            }, this.agentConfig.maxDurationSeconds * 1000);
        }

        // Start listening
        this.startListening();

        // Speak first message if configured
        if (this.agentConfig.firstMessageMode === 'assistant-speaks-first' &&
            this.agentConfig.firstMessage) {
            await this.speak(this.agentConfig.firstMessage);
        } else {
            this.state = 'listening';
            this.startSilenceTimer();
        }

        this.emit('started');
    }

    /**
     * Start listening for user input
     */
    startListening() {
        console.log('[Orchestrator] Starting Deepgram transcription');

        this.deepgram.startLiveTranscription(
            this.agentConfig.transcriber,
            (transcript) => this.onUserSpeech(transcript),
            (error) => this.onError(error),
            // Interim callback - reset silence timer when user starts speaking
            (interimTranscript) => {
                console.log(`[Orchestrator] User speaking (interim): ${interimTranscript}`);
                this.resetSilenceTimer();
            }
        );

        this.state = 'listening';
    }

    /**
     * Handle user speech
     */
    async onUserSpeech(transcript) {
        if (this.state === 'ended' || this._aborted) return;

        console.log(`[Orchestrator] User said: ${transcript}`);

        // Log conversation
        this.conversationLog.push({
            role: 'user',
            content: transcript,
            timestamp: new Date()
        });

        this.emit('user_speech', transcript);

        // Reset silence timer
        this.resetSilenceTimer();

        // Add configured response delay
        if (this.agentConfig.responseDelaySeconds) {
            await this.delay(this.agentConfig.responseDelaySeconds * 1000);
        }

        // Check again after delay - call may have ended during wait
        if (this._aborted) {
            console.log('[Orchestrator] Call ended during response delay, aborting');
            return;
        }

        // Get AI response
        await this.getAIResponse(transcript);
    }

    /**
     * Get AI response and speak it
     */
    async getAIResponse(userMessage) {
        if (this._aborted) return;

        this.state = 'thinking';
        this.emit('thinking');

        // CRITICAL: Clear buffer before generating speech to prevent echo
        this.deepgram.clearBuffer();

        try {
            console.log('[Orchestrator] Getting AI response');

            let fullResponse = '';

            // Get streaming response from Gemini
            await this.gemini.getResponse(userMessage, async (chunk) => {
                fullResponse += chunk;
                // Just accumulate, don't stream to TTS chunk-by-chunk
            });

            // CRITICAL: Check if call ended while Gemini was processing
            if (this._aborted) {
                console.log('[Orchestrator] Call ended during AI processing, skipping TTS');
                return;
            }

            // Add to conversation log
            this.conversationLog.push({
                role: 'assistant',
                content: fullResponse,
                timestamp: new Date()
            });

            this.emit('assistant_speech', fullResponse);

            // Speak the complete response once
            await this.speak(fullResponse);

        } catch (error) {
            if (this._aborted) return; // Don't recover if call is dead
            console.error('[Orchestrator] Error getting AI response:', error);
            this.emit('error', error);

            // Graceful error recovery - speak apology and continue listening
            try {
                const errorMessage = 'Sorry, I encountered an issue. Could you please repeat that?';
                console.log('[Orchestrator] Speaking error recovery message');
                await this.speak(errorMessage);
            } catch (speakError) {
                console.error('[Orchestrator] Failed to speak error message:', speakError);
                // If we can't even speak, end the call
                this.end('error');
            }
        }
    }

    /**
     * Speak text using TTS
     */
    async speak(text) {
        // CRITICAL: Don't speak if call is already ended
        if (this._aborted) {
            console.log('[Orchestrator] speak() skipped - call already ended');
            return;
        }

        this.state = 'speaking';
        this.emit('speaking', text);

        // Clear any pending transcripts to avoid processing stale audio
        this.deepgram.clearBuffer();

        console.log(`[Orchestrator] Speaking: ${text}`);

        try {
            await this.elevenlabs.textToSpeechStream(
                text,
                this.agentConfig.voice,
                (audioChunk) => this.onAudioChunk(audioChunk)
            );

            // CRITICAL: Only transition to listening if call is still alive
            if (!this._aborted) {
                this.state = 'listening';
                console.log('[Orchestrator] Speaking complete, now listening');
                this.startSilenceTimer();
            } else {
                console.log('[Orchestrator] Speaking complete but call already ended, not restarting listener');
            }

        } catch (error) {
            if (this._aborted) return; // Expected if call ended mid-TTS
            console.error('[Orchestrator] TTS error:', error);
            this.emit('error', error);
        }
    }

    /**
     * Handle audio chunks from TTS
     */
    onAudioChunk(audioChunk) {
        // CRITICAL: Don't emit audio if call is ended
        if (this._aborted) return;
        // Emit audio chunk to be sent to phone call
        this.emit('audio', audioChunk);
    }

    /**
     * Process incoming audio from phone call
     */
    processIncomingAudio(audioBuffer) {
        // Log state occasionally for debugging
        if (!this._audioLogCount) this._audioLogCount = 0;
        this._audioLogCount++;
        if (this._audioLogCount === 1 || this._audioLogCount % 500 === 0) {
            console.log(`[Orchestrator] processIncomingAudio state=${this.state}, deepgram ready=${this.deepgram?.isConnectionReady?.()}`);
        }

        // ALWAYS send audio to Deepgram to keep WebSocket connection alive
        // The _ignoreTranscripts flag in DeepgramService handles discarding
        // results during speaking/thinking states
        if (this.state !== 'ended' && this.deepgram && this.deepgram.isConnectionReady()) {
            this.deepgram.sendAudio(audioBuffer);
        }
    }

    /**
     * Start/reset silence timer
     */
    startSilenceTimer() {
        this.clearSilenceTimer();

        if (this.agentConfig.silenceTimeoutSeconds) {
            this.silenceTimer = setTimeout(() => {
                console.log('[Orchestrator] Silence timeout');
                this.end('silence_timeout');
            }, this.agentConfig.silenceTimeoutSeconds * 1000);
        }
    }

    resetSilenceTimer() {
        this.startSilenceTimer();
    }

    clearSilenceTimer() {
        if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
            this.silenceTimer = null;
        }
    }

    /**
     * Check if max duration reached
     */
    checkMaxDuration() {
        const duration = (Date.now() - this.startTime) / 1000;
        return duration >= (this.agentConfig.maxDurationSeconds || Infinity);
    }

    /**
     * End conversation
     */
    end(reason = 'user_hangup') {
        if (this.state === 'ended') return;

        console.log(`[Orchestrator] Ending conversation: ${reason}`);

        this.state = 'ended';
        this._aborted = true; // Hard stop - all async pipeline checks this

        // Clear timers
        this.clearSilenceTimer();
        if (this.maxDurationTimer) {
            clearTimeout(this.maxDurationTimer);
        }

        // Close services
        if (this.deepgram) {
            this.deepgram.close();
        }
        if (this.elevenlabs) {
            this.elevenlabs.stop();
        }

        // Calculate stats
        const duration = (Date.now() - this.startTime) / 1000;

        this.emit('ended', {
            reason,
            duration,
            messageCount: this.conversationLog.length,
            conversationLog: this.conversationLog
        });
    }

    /**
     * Handle errors
     */
    onError(error) {
        console.error('[Orchestrator] Error:', error);
        this.emit('error', error);
    }

    /**
     * Delay utility
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Get conversation log
     */
    getConversationLog() {
        return this.conversationLog;
    }

    /**
     * Get conversation duration
     */
    getDuration() {
        return (Date.now() - this.startTime) / 1000;
    }
}

module.exports = ConversationOrchestrator;
