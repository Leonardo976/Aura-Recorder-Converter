const { ipcRenderer, webUtils } = require('electron');

// State
let mediaRecorder;
let recordedChunks = [];
let stream = null;
let micStream = null;
let combinedStream = null;
let isRecording = false;
let isPaused = false;
let timerInterval;
let seconds = 0;
let isMicMuted = false;
let isSysMuted = false;
let actualRecordingFps = null; // Store the actual FPS used for recording (after adjustment)

// Keybinds (default)
let keybinds = { pause: 'F9', stop: 'F10', mic: 'F11', sys: 'F8' };
let currentListeningButton = null;
let previousView = 'menu'; // Track navigation history
let currentBlobUrl = null; // Track current blob URL for cleanup

// DOM
const views = {
    menu: document.getElementById('main-menu'),
    selection: document.getElementById('source-selection'),
    recording: document.getElementById('recording-view'),
    review: document.getElementById('review-view'),
    mini: document.getElementById('mini-bar-view')
};
const windowControls = document.getElementById('window-controls');
const btnRecordScreen = document.getElementById('btn-record-screen');
const btnRecordApp = document.getElementById('btn-record-app');
const btnBack = document.getElementById('btn-back-to-menu');
const btnSettings = document.getElementById('btn-settings');
const btnStart = document.getElementById('btn-start-recording');
const btnPause = document.getElementById('btn-pause');
const btnResume = document.getElementById('btn-resume');
const btnStop = document.getElementById('btn-stop');
const btnMic = document.getElementById('btn-mic-toggle');
const btnSys = document.getElementById('btn-sys-toggle');
const btnMini = document.getElementById('btn-mini-mode');
const btnMiniStart = document.getElementById('btn-mini-start');
const btnMiniPause = document.getElementById('btn-mini-pause');
const btnMiniResume = document.getElementById('btn-mini-resume');
const btnMiniStop = document.getElementById('btn-mini-stop');
const btnMiniMic = document.getElementById('btn-mini-mic');
const btnMiniSys = document.getElementById('btn-mini-sys');
const btnMiniExpand = document.getElementById('btn-mini-expand');
const btnMiniHide = document.getElementById('btn-mini-hide');
const btnSave = document.getElementById('btn-save');
const btnDiscard = document.getElementById('btn-discard');
const livePreview = document.getElementById('live-preview');
const recordedVideo = document.getElementById('recorded-video');
const sourcesGrid = document.getElementById('sources-grid');
const timerDisplay = document.getElementById('recording-timer');
const miniTimer = document.getElementById('mini-timer');
const countdownOverlay = document.getElementById('countdown-overlay');
const countdownNumber = document.getElementById('countdown-number');
const hiddenRestoreBtn = document.getElementById('hidden-restore-btn');

// Custom Modal System
function showModal(title, text, isConfirm = false) {
    return new Promise((resolve) => {
        const container = document.getElementById('custom-modal-container');
        container.innerHTML = `
            <div class="custom-modal-overlay">
                <div class="custom-modal-box">
                    <div class="modal-icon"><i class="ph ph-info"></i></div>
                    <div class="modal-title">${title}</div>
                    <div class="modal-desc">${text}</div>
                    <div class="modal-actions">
                        ${isConfirm ? '<button class="modal-btn cancel" id="modal-cancel">Cancelar</button>' : ''}
                        <button class="modal-btn confirm" id="modal-confirm">Aceptar</button>
                    </div>
                </div>
            </div>
        `;

        const confirmBtn = document.getElementById('modal-confirm');
        const cancelBtn = document.getElementById('modal-cancel');

        confirmBtn.focus();

        const close = (val) => {
            const overlay = container.querySelector('.custom-modal-overlay');
            overlay.style.opacity = '0';
            setTimeout(() => { container.innerHTML = ''; resolve(val); }, 300);
        };

        confirmBtn.onclick = () => close(true);
        if (cancelBtn) cancelBtn.onclick = () => close(false);
    });
}

// Window Controls
document.getElementById('btn-win-min').addEventListener('click', () => ipcRenderer.send('window-minimize'));
document.getElementById('btn-win-max').addEventListener('click', () => ipcRenderer.send('window-maximize'));
document.getElementById('btn-win-close').addEventListener('click', async () => {
    if (isRecording) {
        if (await showModal('¿Salir?', 'Si sales ahora, la grabación se perderá.', true)) ipcRenderer.send('window-close');
    } else {
        if (await showModal('¿Cerrar aplicación?', '¿Seguro que quieres salir?', true)) ipcRenderer.send('window-close');
    }
});

// Splash Screen Logic
window.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
        const splash = document.getElementById('splash-screen');
        if (splash) {
            splash.classList.add('fade-out');
            setTimeout(() => splash.remove(), 500);
        }
    }, 2000); // 2 seconds splash
});

// Navigation
function showView(name) {
    Object.values(views).forEach(v => v.classList.add('hidden'));
    views[name].classList.remove('hidden');

    // HIDE WINDOW CONTROLS IN MINI MODE
    if (name === 'mini') {
        ipcRenderer.send('set-mini-mode', true);
        if (windowControls) windowControls.style.display = 'none';
    } else {
        ipcRenderer.send('set-mini-mode', false);
        if (windowControls) windowControls.style.display = 'flex';
    }

    hiddenRestoreBtn.classList.add('hidden');
}

