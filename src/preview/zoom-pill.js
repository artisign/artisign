// CHR-1267 — the zoom pill (− / % / + / Fit) and its popover: a click on the % value opens a continuous 5–200 % slider and the presets. The popover is a native `popover="auto"` (top layer, light dismiss) where the browser has the API, and a plain toggled box with the same outside-click and Escape behaviour where it does not.

export const MIN_ZOOM_PERCENT = 5;
export const MAX_ZOOM_PERCENT = 200;

/**
 * The slider value for a scale (1 = 100 %), clamped to the slider's range.
 * @param {number} scale
 * @returns {number}
 */
export function scaleToPercent(scale) {
  return Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, Math.round(scale * 100)));
}

/**
 * @param {{
 *   pillEl: HTMLElement,
 *   triggerEl: HTMLButtonElement,
 *   menuEl: HTMLElement,
 *   labelEl: HTMLElement,
 *   rangeEl: HTMLInputElement,
 *   presetEls: HTMLElement[],
 *   onZoom: (zoom: "fit" | number) => void,
 * }} args `presetEls` carry `data-zoom` ("fit" or a scale); `onZoom` receives what a preset or the slider asks for (a slider value as a scale).
 * @returns {{ isOpen: () => boolean, close: () => void, sync: (state: { zoom: "fit" | number, scale: number }) => void }}
 */
export function createZoomPill({ pillEl, triggerEl, menuEl, labelEl, rangeEl, presetEls, onZoom }) {
  const native = typeof menuEl.showPopover === "function";

  const isOpen = () => (native ? menuEl.matches(":popover-open") : menuEl.hasAttribute("data-open"));
  const reflect = () => triggerEl.setAttribute("aria-expanded", String(isOpen()));
  function open() {
    if (isOpen()) return;
    if (native) menuEl.showPopover();
    else menuEl.setAttribute("data-open", "");
    reflect();
    rangeEl.focus();
  }
  function close() {
    if (!isOpen()) return;
    if (native) menuEl.hidePopover();
    else menuEl.removeAttribute("data-open");
    reflect();
  }

  triggerEl.addEventListener("click", () => {
    if (isOpen()) close();
    else open();
  });
  // Native light dismiss and Escape close the popover without going through close().
  menuEl.addEventListener("toggle", reflect);
  if (!native) {
    document.addEventListener(
      "pointerdown",
      (evt) => {
        if (isOpen() && !menuEl.contains(evt.target) && !pillEl.contains(evt.target)) close();
      },
      true,
    );
  }

  rangeEl.addEventListener("input", () => onZoom(Number(rangeEl.value) / 100));
  for (const preset of presetEls) {
    if (!menuEl.contains(preset)) continue; // the pill's own Fit button handles its click in app.js
    preset.addEventListener("click", () => {
      close();
      triggerEl.focus();
    });
  }

  return {
    isOpen,
    close,
    sync({ zoom, scale }) {
      const percent = Math.round(scale * 100);
      labelEl.textContent = `${percent}%`;
      rangeEl.value = String(scaleToPercent(scale));
      rangeEl.setAttribute("aria-valuetext", `${percent}%`);
      const fill = ((scaleToPercent(scale) - MIN_ZOOM_PERCENT) / (MAX_ZOOM_PERCENT - MIN_ZOOM_PERCENT)) * 100;
      rangeEl.style.setProperty("--fill", `${fill}%`);
      for (const preset of presetEls) {
        const current = preset.dataset.zoom === (zoom === "fit" ? "fit" : String(zoom));
        preset.setAttribute("aria-pressed", String(current));
        preset.classList.toggle("is-current", current);
      }
    },
  };
}
