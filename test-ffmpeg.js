const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');
const fs = require('fs');

const ffmpeg = spawn(ffmpegStatic, [
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-ar', '8000',
    '-ac', '1',
    '-acodec', 'pcm_mulaw',
    '-f', 'mulaw',
    'pipe:1'
]);

let ffmpegErr = '';
ffmpeg.stderr.on('data', (d) => { ffmpegErr += d.toString(); });

let totalBytes = 0;
ffmpeg.stdout.on('data', (chunk) => {
    totalBytes += chunk.length;
    console.log('Got chunk of', chunk.length, 'bytes');
});

ffmpeg.on('close', (code) => {
    console.log('Exit code:', code);
    console.log('Total bytes:', totalBytes);
    if (ffmpegErr) console.log('Stderr:', ffmpegErr);
});

fs.createReadStream('out.wav').pipe(ffmpeg.stdin);
