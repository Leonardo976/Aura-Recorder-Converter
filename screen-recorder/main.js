const { app, BrowserWindow, ipcMain, desktopCapturer, dialog, globalShortcut, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');

// Fix FFmpeg paths for packaged app
let ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
let ffprobePath = require('@ffprobe-installer/ffprobe').path;

// When app is packaged, binaries are in app.asar.unpacked
if (ffmpegPath.includes('app.asar')) {
    ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
}
if (ffprobePath.includes('app.asar')) {
    ffprobePath = ffprobePath.replace('app.asar', 'app.asar.unpacked');
}

// Set FFmpeg and FFprobe paths
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// Verify FFmpeg paths exist
console.log('FFmpeg path:', ffmpegPath);
console.log('FFprobe path:', ffprobePath);
console.log('FFmpeg exists:', fs.existsSync(ffmpegPath));
console.log('FFprobe exists:', fs.existsSync(ffprobePath));

// Suppress Chromium error messages (minimal configuration)
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');
app.commandLine.appendSwitch('log-level', '3'); // Only show fatal errors

let currentConversion = null;

let mainWindow;

// Filter out WGC error messages from console
const originalConsoleError = console.error;
console.error = (...args) => {
    const message = args.join(' ');
    // Suppress WGC capture errors (they don't affect functionality)
    if (message.includes('wgc_capture_session') ||
        message.includes('ProcessFrame failed')) {
        return; // Ignore these errors
    }
    // Log all other errors normally
    originalConsoleError.apply(console, args);
};

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        minWidth: 300,
        minHeight: 40,
        frame: false,
        transparent: false,
        backgroundColor: '#121212',
        show: false, // Don't show until ready
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            devTools: false // ESTO DESACTIVA EL DEVTOOLS
        }
    });

    // Remove the default menu (File, Edit, etc.)
    Menu.setApplicationMenu(null);

    // Disable DevTools shortcuts
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.control && input.shift && input.key.toLowerCase() === 'i') {
            event.preventDefault();
        }
        if (input.key === 'F12') {
            event.preventDefault();
        }
        if (input.control && input.shift && input.key.toLowerCase() === 'r') {
            event.preventDefault(); // Block hard reload
        }
        if (input.control && input.key.toLowerCase() === 'r') {
            event.preventDefault(); // Block reload checking
        }
        if (input.control && input.shift && input.key.toLowerCase() === 'c') {
            event.preventDefault();
        }
        if (input.control && input.shift && input.key.toLowerCase() === 'j') {
            event.preventDefault();
        }
    });

    mainWindow.loadFile('index.html');

    // Show window when ready to avoid white flash
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });
}

app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
    globalShortcut.unregisterAll();
    if (process.platform !== 'darwin') app.quit();
});

ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
    if (!mainWindow) return;
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('window-close', () => mainWindow?.close());

ipcMain.handle('get-sources', async (e, types) => {
    return await desktopCapturer.getSources({ types, thumbnailSize: { width: 400, height: 400 }, fetchWindowIcons: true });
});

// Get display information including refresh rates
ipcMain.handle('get-display-info', async () => {
    const { screen } = require('electron');
    const displays = screen.getAllDisplays();

    return displays.map(display => ({
        id: display.id,
        bounds: display.bounds,
        workArea: display.workArea,
        scaleFactor: display.scaleFactor,
        rotation: display.rotation,
        // displayFrequency is in Hz (e.g., 60, 120, 144, 165)
        refreshRate: display.displayFrequency || 60, // Default to 60Hz if not available
        isPrimary: display.bounds.x === 0 && display.bounds.y === 0
    }));
});

