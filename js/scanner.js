/*
 * Reads a record's barcode with the camera, using the browser's built-in BarcodeDetector.
 * Chrome on Android has one. Safari, Firefox, and Chrome on Windows and Linux don't yet.
 */
(function () {
  'use strict';

  // Records carry EAN-13 barcodes, or UPC-A in North America.
  const RECORD_FORMATS = ['ean_13', 'upc_a'];
  const FRAME_GAP_MS = 120;

  // A BarcodeDetector can exist and still read no barcode formats, as on Android without Google Play services.
  async function recordFormats() {
    if (!('BarcodeDetector' in window)) return [];
    const formats = await BarcodeDetector.getSupportedFormats();
    return RECORD_FORMATS.filter((format) => formats.includes(format));
  }

  async function supported() {
    return (await recordFormats()).length > 0;
  }

  // Resolves with the digits of the first record barcode the camera sees. Rejects with the camera's
  // error, like NotAllowedError when permission is refused, or with an AbortError once signal aborts.
  // The camera is off again whichever way it ends.
  async function read(video, signal) {
    const detector = new BarcodeDetector({ formats: await recordFormats() });
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    try {
      signal.throwIfAborted();
      video.srcObject = stream;
      await video.play();
      for (;;) {
        const [code] = await detector.detect(video);
        signal.throwIfAborted();
        if (code) return code.rawValue;
        await new Promise((resolve) => setTimeout(resolve, FRAME_GAP_MS));
      }
    } finally {
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
    }
  }

  (window.RC = window.RC || {}).scanner = { supported, read };
})();
