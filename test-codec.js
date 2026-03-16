const alawmulaw = require('alawmulaw');

// Create a 1600-byte dummy mu-law buffer
const rawUlaw = Buffer.alloc(1600, 0xFF); // 0xFF is silence in mu-law

console.log('Original size:', rawUlaw.length);
try {
    const pcmSamples = alawmulaw.mulaw.decode(rawUlaw);
    console.log('PCM size (samples):', pcmSamples.length);
    const alawOutput = alawmulaw.alaw.encode(pcmSamples);
    console.log('Alaw size:', alawOutput.length);
    const finalBuf = Buffer.from(alawOutput);
    console.log('Final buffer size:', finalBuf.length);
} catch (e) {
    console.error('Error during conversion:', e);
}