ipcMain.handle('save-file', async (e, { buffer, format, fps }) => {
    // Mapping
    const map = {
        'video/webm;codecs=vp9': 'webm',
        'video/webm;codecs=h264': 'webm',
        'video/x-matroska;codecs=avc1': 'mkv',
        'video/mp4': 'mp4',
        'audio/webm': 'webm',
        'audio/wav': 'wav',
        'audio/mp3': 'mp3'
    };
    const ext = map[format] || 'webm';
    // Cap FPS at 120 for MP4 to prevent encoding issues
    // Higher FPS (like 165) can cause ffmpeg errors and are rarely needed
    const maxSafeFps = ext === 'mp4' ? 120 : 240;
    const safeFps = fps ? Math.min(fps, maxSafeFps) : 30;

    const filterName = ext === 'wav' ? 'Audio WAV' :
        (ext === 'mp3' ? 'Audio MP3' :
            (ext === 'mp4' ? 'Video MP4' :
                (ext === 'mkv' ? 'Video MKV' : 'Video WebM')));

    // Default Directory Logic
    const videosPath = app.getPath('videos');
    const saveDir = path.join(videosPath, 'Aura Recordings');
    if (!fs.existsSync(saveDir)) {
        fs.mkdirSync(saveDir, { recursive: true });
    }

    const { filePath } = await dialog.showSaveDialog({
        buttonLabel: 'Guardar',
        defaultPath: path.join(saveDir, `grabacion-${Date.now()}.${ext}`),
        filters: [
            { name: filterName, extensions: [ext] },
            { name: 'Todos', extensions: ['*'] }
        ]
    });

    if (filePath) {
        // Fix: Use FFmpeg to process the file and ensure metadata/duration is correct
        // Write temp file first
        const tempPath = path.join(app.getPath('temp'), `temp-${Date.now()}.webm`);
        fs.writeFileSync(tempPath, Buffer.from(buffer));

        return new Promise((resolve, reject) => {
            let command = ffmpeg(tempPath);

            // Input options for better WebM handling
            command = command
                .inputFormat('webm')
                .inputOptions(['-fflags +genpts']);  // Generate presentation timestamps

            // Output logic based on extension
            if (ext === 'mp4' || ext === 'mkv') {
                // MP4 and MKV: H.264/AAC encoding with FPS control
                const isHighFps = safeFps > 60;

                command = command
                    .videoCodec('libx264')
                    .audioCodec('aac')
                    .videoFilters([
                        'scale=trunc(iw/2)*2:trunc(ih/2)*2',
                        'format=yuv420p'
                    ])
                    .outputOptions([
                        isHighFps ? '-preset veryfast' : '-preset ultrafast',
                        '-crf 23',
                        '-movflags +faststart',
                        '-vsync cfr',
                        `-r ${safeFps}`,
                        '-max_muxing_queue_size 1024'
                    ]);
            } else if (ext === 'webm') {
                // WebM: Stream copy (instant save, preserves FPS from recording)
                command = command.outputOptions(['-c copy']);
            } else if (ext === 'wav') {
                command = command.format('wav');
            } else if (ext === 'mp3') {
                command = command
                    .audioCodec('libmp3lame')
                    .audioBitrate('192k')
                    .format('mp3');
            }

            command
                .save(filePath)
                .on('start', (commandLine) => {
                    console.log('FFmpeg command:', commandLine);
                    // Send to renderer for visibility
                    if (mainWindow) {
                        mainWindow.webContents.send('ffmpeg-log', 'FFmpeg command: ' + commandLine);
                    }
                })
                .on('end', () => {
                    console.log('File saved and processed:', filePath);
                    if (mainWindow) {
                        mainWindow.webContents.send('ffmpeg-log', 'File saved successfully: ' + filePath);
                    }
                    try { fs.unlinkSync(tempPath); } catch (e) { }
                    resolve(filePath);
                })
                .on('error', (err, stdout, stderr) => {
                    const errorInfo = {
                        message: err.message,
                        fps: safeFps,
                        ext: ext,
                        outputPath: filePath,
                        tempPath: tempPath,
                        stderr: stderr || 'No stderr output'
                    };

                    console.error('=== FFmpeg Error ===');
                    console.error('Error:', err.message);
                    console.error('FPS attempted:', safeFps);
                    console.error('Extension:', ext);
                    console.error('Output path:', filePath);
                    console.error('Temp path:', tempPath);
                    if (stderr) console.error('FFmpeg stderr:', stderr);
                    console.error('===================');

                    // Send to renderer for visibility
                    if (mainWindow) {
                        mainWindow.webContents.send('ffmpeg-error', errorInfo);
                    }

                    try { fs.unlinkSync(tempPath); } catch (e) { }
                    resolve(null); // Return null on error so UI knows
                });
        });
    }
    return null;
});