// Source Selection
btnRecordScreen.addEventListener('click', () => loadSources('screen'));
btnRecordApp.addEventListener('click', () => loadSources('window'));
btnBack.addEventListener('click', () => showView('menu'));

const btnBackFromRecording = document.getElementById('btn-back-from-recording');
if (btnBackFromRecording) {
    btnBackFromRecording.addEventListener('click', () => {
        // Stop any active streams
        if (stream) stream.getTracks().forEach(t => t.stop());
        if (micStream) micStream.getTracks().forEach(t => t.stop());
        if (combinedStream) combinedStream.getTracks().forEach(t => t.stop());
        // Return to source selection, not main menu
        showView('selection');
    });
}


async function loadSources(type) {
    const sources = await ipcRenderer.invoke('get-sources', [type]);
    sourcesGrid.innerHTML = '';
    sources.forEach(source => {
        const item = document.createElement('div');
        item.className = 'source-item';
        item.innerHTML = `<img src="${source.thumbnail.toDataURL()}"><span>${source.name}</span>`;
        item.addEventListener('click', () => selectSource(source, type));
        sourcesGrid.appendChild(item);
    });
    previousView = 'menu'; // Track that we came from menu
    showView('selection');
}

// FPS Warning Toast System
function showFpsWarning(requestedFps, maxFps, sourceType, sourceName) {
    const container = document.getElementById('fps-warning-container');

    const sourceTypeText = sourceType === 'screen' ? 'pantalla' : 'aplicación';
    const message = `Esta ${sourceTypeText} no permite grabación a ${requestedFps} FPS, se configuró a un máximo de ${maxFps} FPS`;

    const toast = document.createElement('div');
    toast.className = 'fps-warning-toast';
    toast.innerHTML = `
        <i class="ph ph-warning"></i>
        <div class="fps-warning-content">
            <div class="fps-warning-title">FPS Ajustado Automáticamente</div>
            <div class="fps-warning-message">${message}</div>
            <div class="fps-warning-source">${sourceName}</div>
        </div>
    `;

    container.appendChild(toast);

    // Trigger animation
    setTimeout(() => toast.classList.add('show'), 10);

    // Auto-dismiss after 5 seconds
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

// Detect display for a given source
async function getDisplayForSource(source, sourceType) {
    const displays = await ipcRenderer.invoke('get-display-info');

    if (sourceType === 'screen') {
        // For screens, try to match by name or use primary display
        // Screen sources typically have display info in their name
        const displayName = source.name.toLowerCase();

        // Try to find matching display
        for (const display of displays) {
            // If it's the primary display and source name suggests it
            if (display.isPrimary && (displayName.includes('primary') || displayName.includes('principal') || displayName.includes('1'))) {
                return display;
            }
        }

        // If multiple displays, try to match by index
        if (displays.length > 1) {
            const match = source.name.match(/(\d+)/);
            if (match) {
                const index = parseInt(match[1]) - 1;
                if (index >= 0 && index < displays.length) {
                    return displays[index];
                }
            }
        }
    }

    // Default to primary display or first display
    return displays.find(d => d.isPrimary) || displays[0];
}

async function selectSource(source, sourceType = 'screen') {
    showView('recording');
    resetControls();

    try {
        let requestedFps = parseInt(document.getElementById('fps-select').value);
        const res = parseInt(document.getElementById('res-select').value);

        // Detect display and validate FPS
        const display = await getDisplayForSource(source, sourceType);
        const maxRefreshRate = display ? display.refreshRate : 60;

        let actualFps = requestedFps;
        let fpsAdjusted = false;

        // Validate and adjust FPS if necessary
        if (requestedFps > maxRefreshRate) {
            actualFps = maxRefreshRate;
            fpsAdjusted = true;
            console.log(`FPS adjusted: ${requestedFps} -> ${actualFps} (Display max: ${maxRefreshRate}Hz)`);
        }

        // CRITICAL: Store the actual FPS being used for recording
        actualRecordingFps = actualFps;

        stream = await navigator.mediaDevices.getUserMedia({
            audio: { mandatory: { chromeMediaSource: 'desktop' } },
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: source.id,
                    minHeight: res,
                    minFrameRate: actualFps,
                    maxFrameRate: actualFps
                }
            }
        });

        // Show warning if FPS was adjusted
        if (fpsAdjusted) {
            showFpsWarning(requestedFps, actualFps, sourceType, source.name);
        }

        // Log actual FPS being captured
        const videoTrack = stream.getVideoTracks()[0];
        if (videoTrack) {
            const settings = videoTrack.getSettings();
            console.log('=== VIDEO CAPTURE SETTINGS ===');
            console.log('Requested FPS:', requestedFps);
            console.log('Adjusted FPS:', actualFps);
            console.log('Actual FPS:', settings.frameRate);
            console.log('Display Refresh Rate:', maxRefreshRate);
            console.log('Resolution:', settings.width, 'x', settings.height);
            console.log('==============================');
        }

        try {
            micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            micStream.getAudioTracks().forEach(t => t.enabled = !isMicMuted);
        } catch (e) { console.warn('No mic found'); }

        if (micStream && stream.getAudioTracks().length > 0) {
            const ctx = new AudioContext();
            const dest = ctx.createMediaStreamDestination();
            ctx.createMediaStreamSource(stream).connect(dest);
            ctx.createMediaStreamSource(micStream).connect(dest);
            combinedStream = new MediaStream([...stream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
        } else if (micStream) {
            combinedStream = new MediaStream([...stream.getVideoTracks(), ...micStream.getAudioTracks()]);
        } else {
            combinedStream = stream;
        }

        livePreview.srcObject = combinedStream;
        livePreview.play();

        btnStart.classList.remove('hidden');
        btnStop.classList.add('hidden');
        btnPause.classList.add('hidden');

    } catch (e) {
        await showModal('Error', 'Error al acceder a la fuente: ' + e.message);
        showView('menu');
    }
}


// Start
btnStart.addEventListener('click', startSequence);
btnMiniStart.addEventListener('click', startSequence);

function startSequence() {
    btnStart.classList.add('hidden');
    btnMiniStart.classList.add('hidden');
    countdownOverlay.classList.remove('hidden');
    let c = 3;
    countdownNumber.innerText = c;
    const interval = setInterval(() => {
        c--;
        if (c > 0) countdownNumber.innerText = c;
        else {
            clearInterval(interval);
            countdownOverlay.classList.add('hidden');
            beginRecording();
        }
    }, 1000);
}

const formatSelect = document.getElementById('format-select');
const fpsSelect = document.getElementById('fps-select');
const resSelect = document.getElementById('res-select');

formatSelect.addEventListener('change', () => {
    const isAudio = formatSelect.value.includes('audio');
    fpsSelect.disabled = isAudio;
    resSelect.disabled = isAudio;
    if (isAudio) {
        fpsSelect.style.opacity = '0.5';
        resSelect.style.opacity = '0.5';
    } else {
        fpsSelect.style.opacity = '1';
        resSelect.style.opacity = '1';
    }
});

function beginRecording() {
    recordedChunks = [];
    const format = formatSelect.value;
    let mimeType = 'video/webm;codecs=vp9,opus'; // Default

    const isAudio = format.includes('audio');
    let recordingStream = combinedStream;

    if (isAudio) {
        // Create audio-only stream to prevent MediaRecorder errors/issues
        const audioTracks = combinedStream.getAudioTracks();
        if (audioTracks.length === 0) {
            showModal('Error', 'No se detectó audio. Asegúrate de activar el micrófono o audio del sistema.');
            return;
        }
        recordingStream = new MediaStream(audioTracks);

        if (format.includes('wav')) mimeType = 'audio/wav'; // Chrome supports explicit wav sometimes, or we fallback
        else mimeType = 'audio/webm;codecs=opus';
    } else {
        if (format.includes('h264')) mimeType = 'video/webm;codecs=h264,opus';
    }

    let options = { mimeType };
    if (!MediaRecorder.isTypeSupported(mimeType)) {
        console.warn('Codec fallback for:', mimeType);
        if (isAudio) options = { mimeType: 'audio/webm' };
        else options = {};
    }

    try {
        mediaRecorder = new MediaRecorder(recordingStream, options);
    } catch (e) {
        alert('Error al iniciar grabadora: ' + e.message);
        console.error(e);
        return;
    }

    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = handleStop;

    try {
        mediaRecorder.start();
        isRecording = true;
        isPaused = false;
        startTimer();
        updateControls();
    } catch (e) {
        showModal('Error', 'No se pudo iniciar la grabación: ' + e.message);
    }
}

function resetControls() {
    btnStart.classList.remove('hidden');
    btnStop.classList.add('hidden');
    btnPause.classList.add('hidden');
    btnResume.classList.add('hidden');
    btnMiniStart.classList.remove('hidden');
    btnMiniStop.classList.add('hidden');
    btnMiniPause.classList.add('hidden');
    btnMiniResume.classList.add('hidden');
    timerDisplay.innerText = '00:00:00';
    miniTimer.innerText = '00:00';
    seconds = 0;
}

function updateControls() {
    if (isRecording && !isPaused) {
        btnStart.classList.add('hidden');
        btnStop.classList.remove('hidden');
        btnPause.classList.remove('hidden');
        btnResume.classList.add('hidden');
        btnMiniStart.classList.add('hidden');
        btnMiniStop.classList.remove('hidden');
        btnMiniPause.classList.remove('hidden');
        btnMiniResume.classList.add('hidden');
    } else if (isPaused) {
        btnPause.classList.add('hidden');
        btnResume.classList.remove('hidden');
        btnMiniPause.classList.add('hidden');
        btnMiniResume.classList.remove('hidden');
    }
}

function startTimer() {
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        seconds++;
        const s = (seconds % 60).toString().padStart(2, '0');
        const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
        const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
        timerDisplay.innerText = `${h}:${m}:${s}`;
        miniTimer.innerText = `${m}:${s}`;
    }, 1000);
}

