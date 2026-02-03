// SIP Trunk Service
// Handles outbound calls via SIP protocol to a SIP trunk provider
// Uses UDP for SIP signaling and RTP for audio transport

const dgram = require('dgram');
const crypto = require('crypto');
const EventEmitter = require('events');

class SipTrunkService extends EventEmitter {
    constructor(config) {
        super();
        this.serverIp = config.serverIp;
        this.username = config.username;
        this.password = config.password;
        this.port = config.port || 5060;
        this.fromNumber = config.fromNumber;

        // Local port for SIP signaling
        this.localSipPort = 5060;

        // RTP port range (matching MicroSIP settings)
        this.rtpPortMin = 10000;
        this.rtpPortMax = 20000;

        // Active calls: callId -> call data
        this.activeCalls = new Map();

        // UDP socket for SIP
        this.sipSocket = null;

        // Local IP (will be detected)
        this.localIp = null;

        console.log(`[SipTrunkService] Initialized for ${this.serverIp}:${this.port}`);
    }

    /**
     * Get local IP address
     */
    async getLocalIp() {
        if (this.localIp) return this.localIp;

        return new Promise((resolve) => {
            const socket = dgram.createSocket('udp4');
            socket.connect(80, '8.8.8.8', () => {
                const address = socket.address();
                this.localIp = address.address;
                socket.close();
                resolve(this.localIp);
            });
        });
    }

