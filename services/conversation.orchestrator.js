// Conversation Orchestrator
// Coordinates the entire voice conversation pipeline

const DeepgramService = require('./deepgram.service');
const GeminiService = require('./gemini.service');
const ElevenLabsService = require('./elevenlabs.service');
const ChatterboxService = require('./chatterbox.service');
const EventEmitter = require('events');

/**
 * Strip Markdown formatting from text before TTS
 * Asterisks, underscores, headers etc. cause noise/clicks in ElevenLabs
 */
function stripMarkdown(text) {
    return text
        .replace(/\*\*(.+?)\*\*/g, '$1')   // **bold** -> bold
        .replace(/\*(.+?)\*/g, '$1')         // *italic* -> italic
        .replace(/__(.+?)__/g, '$1')          // __bold__ -> bold
        .replace(/_(.+?)_/g, '$1')            // _italic_ -> italic
        .replace(/#{1,6}\s+/g, '')            // ## heading -> heading
        .replace(/\[(.+?)\]\(.+?\)/g, '$1')  // [link](url) -> link
        .replace(/`{1,3}[^`]*`{1,3}/g, '')    // `code` -> (removed)
        .replace(/^\s*[-*+]\s+/gm, '')         // - bullet -> (removed)
        .replace(/^\s*\d+\.\s+/gm, '')        // 1. list -> (removed)
        .replace(/\n{3,}/g, '\n\n')           // Collapse extra blank lines
        .replace(/\s{2,}/g, ' ')              // Collapse multiple spaces
        .trim();
}

/**
 * Get localized filler word based on agent language structure
 */
function getFillerWord(language) {
    const fillers = {
        'hi': ['हम्म...', 'ठीक है...'],
        'en': ['Hmm...', 'Okay...'],
    };
    const langPrefix = (language || 'en').substring(0, 2).toLowerCase();
    const options = fillers[langPrefix] || fillers['en'];
    return options[Math.floor(Math.random() * options.length)];
}

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
        if (!this.agentConfig.responseDelaySeconds) this.agentConfig.responseDelaySeconds = 0.1;

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

        // Select TTS provider based on agent voice config
        const voiceProvider = (this.agentConfig.voice?.provider || '11labs').toLowerCase();
        if (voiceProvider === 'chatterbox') {
            const chatterboxUrl = process.env.CHATTERBOX_BASE_URL || 'http://localhost:4123';
            const chatterboxKey = process.env.CHATTERBOX_API_KEY || null;
            console.log(`[Orchestrator] TTS provider: Chatterbox @ ${chatterboxUrl} (auth: ${chatterboxKey ? 'yes' : 'no'})`);
            this.tts = new ChatterboxService(chatterboxUrl, chatterboxKey);
        } else {
            console.log(`[Orchestrator] TTS provider: ElevenLabs`);
            this.tts = new ElevenLabsService(apiKeys.elevenlabs);
        }
        // Backward-compat alias — some callers still reference this.elevenlabs directly
        this.elevenlabs = this.tts;

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

        // Initialize Gemini with agent configuration + knowledge base
        // IMPORTANT: await here because initializeConversation is async
        // (it may need to fetch KB text from S3 if DB copy is empty)
        // Pass firstMessage so Gemini knows what was already said
        await this.gemini.initializeConversation({
            ...(this.agentConfig.model || {}),
            knowledgeBase: this.agentConfig.knowledgeBase || [],
            firstMessage: (this.agentConfig.firstMessageMode === 'assistant-speaks-first' && this.agentConfig.firstMessage)
                ? this.agentConfig.firstMessage : null
        });

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

            // Add to conversation log for transcript
            this.conversationLog.push({
                role: 'assistant',
                content: this.agentConfig.firstMessage,
                timestamp: new Date()
            });

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
     * Handle user speech - with accumulation buffer and thinking guard
     */
    async onUserSpeech(transcript) {
        if (this.state === 'ended' || this._aborted) return;

        this._transcriptReceivedAt = Date.now();
        console.log(`[⏱ LATENCY] Transcript received: "${transcript}"`);
        console.log(`[Orchestrator] User said: ${transcript}`);

        // Stop current TTS generation to avoid overlapping if the user interrupts
        if (this.tts) {
            this.tts.stop();
        }

        this.emit('user_speech', transcript);

        // Reset silence timer
        this.resetSilenceTimer();

        // If Gemini is already thinking, queue the transcript for after it responds
        if (this._isThinking) {
            console.log(`[Orchestrator] Gemini busy, queueing transcript`);
            if (!this._queuedTranscript) {
                this._queuedTranscript = transcript;
            } else {
                this._queuedTranscript += ' ' + transcript;
            }
            return;
        }

        // Accumulate transcript - wait briefly for more finals before sending to Gemini
        if (!this._pendingTranscript) {
            this._pendingTranscript = transcript;
        } else {
            this._pendingTranscript += ' ' + transcript;
        }

        // Clear previous accumulation timer
        if (this._transcriptAccumTimer) {
            clearTimeout(this._transcriptAccumTimer);
        }

        // Wait 800ms for more transcript finals before processing
        this._transcriptAccumTimer = setTimeout(async () => {
            if (this._aborted || this.state === 'ended') return;

            // Guard: if another getAIResponse just started during this 300ms wait, queue instead
            if (this._isThinking) {
                const t = this._pendingTranscript;
                this._pendingTranscript = null;
                if (t) {
                    this._queuedTranscript = this._queuedTranscript ? `${t} ${this._queuedTranscript}` : t;
                    console.log(`[Orchestrator] Timer fired but AI thinking — queued: ${t}`);
                }
                return;
            }

            const fullTranscript = this._pendingTranscript;
            this._pendingTranscript = null;
            const accumDone = Date.now();
            console.log(`[⏱ LATENCY] Accumulation wait: ${accumDone - this._transcriptReceivedAt}ms`);

            // Log conversation
            this.conversationLog.push({
                role: 'user',
                content: fullTranscript,
                timestamp: new Date()
            });

            // Mark thinking EARLY — prevents a second timer from starting its own Gemini call
            // during the response delay below
            this._isThinking = true;

            // Apply configured response delay (cap at 3s to be safe)
            const delayMs = Math.min((this.agentConfig.responseDelaySeconds || 0) * 1000, 3000);
            if (delayMs > 0) await this.delay(delayMs);
            console.log(`[⏱ LATENCY] Response delay done: +${delayMs}ms`);

            // Check again after delay - call may have ended during wait
            if (this._aborted) {
                this._isThinking = false;
                console.log('[Orchestrator] Call ended during response delay, aborting');
                return;
            }

            // Get AI response with accumulated transcript
            await this.getAIResponse(fullTranscript);

            // After Gemini responds, check if more transcripts were queued
            if (this._queuedTranscript && !this._aborted) {
                const queued = this._queuedTranscript;
                this._queuedTranscript = null;
                console.log(`[Orchestrator] Processing queued transcript: ${queued}`);
                this.conversationLog.push({
                    role: 'user',
                    content: queued,
                    timestamp: new Date()
                });
                await this.getAIResponse(queued);
            }
        }, 300);
    }

    /**
     * Get AI response and speak it — sentence-boundary streaming mode.
     * Gemini chunks are detected for sentence endings; each sentence is sent
     * to ElevenLabs TTS immediately, so audio starts playing while Gemini
     * is still generating the rest of the response.
     */
    async getAIResponse(userMessage) {
        if (this._aborted) return;

        this.state = 'thinking';
        this._isThinking = true;
        this.emit('thinking');

        // CRITICAL: Clear Deepgram buffer immediately so stale audio from before
        // the user finished speaking is discarded
        this.deepgram.clearBuffer();

        try {
            const t0 = Date.now();
            console.log(`[⏱ LATENCY] Gemini start → waiting for first token...`);

            let fullResponse = '';
            let sentenceBuffer = '';
            let ttsStarted = false;
            let isFirstSentence = true;
            let geminiFirstTokenAt = 0;

            // Sequential chain of TTS promises — sentences play in order
            // but Gemini generation overlaps with TTS playback of earlier sentences
            let ttsChain = Promise.resolve();

            // --- ADDITION: Play filler word immediately (Backchanneling) ---
            const filler = getFillerWord(this.agentConfig.transcriber?.language);
            console.log(`[Orchestrator] Backchanneling with filler: ${filler}`);
            this.state = 'speaking';
            this.emit('speaking', filler);

            // Queue filler word first in TTS chain so it plays while Gemini thinks
            ttsChain = ttsChain.then(async () => {
                if (this._aborted) return;
                try {
                    const ttsStart = Date.now();
                    const providerLabel = this.tts instanceof ChatterboxService ? 'Chatterbox' : 'ElevenLabs';
                    await this.tts.textToSpeechStream(
                        filler,
                        this.agentConfig.voice,
                        (chunk) => this.onAudioChunk(chunk)
                    );
                    console.log(`[⏱ LATENCY] Filler TTS done: ${Date.now() - ttsStart}ms (${providerLabel})`);
                } catch (e) {
                    console.error('[Orchestrator] Filler TTS error:', e.message);
                }
            });
            // --- END ADDITION ---

            // TTS merge buffer: accumulate short sentences to reduce API round-trips.
            // Each ElevenLabs call has ~500ms TTFA overhead, so we merge sentences
            // until we have ≥45 chars before firing TTS.
            let ttsMergeBuf = '';
            const MIN_TTS_CHARS = 45;

            // Fire accumulated text as TTS
            const _fireTTS = (text) => {
                if (!text || this._aborted) return;

                if (!ttsStarted) {
                    ttsStarted = true;
                    this.state = 'speaking';
                    this.emit('speaking', text);
                    console.log(`[⏱ LATENCY] Gemini→TTS first sentence: ${Date.now() - t0}ms since getAIResponse start`);
                }

                const capturedIsFirst = isFirstSentence;
                isFirstSentence = false;

                console.log(`[Orchestrator] → TTS: ${text.substring(0, 80)}`);

                ttsChain = ttsChain.then(async () => {
                    if (this._aborted) return;

                    if (capturedIsFirst) {
                        this.deepgram.clearBuffer();
                    }

                    try {
                        const ttsStart = Date.now();
                        let firstChunk = true;
                        const providerLabel = this.tts instanceof ChatterboxService ? 'Chatterbox' : 'ElevenLabs';
                        await this.tts.textToSpeechStream(
                            text,
                            this.agentConfig.voice,
                            (chunk) => {
                                if (firstChunk) {
                                    firstChunk = false;
                                    console.log(`[⏱ LATENCY] TTS first audio byte: ${Date.now() - ttsStart}ms (${providerLabel} TTFA)`);
                                    if (this._transcriptReceivedAt) {
                                        console.log(`[⏱ LATENCY] *** TOTAL E2E (transcript→first audio): ${Date.now() - this._transcriptReceivedAt}ms ***`);
                                    }
                                }
                                this.onAudioChunk(chunk);
                            }
                        );
                        console.log(`[⏱ LATENCY] TTS done: ${Date.now() - ttsStart}ms`);
                        if (!this._aborted) this.emit('audio_flush');
                    } catch (ttsError) {
                        if (!this._aborted) {
                            console.error('[Orchestrator] TTS error:', ttsError.message);
                        }
                    }
                });
            };

            // Enqueue a sentence — merges short sentences to avoid excess TTS round-trips
            const enqueueSentence = (sentence, force = false) => {
                sentence = sentence.trim();
                if (!sentence || this._aborted) return;

                const cleanText = stripMarkdown(sentence);
                if (!cleanText) return;

                // Accumulate in merge buffer
                ttsMergeBuf = ttsMergeBuf ? `${ttsMergeBuf} ${cleanText}` : cleanText;

                // Fire TTS when: buffer is long enough, OR forced (end of stream)
                if (force || ttsMergeBuf.length >= MIN_TTS_CHARS) {
                    _fireTTS(ttsMergeBuf);
                    ttsMergeBuf = '';
                }
            };

            // Split sentenceBuffer at natural sentence boundaries.
            // Uses split-based approach: finds punctuation followed by whitespace.
            // The last sentence (no trailing whitespace) is held in sentenceBuffer
            // and flushed after Gemini finishes.
            const extractSentences = () => {
                // Match punctuation + following whitespace (consume the whitespace as separator)
                const parts = sentenceBuffer.split(/(?<=[.!?।])\s+/);
                if (parts.length > 1) {
                    // All parts except the last are complete sentences
                    const completeSentences = parts.slice(0, -1);
                    sentenceBuffer = parts[parts.length - 1]; // remainder (may be partial)
                    for (const s of completeSentences) {
                        enqueueSentence(s);
                    }
                }
                // If length === 1, no boundary found yet — keep accumulating
            };

            // Stream from Gemini, detecting sentence boundaries in real-time
            await this.gemini.getResponse(userMessage, (chunk) => {
                if (!geminiFirstTokenAt) {
                    geminiFirstTokenAt = Date.now();
                    console.log(`[⏱ LATENCY] Gemini first token: ${geminiFirstTokenAt - t0}ms`);
                }
                fullResponse += chunk;
                sentenceBuffer += chunk;
                extractSentences();
            });
            console.log(`[⏱ LATENCY] Gemini total: ${Date.now() - t0}ms (response: ${fullResponse.length} chars)`);

            // CRITICAL: Check if call ended while Gemini was processing
            if (this._aborted) {
                return;
            }

            // Flush any remaining text (last sentence that had no trailing whitespace)
            if (sentenceBuffer.trim()) {
                enqueueSentence(sentenceBuffer, true); // force=true flushes merge buffer
                sentenceBuffer = '';
            }
            // Flush any merge buffer that didn't reach MIN_TTS_CHARS (short final response)
            if (ttsMergeBuf.trim()) {
                _fireTTS(ttsMergeBuf);
                ttsMergeBuf = '';
            }

            // If Gemini returned an empty response, handle gracefully
            if (!ttsStarted) {
                console.warn('[Orchestrator] Gemini returned empty response');
                this.emit('audio_flush');
                this.state = 'listening';
                this.startSilenceTimer();
                return;
            }

            // Add to conversation log
            this.conversationLog.push({
                role: 'assistant',
                content: fullResponse,
                timestamp: new Date()
            });

            // Check if Gemini wants to end the call
            const shouldEndCall = fullResponse.includes('[END_CALL]');
            if (shouldEndCall) {
                fullResponse = fullResponse.replace(/\[END_CALL\]/g, '').trim();
                console.log('[Orchestrator] Gemini requested call end via [END_CALL]');
            }

            this.emit('assistant_speech', fullResponse);

            // Wait for ALL enqueued TTS sentences to finish playing
            await ttsChain;

            if (this._aborted) {
                return;
            }

            // Final flush and transition to listening
            this.emit('audio_flush');
            this.state = 'listening';
            const totalTurn = Date.now() - t0;
            console.log(`[⏱ LATENCY] All speaking done. Turn total: ${totalTurn}ms`);
            this.startSilenceTimer();

            // If Gemini signaled end, hang up after all sentences are spoken
            if (shouldEndCall && !this._aborted) {
                console.log('[Orchestrator] Ending call as requested by AI');
                await this.delay(1000);
                this.end('ai_ended');
            }

        } catch (error) {
            if (this._aborted) {
                return;
            }
            console.error('[Orchestrator] Error getting AI response:', error);
            this.emit('error', error);

            // Graceful error recovery
            try {
                const errorMessage = 'Sorry, I encountered an issue. Could you please repeat that?';
                console.log('[Orchestrator] Speaking error recovery message');
                await this.speak(errorMessage);
            } catch (speakError) {
                console.error('[Orchestrator] Failed to speak error message:', speakError);
                this.end('error');
            }
        } finally {
            this._isThinking = false;
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

        // Strip Markdown formatting - asterisks, headers etc. create noise in TTS
        const cleanText = stripMarkdown(text);
        if (!cleanText) return;

        this.state = 'speaking';
        this.emit('speaking', cleanText);

        // Clear any pending transcripts to avoid processing stale audio
        this.deepgram.clearBuffer();

        console.log(`[Orchestrator] Speaking: ${cleanText}`);

        try {
            await this.tts.textToSpeechStream(
                cleanText,
                this.agentConfig.voice,
                (audioChunk) => this.onAudioChunk(audioChunk)
            );

            // Signal that TTS is done so any carry-buffer remainder gets flushed to RTP
            if (!this._aborted) {
                this.emit('audio_flush');
            }

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
        if (this._transcriptAccumTimer) {
            clearTimeout(this._transcriptAccumTimer);
        }

        // Close services
        if (this.deepgram) {
            this.deepgram.close();
        }
        if (this.tts) {
            this.tts.stop();
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