btnPause.addEventListener('click', pauseRec);
btnMiniPause.addEventListener('click', pauseRec);
function pauseRec() { if (mediaRecorder && isRecording) { mediaRecorder.pause(); isPaused = true; clearInterval(timerInterval); updateControls(); } }

btnResume.addEventListener('click', resumeRec);
btnMiniResume.addEventListener('click', resumeRec);
function resumeRec() { if (mediaRecorder && isPaused) { mediaRecorder.resume(); isPaused = false; startTimer(); updateControls(); } }

btnStop.addEventListener('click', stopRec);
btnMiniStop.addEventListener('click', stopRec);
function stopRec() { if (mediaRecorder && isRecording) mediaRecorder.stop(); }

function handleStop() {
    clearInterval(timerInterval);
    isRecording = false;
    isPaused = false;

    // Revoke old blob URL if exists
    if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl);
        currentBlobUrl = null;
    }

    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    currentBlobUrl = URL.createObjectURL(blob);

    if (combinedStream) combinedStream.getTracks().forEach(t => t.stop());
    showView('review');
    setupCustomPlayer(blob, currentBlobUrl, seconds);
}

// CUSTOM PLAYER LOGIC
let playerCtx = null;
let playerAnalyser = null;
let playerSource = null;
let visualizerRunning = false;

