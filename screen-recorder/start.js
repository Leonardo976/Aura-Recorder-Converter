// Suppress stderr output from Chromium
const originalStderrWrite = process.stderr.write.bind(process.stderr);

process.stderr.write = (chunk, encoding, callback) => {
    const output = chunk.toString();

    // Filter out WGC errors
    if (output.includes('wgc_capture_session') ||
        output.includes('ProcessFrame failed') ||
        output.includes('DxgiOutputDuplicator') ||
        output.includes('DxgiAdapterDuplicator') ||
        output.includes('DxgiDuplicatorController')) {
        // Suppress these errors
        if (typeof callback === 'function') callback();
        return true;
    }

    // Allow all other stderr output
    return originalStderrWrite(chunk, encoding, callback);
};

// Now require the main application
require('./main.js');
