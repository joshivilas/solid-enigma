/* ── YouTube to GIF – app.js ─────────────────────────────────────── */

// Public Invidious API instances used as a CORS-friendly proxy for
// fetching YouTube video stream URLs.  They are tried in order; the
// first one that responds successfully is used.
const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.privacyredirect.com',
  'https://invidious.io.lol',
  'https://iv.datura.network',
];

// Holds the final Blob so the download button can re-use it
let _gifBlob = null;

// ── Helpers ──────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function showCard(id) { $(id).classList.remove('hidden'); }
function hideCard(id) { $(id).classList.add('hidden'); }

function setProgress(pct, label) {
  $('progress-bar').style.width = pct + '%';
  $('progress-pct').textContent   = Math.round(pct) + '%';
  $('progress-label').textContent = label;
}

function showError(msg) {
  hideCard('progress-card');
  $('error-msg').textContent = msg;
  showCard('error-card');
  $('convert-btn').disabled = false;
}

function resetApp() {
  hideCard('preview-card');
  hideCard('error-card');
  hideCard('progress-card');
  $('convert-btn').disabled = false;
  _gifBlob = null;
}

// ── YouTube URL → video ID ───────────────────────────────────────────

function extractVideoId(url) {
  url = url.trim();
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,          // watch?v=
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,      // youtu.be/
    /\/embed\/([a-zA-Z0-9_-]{11})/,        // /embed/
    /\/shorts\/([a-zA-Z0-9_-]{11})/,       // /shorts/
    /^([a-zA-Z0-9_-]{11})$/,               // bare ID
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

// ── Fetch video info via Invidious API ───────────────────────────────

async function fetchVideoInfo(videoId) {
  const errors = [];
  for (const base of INVIDIOUS_INSTANCES) {
    try {
      const res = await fetch(`${base}/api/v1/videos/${videoId}`, {
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      errors.push(`${base}: ${e.message}`);
    }
  }
  throw new Error(
    'Could not reach any video API server. Check your internet connection or try again later.\n\nDetails: ' +
    errors.join(' | ')
  );
}

// Pick the best stream URL from Invidious formatStreams.
// Prefers MP4, lowest resolution that is at least 360p so the GIF is
// manageable, falls back to whatever is available.
function pickStream(info) {
  const streams = info.formatStreams || [];

  const order = ['360p', '480p', '240p', '720p'];
  for (const q of order) {
    const s = streams.find(f => f.qualityLabel === q && f.container === 'mp4');
    if (s) return s.url;
  }
  // Fall back: first mp4
  const mp4 = streams.find(f => f.container === 'mp4');
  if (mp4) return mp4.url;

  // Last resort: any stream
  if (streams.length) return streams[0].url;

  throw new Error('No playable video stream found for this video.');
}

// ── Wait for a video seek to settle ─────────────────────────────────

function seekTo(video, t) {
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('Seek failed')); };
    const cleanup = () => {
      video.removeEventListener('seeked', done);
      video.removeEventListener('error', fail);
    };
    video.addEventListener('seeked', done, { once: true });
    video.addEventListener('error', fail, { once: true });
    video.currentTime = t;
  });
}

// Wait for video metadata to load
function loadVideo(video, src) {
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('Failed to load video. The stream may be geo-restricted or unavailable.')); };
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', done);
      video.removeEventListener('error', fail);
    };
    video.addEventListener('loadedmetadata', done, { once: true });
    video.addEventListener('error', fail, { once: true });
    video.src = src;
    video.load();
  });
}

// ── Main conversion logic ────────────────────────────────────────────

async function convertToGif() {
  _gifBlob = null;

  const urlVal   = $('yt-url').value.trim();
  const startSec = Math.max(0, parseFloat($('start-time').value) || 0);
  const durSec   = Math.min(10, Math.max(0.5, parseFloat($('duration').value) || 3));
  const fps      = Math.min(20, Math.max(5, parseInt($('fps').value) || 10));
  const gifW     = Math.min(720, Math.max(120, parseInt($('gif-width').value) || 480));

  // UI: disable button, show progress
  $('convert-btn').disabled = true;
  hideCard('preview-card');
  hideCard('error-card');
  showCard('progress-card');
  setProgress(0, 'Extracting video ID…');

  try {
    /* 1 ── Parse video ID */
    const videoId = extractVideoId(urlVal);
    if (!videoId) throw new Error('Could not find a YouTube video ID in that URL. Please paste a full YouTube link (e.g. https://www.youtube.com/watch?v=…).');

    setProgress(8, 'Fetching video information…');

    /* 2 ── Get stream URL via Invidious */
    const info = await fetchVideoInfo(videoId);
    const streamUrl = pickStream(info);

    setProgress(18, 'Loading video stream…');

    /* 3 ── Load into hidden <video> */
    const video = $('hidden-video');
    await loadVideo(video, streamUrl);

    setProgress(28, 'Seeking to start position…');

    /* 4 ── Seek to start */
    await seekTo(video, startSec);

    /* 5 ── Set up canvas */
    const canvas  = $('frame-canvas');
    const aspect  = video.videoHeight / video.videoWidth;
    canvas.width  = gifW;
    canvas.height = Math.round(gifW * aspect);
    const ctx     = canvas.getContext('2d');

    /* 6 ── Capture frames */
    const totalFrames = Math.ceil(durSec * fps);
    const delayMs     = Math.round(1000 / fps);
    const frames      = [];

    for (let i = 0; i < totalFrames; i++) {
      const t = startSec + i / fps;
      await seekTo(video, t);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      // getImageData is safe as long as the video server sends CORS headers
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      frames.push(imageData);
      setProgress(28 + (i / totalFrames) * 52, `Capturing frame ${i + 1} / ${totalFrames}…`);
    }

    setProgress(82, 'Encoding GIF…');

    /* 7 ── Encode with gif.js */
    const gif = new GIF({
      workers:      2,
      quality:      8,
      width:        canvas.width,
      height:       canvas.height,
      workerScript: 'https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js',
    });

    for (const frame of frames) {
      gif.addFrame(frame, { delay: delayMs });
    }

    await new Promise((resolve, reject) => {
      gif.on('finished', blob => { _gifBlob = blob; resolve(); });
      gif.on('error',    err  => reject(new Error('GIF encoding error: ' + err)));
      gif.render();
    });

    setProgress(100, 'Done!');

    /* 8 ── Show preview */
    const objectUrl = URL.createObjectURL(_gifBlob);
    $('gif-img').src = objectUrl;

    setTimeout(() => {
      hideCard('progress-card');
      showCard('preview-card');
      $('convert-btn').disabled = false;
    }, 400);

  } catch (err) {
    console.error('[YT→GIF]', err);
    showError(err.message || String(err));
  }
}

// ── Download ─────────────────────────────────────────────────────────

function downloadGif() {
  if (!_gifBlob) return;
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(_gifBlob);
  const name = ($('yt-url').value.match(/[?&]v=([a-zA-Z0-9_-]{11})/) || ['', 'youtube'])[1];
  a.download = `yt-gif-${name}.gif`;
  a.click();
}
