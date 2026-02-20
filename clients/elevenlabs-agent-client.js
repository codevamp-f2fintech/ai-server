// ElevenLabs Conversational AI Agent Client
// Handles all interactions with ElevenLabs API for agent and phone number management

const axios = require('axios');

const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io';

class ElevenLabsAgentClient {
    constructor(apiKey) {
        if (!apiKey) {
            throw new Error('ElevenLabs API key is required');
        }
        this.apiKey = apiKey;
        this.client = axios.create({
            baseURL: ELEVENLABS_BASE_URL,
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json'
            }
        });
    }

    // ==================== AGENT METHODS ====================

    /**
     * Create a new conversational AI agent
     * @param {Object} config - Agent configuration
     * @returns {Promise<Object>} Created agent data with agent_id
     */
    async createAgent(config) {
        try {
            console.log('Creating ElevenLabs agent with config:', JSON.stringify(config, null, 2));

            const payload = {
                conversation_config: config.conversation_config,
                platform_settings: config.platform_settings || {},
                name: config.name || 'Unnamed Agent',
                tags: config.tags || []
            };

            const response = await this.client.post('/v1/convai/agents/create', payload);
            console.log('Agent created successfully:', response.data.agent_id);
            return response.data;
        } catch (error) {
            console.error('Error creating ElevenLabs agent:', error.response?.data || error.message);
            throw new Error(error.response?.data?.detail?.message || 'Failed to create agent');
        }
    }

    /**
     * Get a specific agent by ID
     * @param {string} agentId - Agent ID
     * @returns {Promise<Object>} Agent details
     */
    async getAgent(agentId) {
        try {
            const response = await this.client.get(`/v1/convai/agents/${agentId}`);
            return response.data;
        } catch (error) {
            console.error('Error getting ElevenLabs agent:', error.response?.data || error.message);
            throw new Error('Failed to get agent');
        }
    }

    /**
     * List all agents
     * @returns {Promise<Array>} List of agents
     */
    async listAgents() {
        try {
            console.log('Fetching agents from ElevenLabs API...');
            const response = await this.client.get('/v1/convai/agents');
            console.log('ElevenLabs API Response Status:', response.status);
            console.log('ElevenLabs API Response Data:', JSON.stringify(response.data, null, 2));

            // The API might return agents in different structures
            // Try to extract the agents array
            const agents = response.data.agents || response.data || [];
            console.log(`Found ${agents.length} agents from ElevenLabs`);

            return agents;
        } catch (error) {
            console.error('Error listing ElevenLabs agents:', error.response?.data || error.message);
            console.error('Full error:', error);
            throw new Error('Failed to list agents');
        }
    }

    /**
     * Update an existing agent
     * @param {string} agentId - Agent ID
     * @param {Object} config - Updated configuration
     * @returns {Promise<Object>} Updated agent data
     */
    async updateAgent(agentId, config) {
        try {
            console.log('Updating ElevenLabs agent:', agentId);

            const payload = {
                conversation_config: config.conversation_config,
                platform_settings: config.platform_settings,
                name: config.name,
                tags: config.tags
            };

            // Remove undefined fields
            Object.keys(payload).forEach(key => {
                if (payload[key] === undefined) {
                    delete payload[key];
                }
            });

            const response = await this.client.patch(`/v1/convai/agents/${agentId}`, payload);
            console.log('Agent updated successfully');
            return response.data;
        } catch (error) {
            console.error('Error updating ElevenLabs agent:', error.response?.data || error.message);
            throw new Error('Failed to update agent');
        }
    }

    /**
     * Delete an agent
     * @param {string} agentId - Agent ID
     * @returns {Promise<Object>} Deletion confirmation
     */
    async deleteAgent(agentId) {
        try {
            console.log('Deleting ElevenLabs agent:', agentId);
            const response = await this.client.delete(`/v1/convai/agents/${agentId}`);
            console.log('Agent deleted successfully');
            return response.data;
        } catch (error) {
            console.error('Error deleting ElevenLabs agent:', error.response?.data || error.message);
            throw new Error('Failed to delete agent');
        }
    }

    // ==================== PHONE NUMBER METHODS ====================

    /**
     * Get all phone numbers associated with the account
     * @returns {Promise<Array>} List of phone numbers
     */
    async getPhoneNumbers() {
        try {
            const response = await this.client.get('/v1/convai/phone-numbers');
            return response.data;
        } catch (error) {
            console.error('Error getting phone numbers:', error.response?.data || error.message);
            throw new Error('Failed to get phone numbers');
        }
    }

    /**
     * Add a phone number (Twilio or other provider)
     * @param {Object} phoneConfig - Phone number configuration
     * @returns {Promise<Object>} Added phone number data
     */
    async addPhoneNumber(phoneConfig) {
        try {
            console.log('Adding phone number to ElevenLabs:', phoneConfig.number || phoneConfig.phone_number);

            const payload = {
                phone_number: phoneConfig.phone_number || phoneConfig.number,
                twilioAccountSid: phoneConfig.twilioAccountSid,
                twilioAuthToken: phoneConfig.twilioAuthToken,
                name: phoneConfig.name,
                agent_id: phoneConfig.agent_id || null
            };

            const response = await this.client.post('/v1/convai/phone-numbers/add', payload);
            console.log('Phone number added successfully');
            return response.data;
        } catch (error) {
            console.error('Error adding phone number:', error.response?.data || error.message);
            throw new Error(error.response?.data?.detail?.message || 'Failed to add phone number');
        }
    }

    /**
     * Update phone number configuration (e.g., assign to agent)
     * @param {string} phoneNumberId - Phone number ID
     * @param {Object} updates - Phone number updates
     * @returns {Promise<Object>} Updated phone number data
     */
    async updatePhoneNumber(phoneNumberId, updates) {
        try {
            console.log('Updating phone number:', phoneNumberId);
            const response = await this.client.patch(`/v1/convai/phone-numbers/${phoneNumberId}`, updates);
            return response.data;
        } catch (error) {
            console.error('Error updating phone number:', error.response?.data || error.message);
            throw new Error('Failed to update phone number');
        }
    }

    /**
     * Delete a phone number
     * @param {string} phoneNumberId - Phone number ID
     * @returns {Promise<Object>} Deletion confirmation
     */
    async deletePhoneNumber(phoneNumberId) {
        try {
            console.log('Deleting phone number:', phoneNumberId);
            const response = await this.client.delete(`/v1/convai/phone-numbers/${phoneNumberId}`);
            console.log('Phone number deleted successfully');
            return response.data;
        } catch (error) {
            console.error('Error deleting phone number:', error.response?.data || error.message);
            throw new Error('Failed to delete phone number');
        }
    }

    // ==================== CONVERSATION/CALL METHODS ====================

    /**
     * Initiate an outbound call via Twilio integration
     * @param {string} agentId - Agent ID to use for the call
     * @param {string} phoneNumber - Phone number to call (E.164 format)
     * @param {string} agentPhoneNumberId - ElevenLabs phone number ID (from Twilio integration)
     * @returns {Promise<Object>} Call initiation data
     */
    async initiateOutboundCall(agentId, phoneNumber, agentPhoneNumberId, variables) {
        try {
            console.log(`Initiating outbound call with agent ${agentId} to ${phoneNumber}`);
            console.log(`Using phone number ID: ${agentPhoneNumberId}`);

            const payload = {
                agent_id: agentId,
                to_number: phoneNumber,
                agent_phone_number_id: agentPhoneNumberId
            };

            // Add dynamic variables if provided
            if (variables && Object.keys(variables).length > 0) {
                console.log('Adding dynamic variables:', JSON.stringify(variables));
                payload.conversation_config_override = {
                    agent: {
                        prompt: {
                            variables: variables
                        }
                    }
                };
            }

            const response = await this.client.post('/v1/convai/twilio/outbound-call', payload);

            console.log('Outbound call initiated successfully');
            console.log('Response:', JSON.stringify(response.data, null, 2));
            return response.data;
        } catch (error) {
            console.error('Error initiating outbound call:', error.response?.data || error.message);
            throw new Error(error.response?.data?.detail?.message || error.response?.data?.detail || 'Failed to initiate call');
        }
    }

    /**
     * Get conversation details including transcript
     * @param {string} conversationId - Conversation ID
     * @returns {Promise<Object>} Conversation details with transcript
     */
    async getConversationDetails(conversationId) {
        try {
            console.log(`Fetching conversation details for: ${conversationId}`);
            const response = await this.client.get(`/v1/convai/conversations/${conversationId}`);
            console.log('Conversation details fetched successfully');
            return response.data;
        } catch (error) {
            console.error('Error fetching conversation details:', error.response?.data || error.message);
            throw new Error(error.response?.data?.detail?.message || 'Failed to fetch conversation details');
        }
    }

    // ==================== CONFIG HELPERS ====================

    /**
     * Get a default configuration schema for creating agents
     * @returns {Object} Default agent configuration
     */
    getConfigSchema() {
        return {
            name: 'New Agent',
            conversation_config: {
                agent: {
                    prompt: {
                        prompt: 'You are a helpful AI assistant.'
                    },
                    first_message: 'Hello! How can I help you today?',
                    language: 'en' // 'en', 'hi', 'hi-Latn' for Hinglish
                },
                tts: {
                    voice_id: '21m00Tcm4TlvDq8ikWAM', // Rachel (default)
                    model_id: 'eleven_multilingual_v3', // v3 Conversational
                    optimize_streaming_latency: 3, // 0-4, recommended: 3
                    output_format: 'pcm_16000' // Recommended for telephony
                },
                asr: {
                    quality: 'high', // 'high' or 'low'
                    user_input_audio_format: 'pcm_16000'
                }
            },
            platform_settings: {
                platform: 'web' // 'web', 'widget', 'webrtc'
            },
            tags: []
        };
    }

    /**
     * Validate agent configuration
     * @param {Object} config - Configuration to validate
     * @returns {Object} Validation result with valid flag and errors array
     */
    validateConfig(config) {
        const errors = [];

        // Check conversation_config exists
        if (!config.conversation_config) {
            errors.push('conversation_config is required');
            return { valid: false, errors };
        }

        // Check agent prompt
        if (!config.conversation_config.agent?.prompt?.prompt) {
            errors.push('Agent prompt is required');
        }

        // Check first message
        if (!config.conversation_config.agent?.first_message) {
            errors.push('First message is required');
        }

        // Check TTS voice
        if (!config.conversation_config.tts?.voice_id) {
            errors.push('TTS voice_id is required');
        }

        // Check TTS model
        if (!config.conversation_config.tts?.model_id) {
            errors.push('TTS model_id is required');
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }
}

module.exports = ElevenLabsAgentClient;
