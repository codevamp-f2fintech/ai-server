// Gemini AI Service - LLM Integration
// Handles conversation with Google Gemini AI

const { GoogleGenerativeAI } = require("@google/generative-ai");
const https = require('https');
const http = require('http');

/**
 * Fetch a file from a URL and return it as a Buffer
 */
function fetchBuffer(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        client.get(url, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

class GeminiService {
    constructor(apiKey) {
        if (!apiKey) {
            throw new Error('Gemini API key is required');
        }
        this.genAI = new GoogleGenerativeAI(apiKey);
        this.conversationHistory = [];
    }

    /**
     * Initialize conversation with agent configuration
     * @param {Object} config - Model configuration from agent
     * @returns {Promise<void>}
     */
    async initializeConversation(config) {
        // Ensure config exists
        config = config || {};

        // Get system prompt from messages array (if exists)
        const messages = config.messages || [];
        const systemMessage = messages.find(m => m.role === 'system');
        let systemPrompt = systemMessage?.content || config.systemPrompt || 'You are a helpful assistant.';

        // Inject knowledge base into system prompt
        const knowledgeBase = config.knowledgeBase || [];
        console.log(`[Gemini] KB entries: ${knowledgeBase.length}`);

        if (knowledgeBase.length > 0) {
            // For each KB file: use stored text, or fetch from S3 if empty
            const resolvedKB = await Promise.all(knowledgeBase.map(async (f) => {
                if (f.text && f.text.trim().length > 0) {
                    console.log(`[Gemini] KB '${f.name}': using stored text (${f.text.length} chars)`);
                    return { ...f };
                }

                // text is empty — attempt S3 fetch
                if (f.s3Url) {
                    console.log(`[Gemini] KB '${f.name}': text is empty, fetching from S3: ${f.s3Url}`);
                    try {
                        const buffer = await fetchBuffer(f.s3Url);
                        const ext = (f.name || '').split('.').pop().toLowerCase();
                        let text = '';
                        if (ext === 'pdf') {
                            const { PDFParse } = require('pdf-parse');
                            const parser = new PDFParse({ data: new Uint8Array(buffer) });
                            const parsed = await parser.getText();
                            text = parsed.text || '';
                            await parser.destroy();
                        } else {
                            text = buffer.toString('utf-8');
                        }
                        console.log(`[Gemini] KB '${f.name}': fetched from S3, extracted ${text.length} chars`);
                        return { ...f, text };
                    } catch (err) {
                        console.error(`[Gemini] KB '${f.name}': S3 fetch/parse failed:`, err.message);
                        return { ...f, text: '' };
                    }
                }

                console.warn(`[Gemini] KB '${f.name}': text is empty and no s3Url — skipping`);
                return { ...f };
            }));

            const kbText = resolvedKB
                .filter(f => f.text && f.text.trim().length > 0)
                .map(f => `--- ${f.name} ---\n${f.text.trim()}`)
                .join('\n\n');

            if (kbText) {
                systemPrompt += `\n\n[KNOWLEDGE BASE - Use this information to answer questions accurately]\n${kbText}`;
                console.log(`[Gemini] ✅ Injected ${resolvedKB.filter(f => f.text?.trim()).length} KB file(s) into system prompt (${kbText.length} chars)`);
            } else {
                console.warn(`[Gemini] ⚠️ KB present (${knowledgeBase.length} file(s)) but all text is empty — KB NOT injected`);
            }
        }

        // Map model name (OpenAI style to Gemini style)
        // Using gemini-2.5-flash as default (confirmed working)
        let modelName = 'gemini-2.5-flash';

        // Convert OpenAI model names to Gemini equivalents
        const modelMapping = {
            'gpt-4o-mini': 'gemini-2.5-flash',
            'gpt-4o': 'gemini-2.5-flash',
            'gpt-4': 'gemini-2.5-flash',
            'gpt-3.5-turbo': 'gemini-2.5-flash',
            'gemini-1.5-flash': 'gemini-2.5-flash',
            'gemini-1.5-pro': 'gemini-2.5-flash',
            'gemini-2.0-flash-exp': 'gemini-2.5-flash',
            'gemini-1.5-pro-latest': 'gemini-2.5-flash',
            'gemini-1.5-flash-latest': 'gemini-2.5-flash',
            'gemini-pro': 'gemini-2.5-flash'
        };

        if (config.model && modelMapping[config.model]) {
            modelName = modelMapping[config.model];
        }

        console.log(`[Gemini] Using model: ${modelName}`);

        // If firstMessage was already spoken, append it to the system prompt
        // so Gemini knows what it already said and won't repeat the introduction
        if (config.firstMessage) {
            systemPrompt += `\n\n[HARD RULE - DO NOT BREAK]\nYou have ALREADY spoken your opening message to the customer: "${config.firstMessage}"\n\nCRITICAL RULES (NEVER violate these):\n1. NEVER say your name (Priya or any name) again — you already introduced yourself.\n2. NEVER say the company name (F2 Fintech or any company name) as an introduction — you already did this.\n3. NEVER say "मैं [name] बोल रही/रहा हूँ" or any variation of this — you already said it.\n4. NEVER say "हम [company] से हैं" or any variation — already said.\n5. Infer the customer's gender from their name and use "Sir" or "Ma'am" accordingly. If unsure, default to "Sir". Never say "Sir/Ma'am" together.\n6. Jump straight into the conversation from where the opening message left off. Treat the conversation as already in progress.`;
            console.log('[Gemini] Anti-reintroduction HARD RULE appended to system prompt');
        }

        // Enforce Devanagari script if language is Hindi
        const langCode = (config.transcriberLanguage || 'en').substring(0, 2).toLowerCase();
        if (langCode === 'hi') {
            systemPrompt += `\n\n[LANGUAGE REQUIREMENT]\nYou must write ALL your responses ENTIRELY in Devanagari script (Hindi script). Do NOT use any English letters (A-Z) in your response, even for English words or names. Transliterate all English words into Devanagari. For example, instead of "Education", write "एजुकेशन". This is critical for the text-to-speech engine.`;
            console.log('[Gemini] Enforcing Devanagari script for Hindi language');
        }

        // Add latency-optimization prompt
        systemPrompt += `\n\n[CONVERSATIONAL STYLE - CRITICAL FOR LOW LATENCY]\n- Keep sentences short, punchy, and direct.\n- Use simple, natural language as if speaking on the phone.\n- Avoid long, complex explanations. Aim for 1-2 short sentences per turn unless a longer explanation is explicitly requested.\n- Always end with a short, easy-to-answer follow-up question to keep the lead engaged.`;

        // Add call end instruction
        systemPrompt += `\n\n[ENDING THE CALL]\nWhen the conversation is naturally finished (e.g., after saying goodbye, or if the user is completely uninterested and wants to hang up), you MUST include the exact string "[END_CALL]" at the very end of your response to remotely cut the call.`;

        console.log('[Gemini] Latency-optimization and call ending prompts added');

        // Determine output token limit (Devanagari uses ~3-4x more tokens than English)
        const maxOutputTokens = config.maxTokens || 2048;

        // Initialize model
        // IMPORTANT: Disable thinking for Gemini 2.5 Flash — thinking tokens consume
        // the maxOutputTokens budget, causing mid-sentence truncation and 5s+ latency.
        // A phone call agent needs fast, simple responses, not deep reasoning.
        this.model = this.genAI.getGenerativeModel({
            model: modelName,
            generationConfig: {
                temperature: config.temperature || 0.7,
                maxOutputTokens,
                topP: 0.95,
                topK: 40,
                thinkingConfig: {
                    thinkingBudget: 0  // Disable thinking entirely
                }
            },
            systemInstruction: systemPrompt
        });

        // Store model config for rebuilding chat sessions
        this._modelConfig = { temperature: config.temperature || 0.7, maxOutputTokens };

        this.conversationHistory = [];
        if (config.firstMessage) {
            this.conversationHistory.push({ role: 'assistant', content: config.firstMessage });
        }

        // Start chat session — will be rebuilt each turn with capped history
        this.chat = this._buildChat([]);
        console.log('[Gemini] Conversation initialized');
    }

    _buildChat(history) {
        // Convert our flat history into Gemini SDK format {role, parts:[{text}]}
        // The Gemini SDK strictly requires history to alternate and ALWAYS start with 'user'.
        // We filter the history to enforce this strict alternating pattern automatically.
        const geminiHistory = [];
        let expectedRole = 'user';

        for (const msg of history) {
            const mappedRole = msg.role === 'assistant' ? 'model' : 'user';
            // Only add if it matches the expected alternating sequence
            if (mappedRole === expectedRole) {
                geminiHistory.push({
                    role: mappedRole,
                    parts: [{ text: msg.content }]
                });
                expectedRole = expectedRole === 'user' ? 'model' : 'user';
            }
        }

        // Before sending a new user message, history MUST end with a 'model' turn (or be empty).
        // If it ends with 'user', it means an orphaned turn exists, so we drop it.
        if (geminiHistory.length > 0 && geminiHistory[geminiHistory.length - 1].role === 'user') {
            geminiHistory.pop();
        }

        return this.model.startChat({
            history: geminiHistory,
            generationConfig: {
                temperature: this._modelConfig.temperature,
                maxOutputTokens: this._modelConfig.maxOutputTokens,
                thinkingConfig: { thinkingBudget: 0 }
            }
        });
    }

    /**
     * Get response from Gemini (streaming)
     * @param {string} userMessage - User's message
     * @param {Function} onChunk - Callback for each text chunk
     * @returns {Promise<string>} - Complete response
     */
    async getResponse(userMessage, onChunk = null) {
        try {
            console.log(`[Gemini] User: ${userMessage}`);

            // Add user message to history BEFORE building the chat so the
            // window includes the current turn's context
            this.conversationHistory.push({
                role: 'user',
                content: userMessage
            });

            // --- HISTORY CAP ---
            // Keep only the last 6 messages (3 turns) to prevent input token
            // growth from slowing down TTFT as the conversation progresses.
            const MAX_HISTORY = 6;
            const windowHistory = this.conversationHistory.slice(-MAX_HISTORY - 1, -1); // everything except the just-pushed user msg
            console.log(`[Gemini] History window: ${windowHistory.length}/${this.conversationHistory.length - 1} messages sent to API`);

            // Rebuild chat with capped history, then send the new user message
            this.chat = this._buildChat(windowHistory);
            const result = await this.chat.sendMessageStream(userMessage);

            let fullResponse = '';

            // Process stream
            for await (const chunk of result.stream) {
                const chunkText = chunk.text();
                fullResponse += chunkText;

                // Call chunk callback for real-time streaming to TTS
                if (onChunk && chunkText) {
                    onChunk(chunkText);
                }
            }

            // Add assistant response to history
            this.conversationHistory.push({
                role: 'assistant',
                content: fullResponse
            });

            console.log(`[Gemini] Assistant: ${fullResponse}`);
            return fullResponse;

        } catch (error) {
            console.error('[Gemini] Error:', error);
            throw new Error(`Gemini API error: ${error.message}`);
        }
    }

    /**
     * Get non-streaming response (for simple use cases)
     * @param {string} userMessage - User's message
     * @returns {Promise<string>} - Complete response
     */
    async getResponseSync(userMessage) {
        try {
            const result = await this.chat.sendMessage(userMessage);
            const response = result.response.text();

            this.conversationHistory.push(
                { role: 'user', content: userMessage },
                { role: 'assistant', content: response }
            );

            return response;
        } catch (error) {
            console.error('[Gemini] Error:', error);
            throw error;
        }
    }

    /**
     * Get conversation history
     * @returns {Array} - Conversation messages
     */
    getHistory() {
        return this.conversationHistory;
    }

    /**
     * Pre-warm the Gemini connection by sending a minimal dummy request.
     * Call this in parallel while TTS is playing the first message.
     * This triggers implicit caching of the system prompt on Google's side,
     * so when the real user reply arrives, TTFT is significantly lower.
     * Fire-and-forget — never awaited by the caller.
     */
    async warmUp() {
        try {
            const t0 = Date.now();
            console.log('[Gemini] 🔥 Warming up connection (parallel with first message TTS)...');
            const warmupChat = this._buildChat([]);
            // Send a minimal internal signal — Gemini processes the full system
            // prompt + KB, establishing the implicit cache for the real turn.
            await warmupChat.sendMessage('[SYSTEM_WARMUP]');
            console.log(`[Gemini] ✅ Warm-up complete in ${Date.now() - t0}ms — next turn will be faster`);
        } catch (e) {
            // Best-effort: warm-up failure must never affect the live call
            console.warn('[Gemini] Warm-up skipped (non-fatal):', e.message);
        }
    }

    /**
     * Transliterate text to Devanagari script
     * @param {string} text - Text to transliterate
     * @returns {Promise<string>} - Transliterated text
     */
    async transliterateToHindi(text) {
        if (!text || !/[a-zA-Z]/.test(text)) return text;
        try {
            const prompt = `Transliterate the following text entirely into Devanagari script (Hindi). Keep the exact same meaning and phrasing, just write the English names/words in Devanagari. Return ONLY the transliterated text without any quotes or extra explanation:\n\n${text}`;
            const result = await this.model.generateContent(prompt);
            return result.response.text().trim();
        } catch (error) {
            console.error('[Gemini] Transliteration error:', error);
            return text; // fallback
        }
    }

    /**
     * Clear conversation history and start fresh
     * @param {Object} config - Model configuration
     */
    resetConversation(config) {
        this.initializeConversation(config);
    }

    /**
     * Check if conversation is too long and summarize if needed
     * @param {number} maxMessages - Maximum messages before summarization
     */
    async checkAndSummarize(maxMessages = 20) {
        if (this.conversationHistory.length > maxMessages) {
            console.log('[Gemini] Conversation too long, summarizing...');

            // Get summary of conversation so far
            const summaryPrompt = "Summarize our conversation so far in 2-3 sentences, focusing on key points and decisions.";
            const summary = await this.getResponseSync(summaryPrompt);

            // Keep only recent messages and summary
            const recentMessages = this.conversationHistory.slice(-5);
            this.conversationHistory = [
                { role: 'assistant', content: `Previous conversation summary: ${summary}` },
                ...recentMessages
            ];

            console.log('[Gemini] Conversation summarized');
        }
    }

    /**
     * Analyze full conversation to extract Lead Type, Profile, and Status
     * @param {Array} history - Full conversation history
     * @returns {Promise<Object>} - { leadType, leadProfile, status, summary }
     */
    async analyzeConversation(history) {
        try {
            if (!history || history.length === 0) {
                return { leadType: 'Cold', leadProfile: 'Unknown', status: 'Failed', summary: 'No conversation' };
            }

            const transcript = history.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
            const prompt = `
                Analyze the following phone conversation transcript between an AI Agent and a Customer.
                Extract the following information in JSON format:
                1. "leadType": Categorize as "Hot" (very interested/ready), "Warm" (interested but has questions/needs follow-up), or "Cold" (not interested/wrong number).
                2. "leadProfile": Identify the customer's profession, role, or key demographic mentioned (e.g. "Doctor", "Business Owner", "Student", "Homeowner"). If unknown, use "Unknown".
                3. "statusClassification": One-word status like "Interested", "Not Interested", "Follow-up", "Busy", "Disconnected".
                4. "summary": A brief 1-sentence summary of the call.

                Transcript:
                ${transcript}

                Return ONLY the JSON object.
            `;

            const result = await this.model.generateContent(prompt);
            const responseText = result.response.text().trim();

            // Clean JSON response (handle markdown blocks if any)
            const jsonStr = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(jsonStr);
        } catch (error) {
            console.error('[Gemini] Analysis error:', error);
            return {
                leadType: 'Unknown',
                leadProfile: 'Unknown',
                statusClassification: 'Error',
                summary: 'Analysis failed'
            };
        }
    }
}

module.exports = GeminiService;
