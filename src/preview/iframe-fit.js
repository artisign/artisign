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
 * Width settles synchronously on `load`; height only one animation frame
 * later (see the comment below) — a caller that needs to react once the
 * iframe's FINAL size (both dimensions) is known must use `onFitted`
 * rather than its own `load` listener, which would read a stale
 * placeholder height. `mockup-zoom.js`'s `applyMockupZoom` is exactly that
 * case: reading `scrollHeight` from a `load` listener silently measured
 * every column at its CSS-default height, not its rendered content's.
 *
 * @param {() => void} [onFitted] called once, after both width and height
 *   have been set to the content's natural size.
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
    // Height only after the new width has been laid out — widening the frame
    // re-wraps text, so a height measured in the same tick clips the last line.
    requestAnimationFrame(() => {
      iframe.style.height = `${Math.ceil(root.scrollHeight)}px`;
      onFitted?.();
    });
  });
  return iframe;
}
