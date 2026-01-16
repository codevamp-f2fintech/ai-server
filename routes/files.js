// File Routes - API endpoints for VAPI file uploads (Knowledge Base)
// REQUIRES AUTHENTICATION

const express = require('express');
const router = express.Router();
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');
const { authenticate } = require('../middleware/auth');

// Apply authentication middleware to ALL routes
router.use(authenticate);

// Configure multer for file uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            'application/pdf',
            'text/plain',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'text/csv',
            'text/markdown',
            'application/json',
            'application/xml',
            'text/xml'
        ];

        const allowedExtensions = ['.pdf', '.txt', '.doc', '.docx', '.csv', '.md', '.json', '.xml', '.log', '.tsv', '.yaml'];
        const ext = '.' + file.originalname.split('.').pop().toLowerCase();

        if (allowedTypes.includes(file.mimetype) || allowedExtensions.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Allowed: PDF, TXT, DOC, DOCX, CSV, MD, JSON, XML'));
        }
    }
});

const VAPI_BASE_URL = 'https://api.vapi.ai';

/**
 * POST /vapi/files/upload
 * Upload a file to VAPI for knowledge base
 */
router.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No file provided'
            });
        }

        if (!process.env.VAPI_KEY) {
            return res.status(500).json({
                success: false,
                message: 'VAPI API key not configured'
            });
        }

        // Create form data for VAPI
        const formData = new FormData();
        formData.append('file', req.file.buffer, {
            filename: req.file.originalname,
            contentType: req.file.mimetype
        });

        console.log('User', req.userId, 'uploading file:', req.file.originalname);

        // Upload to VAPI
        const response = await axios.post(`${VAPI_BASE_URL}/file`, formData, {
            headers: {
                'Authorization': `Bearer ${process.env.VAPI_KEY}`,
                ...formData.getHeaders()
            }
        });

        console.log('File uploaded successfully:', response.data.id);

        res.json({
            success: true,
            file: {
                id: response.data.id,
                name: response.data.name || req.file.originalname,
                originalName: response.data.originalName || req.file.originalname,
                status: response.data.status || 'uploaded',
                bytes: response.data.bytes || req.file.size,
                mimetype: response.data.mimetype || req.file.mimetype,
                createdAt: response.data.createdAt
            }
        });

    } catch (error) {
        console.error('Error uploading file:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: error.response?.data?.message || 'Failed to upload file'
        });
    }
});

/**
 * GET /vapi/files
 * List all uploaded files
 */
router.get('/', async (req, res) => {
    try {
        if (!process.env.VAPI_KEY) {
            return res.status(500).json({
                success: false,
                message: 'VAPI API key not configured'
            });
        }

        const response = await axios.get(`${VAPI_BASE_URL}/file`, {
            headers: {
                'Authorization': `Bearer ${process.env.VAPI_KEY}`
            }
        });

        res.json({
            success: true,
            files: response.data
        });

    } catch (error) {
        console.error('Error listing files:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to list files'
        });
    }
});

/**
 * GET /vapi/files/:id
 * Get a specific file details
 */
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        if (!process.env.VAPI_KEY) {
            return res.status(500).json({
                success: false,
                message: 'VAPI API key not configured'
            });
        }

        const response = await axios.get(`${VAPI_BASE_URL}/file/${id}`, {
            headers: {
                'Authorization': `Bearer ${process.env.VAPI_KEY}`
            }
        });

        res.json({
            success: true,
            file: response.data
        });

    } catch (error) {
        console.error('Error getting file:', error.response?.data || error.message);
        res.status(404).json({
            success: false,
            message: 'File not found'
        });
    }
});

/**
 * DELETE /vapi/files/:id
 * Delete a file
 */
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        if (!process.env.VAPI_KEY) {
            return res.status(500).json({
                success: false,
                message: 'VAPI API key not configured'
            });
        }

        await axios.delete(`${VAPI_BASE_URL}/file/${id}`, {
            headers: {
                'Authorization': `Bearer ${process.env.VAPI_KEY}`
            }
        });

        res.json({
            success: true,
            message: 'File deleted successfully'
        });

    } catch (error) {
        console.error('Error deleting file:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to delete file'
        });
    }
});

module.exports = router;
