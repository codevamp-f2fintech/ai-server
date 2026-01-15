// VAPI Client Module
// Handles all interactions with VAPI API for assistant/agent management

const axios = require('axios');

const VAPI_BASE_URL = 'https://api.vapi.ai';

class VapiClient {
  constructor(apiKey) {
    if (!apiKey) {
      throw new Error('VAPI API key is required');
    }
    this.apiKey = apiKey;
    this.client = axios.create({
      baseURL: VAPI_BASE_URL,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });
  }

  // ==================== ASSISTANT METHODS ====================

  async createAssistant(config) {
    try {
      console.log('Creating VAPI assistant with config:', JSON.stringify(config, null, 2));
      const response = await this.client.post('/assistant', config);
      console.log('Assistant created successfully:', response.data.id);
      return response.data;
    } catch (error) {
      console.error('Error creating VAPI assistant:', error.response?.data || error.message);
      throw new Error(error.response?.data?.message || 'Failed to create assistant');
    }
  }

  async listAssistants(params = {}) {
    try {
      const response = await this.client.get('/assistant', { params });
      return response.data;
    } catch (error) {
      console.error('Error listing VAPI assistants:', error.response?.data || error.message);
      throw new Error('Failed to list assistants');
    }
  }

  async getAssistant(assistantId) {
    try {
      const response = await this.client.get(`/assistant/${assistantId}`);
      return response.data;
    } catch (error) {
      console.error('Error getting VAPI assistant:', error.response?.data || error.message);
      throw new Error('Failed to get assistant');
    }
  }

  async updateAssistant(assistantId, config) {
    try {
      console.log('Updating VAPI assistant:', assistantId);
      const response = await this.client.patch(`/assistant/${assistantId}`, config);
      console.log('Assistant updated successfully');
      return response.data;
    } catch (error) {
      console.error('Error updating VAPI assistant:', error.response?.data || error.message);
      throw new Error('Failed to update assistant');
    }
  }

  async deleteAssistant(assistantId) {
    try {
      console.log('Deleting VAPI assistant:', assistantId);
      const response = await this.client.delete(`/assistant/${assistantId}`);
      console.log('Assistant deleted successfully');
      return response.data;
    } catch (error) {
      console.error('Error deleting VAPI assistant:', error.response?.data || error.message);
      throw new Error('Failed to delete assistant');
    }
  }

  // ==================== PHONE NUMBER METHODS ====================

  async listPhoneNumbers() {
    try {
      const response = await this.client.get('/phone-number');
      return response.data;
    } catch (error) {
      console.error('Error listing phone numbers:', error.response?.data || error.message);
      throw new Error('Failed to list phone numbers');
    }
  }

  async getPhoneNumber(phoneNumberId) {
    try {
      const response = await this.client.get(`/phone-number/${phoneNumberId}`);
      return response.data;
    } catch (error) {
      console.error('Error getting phone number:', error.response?.data || error.message);
      throw new Error('Failed to get phone number');
    }
  }

  async createPhoneNumber(config) {
    try {
      console.log('Creating phone number:', config.name || config.number);
      const response = await this.client.post('/phone-number', config);
      console.log('Phone number created:', response.data.id);
      return response.data;
    } catch (error) {
      console.error('Error creating phone number:', error.response?.data || error.message);
      throw new Error(error.response?.data?.message || 'Failed to create phone number');
    }
  }

  async updatePhoneNumber(phoneNumberId, config) {
    try {
      console.log('Updating phone number:', phoneNumberId);
      const response = await this.client.patch(`/phone-number/${phoneNumberId}`, config);
      return response.data;
    } catch (error) {
      console.error('Error updating phone number:', error.response?.data || error.message);
      throw new Error('Failed to update phone number');
    }
  }

  async deletePhoneNumber(phoneNumberId) {
    try {
      console.log('Deleting phone number:', phoneNumberId);
      const response = await this.client.delete(`/phone-number/${phoneNumberId}`);
      return response.data;
    } catch (error) {
      console.error('Error deleting phone number:', error.response?.data || error.message);
      throw new Error('Failed to delete phone number');
    }
  }

  // ==================== CREDENTIAL METHODS (for SIP Trunk) ====================

  async listCredentials() {
    try {
      const response = await this.client.get('/credential');
      return response.data;
    } catch (error) {
      console.error('Error listing credentials:', error.response?.data || error.message);
      throw new Error('Failed to list credentials');
    }
  }

  async createCredential(config) {
    try {
      console.log('Creating credential:', config.name);
      const response = await this.client.post('/credential', config);
      console.log('Credential created:', response.data.id);
      return response.data;
    } catch (error) {
      console.error('Error creating credential:', error.response?.data || error.message);
      throw new Error(error.response?.data?.message || 'Failed to create credential');
    }
  }

  async deleteCredential(credentialId) {
    try {
      console.log('Deleting credential:', credentialId);
      const response = await this.client.delete(`/credential/${credentialId}`);
      return response.data;
    } catch (error) {
      console.error('Error deleting credential:', error.response?.data || error.message);
      throw new Error('Failed to delete credential');
    }
  }

  // ==================== CONFIG HELPERS ====================

  getConfigSchema() {
    return {
      name: '',
      model: {
        provider: 'openai',
        model: 'gpt-4',
        messages: [{ role: 'system', content: 'You are a helpful assistant.' }],
        temperature: 0.7,
        maxTokens: 500
      },
      voice: {
        provider: '11labs',
        voiceId: '21m00Tcm4TlvDq8ikWAM'
      },
      transcriber: {
        provider: 'deepgram',
        model: 'nova-2',
        language: 'en'
      },
      firstMessage: 'Hello! How can I help you today?',
      firstMessageMode: 'assistant-speaks-first'
    };
  }

  validateConfig(config) {
    const errors = [];
    if (!config.model || !config.model.provider) errors.push('Model provider is required');
    if (!config.model || !config.model.model) errors.push('Model name is required');
    if (!config.voice || !config.voice.provider) errors.push('Voice provider is required');
    return { valid: errors.length === 0, errors };
  }
}

module.exports = VapiClient;