function setupCustomPlayer(blob, blobUrl, recordedSeconds = 0) {
    const video = document.getElementById('recorded-video');
    const playBtn = document.getElementById('player-play-btn');
    const timelineContainer = document.getElementById('timeline-container');
    const timelineFill = document.getElementById('timeline-fill');
    const curTime = document.getElementById('cur-time');
    const durTime = document.getElementById('dur-time');
    const volBtn = document.getElementById('player-vol-btn');
    const stopBtn = document.getElementById('player-stop-btn');

    // Stop visualizer and reset player state
    visualizerRunning = false;

    // Properly reset video element
    video.pause();
    video.currentTime = 0;
    video.src = '';
    video.load(); // Force reset

    // Set new source
    video.src = blobUrl;
    video.load(); // Ensure it loads

    // Setup Audio Visualizer for Player
    if (!playerCtx) {
        playerCtx = new (window.AudioContext || window.webkitAudioContext)();
        playerAnalyser = playerCtx.createAnalyser();
        playerAnalyser.fftSize = 256;
    }

    // CRITICAL FIX: Only create MediaElementSource ONCE for the video element
    // Once created, it cannot be recreated for the same element
    if (!playerSource) {
        try {
            playerSource = playerCtx.createMediaElementSource(video);
            playerSource.connect(playerAnalyser);
            playerAnalyser.connect(playerCtx.destination);
        } catch (e) {
            console.log("Could not create audio source (already exists):", e);
            // If it fails, the video will still play without visualizer
        }
    }

    // Resume context if suspended
    if (playerCtx.state === 'suspended') {
        playerCtx.resume();
    }

    const wrapper = document.getElementById('player-wrapper');
    const isAudio = blobUrl && (blobUrl.type?.includes('audio') || formatSelect.value.includes('audio'));

    if (isAudio) {
        wrapper.classList.add('audio-mode');
    } else {
        wrapper.classList.remove('audio-mode');
    }

    const canvas = document.getElementById('audio-visualizer');
    const canvasCtx = canvas.getContext('2d');

    function drawVisualizer() {
        if (!visualizerRunning) return;
        requestAnimationFrame(drawVisualizer);

        const bufferLength = playerAnalyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        playerAnalyser.getByteFrequencyData(dataArray);

        canvas.width = canvas.parentElement.offsetWidth;
        canvas.height = canvas.parentElement.offsetHeight; // Use parent height

        canvasCtx.clearRect(0, 0, canvas.width, canvas.height);

        // Adjust bar size based on audio mode
        const isAudioMode = wrapper.classList.contains('audio-mode');
        const barWidth = (canvas.width / bufferLength) * (isAudioMode ? 1.5 : 2.5);
        let barHeight;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
            // Scale up for audio mode to look more impressive
            const scale = isAudioMode ? 1.5 : 0.5;
            barHeight = dataArray[i] * scale;

            // Color based on height and neon theme
            const r = barHeight + 25 * (i / bufferLength);
            const g = 250 * (i / bufferLength);
            const b = 50;

            // Gradient fill
            const gradient = canvasCtx.createLinearGradient(0, canvas.height, 0, canvas.height - barHeight);
            gradient.addColorStop(0, `rgb(187, 134, 252)`); // Primary
            gradient.addColorStop(1, `rgb(3, 218, 198)`); // Secondary

            canvasCtx.fillStyle = gradient;

            // Draw center-aligned if audio mode
            if (isAudioMode) {
                const centerY = canvas.height / 2;
                canvasCtx.fillRect(x, centerY - barHeight / 2, barWidth, barHeight);
            } else {
                canvasCtx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
            }

            x += barWidth + 1;
        }
    }

    // Play/Pause
    const togglePlay = () => {
        if (video.paused) {
            video.play();
            playBtn.innerHTML = '<i class="ph ph-pause"></i>';
            visualizerRunning = true;
            drawVisualizer();
            playerCtx.resume();
        } else {
            video.pause();
            playBtn.innerHTML = '<i class="ph ph-play"></i>';
            visualizerRunning = false;
        }
    };

    playBtn.onclick = togglePlay;
    video.onclick = togglePlay; // Click video to toggle

    // Stop (Reset)
    stopBtn.onclick = () => {
        video.pause();
        video.currentTime = 0;
        playBtn.innerHTML = '<i class="ph ph-play"></i>';
        visualizerRunning = false;
        timelineFill.style.width = '0%';
    };

    // Update Timeline
    video.ontimeupdate = () => {
        let dur = video.duration;
        if (!isFinite(dur)) dur = recordedSeconds;

        const percent = (video.currentTime / dur) * 100;
        timelineFill.style.width = `${percent}%`;
        curTime.innerText = formatTime(video.currentTime);

        // Use recorded seconds if metadata duration is failing (Infinity)
        if (!isFinite(video.duration)) {
            durTime.innerText = formatTime(recordedSeconds);
        } else {
            durTime.innerText = formatTime(video.duration);
        }
    };

    // Seek
    timelineContainer.onclick = (e) => {
        const rect = timelineContainer.getBoundingClientRect();
        const pos = (e.clientX - rect.left) / rect.width;
        let dur = video.duration;
        if (!isFinite(dur)) dur = recordedSeconds;
        video.currentTime = pos * dur;
    };

    // Volume Toggle
    volBtn.onclick = () => {
        video.muted = !video.muted;
        volBtn.innerHTML = video.muted ? '<i class="ph ph-speaker-slash"></i>' : '<i class="ph ph-speaker-high"></i>';
    };

    // Reset state on end
    video.onended = () => {
        playBtn.innerHTML = '<i class="ph ph-play"></i>';
        visualizerRunning = false;
    };
}

