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
 * Check if text is ONLY audio/emotion tags with no actual speakable content.
 * Tags like [exhales], [sighs], [pause] cause ElevenLabs 400 when sent alone.
 */
function isOnlyAudioTags(text) {
    const stripped = text
        .replace(/\[(?:exhales|sighs|gasps|clears throat|laughs|pause|short pause|long pause|friendly|excited|calm|confident|nervous|sorrowful|concerned|reassuring|whispers|speaking softly|loudly|rushed|slows down|stammers|drawn out|hesitates)\]/gi, '')
        .trim();
    return stripped.length === 0;
}

/**
 * Detect automated voicemail and IVR responses from transcripts.
 * Used to proactively hang up the call to save credits and agent time.
 */
const VOICEMAIL_KEYWORDS = [
    /record your message/i,
    /record your name/i,
    /stay on the line/i,
    /trying to reach is not available/i,
    /person you are calling/i,
    /please leave your message/i,
    /after the tone/i,
    /forwarded to an automatic/i,
    /is not answering/i,
    /number you have dialed/i,
    /subscriber you have dialed/i,
    /is currently busy/i,
    /out of coverage/i,
    /switched off/i,
    /not reachable/i,
    /leave a message/i,
    /voicemail/i
];

function isVoicemail(text) {
    return VOICEMAIL_KEYWORDS.some(regex => regex.test(text));
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
        if (!this.agentConfig.responseDelaySeconds) this.agentConfig.responseDelaySeconds = 0.05;

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
            transcriberLanguage: this.agentConfig.transcriber?.language,
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

            // Lock barge-in for the duration of the first message
            this._speakingFirstMessage = true;
            await this.speak(this.agentConfig.firstMessage);
            this._speakingFirstMessage = false;
            console.log('[Orchestrator] First message complete — barge-in now enabled');

            // ---------------------------------------------------------------
            // VOICEMAIL DETECTION
            // After speaking the first message, wait up to 8 seconds for the
            // human to respond (send back any audio). If we receive zero bytes
            // of inbound audio during that window, the call was forwarded to
            // voicemail (or an IVR picked up) and we should hang up immediately.
            // ---------------------------------------------------------------
            if (!this._aborted && !this._receivedCallerAudio) {
                console.log('[Orchestrator] Voicemail check: waiting up to 8s for caller audio...');
                this._voicemailTimer = setTimeout(() => {
                    if (!this._receivedCallerAudio && !this._aborted) {
                        console.log('[Orchestrator] ⚠️ No caller audio detected after first message — likely voicemail. Hanging up.');
                        this.end('voicemail');
                    }
                }, 8000);
            }
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

                // Barge-in: if user speaks while agent is speaking, stop and listen
                // BUT: never barge-in during the first greeting message
                if (this.state === 'speaking' && !this._bargeInTriggered && !this._speakingFirstMessage) {
                    this._bargeInTriggered = true;
                    console.log(`[Orchestrator] Barge-in detected! User interrupted — stopping speech to listen`);
                    // Stop TTS generation
                    if (this.tts) this.tts.stop();
                    // Signal SipMediaBridge to clear outgoing audio queue
                    this.emit('barge_in');
                    // Transition to listening
                    this.state = 'listening';
                } else if (this.state === 'speaking' && this._speakingFirstMessage) {
                    console.log(`[Orchestrator] Barge-in blocked — first message is protected`);
                }
            }
        );

        this.state = 'listening';
    }

    /**
     * Handle user speech - with accumulation buffer and thinking guard
     */
    async onUserSpeech(transcript) {
        if (this.state === 'ended' || this._aborted) return;

        // PROTECTED FIRST MESSAGE: discard any speech received during the greeting.
        // The user may speak, but we don't react until the first message is fully done.
        if (this._speakingFirstMessage) {
            console.log(`[Orchestrator] Ignoring user speech during first message (protected): "${transcript}"`);
            return;
        }

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

        // If Gemini is already thinking, queue the transcript and abort the stale response
        if (this._isThinking) {
            console.log(`[Orchestrator] Gemini busy, queueing transcript and aborting stale response`);
            if (!this._queuedTranscript) {
                this._queuedTranscript = transcript;
            } else {
                this._queuedTranscript += ' ' + transcript;
            }
            // Signal that the current response is stale and should be skipped
            this._abortCurrentResponse = true;
            // Stop any in-progress TTS for the stale response
            if (this.tts) {
                this.tts.stop();
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

        // Wait 0ms (next tick) — speech_final from Deepgram is already a complete utterance
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

            // Voicemail / IVR detection
            if (isVoicemail(fullTranscript)) {
                console.log(`[Orchestrator] ⚠️ Automated IVR/Voicemail detected from transcript: "${fullTranscript}". Hanging up.`);
                this.end('voicemail');
                return;
            }

            // Mark thinking EARLY — prevents a second timer from starting its own Gemini call
            // during the response delay below
            this._isThinking = true;

            // Apply configured response delay (skip entirely if 0 or very low)
            const delayMs = Math.round((this.agentConfig.responseDelaySeconds || 0) * 1000);
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
                // Combine original + queued into one full question so Gemini
                // gets the complete context instead of two fragmented messages
                const combinedTranscript = `${fullTranscript} ${queued}`;
                console.log(`[Orchestrator] Processing combined transcript (original + queued): ${combinedTranscript}`);
                this.conversationLog.push({
                    role: 'user',
                    content: combinedTranscript,
                    timestamp: new Date()
                });
                await this.getAIResponse(combinedTranscript);
            }
        }, 0);
    }

    /**
     * Get AI response and speak it — sentence-boundary streaming mode.
     * Gemini chunks are detected for sentence endings; each sentence is sent
     * to ElevenLabs TTS immediately, so audio starts playing while Gemini
     * is still generating the rest of the response.
     */
    async getAIResponse(userMessage) {
        if (this._aborted) return;

        this.clearSilenceTimer(); // Ensure we don't timeout while thinking or speaking
        this.state = 'thinking';
        this._isThinking = true;
        this._bargeInTriggered = false; // Reset barge-in flag for new response
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

            // Sequential chain of TTS playback promises — ensures sentences play in order
            // while Gemini generation and TTS requests overlap in parallel.
            let ttsChain = Promise.resolve();

            // TTS merge buffer: accumulate short sentences to reduce API round-trips.
            // Reduced to 12 chars to trigger initial speech even faster.
            let ttsMergeBuf = '';
            const MIN_TTS_CHARS = 12;

            // Fire accumulated text as TTS
            const _fireTTS = (text) => {
                if (!text || this._aborted || this._bargeInTriggered) return;

                if (!ttsStarted) {
                    ttsStarted = true;
                    this.state = 'speaking';
                    this.emit('speaking', text);
                    console.log(`[⏱ LATENCY] Gemini→TTS first sentence: ${Date.now() - t0}ms since getAIResponse start`);
                }

                const capturedIsFirst = isFirstSentence;
                isFirstSentence = false;

                console.log(`[Orchestrator] → TTS (parallel start): ${text.substring(0, 80)}`);

                // START TTS REQUEST IMMEDIATELY - DO NOT AWAIT
                // We buffer chunks locally until this sentence's turn in the playback chain
                const sentenceChunks = [];
                let streamDone = false;
                let activeOutputCallback = null;

                const providerLabel = this.tts instanceof ChatterboxService ? 'Chatterbox' : 'ElevenLabs';
                const langCode = (this.agentConfig.transcriber?.language || 'en').substring(0, 2).toLowerCase();
                const ttsStart = Date.now();

                // TTS background worker
                const ttsReqPromise = (async () => {
                    try {
                        let finalText = text;
                        if (langCode === 'hi' && this.tts instanceof ChatterboxService && /[a-zA-Z]/.test(finalText)) {
                            finalText = await this.gemini.transliterateToHindi(finalText);
                        }

                        let firstByteLogged = false;
                        await this.tts.textToSpeechStream(
                            finalText,
                            { ...this.agentConfig.voice, language: this.agentConfig.voice?.language || langCode },
                            (chunk) => {
                                if (!firstByteLogged) {
                                    firstByteLogged = true;
                                    console.log(`[⏱ LATENCY] TTS first audio byte: ${Date.now() - ttsStart}ms (${providerLabel} TTFA)`);
                                }

                                if (activeOutputCallback) {
                                    activeOutputCallback(chunk);
                                } else {
                                    sentenceChunks.push(chunk);
                                }
                            }
                        );
                        streamDone = true;
                        if (activeOutputCallback) activeOutputCallback(null); // Signal end to chain
                    } catch (err) {
                        console.error(`[Orchestrator] Parallel TTS error for "${text.substring(0, 20)}...":`, err.message);
                        streamDone = true;
                        if (activeOutputCallback) activeOutputCallback(null);
                    }
                })();

                // Link this sentence to the sequential playback chain
                ttsChain = ttsChain.then(async () => {
                    if (this._aborted || this._bargeInTriggered) return;

                    if (capturedIsFirst) {
                        this.deepgram.clearBuffer();
                    }

                    // 1. Drain already buffered chunks
                    while (sentenceChunks.length > 0) {
                        if (this._aborted || this._bargeInTriggered) break;
                        this.onAudioChunk(sentenceChunks.shift());
                    }

                    // 2. If TTS stream is still running, pipe incoming chunks directly to output
                    if (!streamDone && !this._aborted && !this._bargeInTriggered) {
                        await new Promise(resolve => {
                            activeOutputCallback = (chunk) => {
                                if (chunk === null) {
                                    resolve();
                                } else {
                                    if (!this._aborted && !this._bargeInTriggered) {
                                        this.onAudioChunk(chunk);
                                    }
                                }
                            };
                        });
                    }

                    console.log(`[⏱ LATENCY] Sentence playback delivered: ${text.substring(0, 30)}...`);
                    if (!this._aborted) this.emit('audio_flush');
                });
            };

            // Enqueue a sentence — merges short sentences to avoid excess TTS round-trips
            const enqueueSentence = (sentence, force = false) => {
                // Strip [END_CALL] before TTS to prevent saying it out loud
                sentence = sentence.replace(/\[END_CALL\]/g, '').trim();

                if (!sentence || this._aborted) return;

                const cleanText = stripMarkdown(sentence);
                if (!cleanText) return;

                // Skip standalone audio-only tags — they cause ElevenLabs 400 errors
                if (isOnlyAudioTags(cleanText)) {
                    console.log(`[Orchestrator] Skipping audio-only tag: ${cleanText}`);
                    return;
                }

                // Accumulate in merge buffer
                ttsMergeBuf = ttsMergeBuf ? `${ttsMergeBuf} ${cleanText}` : cleanText;

                // Fire TTS when: buffer is long enough, OR forced (end of stream),
                // OR if it's the FIRST sentence of the turn (Fast-Start bypass).
                if (force || ttsMergeBuf.length >= MIN_TTS_CHARS || isFirstSentence) {
                    _fireTTS(ttsMergeBuf);
                    ttsMergeBuf = '';
                }
            };

            // For Chatterbox, we want ONE request per message to avoid gaps between sentences.
            const isChatterbox = this.tts instanceof ChatterboxService;

            // Split sentenceBuffer at natural sentence boundaries.
            // Uses split-based approach: finds punctuation followed by whitespace.
            // The last sentence (no trailing whitespace) is held in sentenceBuffer
            // and flushed after Gemini finishes.
            const extractSentences = () => {
                if (isChatterbox) return; // For Chatterbox, accumulate entire response

                // Match punctuation + following whitespace OR end of string if very long
                // This ensures we don't wait too long for punctuation if the AI is verbose.
                const parts = sentenceBuffer.split(/(?<=[.!?।])\s+/);

                if (parts.length > 1) {
                    const completeSentences = parts.slice(0, -1);
                    sentenceBuffer = parts[parts.length - 1];
                    for (const s of completeSentences) {
                        enqueueSentence(s);
                    }
                } else if (sentenceBuffer.length > 120) {
                    // Safety split for very long segments without punctuation
                    const lastSpaceIndex = sentenceBuffer.lastIndexOf(' ');
                    if (lastSpaceIndex > 60) {
                        const s = sentenceBuffer.substring(0, lastSpaceIndex).trim();
                        sentenceBuffer = sentenceBuffer.substring(lastSpaceIndex).trim();
                        enqueueSentence(s);
                    }
                }
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

            // Check if a new transcript arrived while Gemini was thinking—
            // if so, this response is stale and should be skipped entirely.
            if (this._abortCurrentResponse) {
                console.log(`[Orchestrator] Aborting stale response — new user speech arrived during thinking`);
                this._abortCurrentResponse = false;
                this._isThinking = false;
                // Don't speak anything — the caller will process the queued transcript next
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

            // If Gemini returned an empty response, retry once with a nudge
            if (!ttsStarted) {
                console.warn('[Orchestrator] Gemini returned empty response — retrying with nudge...');
                // Don't fall silent — ask Gemini to continue naturally.
                // Use the same language as the agent's configured transcriber language.
                const lang = (this.agentConfig.transcriber?.language || 'en').substring(0, 2).toLowerCase();
                const nudge = lang === 'hi'
                    ? '[SYSTEM] User ne kuch kaha lekin response generate nahi hua. Conversation naturally continue karo.'
                    : '[SYSTEM] The user said something but no response was generated. Continue the conversation naturally.';
                try {
                    await this.getAIResponse(nudge);
                } catch (e) {
                    console.error('[Orchestrator] Nudge retry failed:', e.message);
                    this.emit('audio_flush');
                    this.state = 'listening';
                    this.startSilenceTimer();
                }
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

            // Wait for ALL enqueued TTS sentences to finish generating
            await ttsChain;

            if (this._aborted) {
                return;
            }

            // Final flush to push carry buffer to RTP
            this.emit('audio_flush');

            // Wait for actual audio playback to finish over SIP/RTP
            await new Promise(resolve => {
                let resolved = false;
                const finish = () => {
                    if (resolved) return;
                    resolved = true;
                    this.removeListener('playback_complete', onWaitEnd);
                    this.removeListener('user_speech', onWaitEnd);
                    clearTimeout(timeout);
                    resolve();
                };

                const onWaitEnd = () => finish();
                this.once('playback_complete', onWaitEnd);
                this.once('user_speech', onWaitEnd);

                // Safety timeout
                const timeout = setTimeout(() => finish(), 15000);
            });

            if (this._aborted) {
                return;
            }

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
            this._abortCurrentResponse = false;
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

        this.clearSilenceTimer(); // Pause timeout during speech

        // Strip Markdown formatting - asterisks, headers etc. create noise in TTS
        let cleanText = stripMarkdown(text);
        if (!cleanText) return;

        const langCode = (this.agentConfig.transcriber?.language || 'en').substring(0, 2).toLowerCase();

        // XTTS Chatterbox backend fails silently if Hindi text contains English characters.
        // We transliterate using Gemini on the fly if needed.
        if (langCode === 'hi' && this.tts instanceof ChatterboxService && /[a-zA-Z]/.test(cleanText)) {
            console.log('[Orchestrator] English characters detected in Hindi text, transliterating via Gemini...');
            cleanText = await this.gemini.transliterateToHindi(cleanText);
            console.log(`[Orchestrator] Transliterated to: ${cleanText}`);
        }

        this.state = 'speaking';
        this.emit('speaking', cleanText);

        // Clear any pending transcripts to avoid processing stale audio
        this.deepgram.clearBuffer();

        console.log(`[Orchestrator] Speaking: ${cleanText}`);

        try {
            await this.tts.textToSpeechStream(
                cleanText,
                { ...this.agentConfig.voice, language: this.agentConfig.voice?.language || langCode },
                (audioChunk) => this.onAudioChunk(audioChunk)
            );

            // Signal that TTS is done so any carry-buffer remainder gets flushed to RTP
            if (!this._aborted) {
                this.emit('audio_flush');
            }

            if (!this._aborted) {
                await new Promise(resolve => {
                    let resolved = false;
                    const finish = () => {
                        if (resolved) return;
                        resolved = true;
                        this.removeListener('playback_complete', onWaitEnd);
                        this.removeListener('user_speech', onWaitEnd);
                        clearTimeout(timeout);
                        resolve();
                    };
                    const onWaitEnd = () => finish();
                    this.once('playback_complete', onWaitEnd);
                    this.once('user_speech', onWaitEnd);
                    const timeout = setTimeout(() => finish(), 15000);
                });
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
        // Track that we received caller audio (used for voicemail detection)
        if (!this._receivedCallerAudio) {
            // Only count non-silent packets. RTP silence = 160 bytes of 0xFF (μ-law silence)
            // We check if at least some bytes differ from the silence value
            const isSilence = audioBuffer.every(b => b === 0xFF || b === 0x7F);
            if (!isSilence) {
                this._receivedCallerAudio = true;
                if (this._voicemailTimer) {
                    clearTimeout(this._voicemailTimer);
                    this._voicemailTimer = null;
                    console.log('[Orchestrator] Caller audio detected — voicemail timer cancelled');
                }
            }
        }

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

        // Clear voicemail detection timer
        if (this._voicemailTimer) {
            clearTimeout(this._voicemailTimer);
            this._voicemailTimer = null;
        }

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
