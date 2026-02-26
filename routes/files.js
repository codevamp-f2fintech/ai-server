// File Routes - Knowledge Base upload
// Uploads files to S3 and extracts text for Gemini injection
// REQUIRES AUTHENTICATION

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { authenticate } = require('../middleware/auth');

// Apply authentication middleware to ALL routes
router.use(authenticate);

// Configure multer for in-memory file uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        const allowedExtensions = ['.pdf', '.txt', '.doc', '.docx', '.csv', '.md', '.json', '.xml', '.log', '.tsv', '.yaml'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedExtensions.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Allowed: PDF, TXT, DOC, DOCX, CSV, MD, JSON, XML'));
        }
    }
});

// S3 client (shared with recording service)
const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

/**
 * Extract plain text from a file buffer
 * @param {Buffer} buffer - File buffer
 * @param {string} ext - File extension (with dot)
 * @returns {Promise<string>} Extracted text
 */
async function extractText(buffer, ext) {
    if (ext === '.pdf') {
        try {
            // Use raw lib path to avoid the bundled dist's browser-only polyfills
            // (DOMMatrix, ImageData etc.) that crash in Node.js environments
            const pdfParse = require('pdf-parse/lib/pdf-parse.js');
            const data = await pdfParse(buffer);
            const text = data.text || '';
            if (!text.trim()) {
                console.warn('[Files] PDF parsed but no text extracted — PDF may be image-based or encrypted');
            } else {
                console.log(`[Files] ✅ PDF text extracted: ${text.length} chars, preview: "${text.slice(0, 100).replace(/\n/g, ' ')}..."`);
            }
            return text;
        } catch (err) {
            console.error('[Files] PDF parse FAILED:', err.message, err.stack);
            return ''; // Return empty on parse failure
        }
    }
    // All other formats: plain text (TXT, CSV, MD, JSON, XML, etc.)
    return buffer.toString('utf-8');
}

/**
 * POST /vapi/files/upload
 * Upload a knowledge base file — extract text, upload to S3, return text + URL
 */
router.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file provided' });
        }

        const ext = path.extname(req.file.originalname).toLowerCase();
        const id = `kb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        // 1. Extract text from the buffer
        console.log(`[Files] Extracting text from ${req.file.originalname} (${ext}, ${req.file.size} bytes)`);
        const text = await extractText(req.file.buffer, ext);
        if (!text || text.trim().length === 0) {
            console.warn(`[Files] ⚠️ Extracted 0 chars from ${req.file.originalname} — KB will be empty!`);
        } else {
            console.log(`[Files] ✅ Extracted ${text.length} chars from ${req.file.originalname}`);
        }

        // 2. Upload original file to S3 (if configured)
        let s3Url = null;
        if (process.env.AWS_S3_BUCKET) {
            try {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const s3Key = `knowledge-base/${req.userId}/${timestamp}_${id}${ext}`;
                await s3Client.send(new PutObjectCommand({
                    Bucket: process.env.AWS_S3_BUCKET,
                    Key: s3Key,
                    Body: req.file.buffer,
                    ContentType: req.file.mimetype || 'application/octet-stream',
                    Metadata: {
                        originalName: req.file.originalname,
                        userId: String(req.userId)
                    }
                }));
                s3Url = `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION || 'ap-south-1'}.amazonaws.com/${s3Key}`;
                console.log(`[Files] Uploaded to S3: ${s3Url}`);
            } catch (s3Err) {
                console.error('[Files] S3 upload failed (continuing without S3 URL):', s3Err.message);
            }
        } else {
            console.warn('[Files] AWS_S3_BUCKET not set — file saved locally only (text extracted)');
        }

        res.json({
            success: true,
            file: {
                id,
                name: req.file.originalname,
                text,
                s3Url,
                bytes: req.file.size,
                status: 'processed'
            }
        });

    } catch (error) {
        console.error('[Files] Upload error:', error.message);
        res.status(500).json({ success: false, message: error.message || 'Failed to process file' });
    }
});

/**
 * GET /vapi/files
 * List KB files — returns empty array (files are stored per-agent in MongoDB)
 */
router.get('/', async (req, res) => {
    res.json({ success: true, files: [] });
});

/**
 * DELETE /vapi/files/:id
 * Remove file reference (actual deletion from S3 is out of scope for now)
 */
router.delete('/:id', async (req, res) => {
    res.json({ success: true, message: 'File reference removed' });
});

module.exports = router;
