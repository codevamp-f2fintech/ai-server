// SIP Trunk Service
// Handles outbound calls via SIP protocol to a SIP trunk provider
// Uses UDP for SIP signaling and RTP for audio transport

const dgram = require('dgram');
const crypto = require('crypto');
const EventEmitter = require('events');

// Use the alawmulaw npm library for correct ITU-T G.711 codec conversion.
// This library implements the proper companding algorithm — cleaner than hand-rolled tables.
const alawmulaw = require('alawmulaw');

/**
 * Convert a μ-law buffer to A-law buffer using alawmulaw library
 * alawmulaw.mulaw.decode → 16-bit samples → alawmulaw.alaw.encode → A-law bytes
 */
function ulawToAlaw(ulawBuffer) {
    // Decode μ-law → 16-bit linear PCM
    const pcmSamples = alawmulaw.mulaw.decode(ulawBuffer);
    // Encode 16-bit linear PCM → A-law
    return Buffer.from(alawmulaw.alaw.encode(pcmSamples));
}

/**
 * Convert an A-law buffer to μ-law buffer using alawmulaw library
 */
function alawToUlaw(alawBuffer) {
    // Decode A-law → 16-bit linear PCM
    const pcmSamples = alawmulaw.alaw.decode(alawBuffer);
    // Encode 16-bit linear PCM → μ-law
    return Buffer.from(alawmulaw.mulaw.encode(pcmSamples));
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

        // SDP for audio - offer PCMU first (preferred), then PCMA as fallback
        // Provider may require A-law (PCMA) due to regional standards
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
    createAckRequest(toNumber, callId, fromTag, toTag, cseq, localIp, localSipPort = 5060, contactUri = null, routeHeader = null) {
        let cleanTo = toNumber.replace(/^\+/, '');
        if (cleanTo.startsWith('91') && cleanTo.length > 10) cleanTo = cleanTo.substring(2);

        let uri = `sip:${cleanTo}@${this.serverIp}:${this.port}`;
        if (contactUri) {
            uri = contactUri.startsWith('sip:') ? contactUri : `sip:${contactUri}`;
        }

        const fromUri = `sip:${this.fromNumber}@${this.serverIp}`;
        const toUri = `sip:${toNumber}@${this.serverIp}`;
        const branch = this.generateBranch();

        const request = [
            `ACK ${uri} SIP/2.0`,
            `Via: SIP/2.0/UDP ${localIp}:${localSipPort};rport;branch=${branch}`,
            `Max-Forwards: 70`,
            `From: <${fromUri}>;tag=${fromTag}`,
            `To: <${toUri}>;tag=${toTag}`,
            `Call-ID: ${callId}`,
            `CSeq: ${cseq} ACK`
        ];

        if (routeHeader) {
            request.push(`Route: ${routeHeader}`);
        }

        request.push(
            `Content-Length: 0`,
            '',
            ''
        );

        return request.join('\r\n');
    }

    /**
     * Create SIP BYE request
     */
    createByeRequest(toNumber, callId, fromTag, toTag, cseq, localIp, localSipPort = 5060, contactUri = null, routeHeader = null) {
        let cleanTo = toNumber.replace(/^\+/, '');
        if (cleanTo.startsWith('91') && cleanTo.length > 10) cleanTo = cleanTo.substring(2);

        // BUG FIX: From URI must use the SIP *username* (registered identity, e.g. "2002"),
        // NOT the fromNumber. The original INVITE used username as From, so the BYE must
        // match it exactly — otherwise the SIP trunk rejects the BYE (dialog mismatch).
        const fromUri = `sip:${this.username}@${this.serverIp}`;
        const toUri = `sip:${cleanTo}@${this.serverIp}`;

        let uri = `sip:${cleanTo}@${this.serverIp}:${this.port}`;
        if (contactUri) {
            uri = contactUri.startsWith('sip:') ? contactUri : `sip:${contactUri}`;
        }

        const branch = this.generateBranch();

        const request = [
            `BYE ${uri} SIP/2.0`,
            `Via: SIP/2.0/UDP ${localIp}:${localSipPort};rport;branch=${branch}`,
            `Max-Forwards: 70`,
            `From: <${fromUri}>;tag=${fromTag}`,
            `To: <${toUri}>;tag=${toTag}`,
            `Call-ID: ${callId}`,
            `CSeq: ${cseq} BYE`
        ];

        if (routeHeader) {
            request.push(`Route: ${routeHeader}`);
        }

        request.push(
            `Content-Length: 0`,
            '',
            ''
        );

        return request.join('\r\n');
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
                if (response.headers[key]) {
                    response.headers[key] += `, ${value}`; // Handle multiple headers (e.g. Record-Route)
                } else {
                    response.headers[key] = value;
                }
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

        // Parse Contact URI
        if (response.headers['contact']) {
            const contactMatch = response.headers['contact'].match(/<([^>]+)>/);
            if (contactMatch) {
                response.contactUri = contactMatch[1];
            } else {
                // Sometime Contact is just the URI
                response.contactUri = response.headers['contact'].trim();
            }
        }

        // Parse Record-Route
        if (response.headers['record-route']) {
            response.recordRoute = response.headers['record-route'];
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
                answered: false,     // Track if 200 OK already processed
                contactUri: null,    // Store Contact URI for future requests (ACK, BYE)
                recordRoute: null    // Store Record-Route for future requests (ACK, BYE)
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
                        callData.callEnded = true; // Stop sendAudio from queuing more packets

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
                        // Handle re-INVITE: respond with 200 OK + SDP to keep call alive
                        console.log('[SipTrunk] Received re-INVITE, responding with 200 OK');

                        // Update RTP endpoint if new SDP is present
                        if (response.sdp) {
                            if (response.sdp.remoteIp && response.sdp.remoteRtpPort) {
                                const oldIp = callData.remoteRtpIp;
                                const oldPort = callData.remoteRtpPort;
                                callData.remoteRtpIp = response.sdp.remoteIp;
                                callData.remoteRtpPort = response.sdp.remoteRtpPort;
                                if (oldIp !== callData.remoteRtpIp || oldPort !== callData.remoteRtpPort) {
                                    console.log(`[SipTrunk] RTP endpoint updated (re-INVITE): ${oldIp}:${oldPort} -> ${callData.remoteRtpIp}:${callData.remoteRtpPort}`);
                                    callData.endpointLockoutUntil = Date.now() + 5000;
                                    callData.sdpRerouteOccurred = true;
                                }
                            }
                        }

                        // Build 200 OK response with our SDP (PCMU only)
                        const reInviteSdp = [
                            'v=0',
                            `o=- ${Date.now()} ${Date.now()} IN IP4 ${localIp}`,
                            's=VaniVoiceAI',
                            `c=IN IP4 ${localIp}`,
                            't=0 0',
                            `m=audio ${callData.rtpPort} RTP/AVP 0 8`,
                            'a=rtpmap:0 PCMU/8000',
                            'a=rtpmap:8 PCMA/8000',
                            'a=ptime:20',
                            'a=sendrecv',
                            ''
                        ].join('\r\n');

                        const reInviteOk = [
                            `SIP/2.0 200 OK`,
                            `Via: ${response.headers?.via || ''}`,
                            `From: ${response.headers?.from || ''}`,
                            `To: ${response.headers?.to || ''}`,
                            `Call-ID: ${response.headers?.['call-id'] || callId}`,
                            `CSeq: ${response.headers?.cseq || '1 INVITE'}`,
                            `Contact: <sip:${this.username}@${localIp}:${callData.localSipPort}>`,
                            `Content-Type: application/sdp`,
                            `Content-Length: ${reInviteSdp.length}`,
                            '',
                            reInviteSdp
                        ].join('\r\n');

                        socket.send(Buffer.from(reInviteOk), rinfo.port, rinfo.address);
                        console.log('[SipTrunk] Sent 200 OK for re-INVITE');
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
                            console.log('[SipTrunk] 200 OK already processed, ignoring duplicate (but resending ACK)');
                        }

                        // Resend ACK for duplicate 200 OK (important to avoid provider timeout)
                        // Determine correct destination for ACK (use Route if present)
                        let ackTargetIp = this.serverIp;
                        let ackTargetPort = this.port;
                        if (callData.recordRoute) {
                            const routeMatch = callData.recordRoute.match(/<sip:([^;>\s:]+)(?::(\d+))?/i);
                            if (routeMatch) {
                                ackTargetIp = routeMatch[1];
                                ackTargetPort = routeMatch[2] ? parseInt(routeMatch[2]) : this.port;
                            }
                        }

                        socket.send(ack, ackTargetPort, ackTargetIp);
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
                        if (!callData.initialRtpIp) {
                            callData.initialRtpIp = callData.remoteRtpIp;
                        }
                        console.log(`[SipTrunk] Remote RTP endpoint: ${callData.remoteRtpIp}:${callData.remoteRtpPort}`);
                    } else {
                        // Fallback to server IP and local port if no SDP
                        callData.remoteRtpIp = this.serverIp;
                        callData.remoteRtpPort = callData.rtpPort;
                        callData.remoteCodec = 0;
                        if (!callData.initialRtpIp) {
                            callData.initialRtpIp = callData.remoteRtpIp;
                        }
                        console.warn('[SipTrunk] No SDP in 200 OK, using fallback RTP endpoint');
                    }

                    // Save URI and routes for future requests (ACK, BYE)
                    if (response.contactUri) callData.contactUri = response.contactUri;
                    if (response.recordRoute) callData.recordRoute = response.recordRoute;

                    // Determine correct destination for ACK (use Route if present)
                    let ackTargetIp = this.serverIp;
                    let ackTargetPort = this.port;
                    if (callData.recordRoute) {
                        const routeMatch = callData.recordRoute.match(/<sip:([^;>\s:]+)(?::(\d+))?/i);
                        if (routeMatch) {
                            ackTargetIp = routeMatch[1];
                            ackTargetPort = routeMatch[2] ? parseInt(routeMatch[2]) : this.port;
                        }
                    }

                    // Send ACK
                    const ack = this.createAckRequest(
                        toNumber, callId, fromTag, response.toTag, callData.cseq, localIp, callData.localSipPort, callData.contactUri, callData.recordRoute
                    );
                    socket.send(ack, ackTargetPort, ackTargetIp);

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
            // BUT: Disable if we had a forced SDP re-route and the packet is from the old IP!
            if (rinfo.address !== callData.remoteRtpIp || rinfo.port !== callData.remoteRtpPort) {
                // If SDP re-route happened, check if the packet is from the exact old dead IP.
                // If so, ignore it - it's delayed/duplicate packets from the initial provider node.
                if (callData.sdpRerouteOccurred && rinfo.address === callData.initialRtpIp) {
                    // Ignore stale packets from original proxy
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
                // Emit raw audio with codec type - no conversion needed.
                // DeepgramService will be told the correct encoding (alaw or mulaw)
                // so it handles the codec natively without any table conversion.
                this.emit('audio_in', {
                    callId: callData.callId,
                    internalCallId: callData.internalCallId,
                    audio: audioPayload,
                    codec: callData.remoteCodec || 0  // 0=PCMU, 8=PCMA
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

            // Suppress keep-alive for 200ms after last real RTP packet
            // This prevents silence packets from interleaving between ElevenLabs streaming chunks
            // (which arrive in rapid succession with brief gaps between them)
            const timeSinceLastRtp = Date.now() - (callData.lastRtpSentTime || 0);
            if (timeSinceLastRtp < 200) {
                return;
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

        // Don't send audio if call is already ended (BYE received)
        if (callData.callEnded) {
            return;
        }

        // Convert μ-law to A-law if remote codec is 8 (PCMA)
        // ElevenLabs outputs μ-law (ulaw_8000), but remote negotiates A-law (codec 8)
        let processedAudio = audioData;
        if (callData.remoteCodec === 8) {
            processedAudio = ulawToAlaw(audioData);
            if (!callData.codecConversionLogged) {
                console.log('[SipTrunk] Converting audio μ-law → A-law for remote codec 8 (PCMA)');
                callData.codecConversionLogged = true;
            }
        }

        // 160 bytes = one 20ms frame at 8kHz G.711
        const CHUNK_SIZE = 160;

        // Queue all chunks for paced sending
        if (!callData.audioQueue) {
            callData.audioQueue = [];
        }
        if (!callData.audioCarryBuffer) {
            callData.audioCarryBuffer = Buffer.alloc(0);
        }

        // Prepend any leftover bytes from the previous sendAudio call
        // This ensures we never send partial (< 160 byte) RTP frames in the middle of a stream
        const combined = Buffer.concat([callData.audioCarryBuffer, processedAudio]);
        callData.audioCarryBuffer = Buffer.alloc(0);

        let off2 = 0;
        while (off2 + CHUNK_SIZE <= combined.length) {
            callData.audioQueue.push(combined.slice(off2, off2 + CHUNK_SIZE));
            off2 += CHUNK_SIZE;
        }

        // Keep remaining bytes for next call to join with (avoids short intermediate frames)
        if (off2 < combined.length) {
            callData.audioCarryBuffer = Buffer.from(combined.slice(off2));
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
                    this.emit('playback_complete', callId);
                    return;
                }

                const chunk = callData.audioQueue.shift();

                // Pad to exactly 160 bytes with codec-correct silence if needed
                // (handles the very last chunk of a TTS burst that didn't fill a full frame)
                let frameChunk = chunk;
                if (chunk.length < CHUNK_SIZE) {
                    const silenceByte = callData.remoteCodec === 8 ? 0xD5 : 0xFF;
                    frameChunk = Buffer.alloc(CHUNK_SIZE, silenceByte);
                    chunk.copy(frameChunk, 0);
                }

                // Create RTP packet
                const header = Buffer.alloc(12);
                header.writeUInt8(0x80, 0); // Version 2, no padding, no extension, no CSRC

                // Set Marker bit on first packet of each speech segment (jitter buffer hint)
                const isFirstPacket = !callData.lastAudioSentTime || (Date.now() - callData.lastAudioSentTime) > 200;
                const payloadType = (callData.remoteCodec || 0x00) | (isFirstPacket ? 0x80 : 0x00);
                header.writeUInt8(payloadType, 1);
                header.writeUInt16BE(callData.rtpSequence++ & 0xFFFF, 2);
                header.writeUInt32BE(callData.rtpTimestamp, 4);
                header.writeUInt32BE(callData.ssrc, 8);

                const rtpPacket = Buffer.concat([header, frameChunk]);

                // Always advance by exactly 160 samples (20ms) to keep clock grid aligned
                callData.rtpTimestamp += CHUNK_SIZE;

                // Send to remote RTP endpoint
                const targetIp = callData.remoteRtpIp || this.serverIp;
                const targetPort = callData.remoteRtpPort || callData.rtpPort;

                try {
                    callData.rtpSocket.send(rtpPacket, targetPort, targetIp);
                    // Track exact time of last real audio packet for keep-alive suppression
                    callData.lastRtpSentTime = Date.now();
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
     * Flush any remaining carry-buffer bytes as a final padded RTP packet.
     * Called after ElevenLabs TTS stream completes to avoid losing the tail.
     */
    flushCarryBuffer(callId) {
        const callData = this.activeCalls.get(callId);
        if (!callData || !callData.audioCarryBuffer || callData.audioCarryBuffer.length === 0) return;
        if (callData.callEnded) return;

        const CHUNK_SIZE = 160;

        // IMPORT: audioCarryBuffer already holds bytes that need to be padded.
        // Pad with codec-correct silence to exactly 160 bytes.
        const silenceByte = callData.remoteCodec === 8 ? 0xD5 : 0xFF; // A-law or μ-law silence
        const frameChunk = Buffer.alloc(CHUNK_SIZE, silenceByte);
        callData.audioCarryBuffer.copy(frameChunk, 0);  // carry bytes at start, silence padding at end
        callData.audioCarryBuffer = Buffer.alloc(0);

        // In previous logic (sendAudio line 1075), we already converted to A-law (PCMA)
        // if remoteCodec === 8. Redundant conversion here caused noise/distortion. 
        const finalFrameChunk = frameChunk;

        if (!callData.audioQueue) callData.audioQueue = [];
        callData.audioQueue.push(finalFrameChunk);

        // Explicitly append 3 silence packets (60ms) to the queue as a "tail"
        // This ensures the final word is never clipped by the remote jitter buffer.
        // Doing this here (at end of turn) prevents stuttering between TTS chunks. 
        const silenceByteForTail = callData.remoteCodec === 8 ? 0xD5 : 0xFF;
        const silenceTailPacket = Buffer.alloc(CHUNK_SIZE, silenceByteForTail);
        callData.audioQueue.push(silenceTailPacket);
        callData.audioQueue.push(silenceTailPacket);
        callData.audioQueue.push(silenceTailPacket);

        // Start pacing timer if not already running
        if (!callData.audioSendInterval) {
            callData.isSendingAudio = true;
            callData.audioSendInterval = setInterval(() => {
                if (!callData.audioQueue || callData.audioQueue.length === 0) {
                    clearInterval(callData.audioSendInterval);
                    callData.audioSendInterval = null;
                    callData.isSendingAudio = false;
                    callData.lastAudioSentTime = Date.now();
                    this.emit('playback_complete', callId);
                    return;
                }
                const chunk = callData.audioQueue.shift();
                const header = Buffer.alloc(12);
                header.writeUInt8(0x80, 0);
                const isFirstPacket = !callData.lastAudioSentTime || (Date.now() - callData.lastAudioSentTime) > 200;
                const payloadType = (callData.remoteCodec || 0x00) | (isFirstPacket ? 0x80 : 0x00);
                header.writeUInt8(payloadType, 1);
                header.writeUInt16BE(callData.rtpSequence++ & 0xFFFF, 2);
                header.writeUInt32BE(callData.rtpTimestamp, 4);
                header.writeUInt32BE(callData.ssrc, 8);
                callData.rtpTimestamp += CHUNK_SIZE;
                const rtpPacket = Buffer.concat([header, chunk]);
                const targetIp = callData.remoteRtpIp || this.serverIp;
                const targetPort = callData.remoteRtpPort || callData.rtpPort;
                try { callData.rtpSocket.send(rtpPacket, targetPort, targetIp); } catch (e) { }
            }, 20);
        }
    }

    /**
     * Get the negotiated RTP codec for a call (0=PCMU, 8=PCMA)
     */
    getCallCodec(sipCallId) {
        // sipCallId can be either the SIP Call-ID or the internal internalCallId
        for (const [, cd] of this.activeCalls) {
            if (cd.callId === sipCallId || cd.internalCallId === sipCallId) {
                return cd.remoteCodec || 0;
            }
        }
        return 0; // default PCMU
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

        // Mark call as ended so no more audio is queued
        callData.callEnded = true;

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
            localIp,
            callData.localSipPort,
            callData.contactUri,
            callData.recordRoute
        );

        // RFC 3261 ROUTING RULES:
        // 1. If Route set is NOT empty, send to first URI in Route set.
        // 2. If Route set is empty, send to remote target (Contact).
        let byeTargetIp = this.serverIp;
        let byeTargetPort = this.port;

        if (callData.recordRoute) {
            // Parse host:port from Record-Route set (usually <sip:host:port;lr>)
            // We take the first proxy in the set.
            const routeMatch = callData.recordRoute.match(/<sip:([^;>\s:]+)(?::(\d+))?/i);
            if (routeMatch) {
                byeTargetIp = routeMatch[1];
                byeTargetPort = routeMatch[2] ? parseInt(routeMatch[2]) : this.port;
                console.log(`[SipTrunk] Route set detected, targeting proxy: ${byeTargetIp}:${byeTargetPort}`);
            }
        } else if (callData.contactUri) {
            // Parse host:port from sip:user@host:port;params
            const contactMatch = callData.contactUri.match(/sip:[^@]+@([^;>\s:]+)(?::(\d+))?/i);
            if (contactMatch) {
                byeTargetIp = contactMatch[1];
                byeTargetPort = contactMatch[2] ? parseInt(contactMatch[2]) : this.port;
                console.log(`[SipTrunk] No route set, targeting remote contact: ${byeTargetIp}:${byeTargetPort}`);
            }
        }

        console.log(`[SipTrunk] Sending BYE to ${byeTargetIp}:${byeTargetPort} (callId: ${callId})`);
        console.log('[SipTrunk] BYE message:\n' + bye);

        await new Promise((resolve) => {
            callData.socket.send(bye, byeTargetPort, byeTargetIp, (err) => {
                if (err) console.error('[SipTrunk] Error sending BYE:', err);
                else console.log('[SipTrunk] BYE sent successfully');
                resolve();
            });
        });

        // Cleanup AFTER BYE is confirmed sent
        await new Promise(r => setTimeout(r, 200)); // Grace period for network buffers

        if (callData.rtpSocket) {
            try { callData.rtpSocket.close(); } catch (e) { }
        }
        try { callData.socket.close(); } catch (e) { }
        this.activeCalls.delete(callId);

        this.emit('ended', { callId, internalCallId: callData.internalCallId });
    }

    /**
     * Clear the audio queue (stop current playback)
     * Automatically ignores interruptions within 1 second of last queue clear 
     * or if the AI is actively starting to speak, to prevent echo/noise truncation.
     */
    clearAudioQueue(callId, force = false) {
        const callData = this.activeCalls.get(callId);
        if (callData) {
            // Anti-echo block: if we're actively pumping audio, and a tiny bit of noise comes in,
            // don't instantly wipe the whole queue unless it's a real interruption.
            // Raised from 50 → 150: Chatterbox delivers audio in ONE large burst, so a long
            // Hindi sentence can fill 200+ packets instantly. 50 packets (1s) was too low.
            // EXCEPTION: force=true bypasses this (used for explicit barge-in from user speech)
            if (!force && callData.audioQueue && callData.audioQueue.length > 150) {
                 // > 150 packets = ~3 seconds of audio. Almost certainly an echo of the AI's own voice.
                 console.log(`[SipTrunk] Ignoring clearAudioQueue (anti-echo protection, ${callData.audioQueue.length} packets remain) for call ${callId}`);
                 return;
            }


            if (callData.audioSendInterval) {
                clearInterval(callData.audioSendInterval);
                callData.audioSendInterval = null;
            }
            callData.audioQueue = [];
            callData.audioCarryBuffer = Buffer.alloc(0);
            callData.isSendingAudio = false;
            callData.lastAudioSentTime = Date.now();
            if (force) {
                console.log(`[SipTrunk] Audio queue force-cleared (barge-in) for call ${callId}`);
            }
            this.emit('playback_complete', callId);
        }
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
