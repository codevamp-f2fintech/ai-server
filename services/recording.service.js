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

            // Decode and mix μ-law audio from both channels into PCM
            const pcmBuffer = this.mixAudioToPcm(callerBuffer, agentBuffer);

            // Wrap as standard 16-bit PCM WAV (universally playable)
            const wavBuffer = this.createWavFile(pcmBuffer, 8000, 1);

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
     * Mix two μ-law audio buffers into a single PCM Int16 array.
     * Both buffers must be μ-law 8 kHz mono.
     * Returns a Buffer containing raw signed 16-bit little-endian PCM samples.
     */
    mixAudioToPcm(buffer1, buffer2) {
        // μ-law silence byte is 0xFF (not 0x7F — 0x7F is a large mid-scale value)
        const MULAW_SILENCE = 0xFF;
        const maxLength = Math.max(buffer1.length, buffer2.length);
        // Each μ-law byte → one Int16 PCM sample → 2 bytes in output
        const pcmOut = Buffer.alloc(maxLength * 2);

        for (let i = 0; i < maxLength; i++) {
            const mu1 = i < buffer1.length ? buffer1[i] : MULAW_SILENCE;
            const mu2 = i < buffer2.length ? buffer2[i] : MULAW_SILENCE;

            // Decode both channels to linear PCM
            const lin1 = this.mulawToLinear(mu1);
            const lin2 = this.mulawToLinear(mu2);

            // Sum and clamp to Int16 range to avoid overflow/clipping noise
            let mixed = lin1 + lin2;
            if (mixed > 32767)  mixed = 32767;
            if (mixed < -32768) mixed = -32768;

            pcmOut.writeInt16LE(mixed, i * 2);
        }

        return pcmOut;
    }

    /**
     * Create a standard 16-bit PCM WAV file.
     * Using PCM (format tag 1) instead of μ-law (format 7) ensures
     * every media player, browser, and AWS service decodes it correctly
     * without needing a μ-law codec — eliminating a major source of noise.
     *
     * @param {Buffer} pcmData   - Signed 16-bit little-endian PCM samples
     * @param {number} sampleRate - e.g. 8000
     * @param {number} channels   - 1 for mono
     * @returns {Buffer} Complete WAV file
     */
    createWavFile(pcmData, sampleRate, channels) {
        const bitsPerSample = 16;
        const byteRate = sampleRate * channels * (bitsPerSample / 8);
        const blockAlign = channels * (bitsPerSample / 8);
        const dataSize = pcmData.length;
        const fileSize = 36 + dataSize;

        const header = Buffer.alloc(44);

        // RIFF chunk
        header.write('RIFF', 0);
        header.writeUInt32LE(fileSize, 4);
        header.write('WAVE', 8);

        // fmt sub-chunk
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);                // fmt chunk size (16 for PCM)
        header.writeUInt16LE(1, 20);                 // AudioFormat = 1 (PCM)
        header.writeUInt16LE(channels, 22);          // NumChannels
        header.writeUInt32LE(sampleRate, 24);        // SampleRate
        header.writeUInt32LE(byteRate, 28);          // ByteRate
        header.writeUInt16LE(blockAlign, 32);        // BlockAlign
        header.writeUInt16LE(bitsPerSample, 34);     // BitsPerSample

        // data sub-chunk
        header.write('data', 36);
        header.writeUInt32LE(dataSize, 40);

        return Buffer.concat([header, pcmData]);
    }

    /**
     * μ-law to signed linear-16 PCM conversion (ITU G.711)
     */
    mulawToLinear(mulaw) {
        const BIAS = 0x84;
        mulaw = ~mulaw & 0xFF;
        const sign = mulaw & 0x80;
        const exponent = (mulaw >> 4) & 0x07;
        const mantissa = mulaw & 0x0F;

        let sample = ((mantissa << 3) + BIAS) << exponent;
        sample -= BIAS;

        return sign ? -sample : sample;
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