function formatTime(s) {
    if (isNaN(s) || !isFinite(s)) return "00:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
}

btnMic.addEventListener('click', toggleMic);
btnMiniMic.addEventListener('click', toggleMic);
function toggleMic() {
    isMicMuted = !isMicMuted;
    if (micStream) micStream.getAudioTracks().forEach(t => t.enabled = !isMicMuted);
    btnMic.classList.toggle('muted', isMicMuted);
    btnMiniMic.classList.toggle('muted', isMicMuted);
}

// FIX: System Audio Mute Function
function toggleSysMute() {
    isSysMuted = !isSysMuted;

    // Mute source stream tracks (desktop audio)
    if (stream) {
        stream.getAudioTracks().forEach(t => t.enabled = !isSysMuted);
    }

    // CRITICAL: Also mute combined stream tracks if they are different/cloned
    if (combinedStream) {
        // Find which tracks in combinedStream are from system audio (not mic)
        // Usually mic tracks have different IDs. 
        // Simplest way: if we have micStream, disable tracks NOT in micStream

        const micTrackIds = micStream ? micStream.getAudioTracks().map(t => t.id) : [];

        combinedStream.getAudioTracks().forEach(t => {
            if (!micTrackIds.includes(t.id)) {
                t.enabled = !isSysMuted;
            }
        });
    }

    btnSys.classList.toggle('muted', isSysMuted);
    btnMiniSys.classList.toggle('muted', isSysMuted);
}

btnSys.addEventListener('click', toggleSysMute);
btnMiniSys.addEventListener('click', toggleSysMute);

btnMini.addEventListener('click', () => showView('mini'));
btnMiniExpand.addEventListener('click', () => showView('recording'));
btnMiniHide.addEventListener('click', () => { ipcRenderer.send('set-window-visibility', 'hidden'); hiddenRestoreBtn.classList.remove('hidden'); });
hiddenRestoreBtn.addEventListener('click', () => { ipcRenderer.send('set-window-visibility', 'visible'); hiddenRestoreBtn.classList.add('hidden'); });

// Complete cleanup function for video state
function cleanupVideoState() {
    const v = document.getElementById('recorded-video');

    // Stop visualizer
    visualizerRunning = false;

    // Pause and clear video
    v.pause();
    v.currentTime = 0;
    v.src = "";
    v.removeAttribute('data-audio-connected');
    v.load();

    // Revoke blob URL
    if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl);
        currentBlobUrl = null;
    }

    // Clear recorded chunks - CRITICAL for preventing cache
    recordedChunks = [];

    // NOTE: Do NOT disconnect playerSource here
    // MediaElementSource can only be created once per video element
    // We reuse the same connection for all videos
}

btnSave.addEventListener('click', async () => {
    // Prevent double-click during save
    if (btnSave.disabled) return;

    btnSave.disabled = true;
    btnDiscard.disabled = true;
    const originalText = btnSave.textContent;
    btnSave.textContent = 'Guardando...';

    try {
        const format = document.getElementById('format-select').value;
        const blob = new Blob(recordedChunks, { type: 'video/webm' });
        const buffer = Buffer.from(await blob.arrayBuffer());

        // CRITICAL: Use actualRecordingFps (adjusted value) instead of selector value
        // This ensures the saved file matches the actual recording FPS
        const fps = actualRecordingFps || parseInt(document.getElementById('fps-select').value);
        console.log('Saving with FPS:', fps, '(actualRecordingFps:', actualRecordingFps, ')');

        const savedPath = await ipcRenderer.invoke('save-file', { buffer, format, fps });

        if (savedPath) {
            // Clean up BEFORE showing modal
            cleanupVideoState();

            if (await showModal('Guardado con éxito', `Archivo guardado en:\\n${savedPath}`, true)) {
                ipcRenderer.send('open-file-location', savedPath);
            }
            showView('menu');
        } else {
            await showModal('Error', 'No se pudo guardar el archivo correctamente.');
        }
    } finally {
        // Re-enable buttons
        btnSave.disabled = false;
        btnDiscard.disabled = false;
        btnSave.textContent = originalText;
    }
});

btnDiscard.addEventListener('click', async () => {
    if (await showModal('¿Eliminar?', 'La grabación se eliminará permanentemente.', true)) {
        cleanupVideoState();
        showView('menu');
    }
});

document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        recordedVideo.playbackRate = parseFloat(btn.dataset.speed);
    });
});

const settingsModal = document.getElementById('settings-modal');
document.getElementById('btn-settings').addEventListener('click', () => settingsModal.classList.remove('hidden'));
document.getElementById('btn-close-settings').addEventListener('click', () => settingsModal.classList.add('hidden'));

