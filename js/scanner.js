/*
 * Reads a record's barcode with the camera. Chrome on Android has a built-in BarcodeDetector that
 * reads record barcodes. Other browsers, like Safari on iPhone and Firefox, load the barcode-detector
 * library (ZXing compiled to WebAssembly) from jsDelivr the first time someone scans.
 */
(function () {
  'use strict';

  // Records carry EAN-13 barcodes, or UPC-A in North America.
  const RECORD_FORMATS = ['ean_13', 'upc_a'];
  const FRAME_GAP_MS = 120;

  // The browser refuses either file if it no longer matches its hash. A new version needs a new hash.
  const FALLBACK_SCRIPT = {
    url: 'https://cdn.jsdelivr.net/npm/barcode-detector@3.2.3/dist/iife/ponyfill.js',
    integrity: 'sha384-ZQvvHKgw7Ktqkui5vapXokyfDpQcnXLZhR9hfFMh8rUQztTRNywKQdQ994308nhY',
  };
  const FALLBACK_WASM = {
    url: 'https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.6/dist/reader/zxing_reader.wasm',
    integrity: 'sha384-nK2pHJVglp+a6HfEzYu3Das+oIISIChcnPvLUzhPoPHhi8NaJzy9dzcwIdK/dC0I',
  };

  // Browsers offer the camera only on HTTPS pages and on localhost.
  function supported() {
    return Boolean(navigator.mediaDevices?.getUserMedia);
  }

  // A BarcodeDetector can exist and still read no record barcodes, as on Android without Google Play services.
  async function builtInFormats() {
    if (!('BarcodeDetector' in window)) return [];
    const formats = await BarcodeDetector.getSupportedFormats();
    return RECORD_FORMATS.filter((format) => formats.includes(format));
  }

  function loadScript({ url, integrity }) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.integrity = integrity;
      script.crossOrigin = 'anonymous';
      script.onload = resolve;
      script.onerror = reject;
      document.head.append(script);
    });
  }

  async function fetchWasm({ url, integrity }) {
    const res = await fetch(url, { integrity });
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    return res.arrayBuffer();
  }

  // The app fetches the WebAssembly, not the library, so that the browser checks its hash.
  let fallback = null;
  function loadFallback() {
    fallback ??= Promise.all([loadScript(FALLBACK_SCRIPT), fetchWasm(FALLBACK_WASM)])
      .then(async ([, wasmBinary]) => {
        await BarcodeDetectionAPI.prepareZXingModule({ overrides: { wasmBinary }, fireImmediately: true });
        return BarcodeDetectionAPI.BarcodeDetector;
      })
      .catch(() => {
        fallback = null;
        throw new DOMException("Couldn't load the barcode reader", 'NetworkError');
      });
    return fallback;
  }

  async function makeDetector() {
    const formats = await builtInFormats();
    if (formats.length) return new BarcodeDetector({ formats });
    const Fallback = await loadFallback();
    return new Fallback({ formats: RECORD_FORMATS });
  }

  // Resolves with the digits of the first record barcode the camera sees. Rejects with the camera's
  // error, like NotAllowedError when permission is refused, with a NetworkError when the fallback
  // reader can't load, or with an AbortError once signal aborts. It never resolves after an abort.
  // The camera is off again whichever way it ends.
  async function read(video, signal) {
    const detecting = makeDetector();
    detecting.catch(() => {}); // awaited below. This stops an unhandled rejection when the camera fails first.
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    try {
      signal.throwIfAborted();
      video.srcObject = stream;
      await video.play();
      const detector = await detecting;
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

  (window.Alexandria = window.Alexandria || {}).scanner = { supported, read };
})();
