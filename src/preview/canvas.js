// Preview canvas: clips, scales and centers the screen iframe inside a
// neutral pane, and positions the optional status-bar chrome over it. All
// measurement/positioning happens on the PARENT document's elements — the
// iframe's own document (srcdoc) is never read from or written to beyond
// measuring its already-rendered root, per render determinism: nothing here
// can leak into stored screen HTML or a get_screen response.

const FALLBACK_WIDTH = 390;
const FALLBACK_HEIGHT = 844;

/**
 * Scale that fits a `screenW`x`screenH` box inside `availW`x`availH`
 * without cropping. Capped at 1 — a screen smaller than the pane renders at
 * its true size rather than being blurrily upscaled to fill it.
 *
 * @param {number} availW
 * @param {number} availH
 * @param {number} screenW
 * @param {number} screenH
 * @returns {number}
 */
export function fitScale(availW, availH, screenW, screenH) {
  if (screenW <= 0 || screenH <= 0 || availW <= 0 || availH <= 0) return 1;
  return Math.min(1, availW / screenW, availH / screenH);
}

/**
 * Reads the screen's declared size off its rendered root element (the
 * screen root carries `width`/`height` in its inline style, per the
 * augmentation grammar). Falls back to a default phone size when the root
 * is unavailable — an empty screen, or an error message rendered in its
 * place.
 *
 * @param {HTMLIFrameElement} iframeEl
 * @returns {{ width: number, height: number }}
 */
function readScreenSize(iframeEl) {
  const root = iframeEl.contentDocument?.body?.firstElementChild;
  return {
    width: root?.offsetWidth || FALLBACK_WIDTH,
    height: root?.offsetHeight || FALLBACK_HEIGHT,
  };
}

/**
 * Sizes `#screen-holder` and the iframe inside it to the screen's declared
 * size, scales the holder per `zoom` and centers it inside `canvasEl`.
 * Called after every iframe load (a fresh document each time, possibly a
 * different screen size) and on window resize while zoom is "fit".
 *
 * @param {{
 *   canvasEl: HTMLElement,
 *   holderEl: HTMLElement,
 *   iframeEl: HTMLIFrameElement,
 *   zoom: "fit" | number,
 * }} args
 */
export function applyCanvas({ canvasEl, holderEl, iframeEl, zoom }) {
  const { width, height } = readScreenSize(iframeEl);
  const availW = canvasEl.clientWidth;
  const availH = canvasEl.clientHeight;
  const scale = zoom === "fit" ? fitScale(availW, availH, width, height) : zoom;

  holderEl.style.width = `${width}px`;
  holderEl.style.height = `${height}px`;
  holderEl.style.transform = `scale(${scale})`;
  holderEl.style.left = `${Math.max(0, (availW - width * scale) / 2)}px`;
  holderEl.style.top = `${Math.max(0, (availH - height * scale) / 2)}px`;

  iframeEl.style.width = `${width}px`;
  iframeEl.style.height = `${height}px`;
}