['pause', 'stop', 'mic', 'sys'].forEach(action => {
    const btn = document.getElementById(`bind-${action}`);
    btn.innerText = keybinds[action];
    btn.addEventListener('click', () => {
        const original = keybinds[action];
        btn.innerText = '...';
        btn.classList.add('listening');
        const handler = (e) => {
            e.preventDefault();
            if (e.key === 'Escape') {
                btn.innerText = original;
            } else {
                const k = e.key.toUpperCase();
                keybinds[action] = k;
                btn.innerText = k;
                ipcRenderer.send('update-shortcuts', keybinds);
            }
            btn.classList.remove('listening');
            document.removeEventListener('keydown', handler);
        };
        document.addEventListener('keydown', handler);
    });
});

ipcRenderer.on('shortcut-triggered', (e, act) => {
    if (!isRecording) return;
    if (act === 'pause') isPaused ? resumeRec() : pauseRec();
    if (act === 'stop') stopRec();
    if (act === 'mic') toggleMic();
    if (act === 'sys') toggleSysMute();
});

ipcRenderer.send('update-shortcuts', keybinds);
showView('menu');

// ========== CONVERTER LOGIC ==========
const converterModal = document.getElementById('converter-modal');
const btnConverter = document.getElementById('btn-converter');
const btnCloseConverter = document.getElementById('btn-close-converter');
const fileDropZone = document.getElementById('file-drop-zone');
const btnBrowseFile = document.getElementById('btn-browse-file');
const fileInfoPanel = document.getElementById('file-info-panel');
const formatSelectionPanel = document.getElementById('format-selection-panel');
const converterActions = document.getElementById('converter-actions');
const btnStartConversion = document.getElementById('btn-start-conversion');
const btnChangeFile = document.getElementById('btn-change-file');
const conversionProgressPanel = document.getElementById('conversion-progress-panel');
const btnCancelConversion = document.getElementById('btn-cancel-conversion');

let selectedSourceFile = null;
let selectedOutputFormat = null;
let selectedFps = 'original';
let isConverting = false;

// Open converter modal
btnConverter.addEventListener('click', () => {
    converterModal.classList.remove('hidden');
    resetConverterState();
});

// Close converter modal
btnCloseConverter.addEventListener('click', () => {
    if (isConverting) {
        showModal('Conversión en progreso', 'No puedes cerrar mientras se está convirtiendo.', false);
        return;
    }
    converterModal.classList.add('hidden');
    resetConverterState();
});

// Reset converter state
function resetConverterState() {
    selectedSourceFile = null;
    selectedOutputFormat = null;
    isConverting = false;

    fileDropZone.classList.remove('hidden');
    fileInfoPanel.classList.add('hidden');
    formatSelectionPanel.classList.add('hidden');
    converterActions.classList.add('hidden');
    conversionProgressPanel.classList.add('hidden');

    document.getElementById('quality-select').value = 'medium';
    if (document.getElementById('fps-picker-unique')) {
        document.getElementById('fps-picker-unique').value = 'original';
        selectedFps = 'original';
    }

    // Show all format sections by default
    const videoSection = document.getElementById('video-formats-section');
    const audioSection = document.getElementById('audio-formats-section');
    const optionsGrid = document.querySelector('.options-grid');

    if (videoSection) videoSection.style.display = 'block';
    if (audioSection) audioSection.style.display = 'block';
    if (optionsGrid) optionsGrid.style.display = 'grid';

    // Remove selection from all format cards
    const allFormatCards = document.querySelectorAll('.format-card');
    allFormatCards.forEach(card => card.classList.remove('selected'));

    btnStartConversion.disabled = true;
}

// Browse file button
btnBrowseFile.addEventListener('click', async () => {
    const filePath = await ipcRenderer.invoke('select-file-to-convert');
    if (filePath) {
        await loadSourceFile(filePath);
    }
});

// Change file button
btnChangeFile.addEventListener('click', async () => {
    const filePath = await ipcRenderer.invoke('select-file-to-convert');
    if (filePath) {
        await loadSourceFile(filePath);
    }
});

// Drag and drop
fileDropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    fileDropZone.classList.add('drag-over');
    console.log('📂 Drag over detected');
});

fileDropZone.addEventListener('dragleave', () => {
    fileDropZone.classList.remove('drag-over');
    console.log('📂 Drag leave');
});

fileDropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    fileDropZone.classList.remove('drag-over');

    if (e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        console.log('📂 File dropped:', file.name);

        try {
            // Use Electron's webUtils to get the file path
            const filePath = webUtils.getPathForFile(file);
            console.log('✅ File path obtained:', filePath);
            await loadSourceFile(filePath);
        } catch (error) {
            console.error('❌ Error getting file path:', error);
            await showModal('Error', 'No se pudo leer el archivo arrastrado. Por favor usa el botón "Examinar".');
        }
    } else {
        console.log('📂 No files in drop event');
    }
});

