const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { getInstance: getHumanMediaBridge } = require('../services/human-media-bridge');
const Call = require('../models/Call');

const JWT_SECRET = process.env.JWT_SECRET || 'vani-voice-ai-secret-key-change-in-production';

class ManualCallServer {
    constructor(server) {
        // When server is null, use noServer:true so server.js can dispatch
        // upgrade events manually (avoids conflict between multiple WS servers).
        this.wss = new WebSocket.Server(
            server ? { server, path: '/ws/manual-call' } : { noServer: true }
        );

        this.bridge = getHumanMediaBridge();
        this.setupWebSocketServer();
    }

    setupWebSocketServer() {
        this.wss.on('connection', (ws, req) => {
            console.log('[ManualCallWS] Client connected to manual call bridge');

            let isInitialized = false;

            ws.on('message', async (message) => {
                try {
                    // ── Text messages: JSON control frames ──────────────────────────────
                    if (typeof message === 'string' || (Buffer.isBuffer(message) && !isInitialized)) {
                        const msgStr = message.toString();

                        if (msgStr.startsWith('{')) {
                            const data = JSON.parse(msgStr);

                            // ── Init message: authenticate and attach to SIP session ────
                            if (data.event === 'init') {
                                const { internalCallId, token } = data;

                                if (!internalCallId) {
                                    ws.send(JSON.stringify({ event: 'error', error: 'Missing internalCallId' }));
                                    return ws.close();
                                }

                                // Verify JWT token
                                let decoded;
                                try {
                                    decoded = jwt.verify(token, JWT_SECRET);
                                } catch (jwtErr) {
                                    console.warn(`[ManualCallWS] JWT verification failed: ${jwtErr.message}`);
                                    ws.send(JSON.stringify({ event: 'error', error: 'Unauthorized: invalid token' }));
                                    return ws.close();
                                }

                                // Verify the call belongs to this user
                                try {
                                    const callRecord = await Call.findOne({
                                        _id: internalCallId,
                                        userId: decoded.userId
                                    });

                                    if (!callRecord) {
                                        console.warn(`[ManualCallWS] Call ${internalCallId} not found for user ${decoded.userId}`);
                                        ws.send(JSON.stringify({ event: 'error', error: 'Unauthorized: call not found' }));
                                        return ws.close();
                                    }
                                } catch (dbErr) {
                                    console.error(`[ManualCallWS] DB lookup error:`, dbErr);
                                    ws.send(JSON.stringify({ event: 'error', error: 'Server error during auth' }));
                                    return ws.close();
                                }

                                console.log(`[ManualCallWS] Auth OK — user ${decoded.userId}, call: ${internalCallId}`);
                                ws.internalCallId = internalCallId;
                                ws.userId = decoded.userId;
                                isInitialized = true;

                                ws.send(JSON.stringify({ event: 'initialized' }));

                                // Attach this socket to the active SIP bridge session
                                this.bridge.attachWebSocket(internalCallId, ws);
                                return;
                            }

                            // ── End message from frontend (before WS close) ─────────────
                            if (data.event === 'end' && isInitialized && ws.internalCallId) {
                                this.bridge.endSession(ws.internalCallId, 'agent_ended');
                                return;
                            }
                        }
                    }

                    // ── Binary messages: raw audio (μ-law) from the agent's mic ─────────
                    if (Buffer.isBuffer(message) || message instanceof ArrayBuffer) {
                        if (!isInitialized) {
                            console.warn('[ManualCallWS] Received audio before init, discarding.');
                            return;
                        }
                        // Binary audio is handled by the HumanMediaBridge message listener
                        // that was set up in setupWebSocketAudio() — nothing more needed here.
                    }
                } catch (err) {
                    console.error('[ManualCallWS] Error processing message:', err);
                }
            });

            ws.on('close', () => {
                console.log('[ManualCallWS] Client disconnected');
                // HumanMediaBridge handles its own ws.on('close') inside setupWebSocketAudio
            });

            ws.on('error', (err) => {
                console.error('[ManualCallWS] Socket error:', err.message);
            });
        });

        console.log('[ManualCallWS] WebSocket server initialized at /ws/manual-call');
    }
}

module.exports = ManualCallServer;
