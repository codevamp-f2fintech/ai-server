// Gemini AI Service - LLM Integration
// Handles conversation with Google Gemini AI

const { GoogleGenerativeAI } = require("@google/generative-ai");

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
     */
    initializeConversation(config) {
        // Ensure config exists
        config = config || {};

        // Get system prompt from messages array (if exists)
        const messages = config.messages || [];
        const systemMessage = messages.find(m => m.role === 'system');
        const systemPrompt = systemMessage?.content || config.systemPrompt || 'You are a helpful assistant.';

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

        // Initialize model
        this.model = this.genAI.getGenerativeModel({
            model: modelName,
            generationConfig: {
                temperature: config.temperature || 0.7,
                maxOutputTokens: config.maxTokens || 500,
                topP: 0.95,
                topK: 40
            },
            systemInstruction: systemPrompt
        });

        // Start chat session
        this.chat = this.model.startChat({
            history: [],
            generationConfig: {
                temperature: config.temperature || 0.7,
                maxOutputTokens: config.maxTokens || 500
            }
        });

        this.conversationHistory = [];
        console.log('[Gemini] Conversation initialized');
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

            // Add user message to history
            this.conversationHistory.push({
                role: 'user',
                content: userMessage
            });

            // Send message and get streaming response
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
}

module.exports = GeminiService;