// Load source file
async function loadSourceFile(filePath) {
    try {
        const fileInfo = await ipcRenderer.invoke('get-file-info', filePath);

        if (!fileInfo) {
            await showModal('Error', 'No se pudo leer el archivo. Verifica que sea un archivo de video o audio válido.');
            return;
        }

        selectedSourceFile = { path: filePath, info: fileInfo };

        // Detect if source is audio-only (no video stream)
        const isAudioOnly = !fileInfo.resolution;

        // Update UI
        document.getElementById('source-file-name').textContent = fileInfo.filename;

        let metaText = '';
        if (fileInfo.duration) {
            const mins = Math.floor(fileInfo.duration / 60);
            const secs = Math.floor(fileInfo.duration % 60);
            metaText += `${mins}:${secs.toString().padStart(2, '0')}`;
        }
        if (fileInfo.resolution) metaText += ` • ${fileInfo.resolution}`;
        if (fileInfo.format) metaText += ` • ${fileInfo.format.toUpperCase()}`;

        // Show VFR warning if detected
        if (fileInfo.isVFR && fileInfo.avgFps) {
            metaText += ` • VFR (~${Math.round(fileInfo.avgFps)} fps promedio)`;
        }

        document.getElementById('source-file-meta').textContent = metaText;

        // Show/hide format sections based on source type
        const videoSection = document.getElementById('video-formats-section');
        const audioSection = document.getElementById('audio-formats-section');
        const optionsGrid = document.querySelector('.options-grid');

        if (isAudioOnly) {
            // Hide video section completely (including title)
            if (videoSection) videoSection.style.display = 'none';
            // Show audio section
            if (audioSection) audioSection.style.display = 'block';
            // Hide video options (FPS and Quality)
            if (optionsGrid) optionsGrid.style.display = 'none';
        } else {
            // Show both sections for video files
            if (videoSection) videoSection.style.display = 'block';
            if (audioSection) audioSection.style.display = 'block';
            // Show video options
            if (optionsGrid) optionsGrid.style.display = 'grid';
            // Initial FPS selector setup (will update when format is selected)
            updateFpsSelector(fileInfo.format);
        }

        // Show panels
        fileDropZone.classList.add('hidden');
        fileInfoPanel.classList.remove('hidden');
        formatSelectionPanel.classList.remove('hidden');
        converterActions.classList.remove('hidden');

    } catch (error) {
        await showModal('Error', 'Error al cargar el archivo: ' + error.message);
    }
}

// Function to update FPS selector based on source and target formats
function updateFpsSelector(sourceFormat, targetFormat = null) {
    const fpsSelect = document.getElementById('fps-picker-unique');
    if (!fpsSelect || !selectedSourceFile) return;

    // Formats that support VFR natively
    const vfrFormats = ['webm', 'mkv'];

    const isSourceVFR = vfrFormats.includes(sourceFormat);
    const isTargetVFR = targetFormat ? vfrFormats.includes(targetFormat) : false;

    // Get real FPS from source file
    const sourceRealFps = selectedSourceFile.info.realFps;
    const hasValidFps = sourceRealFps && isFinite(sourceRealFps) && sourceRealFps > 0 && sourceRealFps < 500;

    console.log('FPS Selector Update:', { sourceFormat, targetFormat, sourceRealFps, hasValidFps });

    // Determine available FPS options based on source FPS
    const allFpsOptions = [30, 60, 90, 120];
    let availableFpsOptions = [];

    if (hasValidFps) {
        // Only allow FPS equal to or lower than source FPS (no upscaling)
        availableFpsOptions = allFpsOptions.filter(fps => fps <= Math.round(sourceRealFps));
        console.log('Available FPS options (based on source):', availableFpsOptions);
    } else {
        // If we can't detect FPS, show common options
        availableFpsOptions = [30, 60, 90];
    }

    // Show "original" option only if BOTH source and target support VFR
    const canPreserveVFR = isSourceVFR && (targetFormat === null || isTargetVFR);

    if (canPreserveVFR) {
        // Both formats support VFR: allow "original" to preserve VFR
        let optionsHtml = '<option value="original" selected>Originales (Mantener VFR)</option>';
        availableFpsOptions.forEach(fps => {
            optionsHtml += `<option value="${fps}">${fps} FPS (Forzar CFR)</option>`;
        });
        fpsSelect.innerHTML = optionsHtml;
        selectedFps = 'original';
    } else if (isSourceVFR && !isTargetVFR && targetFormat) {
        // Source is VFR but target doesn't support it: force specific FPS
        let optionsHtml = '';
        const defaultFps = availableFpsOptions.includes(60) ? 60 : availableFpsOptions[availableFpsOptions.length - 1];
        availableFpsOptions.forEach(fps => {
            const isDefault = fps === defaultFps;
            optionsHtml += `<option value="${fps}"${isDefault ? ' selected' : ''}>${fps} FPS${isDefault ? ' (Recomendado)' : ''}</option>`;
        });
        fpsSelect.innerHTML = optionsHtml;
        selectedFps = defaultFps.toString();
    } else {
        // Non-VFR source or no target selected yet: show all available options
        let optionsHtml = '<option value="original" selected>Originales (Mantener)</option>';
        availableFpsOptions.forEach(fps => {
            optionsHtml += `<option value="${fps}">${fps} FPS</option>`;
        });
        fpsSelect.innerHTML = optionsHtml;
        selectedFps = 'original';
    }
}

// Format selection
const audioFormats = ['mp3', 'wav', 'aac', 'flac', 'ogg'];