ipcMain.on('set-mini-mode', (e, isMini) => {
    if (!mainWindow) return;

    if (isMini) {
        mainWindow.setMinimumSize(300, 40);
        mainWindow.setSize(320, 50);
        mainWindow.setAlwaysOnTop(true, 'screen-saver');
        mainWindow.setResizable(false);
    } else {
        mainWindow.setMinimumSize(800, 600);
        mainWindow.setSize(1000, 700);
        mainWindow.setAlwaysOnTop(false);
        mainWindow.setResizable(true);
        mainWindow.center();
    }
});

ipcMain.on('set-window-visibility', (e, mode) => {
    if (!mainWindow) return;
    if (mode === 'hidden') {
        const { screen } = require('electron');
        const display = screen.getDisplayNearestPoint(mainWindow.getBounds());
        const { x, y, width, height } = display.workArea;
        mainWindow.setSize(40, 60);
        mainWindow.setPosition(x + width - 40, y + Math.floor(height / 2));
        mainWindow.setAlwaysOnTop(true, 'screen-saver');
    } else {
        mainWindow.setSize(320, 50);
        mainWindow.setAlwaysOnTop(true, 'screen-saver');
    }
});

ipcMain.on('update-shortcuts', (e, binds) => {
    globalShortcut.unregisterAll();
    const reg = (k, a) => {
        try { if (k && k !== 'None') globalShortcut.register(k, () => mainWindow?.webContents.send('shortcut-triggered', a)); }
        catch (err) { console.log(err); }
    };
    reg(binds.pause, 'pause');
    reg(binds.stop, 'stop');
    reg(binds.mic, 'mic');
    reg(binds.sys, 'sys');
});

ipcMain.on('open-file-location', (e, path) => {
    const { shell } = require('electron');
    shell.showItemInFolder(path);
});

// ========== CONVERTER IPC HANDLERS ==========

// Select file to convert
ipcMain.handle('select-file-to-convert', async () => {
    const result = await dialog.showOpenDialog({
        title: 'Seleccionar archivo para convertir',
        filters: [
            { name: 'Video', extensions: ['webm', 'mp4', 'mkv', 'avi', 'mov', 'flv', 'm4v'] },
            { name: 'Audio', extensions: ['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a', 'wma'] },
            { name: 'Todos', extensions: ['*'] }
        ],
        properties: ['openFile']
    });

    return result.canceled ? null : result.filePaths[0];
});

// Get file info using FFprobe
ipcMain.handle('get-file-info', async (event, filePath) => {
    if (!filePath) {
        // Silent return for empty calls (happens on startup)
        return null;
    }

    console.log('📄 Getting file info for:', filePath);

    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) {
                console.error('❌ FFprobe error for file:', filePath);
                console.error('   Error:', err.message);
                resolve(null);
                return;
            }

            try {
                const videoStream = metadata.streams.find(s => s.codec_type === 'video');
                const audioStream = metadata.streams.find(s => s.codec_type === 'audio');

                const durationVal = parseFloat(metadata.format.duration);
                const safeDuration = (isFinite(durationVal) && durationVal > 0) ? durationVal : 0;

                // Use extension for cleaner UI display, fallback to ffprobe if needed
                const ext = path.extname(filePath).replace('.', '').toLowerCase();
                const probeFormat = metadata.format.format_name || '';
                const displayFormat = ext || probeFormat.split(',')[0];

                const info = {
                    filename: path.basename(filePath),
                    duration: safeDuration,
                    format: displayFormat,
                    size: metadata.format.size,
                    isVFR: false,  // NEW: Detect VFR
                    avgFps: null   // NEW: Average FPS
                };

                if (videoStream) {
                    info.resolution = `${videoStream.width}x${videoStream.height}`;
                    info.codec = videoStream.codec_name;

                    // CALCULATE REAL FPS using multiple methods
                    let realFps = null;

                    // Method 1: Use avg_frame_rate (most reliable for VFR)
                    if (videoStream.avg_frame_rate) {
                        const [num, den] = videoStream.avg_frame_rate.split('/').map(Number);
                        if (den && den !== 0) {
                            realFps = num / den;
                        }
                    }

                    // Method 2: Calculate from nb_frames and duration
                    if (!realFps || !isFinite(realFps)) {
                        const nbFrames = parseInt(videoStream.nb_frames);
                        const streamDuration = parseFloat(videoStream.duration) || safeDuration;
                        if (nbFrames > 0 && streamDuration > 0) {
                            realFps = nbFrames / streamDuration;
                        }
                    }

                    // Method 3: Use r_frame_rate if CFR
                    if (!realFps || !isFinite(realFps)) {
                        if (videoStream.r_frame_rate) {
                            const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
                            if (den && den !== 0) {
                                realFps = num / den;
                            }
                        }
                    }

                    // Detect VFR
                    const rFrameRate = videoStream.r_frame_rate ? eval(videoStream.r_frame_rate) : 0;
                    const avgFrameRate = videoStream.avg_frame_rate ? eval(videoStream.avg_frame_rate) : 0;
                    info.isVFR = rFrameRate === 0 || Math.abs(rFrameRate - avgFrameRate) > 1;

                    // Save real FPS (replaces avgFps)
                    info.realFps = realFps && isFinite(realFps) ? realFps : null;
                    info.avgFps = info.realFps; // Keep for backward compatibility

                    console.log(`=== FPS Analysis ===`);
                    console.log(`r_frame_rate: ${rFrameRate}`);
                    console.log(`avg_frame_rate: ${avgFrameRate}`);
                    console.log(`Real FPS (calculated): ${realFps}`);
                    console.log(`Is VFR: ${info.isVFR}`);
                    console.log(`===================`);
                }

                if (audioStream) {
                    info.audioCodec = audioStream.codec_name;
                    info.sampleRate = audioStream.sample_rate;
                }

                resolve(info);
            } catch (error) {
                console.error('Error parsing metadata:', error);
                resolve(null);
            }
        });
    });
});

