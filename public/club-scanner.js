'use strict';
// Club Eats in-app QR scanner — deliberately isolated from the main club.html app script so all
// camera/decoding logic lives in one external file (no inline handlers, easy to audit/cache).
// Depends on window.jsQR (vendored at /vendor/jsqr.js, loaded before this file).
window.ClubScanner = (function () {
  let stream = null;
  let videoEl = null;
  let canvasEl = null;
  let ctx = null;
  let rafId = null;
  let onDecode = null;
  let torchTrack = null;
  let lastResult = null;
  let lastResultAt = 0;

  async function start(video, canvas, { onResult, onError }) {
    videoEl = video;
    canvasEl = canvas;
    ctx = canvas.getContext('2d', { willReadFrequently: true });
    onDecode = onResult;
    lastResult = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      videoEl.srcObject = stream;
      await videoEl.play();
      const track = stream.getVideoTracks()[0];
      torchTrack = track;
      rafId = requestAnimationFrame(loop);
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      return { ok: true, torchSupported: !!caps.torch };
    } catch (err) {
      onError && onError(err);
      return { ok: false, torchSupported: false };
    }
  }

  function loop() {
    if (!videoEl) return;
    if (videoEl.readyState === videoEl.HAVE_ENOUGH_DATA) {
      canvasEl.width = videoEl.videoWidth;
      canvasEl.height = videoEl.videoHeight;
      ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
      const frame = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
      const code = window.jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' });
      if (code && code.data) {
        // De-dupe identical consecutive reads for ~1.5s so one physical QR isn't reported 30x/sec.
        const now = Date.now();
        if (code.data !== lastResult || now - lastResultAt > 1500) {
          lastResult = code.data;
          lastResultAt = now;
          onDecode && onDecode(code.data);
        }
      }
    }
    rafId = requestAnimationFrame(loop);
  }

  async function toggleTorch(on) {
    if (!torchTrack) return false;
    try {
      await torchTrack.applyConstraints({ advanced: [{ torch: on }] });
      return true;
    } catch {
      return false;
    }
  }

  function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null;
    torchTrack = null;
    if (videoEl) videoEl.srcObject = null;
    lastResult = null;
  }

  return { start, stop, toggleTorch };
})();
