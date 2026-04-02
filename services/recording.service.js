// Recording Service
// Records call audio streams and uploads to AWS S3
// Captures both caller and agent audio, merges them, and stores as a proper
// conversation-flow WAV using timestamped chunks so every voice is placed at
// the correct position on the recording timeline.

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

// Audio constants
const SAMPLE_RATE = 8000;   // 8 kHz telephony
const BYTES_PER_SAMPLE = 2; // 16-bit PCM output

class RecordingService {
    constructor() {
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
     * Start recording for a call.
     * @param {string} callId - Unique call identifier
     * @param {Object} metadata - Call metadata (agentId, userId, etc.)
     */
    startRecording(callId, metadata = {}) {
        if (!this.bucketName) {
            console.warn('[RecordingService] S3 bucket not configured, skipping recording');
            return;
        }

        const startTime = Date.now();
        console.log(`[RecordingService] Starting recording for call: ${callId}`);

        this.activeRecordings.set(callId, {
            callId,
            metadata,
            startTime,
            // Each entry: { offsetMs: number, data: Buffer, direction: 'caller'|'agent' }
            chunks: [],
            byteCount: 0
        });
    }

    /**
     * Add a timestamped audio chunk to the recording.
     * The chunk is tagged with the milliseconds elapsed since call start so
     * it can be placed at the correct position on the shared timeline.
     *
     * @param {string} callId     - Call identifier
     * @param {Buffer} chunk      - Audio data (μ-law 8 kHz mono)
     * @param {string} direction  - 'caller' | 'agent'
     */
    addAudioChunk(callId, chunk, direction) {
        const recording = this.activeRecordings.get(callId);
        if (!recording) return;

        // Capture the wall-clock offset from call start NOW (not at mix time).
        const offsetMs = Date.now() - recording.startTime;

        recording.chunks.push({ offsetMs, data: chunk, direction });
        recording.byteCount += chunk.length;

        // Log progress occasionally
        if (recording.byteCount % 100000 < chunk.length) {
            console.log(`[RecordingService] Recording ${callId}: ${Math.round(recording.byteCount / 1024)}KB captured`);
        }
    }

    /**
     * Stop recording and upload to S3.
     * @param {string} callId - Call identifier
     * @returns {Promise<string|null>} S3 URL of recording, or null if failed
     */
    async stopAndUpload(callId) {
        const recording = this.activeRecordings.get(callId);
        if (!recording) {
            console.warn(`[RecordingService] No recording found for call: ${callId}`);
            return null;
        }

        console.log(`[RecordingService] Stopping recording for call: ${callId}, chunks: ${recording.chunks.length}`);

        try {
            // Build a properly time-aligned PCM mix from all timestamped chunks
            const pcmBuffer = this.buildTimelineMix(recording.chunks, recording.startTime);

            if (pcmBuffer.length === 0) {
                console.warn(`[RecordingService] No audio data for call: ${callId}`);
                this.activeRecordings.delete(callId);
                return null;
            }

            // Wrap as standard 16-bit PCM WAV (universally playable)
            const wavBuffer = this.createWavFile(pcmBuffer, SAMPLE_RATE, 1);

            // Generate S3 key
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const s3Key = `recordings/${timestamp}_${callId}.wav`;

            // Upload to S3
            await this.s3Client.send(new PutObjectCommand({
                Bucket: this.bucketName,
                Key: s3Key,
                Body: wavBuffer,
                ContentType: 'audio/wav',
                Metadata: {
                    callId,
                    agentId: recording.metadata.agentId || '',
                    duration: String(Math.round((Date.now() - recording.startTime) / 1000))
                }
            }));

            const recordingUrl = `https://${this.bucketName}.s3.${process.env.AWS_REGION || 'ap-south-1'}.amazonaws.com/${s3Key}`;
            console.log(`[RecordingService] Recording uploaded: ${recordingUrl}`);

            this.activeRecordings.delete(callId);
            return recordingUrl;

        } catch (error) {
            console.error(`[RecordingService] Error uploading recording:`, error);
            this.activeRecordings.delete(callId);
            return null;
        }
    }

    /**
     * Build a time-aligned PCM timeline from timestamped μ-law chunks.
     *
     * HOW IT WORKS:
     * Each chunk carries an `offsetMs` capturing exactly when that packet
     * arrived relative to call start.  We convert that offset to a sample
     * index, write the decoded PCM samples into a pre-allocated Int32 work
     * buffer (Int32 so we can safely accumulate both channels without
     * overflow), clamp to Int16 range, then return as a Buffer of signed
     * 16-bit LE PCM samples.
     *
     * This guarantees that:
     *   • Agent speech at t=2s appears at the 2-second mark in the output.
     *   • User speech at t=5s appears at the 5-second mark in the output.
     *   • If both speak simultaneously (very rare), samples are summed and clamped.
     *
     * @param {Array<{offsetMs, data, direction}>} chunks
     * @returns {Buffer} Raw signed 16-bit LE PCM
     */
    buildTimelineMix(chunks) {
        if (!chunks || chunks.length === 0) return Buffer.alloc(0);

        // Compute total timeline length in samples.
        // For each chunk: the last sample it occupies = offsetMs_sample + chunk_samples.
        let totalSamples = 0;
        for (const chunk of chunks) {
            const startSample = Math.floor((chunk.offsetMs / 1000) * SAMPLE_RATE);
            const chunkSamples = chunk.data.length; // 1 μ-law byte = 1 sample
            const endSample = startSample + chunkSamples;
            if (endSample > totalSamples) totalSamples = endSample;
        }

        if (totalSamples === 0) return Buffer.alloc(0);

        // Use Int32Array as the accumulation buffer so summing two ±32768
        // PCM values never overflows a 32-bit integer.
        const timeline = new Int32Array(totalSamples);

        for (const chunk of chunks) {
            const startSample = Math.floor((chunk.offsetMs / 1000) * SAMPLE_RATE);
            for (let i = 0; i < chunk.data.length; i++) {
                const sampleIdx = startSample + i;
                if (sampleIdx >= totalSamples) break;
                const pcmVal = this.mulawToLinear(chunk.data[i]);
                timeline[sampleIdx] += pcmVal;
            }
        }

        // Convert Int32 timeline → Int16 LE PCM Buffer with clamping
        const pcmOut = Buffer.alloc(totalSamples * BYTES_PER_SAMPLE);
        for (let i = 0; i < totalSamples; i++) {
            let v = timeline[i];
            if (v > 32767)  v = 32767;
            if (v < -32768) v = -32768;
            pcmOut.writeInt16LE(v, i * BYTES_PER_SAMPLE);
        }

        console.log(`[RecordingService] Timeline mix: ${totalSamples} samples (${(totalSamples / SAMPLE_RATE).toFixed(1)}s)`);
        return pcmOut;
    }

    /**
     * Create a standard 16-bit PCM WAV file.
     * Format tag 1 (PCM) is universally supported — no codec needed.
     *
     * @param {Buffer} pcmData    - Signed 16-bit LE PCM samples
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
        header.writeUInt32LE(16, 16);            // fmt chunk size
        header.writeUInt16LE(1, 20);             // AudioFormat = 1 (PCM)
        header.writeUInt16LE(channels, 22);      // NumChannels
        header.writeUInt32LE(sampleRate, 24);    // SampleRate
        header.writeUInt32LE(byteRate, 28);      // ByteRate
        header.writeUInt16LE(blockAlign, 32);    // BlockAlign
        header.writeUInt16LE(bitsPerSample, 34); // BitsPerSample

        // data sub-chunk
        header.write('data', 36);
        header.writeUInt32LE(dataSize, 40);

        return Buffer.concat([header, pcmData]);
    }

    /**
     * μ-law to signed linear-16 PCM conversion (ITU G.711).
     */
    mulawToLinear(mulaw) {
        const BIAS = 0x84;
        mulaw = ~mulaw & 0xFF;
        const sign     = mulaw & 0x80;
        const exponent = (mulaw >> 4) & 0x07;
        const mantissa = mulaw & 0x0F;

        let sample = ((mantissa << 3) + BIAS) << exponent;
        sample -= BIAS;

        return sign ? -sample : sample;
    }

    /**
     * Check if recording is active for a call.
     */
    isRecording(callId) {
        return this.activeRecordings.has(callId);
    }

    /**
     * Get active recording count.
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
