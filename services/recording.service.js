// Recording Service
// Records call audio streams and uploads to AWS S3
// Captures both caller and agent audio, merges them, and stores as MP3

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

class RecordingService {
    constructor() {
        // Initialize S3 client
        this.s3Client = new S3Client({
            region: process.env.AWS_REGION || 'ap-south-1',
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
            }
        });
        this.bucketName = process.env.AWS_S3_BUCKET;

        // Active recording sessions: callId -> recording data
        this.activeRecordings = new Map();

        // Create temp directory for recordings
        this.tempDir = path.join(__dirname, '../temp/recordings');
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }

        console.log('[RecordingService] Initialized with bucket:', this.bucketName);
    }

    /**
     * Start recording for a call
     * @param {string} callId - Unique call identifier
     * @param {Object} metadata - Call metadata (agentId, userId, etc.)
     */
    startRecording(callId, metadata = {}) {
        if (!this.bucketName) {
            console.warn('[RecordingService] S3 bucket not configured, skipping recording');
            return;
        }

        console.log(`[RecordingService] Starting recording for call: ${callId}`);

        this.activeRecordings.set(callId, {
            callId,
            metadata,
            callerAudio: [],       // Raw audio chunks from caller (μ-law)
            agentAudio: [],        // Raw audio chunks from agent (μ-law)
            startTime: Date.now(),
            byteCount: 0
        });
    }

    /**
     * Add audio chunk to recording
     * @param {string} callId - Call identifier
     * @param {Buffer} chunk - Audio chunk (μ-law 8kHz)
     * @param {string} direction - 'caller' or 'agent'
     */
    addAudioChunk(callId, chunk, direction) {
        const recording = this.activeRecordings.get(callId);
        if (!recording) return;

        if (direction === 'caller') {
            recording.callerAudio.push(chunk);
        } else if (direction === 'agent') {
            recording.agentAudio.push(chunk);
        }

        recording.byteCount += chunk.length;

        // Log progress occasionally
        if (recording.byteCount % 100000 < chunk.length) {
            console.log(`[RecordingService] Recording ${callId}: ${Math.round(recording.byteCount / 1024)}KB captured`);
        }
    }

    /**
     * Stop recording and upload to S3
     * @param {string} callId - Call identifier
     * @returns {Promise<string|null>} - S3 URL of recording, or null if failed
     */
    async stopAndUpload(callId) {
        const recording = this.activeRecordings.get(callId);
        if (!recording) {
            console.warn(`[RecordingService] No recording found for call: ${callId}`);
            return null;
        }

        console.log(`[RecordingService] Stopping recording for call: ${callId}`);

        try {
            // Merge audio chunks
            const callerBuffer = Buffer.concat(recording.callerAudio);
            const agentBuffer = Buffer.concat(recording.agentAudio);

            console.log(`[RecordingService] Caller audio: ${callerBuffer.length} bytes, Agent audio: ${agentBuffer.length} bytes`);

            // Create mixed audio (interleave caller and agent)
            const mixedBuffer = this.mixAudio(callerBuffer, agentBuffer);

            // Convert μ-law to WAV format for playback
            const wavBuffer = this.createWavFile(mixedBuffer, 8000, 1);

            // Generate S3 key
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const s3Key = `recordings/${timestamp}_${callId}.wav`;

            // Upload to S3
            const uploadParams = {
                Bucket: this.bucketName,
                Key: s3Key,
                Body: wavBuffer,
                ContentType: 'audio/wav',
                Metadata: {
                    callId,
                    agentId: recording.metadata.agentId || '',
                    duration: String(Math.round((Date.now() - recording.startTime) / 1000))
                }
            };

            await this.s3Client.send(new PutObjectCommand(uploadParams));

            // Generate S3 URL
            const recordingUrl = `https://${this.bucketName}.s3.${process.env.AWS_REGION || 'ap-south-1'}.amazonaws.com/${s3Key}`;

            console.log(`[RecordingService] Recording uploaded: ${recordingUrl}`);

            // Cleanup
            this.activeRecordings.delete(callId);

            return recordingUrl;

        } catch (error) {
            console.error(`[RecordingService] Error uploading recording:`, error);
            this.activeRecordings.delete(callId);
            return null;
        }
    }

    /**
     * Mix two audio buffers (simple averaging)
     * Both buffers should be μ-law 8kHz mono
     */
    mixAudio(buffer1, buffer2) {
        // Pad shorter buffer with silence (0x7F is μ-law silence)
        const maxLength = Math.max(buffer1.length, buffer2.length);
        const mixed = Buffer.alloc(maxLength);

        for (let i = 0; i < maxLength; i++) {
            const sample1 = i < buffer1.length ? buffer1[i] : 0x7F;
            const sample2 = i < buffer2.length ? buffer2[i] : 0x7F;

            // Convert μ-law to linear, mix, convert back
            const linear1 = this.mulawToLinear(sample1);
            const linear2 = this.mulawToLinear(sample2);

            // Mix with 50% each (simple average)
            const mixedLinear = Math.round((linear1 + linear2) / 2);

            // Convert back to μ-law
            mixed[i] = this.linearToMulaw(mixedLinear);
        }

        return mixed;
    }

    /**
     * Create WAV file from μ-law audio
     * @param {Buffer} audioData - μ-law audio data
     * @param {number} sampleRate - Sample rate (8000)
     * @param {number} channels - Number of channels (1 for mono)
     * @returns {Buffer} - WAV file buffer
     */
    createWavFile(audioData, sampleRate, channels) {
        // WAV header for μ-law format
        const header = Buffer.alloc(44);
        const dataSize = audioData.length;
        const fileSize = 36 + dataSize;

        // RIFF header
        header.write('RIFF', 0);
        header.writeUInt32LE(fileSize, 4);
        header.write('WAVE', 8);

        // fmt chunk
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);           // Chunk size
        header.writeUInt16LE(7, 20);            // Audio format (7 = μ-law)
        header.writeUInt16LE(channels, 22);     // Channels
        header.writeUInt32LE(sampleRate, 24);   // Sample rate
        header.writeUInt32LE(sampleRate * channels, 28); // Byte rate
        header.writeUInt16LE(channels, 32);     // Block align
        header.writeUInt16LE(8, 34);            // Bits per sample

        // data chunk
        header.write('data', 36);
        header.writeUInt32LE(dataSize, 40);

        return Buffer.concat([header, audioData]);
    }

    /**
     * μ-law to linear PCM conversion
     */
    mulawToLinear(mulaw) {
        const BIAS = 0x84;
        mulaw = ~mulaw;
        const sign = mulaw & 0x80;
        const exponent = (mulaw >> 4) & 0x07;
        const mantissa = mulaw & 0x0F;

        let sample = mantissa << (exponent + 3);
        sample += BIAS << exponent;
        if (exponent === 0) sample += BIAS;

        return sign === 0 ? sample : -sample;
    }

    /**
     * Linear PCM to μ-law conversion
     */
    linearToMulaw(sample) {
        const BIAS = 0x84;
        const CLIP = 32635;
        const TABLE = [0, 0, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3,
            4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4];

        const sign = sample < 0 ? 0x80 : 0;
        sample = Math.abs(sample);

        if (sample > CLIP) sample = CLIP;
        sample = sample + BIAS;

        const exponent = TABLE[(sample >> 7) & 0xFF] || 0;
        const mantissa = (sample >> (exponent + 3)) & 0x0F;
        const mulaw = ~(sign | (exponent << 4) | mantissa);

        return mulaw & 0xFF;
    }

    /**
     * Check if recording is active for a call
     */
    isRecording(callId) {
        return this.activeRecordings.has(callId);
    }

    /**
     * Get active recording count
     */
    getActiveRecordingCount() {
        return this.activeRecordings.size;
    }
}

// Singleton instance
let instance = null;

module.exports = {
    RecordingService,
    getInstance: () => {
        if (!instance) {
            instance = new RecordingService();
        }
        return instance;
    }
};
