// Preview canvas: clips, scales and centers the screen iframe inside a
// neutral pane. All
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
 * The canvas fills the window; the floating cards lie over it. `insets` is
 * the part the cards cover, and only the fit scale and the centring read it —
 * the canvas origin itself never depends on a card.
 *
 * @param {{
 *   canvasEl: HTMLElement,
 *   holderEl: HTMLElement,
 *   iframeEl: HTMLIFrameElement,
 *   zoom: "fit" | number,
 *   topInset?: number,
 *   insets?: { left: number, right: number, top: number, bottom: number },
 *   pan?: { x: number, y: number },
 * }} args `topInset` reserves a band above the frame (the frame caption, CHR-912). `pan` (CHR-1290) is how far the human moved the frame off its centring by hand; it applies only on an axis where the frame fits the free area (there is nothing to scroll), kept inside the pane. Where the frame overflows, the scroll model below moves it.
 * @returns {{ width: number, height: number, pan: { x: number, y: number } }} the screen's unscaled size and the pan actually applied
 */
export function applyCanvas({ canvasEl, holderEl, iframeEl, zoom, topInset = 0, insets = { left: 0, right: 0, top: 0, bottom: 0 }, pan = { x: 0, y: 0 } }) {
  const { width, height } = readScreenSize(iframeEl);
  const availW = canvasEl.clientWidth - insets.left - insets.right;
  const availH = canvasEl.clientHeight - insets.top - insets.bottom - topInset;
  const scale = zoom === "fit" ? fitScale(availW, availH, width, height) : zoom;

  holderEl.style.width = `${width}px`;
  holderEl.style.height = `${height}px`;
  holderEl.style.transform = `scale(${scale})`;
  holderEl.style.setProperty("--zoom", String(scale)); // overlay labels counter-scale with it (CHR-780)
  const drawnW = width * scale;
  const drawnH = height * scale;
  const centredLeft = insets.left + Math.max(0, (availW - drawnW) / 2);
  const centredTop = insets.top + topInset + Math.max(0, (availH - drawnH) / 2);
  const left = drawnW <= availW ? Math.min(Math.max(0, canvasEl.clientWidth - drawnW), Math.max(0, centredLeft + pan.x)) : centredLeft;
  const top = drawnH <= availH ? Math.min(Math.max(0, canvasEl.clientHeight - drawnH), Math.max(0, centredTop + pan.y)) : centredTop;
  holderEl.style.left = `${left}px`;
  holderEl.style.top = `${top}px`;

  // Trailing scroll room: a frame wider or taller than the free area scrolls out from under the cards on the right and the zoom pill below (a ::after of the canvas, style.css, sized to the frame's far edge plus the insets).
  canvasEl.style?.setProperty("--room-w", `${left + drawnW + insets.right}px`);
  canvasEl.style?.setProperty("--room-h", `${top + drawnH + insets.bottom}px`);

  iframeEl.style.width = `${width}px`;
  iframeEl.style.height = `${height}px`;
  return { width, height, pan: { x: left - centredLeft, y: top - centredTop } };
}
