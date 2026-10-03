// Small polyfills for older browser engines, e.g. the factory WebView of an
// Android device that never connects to the internet (the APK build).

if (typeof Blob !== 'undefined' && !Blob.prototype.arrayBuffer) {
  // Blob.arrayBuffer() arrived in Chrome 76; Response has read Blobs since 42.
  Blob.prototype.arrayBuffer = function arrayBuffer() {
    return new Response(this).arrayBuffer();
  };
}

if (typeof Element !== 'undefined' && !Element.prototype.replaceChildren) {
  // Chrome 86+.
  Element.prototype.replaceChildren = function replaceChildren(...nodes) {
    while (this.firstChild) this.removeChild(this.firstChild);
    this.append(...nodes);
  };
}

if (!Array.prototype.flatMap) {
  // Chrome 69+.
  Object.defineProperty(Array.prototype, 'flatMap', {
    configurable: true,
    writable: true,
    value(fn, thisArg) {
      return this.reduce((acc, x, i, arr) => acc.concat(fn.call(thisArg, x, i, arr)), []);
    },
  });
}
