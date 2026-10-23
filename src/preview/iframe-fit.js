// Shared "sandboxed, measure-and-grow-to-fit" iframe factory — used by the
// design-system view (component/pattern variant cells) and the mockup view
// (comparison columns) for the same reason: both render arbitrary
// untrusted HTML at its own natural size, which the CSS default (a small
// fixed box) would otherwise clip.

/**
 * Creates a sandboxed iframe pre-wired to grow to its content's natural
 * size once it loads. Callers set `srcdoc` (directly, or via an async
 * fetch) after creating it.
 *
 * Width and height both settle synchronously on `load` (the height read
 * flushes layout, so it follows the new width); a second pass one animation
 * frame later catches content that grows after load. A caller that needs to
 * react once the iframe's size is known must use `onFitted` rather than its
 * own `load` listener, which would read a stale placeholder height.
 * `mockup-zoom.js`'s `applyMockupZoom` is exactly that case.
 *
 * @param {() => void} [onFitted] called after the height was set to the
 *   content's natural size, and again whenever a later pass changes it.
 * @returns {HTMLIFrameElement}
 */
export function createFittingIframe(onFitted) {
  const iframe = document.createElement("iframe");
  // "allow-same-origin" only, NEVER "allow-scripts" — see the comment on
  // #screen-frame in index.html; the same untrusted-content reasoning
  // applies to rendered component/pattern variants and mockup variants.
  // setAttribute (not the `iframe.sandbox = "..."` property form) so this
  // is exercisable under jsdom, which doesn't reflect that assignment.
  iframe.setAttribute("sandbox", "allow-same-origin");
  iframe.addEventListener("load", () => {
    // documentElement, not body: it includes the default body margin, which
    // would otherwise be cut off the right and bottom edge.
    const root = iframe.contentDocument?.documentElement;
    if (!root) return;
    iframe.style.width = `${Math.ceil(root.scrollWidth)}px`;
    // Height right away: reading scrollHeight flushes the iframe's layout, so it already reflects the new width (widening re-wraps text). Not deferred to a frame — requestAnimationFrame never fires in a hidden or throttled window, which left the frame at its 200px default for good.
    fitHeight();
    // One more pass a frame later: images, web fonts and late style recalcs can still grow the document after load.
    requestAnimationFrame(fitHeight);
  });

  let fittedHeight = null;
  function fitHeight() {
    const root = iframe.contentDocument?.documentElement;
    if (!root) return;
    const height = Math.ceil(root.scrollHeight);
    if (height === fittedHeight) return;
    fittedHeight = height;
    iframe.style.height = `${height}px`;
    onFitted?.();
  }

  return iframe;
}