    /**
     * Get public IP address for NAT traversal
     * Uses ipify.org API to get the public IP
     */
    async getPublicIp() {
        if (this.publicIp) return this.publicIp;

        const https = require('https');
        return new Promise((resolve, reject) => {
            https.get('https://api.ipify.org?format=json', (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        this.publicIp = json.ip;
                        console.log(`[SipTrunk] Public IP detected: ${this.publicIp}`);
                        resolve(this.publicIp);
                    } catch (e) {
                        console.error('[SipTrunk] Failed to parse public IP, using local IP');
                        resolve(null);
                    }
                });
            }).on('error', (err) => {
                console.error('[SipTrunk] Failed to get public IP:', err.message);
                resolve(null);
            });
        });
    }

    /**
     * Get a free RTP port
     */
    getNextRtpPort() {
        return this.rtpPortMin + Math.floor(Math.random() * (this.rtpPortMax - this.rtpPortMin));
    }

    /**
     * Generate a unique Call-ID
     */
    generateCallId() {
        return crypto.randomBytes(16).toString('hex') + '@' + (this.localIp || 'localhost');
    }

    /**
     * Generate a unique branch parameter
     */
    generateBranch() {
        return 'z9hG4bK' + crypto.randomBytes(8).toString('hex');
    }

    /**
     * Generate a unique tag
     */
    generateTag() {
        return crypto.randomBytes(8).toString('hex');
    }

    /**
     * Create SIP REGISTER request
     */
    createRegisterRequest(callId, fromTag, cseq, localIp, localSipPort, expires = 300) {
        const uri = `sip:${this.serverIp}`;
        const toUri = `sip:${this.username}@${this.serverIp}`;
        const branch = this.generateBranch();

        return [
            `REGISTER ${uri} SIP/2.0`,
            `Via: SIP/2.0/UDP ${localIp}:${localSipPort};rport;branch=${branch}`,
            `Max-Forwards: 70`,
            `From: <${toUri}>;tag=${fromTag}`,
            `To: <${toUri}>`,
            `Call-ID: ${callId}`,
            `CSeq: ${cseq} REGISTER`,
            `Contact: <sip:${this.username}@${localIp}:${localSipPort}>`,
            `Expires: ${expires}`,
            `Content-Length: 0`,
            `User-Agent: VaniVoiceAI/1.0`,
            '',
            ''
        ].join('\r\n');
    }

    /**
     * Create authenticated REGISTER request
     */
    createAuthenticatedRegister(callId, fromTag, cseq, localIp, localSipPort, authParams, expires = 300) {
        const uri = `sip:${this.serverIp}`;
        const toUri = `sip:${this.username}@${this.serverIp}`;
        const branch = this.generateBranch();

        // Calculate Digest response
        const ha1 = crypto.createHash('md5')
            .update(`${this.username}:${authParams.realm}:${this.password}`)
            .digest('hex');
        const ha2 = crypto.createHash('md5')
            .update(`REGISTER:${uri}`)
            .digest('hex');
        const response = crypto.createHash('md5')
            .update(`${ha1}:${authParams.nonce}:${ha2}`)
            .digest('hex');

        const authHeader = `Digest username="${this.username}", realm="${authParams.realm}", nonce="${authParams.nonce}", uri="${uri}", response="${response}", algorithm=MD5`;

        return [
            `REGISTER ${uri} SIP/2.0`,
            `Via: SIP/2.0/UDP ${localIp}:${localSipPort};rport;branch=${branch}`,
            `Max-Forwards: 70`,
            `From: <${toUri}>;tag=${fromTag}`,
            `To: <${toUri}>`,
            `Call-ID: ${callId}`,
            `CSeq: ${cseq} REGISTER`,
            `Contact: <sip:${this.username}@${localIp}:${localSipPort}>`,
            `Authorization: ${authHeader}`,
            `Expires: ${expires}`,
            `Content-Length: 0`,
            `User-Agent: VaniVoiceAI/1.0`,
            '',
            ''
        ].join('\r\n');
    }

    /**
     * Register with SIP server (required before making calls)
     * @returns {Promise<{socket: dgram.Socket, localSipPort: number}>}
     */
    async register() {
        const localIp = await this.getLocalIp();
        const publicIp = await this.getPublicIp() || localIp; // Fall back to local if public fails
        const callId = this.generateCallId();
        const fromTag = this.generateTag();
        let cseq = 1;

        console.log(`[SipTrunk] Registering ${this.username}@${this.serverIp}...`);
        console.log(`[SipTrunk] Using IP for SIP headers: ${publicIp}`);

        return new Promise((resolve, reject) => {
            const socket = dgram.createSocket('udp4');

            socket.on('error', (err) => {
                console.error('[SipTrunk] Register socket error:', err);
                reject(err);
            });

            socket.bind(0, () => {
                const boundAddress = socket.address();
                const localSipPort = boundAddress.port;
                console.log(`[SipTrunk] Register socket bound to port ${localSipPort}`);

                let registered = false;

                socket.on('message', (data, rinfo) => {
                    const response = this.parseSipResponse(data);
                    console.log(`[SipTrunk] Register response: ${response.statusCode} ${response.statusText}`);

                    if (response.statusCode === 401 || response.statusCode === 407) {
                        // Authentication required
                        console.log('[SipTrunk] Register auth required, sending credentials...');
                        cseq++;
                        const authRegister = this.createAuthenticatedRegister(
                            callId, fromTag, cseq, publicIp, localSipPort, response.authParams
                        );
                        socket.send(authRegister, this.port, this.serverIp);
                    } else if (response.statusCode === 200) {
                        console.log('[SipTrunk] Registration successful!');
                        registered = true;
                        this.registeredSocket = socket;
                        this.registeredPort = localSipPort;
                        resolve({ socket, localSipPort, localIp: publicIp });
                    } else if (response.statusCode >= 400) {
                        console.error(`[SipTrunk] Registration failed: ${response.statusCode}`);
                        socket.close();
                        reject(new Error(`Registration failed: ${response.statusCode} ${response.statusText}`));
                    }
                });

                // Send initial REGISTER
                const registerRequest = this.createRegisterRequest(callId, fromTag, cseq, publicIp, localSipPort);
                console.log('[SipTrunk] Sending REGISTER...');
                socket.send(registerRequest, this.port, this.serverIp);

                // Timeout after 10 seconds (only if not already registered)
                setTimeout(() => {
                    if (!registered) {
                        console.error('[SipTrunk] Registration timeout');
                        try { socket.close(); } catch (e) { }
                        reject(new Error('Registration timeout'));
                    }
                }, 10000);
            });
        });
    }

    /**
     * Create SIP INVITE request
     * @param {number} localSipPort - The actual local SIP port (ephemeral or bound)
     */
    createInviteRequest(toNumber, callId, fromTag, cseq, localIp, rtpPort, localSipPort = 5060) {
        // Clean phone numbers - remove + prefix if present (some SIP providers don't accept it)
        const cleanTo = toNumber.replace(/^\+/, '');
        const cleanFrom = this.fromNumber.replace(/^\+/, '');

        const uri = `sip:${cleanTo}@${this.serverIp}:${this.port}`;
        // Use username as the SIP identity (matches registered identity)
        const fromUri = `sip:${this.username}@${this.serverIp}`;
        const toUri = `sip:${cleanTo}@${this.serverIp}`;
        const branch = this.generateBranch();

        console.log('[SipTrunk] Creating INVITE:');
        console.log(`  Request-URI: ${uri}`);
        console.log(`  From (SIP identity): ${this.username}`);
        console.log(`  Caller ID: ${cleanFrom}`);
        console.log(`  To: ${cleanTo}`);
        console.log(`  Server: ${this.serverIp}:${this.port}`);

        // SDP for audio - μ-law (PCMU) codec
        const sdp = [
            'v=0',
            `o=- ${Date.now()} ${Date.now()} IN IP4 ${localIp}`,
            's=VaniVoiceAI',
            `c=IN IP4 ${localIp}`,
            't=0 0',
            `m=audio ${rtpPort} RTP/AVP 0 8`,  // 0=PCMU (μ-law), 8=PCMA (A-law)
            'a=rtpmap:0 PCMU/8000',
            'a=rtpmap:8 PCMA/8000',
            'a=ptime:20',
            'a=sendrecv',
        ].join('\r\n');

        const sipRequest = [
            `INVITE ${uri} SIP/2.0`,
            `Via: SIP/2.0/UDP ${localIp}:${localSipPort};rport;branch=${branch}`,
            `Max-Forwards: 70`,
            `From: <${fromUri}>;tag=${fromTag}`,
            `To: <${toUri}>`,
            `Call-ID: ${callId}`,
            `CSeq: ${cseq} INVITE`,
            `Contact: <sip:${this.username}@${localIp}:${localSipPort}>`,
            `P-Asserted-Identity: <sip:${cleanFrom}@${this.serverIp}>`,
            `Content-Type: application/sdp`,
            `Content-Length: ${sdp.length}`,
            `User-Agent: VaniVoiceAI/1.0`,
            `Allow: INVITE, ACK, CANCEL, BYE, OPTIONS`,
            '',
            sdp
        ].join('\r\n');

        // Debug: print full INVITE message
        console.log('[SipTrunk] Full INVITE message:');
        console.log('---START INVITE---');
        console.log(sipRequest);
        console.log('---END INVITE---');

        return { sipRequest, branch };
    }

    /**
     * Create SIP ACK request
     */
    createAckRequest(toNumber, callId, fromTag, toTag, cseq, localIp) {
        const uri = `sip:${toNumber}@${this.serverIp}:${this.port}`;
        const fromUri = `sip:${this.fromNumber}@${this.serverIp}`;
        const toUri = `sip:${toNumber}@${this.serverIp}`;
        const branch = this.generateBranch();

        return [
            `ACK ${uri} SIP/2.0`,
            `Via: SIP/2.0/UDP ${localIp}:${this.localSipPort};rport;branch=${branch}`,
            `Max-Forwards: 70`,
            `From: <${fromUri}>;tag=${fromTag}`,
            `To: <${toUri}>;tag=${toTag}`,
            `Call-ID: ${callId}`,
            `CSeq: ${cseq} ACK`,
            `Content-Length: 0`,
            '',
            ''
        ].join('\r\n');
    }

    /**
     * Create SIP BYE request
     */
    createByeRequest(toNumber, callId, fromTag, toTag, cseq, localIp) {
        const cleanTo = toNumber.replace(/^\+/, '');
        const cleanFrom = this.fromNumber.replace(/^\+/, '');
        const uri = `sip:${cleanTo}@${this.serverIp}:${this.port}`;
        const fromUri = `sip:${cleanFrom}@${this.serverIp}`;
        const toUri = `sip:${cleanTo}@${this.serverIp}`;
        const branch = this.generateBranch();

        return [
            `BYE ${uri} SIP/2.0`,
            `Via: SIP/2.0/UDP ${localIp}:${this.localSipPort};rport;branch=${branch}`,
            `Max-Forwards: 70`,
            `From: <${fromUri}>;tag=${fromTag}`,
            `To: <${toUri}>;tag=${toTag}`,
            `Call-ID: ${callId}`,
            `CSeq: ${cseq} BYE`,
            `Content-Length: 0`,
            '',
            ''
        ].join('\r\n');
    }

    /**
     * Create authenticated INVITE (with Authorization header)
     * @param {number} localSipPort - The actual local SIP port (ephemeral or bound)
     */
    createAuthenticatedInvite(toNumber, callId, fromTag, cseq, localIp, rtpPort, authParams, localSipPort = 5060) {
        const cleanTo = toNumber.replace(/^\+/, '');
        const cleanFrom = this.fromNumber.replace(/^\+/, '');
        const uri = `sip:${cleanTo}@${this.serverIp}:${this.port}`;
        // Use username as the SIP identity (matches registered identity)
        const fromUri = `sip:${this.username}@${this.serverIp}`;
        const toUri = `sip:${cleanTo}@${this.serverIp}`;
        const branch = this.generateBranch();

        // Calculate Digest response
        const ha1 = crypto.createHash('md5')
            .update(`${this.username}:${authParams.realm}:${this.password}`)
            .digest('hex');
        const ha2 = crypto.createHash('md5')
            .update(`INVITE:${uri}`)
            .digest('hex');
        const response = crypto.createHash('md5')
            .update(`${ha1}:${authParams.nonce}:${ha2}`)
            .digest('hex');

        // SDP for audio
        const sdp = [
            'v=0',
            `o=- ${Date.now()} ${Date.now()} IN IP4 ${localIp}`,
            's=VaniVoiceAI',
            `c=IN IP4 ${localIp}`,
            't=0 0',
            `m=audio ${rtpPort} RTP/AVP 0 8`,
            'a=rtpmap:0 PCMU/8000',
            'a=rtpmap:8 PCMA/8000',
            'a=ptime:20',
            'a=sendrecv',
            ''
        ].join('\r\n');

        const authHeader = `Digest username="${this.username}", realm="${authParams.realm}", nonce="${authParams.nonce}", uri="${uri}", response="${response}", algorithm=MD5`;

        const sipRequest = [
            `INVITE ${uri} SIP/2.0`,
            `Via: SIP/2.0/UDP ${localIp}:${localSipPort};rport;branch=${branch}`,
            `Max-Forwards: 70`,
            `From: <${fromUri}>;tag=${fromTag}`,
            `To: <${toUri}>`,
            `Call-ID: ${callId}`,
            `CSeq: ${cseq} INVITE`,
            `Contact: <sip:${this.username}@${localIp}:${localSipPort}>`,
            `P-Asserted-Identity: <sip:${cleanFrom}@${this.serverIp}>`,
            `Authorization: ${authHeader}`,
            `Content-Type: application/sdp`,
            `Content-Length: ${sdp.length}`,
            `User-Agent: VaniVoiceAI/1.0`,
            `Allow: INVITE, ACK, CANCEL, BYE, OPTIONS`,
            '',
            sdp
        ].join('\r\n');

        return { sipRequest, branch };
    }

    /**
     * Parse SIP response
     */
    parseSipResponse(data) {
        const dataStr = data.toString();
        const lines = dataStr.split('\r\n');
        const response = {};

        // Parse status line
        const statusLine = lines[0];
        const statusMatch = statusLine.match(/SIP\/2.0 (\d{3}) (.+)/);
        if (statusMatch) {
            response.statusCode = parseInt(statusMatch[1]);
            response.statusText = statusMatch[2];
        }

        // Parse headers
        response.headers = {};
        let bodyStart = -1;
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (line === '') {
                bodyStart = i + 1;
                break;
            }

            const colonIdx = line.indexOf(':');
            if (colonIdx > 0) {
                const key = line.substring(0, colonIdx).trim().toLowerCase();
                const value = line.substring(colonIdx + 1).trim();
                response.headers[key] = value;
            }
        }

        // Parse WWW-Authenticate if present
        if (response.headers['www-authenticate']) {
            const authHeader = response.headers['www-authenticate'];
            response.authParams = {};

            const realmMatch = authHeader.match(/realm="([^"]+)"/);
            if (realmMatch) response.authParams.realm = realmMatch[1];

            const nonceMatch = authHeader.match(/nonce="([^"]+)"/);
            if (nonceMatch) response.authParams.nonce = nonceMatch[1];
        }

        // Parse To tag
        if (response.headers['to']) {
            const toTagMatch = response.headers['to'].match(/tag=([^;>]+)/);
            if (toTagMatch) response.toTag = toTagMatch[1];
        }

        // Parse SDP body if present (for 200 OK responses)
        if (bodyStart > 0 && response.headers['content-type']?.includes('application/sdp')) {
            const sdpBody = lines.slice(bodyStart).join('\r\n');
            response.sdp = this.parseSdp(sdpBody);
            console.log('[SipTrunk] Parsed remote SDP:', JSON.stringify(response.sdp));
        }

        return response;
    }

    /**
     * Parse SDP to extract media info
     */
    parseSdp(sdpString) {
        const result = { remoteRtpPort: null, remoteIp: null, codec: null };
        const lines = sdpString.split('\r\n');

        for (const line of lines) {
            // Parse connection info: c=IN IP4 1.2.3.4
            if (line.startsWith('c=')) {
                const match = line.match(/c=IN IP4 (\S+)/);
                if (match) {
                    result.remoteIp = match[1];
                }
            }
            // Parse media line: m=audio 20000 RTP/AVP 0 8
            if (line.startsWith('m=audio')) {
                const match = line.match(/m=audio (\d+)/);
                if (match) {
                    result.remoteRtpPort = parseInt(match[1]);
                }
                // Check preferred codec
                const codecMatch = line.match(/m=audio \d+ RTP\/AVP (\d+)/);
                if (codecMatch) {
                    result.codec = parseInt(codecMatch[1]); // 0=PCMU, 8=PCMA
                }
            }
        }

        return result;
    }

    /**
     * Make an outbound call
     * @param {string} toNumber - Phone number to call (with country code)
     * @param {string} internalCallId - Internal call ID for tracking
     * @returns {Promise<Object>} - Call object with SIP call-id
     */
    async makeCall(toNumber, internalCallId) {
        // First, register with SIP server if not already registered
        let localIp, sipSocket, localSipPort;

        try {
            console.log('[SipTrunk] Registering before making call...');
            const registrationResult = await this.register();
            sipSocket = registrationResult.socket;
            localSipPort = registrationResult.localSipPort;
            localIp = registrationResult.localIp;
            console.log('[SipTrunk] Registration complete, proceeding with call');
        } catch (regError) {
            console.error('[SipTrunk] Registration failed:', regError.message);
            throw new Error(`Registration failed: ${regError.message}`);
        }

        const rtpPort = this.getNextRtpPort();
        const callId = this.generateCallId();
        const fromTag = this.generateTag();
        let cseq = 1;

        console.log(`[SipTrunk] Making call to ${toNumber} from ${this.fromNumber}`);
        console.log(`[SipTrunk] Local IP: ${localIp}, RTP Port: ${rtpPort}, SIP Port: ${localSipPort}`);

        return new Promise((resolve, reject) => {
            // Reuse the registered socket
            const socket = sipSocket;

            const callData = {
                internalCallId,
                callId,
                toNumber,
                fromTag,
                toTag: null,
                rtpPort,
                socket,
                rtpSocket: null,
                status: 'initiating',
                cseq,
                startTime: Date.now(),
                localSipPort: null  // Will be set when socket binds
            };

            this.activeCalls.set(callId, callData);

            // Remove registration message handlers before adding call handlers
            socket.removeAllListeners('message');

            socket.on('message', async (data, rinfo) => {
                const response = this.parseSipResponse(data);
                console.log(`[SipTrunk] Received ${response.statusCode} ${response.statusText}`);

                if (response.statusCode === 401 || response.statusCode === 407) {
                    // Authentication required
                    console.log('[SipTrunk] Authentication required, sending credentials...');

                    cseq++;
                    callData.cseq = cseq;

                    const { sipRequest } = this.createAuthenticatedInvite(
                        toNumber, callId, fromTag, cseq, localIp, rtpPort, response.authParams, callData.localSipPort
                    );

                    socket.send(sipRequest, this.port, this.serverIp, (err) => {
                        if (err) console.error('[SipTrunk] Error sending authenticated INVITE:', err);
                    });

                } else if (response.statusCode === 100) {
                    // Trying
                    callData.status = 'trying';
                    this.emit('trying', { callId, internalCallId });

                } else if (response.statusCode === 180 || response.statusCode === 183) {
                    // Ringing
                    callData.status = 'ringing';
                    this.emit('ringing', { callId, internalCallId });

                } else if (response.statusCode === 200) {
                    // Call answered!
                    console.log('[SipTrunk] Call answered!');
                    callData.status = 'answered';
                    callData.toTag = response.toTag;

                    // Extract remote RTP info from SDP
                    if (response.sdp) {
                        callData.remoteRtpIp = response.sdp.remoteIp || this.serverIp;
                        callData.remoteRtpPort = response.sdp.remoteRtpPort || callData.rtpPort;
                        callData.remoteCodec = response.sdp.codec || 0; // Default to PCMU
                        console.log(`[SipTrunk] Remote RTP endpoint: ${callData.remoteRtpIp}:${callData.remoteRtpPort}`);
                    } else {
                        // Fallback to server IP and local port if no SDP
                        callData.remoteRtpIp = this.serverIp;
                        callData.remoteRtpPort = callData.rtpPort;
                        callData.remoteCodec = 0;
                        console.warn('[SipTrunk] No SDP in 200 OK, using fallback RTP endpoint');
                    }

                    // Send ACK
                    const ack = this.createAckRequest(
                        toNumber, callId, fromTag, response.toTag, callData.cseq, localIp
                    );
                    socket.send(ack, this.port, this.serverIp);

                    // Start RTP socket for audio
                    this.startRtpSession(callData, localIp);

                    this.emit('answered', { callId, internalCallId });

                    resolve({
                        sid: internalCallId,
                        sipCallId: callId,
                        status: 'answered',
                        to: toNumber,
                        from: this.fromNumber
                    });

                } else if (response.statusCode >= 400) {
                    // Error
                    console.error(`[SipTrunk] Call failed: ${response.statusCode} ${response.statusText}`);
                    callData.status = 'failed';
                    socket.close();
                    this.activeCalls.delete(callId);

                    reject(new Error(`SIP call failed: ${response.statusCode} ${response.statusText}`));
                }
            });

            socket.on('error', (err) => {
                console.error('[SipTrunk] Socket error:', err);
                reject(err);
            });

            // Socket is already bound from registration - just send INVITE
            callData.localSipPort = localSipPort;

            const { sipRequest } = this.createInviteRequest(
                toNumber, callId, fromTag, cseq, localIp, rtpPort, localSipPort
            );

            console.log('[SipTrunk] Sending INVITE...');
            console.log('[SipTrunk] Target: ' + this.serverIp + ':' + this.port);
            socket.send(sipRequest, this.port, this.serverIp, (err) => {
                if (err) {
                    console.error('[SipTrunk] Error sending INVITE:', err);
                    reject(err);
                } else {
                    console.log('[SipTrunk] INVITE sent successfully');
                }
            });

            // Timeout after 30 seconds
            setTimeout(() => {
                if (callData.status === 'initiating' || callData.status === 'trying') {
                    console.log('[SipTrunk] Call timeout');
                    socket.close();
                    this.activeCalls.delete(callId);
                    reject(new Error('Call timeout'));
                }
            }, 30000);
        });
    }

    /**
     * Start RTP session for audio streaming
     */
    startRtpSession(callData, localIp) {
        const rtpSocket = dgram.createSocket('udp4');

        rtpSocket.on('message', (data, rinfo) => {
            // RTP packet received from remote party
            // Skip RTP header (12 bytes) to get audio payload
            if (data.length > 12) {
                const audioPayload = data.slice(12);
                this.emit('audio_in', {
                    callId: callData.callId,
                    internalCallId: callData.internalCallId,
                    audio: audioPayload
                });
            }
        });

        rtpSocket.bind(callData.rtpPort, () => {
            console.log(`[SipTrunk] RTP socket bound to port ${callData.rtpPort}`);
        });

        callData.rtpSocket = rtpSocket;
        callData.rtpSequence = 0;
        callData.rtpTimestamp = 0;
        callData.ssrc = crypto.randomBytes(4).readUInt32BE(0);
    }

    /**
     * Send audio to the call (for TTS playback)
     * @param {string} callId - SIP Call-ID
     * @param {Buffer} audioData - Audio data in μ-law 8kHz
     */
    sendAudio(callId, audioData) {
        const callData = this.activeCalls.get(callId);
        if (!callData || !callData.rtpSocket) {
            console.warn('[SipTrunk] No active call to send audio');
            return;
        }

        // Split audio into 20ms chunks (160 bytes each for 8kHz μ-law)
        const CHUNK_SIZE = 160;
        let offset = 0;

        while (offset < audioData.length) {
            const chunk = audioData.slice(offset, Math.min(offset + CHUNK_SIZE, audioData.length));

            // Create RTP packet
            const header = Buffer.alloc(12);
            header.writeUInt8(0x80, 0); // Version 2, no padding, no extension, no CSRC
            header.writeUInt8(callData.remoteCodec || 0x00, 1); // Payload type from SDP (0=PCMU, 8=PCMA)
            header.writeUInt16BE(callData.rtpSequence++ & 0xFFFF, 2);
            header.writeUInt32BE(callData.rtpTimestamp, 4);
            header.writeUInt32BE(callData.ssrc, 8);

            const rtpPacket = Buffer.concat([header, chunk]);

            // Update timestamp (8000 Hz, 160 samples per 20ms packet)
            callData.rtpTimestamp += chunk.length;

            // Send to remote RTP endpoint (parsed from SDP)
            const targetIp = callData.remoteRtpIp || this.serverIp;
            const targetPort = callData.remoteRtpPort || callData.rtpPort;

            callData.rtpSocket.send(rtpPacket, targetPort, targetIp);

            offset += CHUNK_SIZE;
        }

        // Debug log occasionally
        if (!callData.rtpSendCount) callData.rtpSendCount = 0;
        callData.rtpSendCount++;
        if (callData.rtpSendCount === 1 || callData.rtpSendCount % 100 === 0) {
            const targetIp = callData.remoteRtpIp || this.serverIp;
            const targetPort = callData.remoteRtpPort || callData.rtpPort;
            console.log(`[SipTrunk] Sent RTP audio #${callData.rtpSendCount} to ${targetIp}:${targetPort}, ${audioData.length} bytes`);
        }
    }

    /**
     * Hangup a call
     */
    async hangup(callId) {
        const callData = this.activeCalls.get(callId);
        if (!callData) {
            console.warn('[SipTrunk] No call found to hangup:', callId);
            return;
        }

        const localIp = await this.getLocalIp();
        const bye = this.createByeRequest(
            callData.toNumber,
            callId,
            callData.fromTag,
            callData.toTag,
            ++callData.cseq,
            localIp
        );

        callData.socket.send(bye, this.port, this.serverIp, () => {
            console.log('[SipTrunk] BYE sent');
        });

        // Cleanup
        if (callData.rtpSocket) callData.rtpSocket.close();
        callData.socket.close();
        this.activeCalls.delete(callId);

        this.emit('ended', { callId, internalCallId: callData.internalCallId });
    }

    /**
     * Get active call by internal ID
     */
    getCallByInternalId(internalId) {
        for (const [callId, data] of this.activeCalls) {
            if (data.internalCallId === internalId) {
                return { callId, ...data };
            }
        }
        return null;
    }

    /**
     * Close all connections
     */
    close() {
        for (const [callId, callData] of this.activeCalls) {
            if (callData.rtpSocket) callData.rtpSocket.close();
            if (callData.socket) callData.socket.close();
        }
        this.activeCalls.clear();
    }
}

/**
 * Create SipTrunkService from a PhoneNumber document
 */
SipTrunkService.createFromPhoneNumber = function (phoneNumber) {
    if (!phoneNumber) {
        throw new Error('Phone number is required');
    }

    if (phoneNumber.provider !== 'sip-trunk') {
        throw new Error(`Phone number provider is ${phoneNumber.provider}, expected sip-trunk`);
    }

    return new SipTrunkService({
        serverIp: phoneNumber.sipServerIp,
        username: phoneNumber.sipUsername,
        password: phoneNumber.sipPassword,
        port: phoneNumber.sipPort || 5060,
        fromNumber: phoneNumber.number
    });
};

module.exports = SipTrunkService;
