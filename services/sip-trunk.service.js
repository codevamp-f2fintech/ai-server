// SIP Trunk Service
// Handles outbound calls via SIP protocol to a SIP trunk provider
// Uses UDP for SIP signaling and RTP for audio transport

const dgram = require('dgram');
const crypto = require('crypto');
const EventEmitter = require('events');

// μ-law to A-law conversion table (ITU-T G.711)
// This converts μ-law (PCMU, codec 0) to A-law (PCMA, codec 8)
const ULAW_TO_ALAW = [
    42, 43, 40, 41, 46, 47, 44, 45, 34, 35, 32, 33, 38, 39, 36, 37,
    58, 59, 56, 57, 62, 63, 60, 61, 50, 51, 48, 49, 54, 55, 52, 53,
    10, 11, 8, 9, 14, 15, 12, 13, 2, 3, 0, 1, 6, 7, 4, 5,
    26, 27, 24, 25, 30, 31, 28, 29, 18, 19, 16, 17, 22, 23, 20, 21,
    98, 99, 96, 97, 102, 103, 100, 101, 90, 91, 88, 89, 94, 95, 92, 93,
    114, 115, 112, 113, 118, 119, 116, 117, 106, 107, 104, 105, 110, 111, 108, 109,
    66, 67, 64, 65, 70, 71, 68, 69, 74, 75, 72, 73, 78, 79, 76, 77,
    82, 83, 80, 81, 86, 87, 84, 85, 122, 123, 120, 121, 126, 127, 124, 125,
    170, 171, 168, 169, 174, 175, 172, 173, 162, 163, 160, 161, 166, 167, 164, 165,
    186, 187, 184, 185, 190, 191, 188, 189, 178, 179, 176, 177, 182, 183, 180, 181,
    138, 139, 136, 137, 142, 143, 140, 141, 130, 131, 128, 129, 134, 135, 132, 133,
    154, 155, 152, 153, 158, 159, 156, 157, 146, 147, 144, 145, 150, 151, 148, 149,
    226, 227, 224, 225, 230, 231, 228, 229, 218, 219, 216, 217, 222, 223, 220, 221,
    242, 243, 240, 241, 246, 247, 244, 245, 234, 235, 232, 233, 238, 239, 236, 237,
    194, 195, 192, 193, 198, 199, 196, 197, 202, 203, 200, 201, 206, 207, 204, 205,
    210, 211, 208, 209, 214, 215, 212, 213, 250, 251, 248, 249, 254, 255, 252, 253
];