// Convert file
ipcMain.handle('convert-file', async (event, { sourcePath, outputFormat, quality, fps }) => {
    console.log('Convert Request:', { sourcePath, outputFormat, quality, fps }); // Debug log
    return new Promise(async (resolve, reject) => {  // Make async
        try {
            // FIRST: Get file info to detect real FPS
            const fileInfo = await new Promise((res, rej) => {
                ffmpeg.ffprobe(sourcePath, (err, metadata) => {
                    if (err) {
                        rej(err);
                        return;
                    }

                    const videoStream = metadata.streams.find(s => s.codec_type === 'video');
                    if (!videoStream) {
                        res({ realFps: null, isVFR: false });
                        return;
                    }

                    // Calculate real FPS
                    let realFps = null;
                    if (videoStream.avg_frame_rate) {
                        const [num, den] = videoStream.avg_frame_rate.split('/').map(Number);
                        if (den && den !== 0) realFps = num / den;
                    }

                    if (!realFps || !isFinite(realFps)) {
                        const nbFrames = parseInt(videoStream.nb_frames);
                        const streamDuration = parseFloat(videoStream.duration) || parseFloat(metadata.format.duration);
                        if (nbFrames > 0 && streamDuration > 0) {
                            realFps = nbFrames / streamDuration;
                        }
                    }

                    const rFrameRate = videoStream.r_frame_rate ? eval(videoStream.r_frame_rate) : 0;
                    const avgFrameRate = videoStream.avg_frame_rate ? eval(videoStream.avg_frame_rate) : 0;
                    const isVFR = rFrameRate === 0 || Math.abs(rFrameRate - avgFrameRate) > 1;

                    res({ realFps, isVFR });
                });
            });

            console.log('File analysis for conversion:', fileInfo);

            // Determine output path
            const videosPath = app.getPath('videos');
            const saveDir = path.join(videosPath, 'Aura Conversions');
            if (!fs.existsSync(saveDir)) {
                fs.mkdirSync(saveDir, { recursive: true });
            }

            const sourceExt = path.extname(sourcePath);
            const baseName = path.basename(sourcePath, sourceExt);
            const outputPath = path.join(saveDir, `${baseName}-converted-${Date.now()}.${outputFormat}`);

            // Quality settings
            const qualitySettings = {
                high: { videoBitrate: '5000k', audioBitrate: '320k', crf: 18 },
                medium: { videoBitrate: '2500k', audioBitrate: '192k', crf: 23 },
                low: { videoBitrate: '1000k', audioBitrate: '128k', crf: 28 }
            };

            const settings = qualitySettings[quality] || qualitySettings.medium;

            // Start conversion
            let command = ffmpeg(sourcePath);
            const startTime = Date.now();

            // FPS logic
            let targetFps = null;
            console.log('=== FPS CONVERSION LOGIC ===');
            console.log('Input fps parameter:', fps);
            console.log('File info realFps:', fileInfo.realFps);

            if (fps && fps !== 'original' && fps !== 'auto') {
                const parsedFps = parseInt(fps);
                console.log('Parsed FPS:', parsedFps);
                if (!isNaN(parsedFps) && parsedFps > 0) {
                    targetFps = parsedFps;
                    console.log('✓ Using specific FPS (will force CFR):', targetFps);
                }
            } else if ((fps === 'original' || fps === 'auto') && fileInfo.realFps && isFinite(fileInfo.realFps)) {
                // KEY: Use detected real FPS instead of passthrough
                targetFps = Math.round(fileInfo.realFps);
                console.log('✓ Using detected real FPS:', targetFps);
            } else {
                console.log('✗ No valid FPS detected, targetFps will be null');
            }
            console.log('Final targetFps:', targetFps);
            console.log('============================');

            // Format-specific settings
            const audioFormats = ['mp3', 'wav', 'aac', 'ogg', 'flac'];
            const isAudioOnly = audioFormats.includes(outputFormat);

            if (isAudioOnly) {
                // Audio-only conversion
                command = command.noVideo();

                if (outputFormat === 'mp3') {
                    command = command.audioBitrate(settings.audioBitrate).audioCodec('libmp3lame');
                } else if (outputFormat === 'wav') {
                    command = command.audioCodec('pcm_s16le');
                } else if (outputFormat === 'aac') {
                    command = command.audioBitrate(settings.audioBitrate).audioCodec('aac');
                } else if (outputFormat === 'ogg') {
                    command = command.audioBitrate(settings.audioBitrate).audioCodec('libvorbis');
                } else if (outputFormat === 'flac') {
                    command = command.audioCodec('flac');
                }
            } else {
                // Video conversion
                const sourceExtension = path.extname(sourcePath).toLowerCase().substring(1);
                const canStreamCopy = (sourceExtension === outputFormat && !targetFps);

                console.log('=== VIDEO CONVERSION PATH ===');
                console.log('Source extension:', sourceExtension);
                console.log('Output format:', outputFormat);
                console.log('Target FPS:', targetFps);
                console.log('Can stream copy:', canStreamCopy);

                if (canStreamCopy) {
                    // Same format without FPS change: stream copy
                    console.log('→ Using stream copy (instant)');
                    command = command.outputOptions(['-c copy']);
                } else {
                    // Needs re-encoding
                    if (targetFps === null || targetFps === 'auto') {
                        console.log('→ Re-encoding WITHOUT specific FPS (VFR/auto mode)');
                        // Original FPS or Auto: Different behavior for VFR
                        const sourceExt = path.extname(sourcePath).toLowerCase().substring(1);
                        const canStreamCopy = (sourceExt === outputFormat);

                        if (canStreamCopy) {
                            // Same format: Use stream copy (instant)
                            command = command.outputOptions(['-c copy']);
                        } else {
                            // Different format: Reencode with proper VFR/CFR handling
                            if (outputFormat === 'mp4') {
                                command = command
                                    .videoCodec('libx264')
                                    .audioCodec('aac')
                                    .videoFilters([
                                        'scale=trunc(iw/2)*2:trunc(ih/2)*2',
                                        'format=yuv420p'
                                    ])
                                    .outputOptions([
                                        `-crf ${settings.crf}`,
                                        '-preset medium',
                                        '-movflags +faststart'
                                        // CRITICAL: Don't use -vsync 0 for MP4
                                        // If VFR, FFmpeg will use average FPS automatically
                                        // If CFR, passthrough will maintain original
                                    ]);
                            } else if (outputFormat === 'webm') {
                                command = command
                                    .videoCodec('libvpx-vp9')
                                    .audioCodec('libopus')
                                    .outputOptions([
                                        `-crf ${settings.crf}`,
                                        '-b:v 0'
                                        // WebM supports VFR, no fps_mode needed
                                    ]);
                            } else if (outputFormat === 'mkv') {
                                console.log('  → MKV with VFR mode');
                                command = command
                                    .videoCodec('libx264')
                                    .audioCodec('aac')
                                    .outputOptions([
                                        `-crf ${settings.crf}`,
                                        '-vsync vfr'  // MKV supports VFR natively
                                    ]);
                            } else if (outputFormat === 'avi') {
                                command = command
                                    .videoCodec('mpeg4')
                                    .audioCodec('libmp3lame')
                                    .videoBitrate(settings.videoBitrate);
                                // AVI will use average FPS automatically
                            }
                        }
                    } else {
                        console.log('→ Re-encoding WITH specific FPS (CFR mode):', targetFps);
                        // Specific FPS (30, 60, 90, 120): Force CFR
                        const targetFpsNum = parseInt(targetFps);

                        if (outputFormat === 'mp4') {
                            command = command
                                .videoCodec('libx264')
                                .audioCodec('aac')
                                .videoFilters([
                                    `fps=${targetFpsNum}`,
                                    'scale=trunc(iw/2)*2:trunc(ih/2)*2',
                                    'format=yuv420p'
                                ])
                                .outputOptions([
                                    `-crf ${settings.crf}`,
                                    '-preset medium',
                                    '-movflags +faststart',
                                    '-vsync cfr'
                                ]);
                        } else if (outputFormat === 'webm') {
                            command = command
                                .videoCodec('libvpx-vp9')
                                .audioCodec('libopus')
                                .videoFilters([`fps=${targetFpsNum}`])
                                .outputOptions([
                                    `-crf ${settings.crf}`,
                                    '-b:v 0',
                                    '-vsync cfr'
                                ]);
                        } else if (outputFormat === 'mkv') {
                            console.log('  → MKV with CFR mode, FPS:', targetFpsNum);

                            // Special handling for high FPS (120+)
                            const isHighFps = targetFpsNum >= 120;
                            const preset = isHighFps ? 'faster' : 'medium';

                            const filters = [
                                `fps=${targetFpsNum}`,
                                'scale=trunc(iw/2)*2:trunc(ih/2)*2',
                                'format=yuv420p'
                            ];

                            // For 120+ FPS, add setpts filter to force timestamp recalculation
                            if (isHighFps) {
                                // Reset PTS to force CFR timestamps
                                filters.push('setpts=PTS-STARTPTS');
                                console.log('  → Using high FPS mode with PTS reset');
                            }

                            const outputOptions = [
                                `-crf ${settings.crf}`,
                                `-preset ${preset}`,
                                '-vsync cfr',
                                `-r ${targetFpsNum}`,
                                '-x264-params force-cfr=1'  // CRITICAL: Force CFR at encoder level
                            ];

                            if (isHighFps) {
                                outputOptions.push('-force_key_frames expr:gte(t,n_forced*2)');
                            }

                            command = command
                                .videoCodec('libx264')
                                .audioCodec('aac')
                                .videoFilters(filters)
                                .outputOptions(outputOptions);
                        } else if (outputFormat === 'avi') {
                            command = command
                                .videoCodec('mpeg4')
                                .audioCodec('libmp3lame')
                                .videoFilters([`fps=${targetFpsNum}`])
                                .videoBitrate(settings.videoBitrate)
                                .outputOptions(['-vsync cfr']);
                        }
                    }
                }
                console.log('==============================');
            }

            // Progress tracking
            command.on('progress', (progress) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    const percent = progress.percent || 0;
                    mainWindow.webContents.send('conversion-progress', { percent, startTime });
                }
            });

            // Error handling
            command.on('error', (err) => {
                console.error('Conversion error:', err);
                currentConversion = null;
                resolve({ success: false, error: err.message });
            });

            // Success
            command.on('end', () => {
                console.log('Conversion completed:', outputPath);
                currentConversion = null;
                resolve({ success: true, outputPath });
            });

            // Save command reference for cancellation
            currentConversion = command;

            // Start conversion
            command.save(outputPath);

        } catch (error) {
            console.error('Conversion setup error:', error);
            resolve({ success: false, error: error.message });
        }
    });
});

// Cancel conversion
ipcMain.on('cancel-conversion', () => {
    if (currentConversion) {
        currentConversion.kill('SIGKILL');
        currentConversion = null;
    }
});