document.querySelectorAll('.format-card').forEach(card => {
    card.addEventListener('click', () => {
        document.querySelectorAll('.format-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        selectedOutputFormat = card.dataset.format;
        btnStartConversion.disabled = false;

        const optionsGrid = document.querySelector('.options-grid');
        const isAudioTarget = audioFormats.includes(selectedOutputFormat);

        if (isAudioTarget) {
            // Hide options for audio formats
            if (optionsGrid) optionsGrid.style.display = 'none';
        } else {
            // Show options for video formats
            if (optionsGrid) optionsGrid.style.display = 'grid';

            // Update FPS selector based on selected output format (only for video)
            if (selectedSourceFile && selectedSourceFile.info && selectedSourceFile.info.resolution) {
                updateFpsSelector(selectedSourceFile.info.format, selectedOutputFormat);
            }
        }
    });
});

// FPS Selection Listener
const fpsSelectEl = document.getElementById('fps-picker-unique');
if (fpsSelectEl) {
    const updateFps = (e) => {
        selectedFps = e.target.value;
        console.log('FPS Updated to:', selectedFps);
    };
    fpsSelectEl.addEventListener('change', updateFps);
    fpsSelectEl.addEventListener('input', updateFps);
}

// Start conversion
btnStartConversion.addEventListener('click', async () => {
    if (!selectedSourceFile || !selectedOutputFormat) {
        await showModal('Error', 'Selecciona un archivo y un formato de salida.');
        return;
    }

    let quality = document.getElementById('quality-select').value;

    // Check if it's audio format and force high quality
    if (['mp3', 'wav', 'aac', 'flac', 'ogg'].includes(selectedOutputFormat)) {
        console.log('🎵 Audio conversion detected, forcing high quality');
        quality = 'high';
    }

    // Hybrid FPS check: State vs DOM
    let fps = selectedFps;

    // For audio, irrelevant, but keep consistent
    if (['mp3', 'wav', 'aac', 'flac', 'ogg'].includes(selectedOutputFormat)) {
        fps = 'original';
    } else {
        try {
            const el = document.getElementById('fps-picker-unique');
            if (el && el.selectedIndex >= 0) {
                const domVal = el.options[el.selectedIndex].value;
                // Trust DOM explicitly if diff
                if (domVal !== 'original' && fps === 'original') {
                    console.warn('FPS Mismatch! State said original but DOM says:', domVal);
                    fps = domVal;
                }
                // Also, if DOM is original but state is 30, trust state? 
                // Logic: If user clicked, state = 30. If DOM = original, maybe reset happened?
                // Use DOM as source of truth at click time if possible
                if (domVal && domVal !== '') fps = domVal;
            }
        } catch (e) { console.error(e); }
    }

    console.log('Final FPS to send:', fps);

    isConverting = true;
    formatSelectionPanel.classList.add('hidden');
    converterActions.classList.add('hidden');
    conversionProgressPanel.classList.remove('hidden');

    try {
        const result = await ipcRenderer.invoke('convert-file', {
            sourcePath: selectedSourceFile.path,
            outputFormat: selectedOutputFormat,
            quality: quality,
            fps: fps
        });

        if (result.success) {
            conversionProgressPanel.classList.add('hidden');

            if (await showModal('¡Conversión Exitosa!', `Archivo guardado en:\n${result.outputPath}`, true)) {
                ipcRenderer.send('open-file-location', result.outputPath);
            }

            converterModal.classList.add('hidden');
            resetConverterState();
        } else {
            throw new Error(result.error || 'Error desconocido');
        }
    } catch (error) {
        conversionProgressPanel.classList.add('hidden');
        formatSelectionPanel.classList.remove('hidden');
        converterActions.classList.remove('hidden');
        isConverting = false;

        await showModal('Error de Conversión', error.message || 'No se pudo convertir el archivo.');
    }
});

// Progress updates
// Progress updates
ipcRenderer.on('conversion-progress', (event, { percent, startTime }) => {
    const progressBar = document.getElementById('progress-bar-fill');
    const progressPercent = document.getElementById('progress-percent');
    const progressText = document.getElementById('progress-text');

    progressBar.style.width = `${percent}%`;
    progressPercent.textContent = `${Math.round(percent)}%`;

    // Improved ETA calculation
    if (percent > 0 && startTime) {
        const elapsed = (Date.now() - startTime) / 1000; // seconds
        const totalEstimated = elapsed * (100 / percent);
        const remaining = totalEstimated - elapsed;

        let etaText = '';
        if (remaining < 60) {
            etaText = `${Math.round(remaining)}s`;
        } else {
            const mins = Math.floor(remaining / 60);
            const secs = Math.round(remaining % 60);
            etaText = `${mins}m ${secs}s`;
        }

        progressText.textContent = `Convirtiendo... (${etaText} restante)`;
    } else {
        progressText.textContent = 'Convirtiendo... (Calculando...)';
    }
});

// Cancel conversion
btnCancelConversion.addEventListener('click', async () => {
    if (await showModal('¿Cancelar conversión?', 'Se perderá el progreso actual.', true)) {
        ipcRenderer.send('cancel-conversion');
        isConverting = false;
        conversionProgressPanel.classList.add('hidden');
        formatSelectionPanel.classList.remove('hidden');
        converterActions.classList.remove('hidden');
    }
});

// ========== FFmpeg Logging (for debugging) ==========
ipcRenderer.on('ffmpeg-log', (event, message) => {
    console.log('[FFmpeg]', message);
});

ipcRenderer.on('ffmpeg-error', (event, errorInfo) => {
    console.error('=== FFmpeg Error (from main process) ===');
    console.error('Message:', errorInfo.message);
    console.error('FPS:', errorInfo.fps);
    console.error('Extension:', errorInfo.ext);
    console.error('Output path:', errorInfo.outputPath);
    console.error('Temp path:', errorInfo.tempPath);
    console.error('FFmpeg stderr:', errorInfo.stderr);
    console.error('========================================');
});