// Convert μ-law buffer to A-law buffer
function ulawToAlaw(ulawBuffer) {
    const alawBuffer = Buffer.alloc(ulawBuffer.length);
    for (let i = 0; i < ulawBuffer.length; i++) {
        alawBuffer[i] = ULAW_TO_ALAW[ulawBuffer[i]];
    }
    return alawBuffer;
}

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
        // Clean phone numbers - remove + and country code (91 for India) to match MicroSIP format
        // MicroSIP uses 10-digit format like 8267818161
        let cleanTo = toNumber.replace(/^\+/, '');
        // Remove 91 country code if present (for India)
        if (cleanTo.startsWith('91') && cleanTo.length > 10) {
            cleanTo = cleanTo.substring(2);
        }
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
        // Clean phone numbers - remove + and country code (91 for India) to match MicroSIP format
        let cleanTo = toNumber.replace(/^\+/, '');
        // Remove 91 country code if present (for India)
        if (cleanTo.startsWith('91') && cleanTo.length > 10) {
            cleanTo = cleanTo.substring(2);
        }
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
     * Parse SIP response or request
     */
    parseSipResponse(data) {
        const dataStr = data.toString();
        const lines = dataStr.split('\r\n');
        const response = {};

        // Parse status line (could be response or request)
        const statusLine = lines[0];

        // Check if it's a response (SIP/2.0 xxx ...)
        const statusMatch = statusLine.match(/SIP\/2.0 (\d{3}) (.+)/);
        if (statusMatch) {
            response.statusCode = parseInt(statusMatch[1]);
            response.statusText = statusMatch[2];
        } else {
            // Check if it's a request (METHOD sip:... SIP/2.0)
            const requestMatch = statusLine.match(/^(\w+)\s+(.+)\s+SIP\/2.0/);
            if (requestMatch) {
                response.method = requestMatch[1]; // e.g., "BYE", "INVITE", "ACK"
                response.requestUri = requestMatch[2];
                response.isRequest = true;
            }
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
                localSipPort: null,  // Will be set when socket binds
                authSent: false,     // Track if we've already sent authenticated INVITE
                answered: false      // Track if 200 OK already processed
            };

            this.activeCalls.set(callId, callData);

            // Remove registration message handlers before adding call handlers
            socket.removeAllListeners('message');

            socket.on('message', async (data, rinfo) => {
                const response = this.parseSipResponse(data);

                // Handle incoming SIP requests (BYE, re-INVITE, etc.)
                if (response.isRequest) {
                    if (response.method === 'BYE') {
                        // Only process BYE once
                        if (callData.byeReceived) {
                            return; // Silently ignore duplicate BYE
                        }
                        callData.byeReceived = true;

                        console.log('[SipTrunk] Remote party sent BYE - call ending');

                        // Clear keep-alive interval
                        if (callData.keepAliveInterval) {
                            clearInterval(callData.keepAliveInterval);
                            callData.keepAliveInterval = null;
                        }

                        // Clear audio send interval and queue
                        if (callData.audioSendInterval) {
                            clearInterval(callData.audioSendInterval);
                            callData.audioSendInterval = null;
                        }
                        if (callData.audioQueue) {
                            callData.audioQueue = [];
                        }

                        // Send 200 OK response to BYE
                        const okResponse = `SIP/2.0 200 OK\r\n` +
                            `Via: ${response.headers?.via || ''}\r\n` +
                            `From: ${response.headers?.from || ''}\r\n` +
                            `To: ${response.headers?.to || ''}\r\n` +
                            `Call-ID: ${response.headers?.['call-id'] || callId}\r\n` +
                            `CSeq: ${response.headers?.cseq || '1 BYE'}\r\n` +
                            `Content-Length: 0\r\n\r\n`;
                        socket.send(Buffer.from(okResponse), this.port, this.serverIp);

                        // Emit call ended event (matches listener in independent-calls.js)
                        this.emit('ended', { callId, internalCallId, reason: 'remote_hangup' });
                        return;
                    } else if (response.method === 'ACK') {
                        console.log('[SipTrunk] Received ACK');
                        return;
                    } else if (response.method === 'INVITE') {
                        console.log('[SipTrunk] Received re-INVITE (ignoring for now)');
                        return;
                    }
                    return;
                }

                console.log(`[SipTrunk] Received ${response.statusCode} ${response.statusText}`);

                if (response.statusCode === 401 || response.statusCode === 407) {
                    // Authentication required - only send once!
                    if (callData.authSent) {
                        console.log('[SipTrunk] Auth already sent, ignoring duplicate 401');
                        return;
                    }
                    callData.authSent = true;
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
                    // Call answered! - only setup session once, but update RTP endpoint if changed
                    if (callData.answered) {
                        // Still update RTP endpoint if SDP has different IP (call re-routing)
                        if (response.sdp && (response.sdp.remoteIp !== callData.remoteRtpIp ||
                            response.sdp.remoteRtpPort !== callData.remoteRtpPort)) {
                            const oldIp = callData.remoteRtpIp;
                            const oldPort = callData.remoteRtpPort;
                            callData.remoteRtpIp = response.sdp.remoteIp;
                            callData.remoteRtpPort = response.sdp.remoteRtpPort;
                            // Set lockout to prevent symmetric RTP from reverting this change
                            callData.endpointLockoutUntil = Date.now() + 5000; // 5 second lockout
                            callData.sdpRerouteOccurred = true; // Permanently disable symmetric RTP
                            console.log(`[SipTrunk] RTP endpoint updated (SDP): ${oldIp}:${oldPort} -> ${callData.remoteRtpIp}:${callData.remoteRtpPort}`);
                        } else {
                            console.log('[SipTrunk] 200 OK already processed, ignoring duplicate');
                        }
                        return;
                    }
                    callData.answered = true;
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
            // SYMMETRIC RTP: Update sending endpoint if we receive RTP from a different source
            // This handles mid-call re-routing before 200 OK SDP update arrives
            // BUT: Disable completely if SDP re-route has occurred (provider sends from old source for a while)
            if (rinfo.address !== callData.remoteRtpIp || rinfo.port !== callData.remoteRtpPort) {
                // If SDP re-route happened, never use symmetric RTP (provider is unreliable)
                if (callData.sdpRerouteOccurred) {
                    // Ignore - SDP is authoritative after re-route
                } else if (callData.endpointLockoutUntil && Date.now() < callData.endpointLockoutUntil) {
                    // Within lockout period, ignore this packet's source
                } else if (data.length > 12) {
                    // Only update if it's a valid RTP source (not just any packet)
                    const oldIp = callData.remoteRtpIp;
                    const oldPort = callData.remoteRtpPort;
                    callData.remoteRtpIp = rinfo.address;
                    callData.remoteRtpPort = rinfo.port;
                    console.log(`[SipTrunk] Symmetric RTP: updated endpoint from ${oldIp}:${oldPort} -> ${rinfo.address}:${rinfo.port}`);
                }
            }

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
        callData.lastAudioSentTime = Date.now();
        callData.isSendingAudio = false;

        // Start RTP keep-alive - send silence packets every 20ms when not sending real audio
        // This prevents SIP providers from timing out due to RTP inactivity
        const KEEP_ALIVE_INTERVAL = 20; // 20ms to match RTP ptime
        const SILENCE_CHUNK_SIZE = 160; // 160 bytes for 20ms at 8kHz

        // Create silence buffer (μ-law silence = 0xFF, A-law silence = 0xD5)
        const silenceUlaw = Buffer.alloc(SILENCE_CHUNK_SIZE, 0xFF);
        const silenceAlaw = Buffer.alloc(SILENCE_CHUNK_SIZE, 0xD5);

        callData.keepAliveInterval = setInterval(() => {
            // Only send keep-alive if not currently sending real audio
            if (callData.isSendingAudio) {
                return;
            }

            // Check if we've been silent for too long (more than 40ms since last audio)
            const timeSinceLastAudio = Date.now() - callData.lastAudioSentTime;
            if (timeSinceLastAudio < 40) {
                return; // Recently sent audio, no need for keep-alive
            }

            // Select appropriate silence based on codec
            const silenceBuffer = callData.remoteCodec === 8 ? silenceAlaw : silenceUlaw;

            // Create RTP packet with silence
            const header = Buffer.alloc(12);
            header.writeUInt8(0x80, 0); // Version 2
            header.writeUInt8(callData.remoteCodec || 0x00, 1); // Payload type
            header.writeUInt16BE(callData.rtpSequence++ & 0xFFFF, 2);
            header.writeUInt32BE(callData.rtpTimestamp, 4);
            header.writeUInt32BE(callData.ssrc, 8);

            const rtpPacket = Buffer.concat([header, silenceBuffer]);
            callData.rtpTimestamp += SILENCE_CHUNK_SIZE;

            const targetIp = callData.remoteRtpIp || this.serverIp;
            const targetPort = callData.remoteRtpPort || callData.rtpPort;

            try {
                callData.rtpSocket.send(rtpPacket, targetPort, targetIp);
            } catch (err) {
                // Socket might be closed, ignore errors
            }

            // Log occasionally (every 100 packets = ~2 seconds)
            if (!callData.keepAliveCount) callData.keepAliveCount = 0;
            callData.keepAliveCount++;
            if (callData.keepAliveCount === 1 || callData.keepAliveCount % 100 === 0) {
                console.log(`[SipTrunk] RTP keep-alive #${callData.keepAliveCount} sent to ${targetIp}:${targetPort}`);
            }
        }, KEEP_ALIVE_INTERVAL);

        console.log('[SipTrunk] RTP keep-alive started');
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

        // Convert μ-law to A-law if remote codec is 8 (PCMA)
        // ElevenLabs outputs μ-law (codec 0), but remote may negotiate A-law (codec 8)
        let processedAudio = audioData;
        if (callData.remoteCodec === 8) {
            processedAudio = ulawToAlaw(audioData);
            if (!callData.codecConversionLogged) {
                console.log('[SipTrunk] Converting audio from μ-law to A-law for remote codec 8');
                callData.codecConversionLogged = true;
            }
        }

        // Queue all chunks for paced sending
        if (!callData.audioQueue) {
            callData.audioQueue = [];
        }

        while (offset < processedAudio.length) {
            const chunk = processedAudio.slice(offset, Math.min(offset + CHUNK_SIZE, processedAudio.length));
            callData.audioQueue.push(chunk);
            offset += CHUNK_SIZE;
        }

        // Start the pacing timer if not already running
        if (!callData.audioSendInterval) {
            callData.isSendingAudio = true;

            callData.audioSendInterval = setInterval(() => {
                if (callData.audioQueue.length === 0) {
                    // Queue empty, stop sending
                    clearInterval(callData.audioSendInterval);
                    callData.audioSendInterval = null;
                    callData.isSendingAudio = false;
                    callData.lastAudioSentTime = Date.now();
                    return;
                }

                const chunk = callData.audioQueue.shift();

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

                // Send to remote RTP endpoint
                const targetIp = callData.remoteRtpIp || this.serverIp;
                const targetPort = callData.remoteRtpPort || callData.rtpPort;

                try {
                    callData.rtpSocket.send(rtpPacket, targetPort, targetIp);
                } catch (err) {
                    // Socket might be closed, clear queue and stop
                    callData.audioQueue = [];
                }

                // Debug log occasionally
                if (!callData.rtpSendCount) callData.rtpSendCount = 0;
                callData.rtpSendCount++;
                if (callData.rtpSendCount === 1 || callData.rtpSendCount % 100 === 0) {
                    console.log(`[SipTrunk] Sent RTP audio #${callData.rtpSendCount} to ${targetIp}:${targetPort}`);
                }
            }, 20); // 20ms interval for 8kHz audio
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

        // Clear keep-alive interval
        if (callData.keepAliveInterval) {
            clearInterval(callData.keepAliveInterval);
            callData.keepAliveInterval = null;
        }

        // Clear audio send interval and queue
        if (callData.audioSendInterval) {
            clearInterval(callData.audioSendInterval);
            callData.audioSendInterval = null;
        }
        if (callData.audioQueue) {
            callData.audioQueue = [];
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
            // Clear keep-alive interval
            if (callData.keepAliveInterval) {
                clearInterval(callData.keepAliveInterval);
                callData.keepAliveInterval = null;
            }
            // Clear audio send interval and queue
            if (callData.audioSendInterval) {
                clearInterval(callData.audioSendInterval);
                callData.audioSendInterval = null;
            }
            if (callData.audioQueue) {
                callData.audioQueue = [];
            }
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
