// Use Cases tab — the mapping view: the flow next to the screens its steps map to, in flow order, as real renders in
// sandboxed iframes (same fitting iframe as the design-system and mockup views, screen HTML never touched). An element
// mapping draws an outline plus a numbered pin over the node, positioned with the inspector's own overlay routine
// (updateInspectOverlay) in the parent document; a screen mapping outlines the whole frame; stale and unstable mappings
// are marked. Clicking a step focuses its frame, clicking a frame opens the screen.

import { h, icon, fill } from "./usecases-dom.js";
import { avatar, targetChip, filterChip } from "./usecases-parts.js";
import { createFittingIframe } from "./iframe-fit.js";
import { updateInspectOverlay } from "./inspector.js";
import { avatarOf, actorName, mappingFor, stepScope, changedKeys, formatValue, plural } from "./usecases-data.js";
import { flowSequence, lanesAtStep, numberBranches } from "./usecases-world-data.js";
import { branchLabel } from "./usecases-world-parts.js";

const FRAME_WIDTH = 240;
const WIDE_FRAME_WIDTH = 420;
const WIDE_THRESHOLD = 600;

/**
 * Scrolls the scroll containers inside the render (never the page around the iframe, never the markup) so `el` is in view: a
 * mapped element can sit in a sheet's scroll area below the fold. Only inner scroll offsets change.
 */
export function revealInScrollParents(el) {
  const view = el.ownerDocument.defaultView;
  for (let parent = el.parentElement; parent && parent !== el.ownerDocument.documentElement; parent = parent.parentElement) {
    if (parent.scrollHeight <= parent.clientHeight + 1) continue;
    const overflow = view.getComputedStyle(parent).overflowY;
    if (overflow === "visible") continue; // overflow:hidden boxes still scroll by script, which is all a static render needs
    const box = parent.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    if (rect.bottom > box.bottom) parent.scrollTop += rect.bottom - box.bottom + 12;
    else if (rect.top < box.top) parent.scrollTop -= box.top - rect.top + 12;
  }
}

/** One-line data change of a step: "Mapping: scope screen → element, node → btn-mapping". */
export function dataChangeLine(step, objectsById) {
  return (step.data ?? [])
    .map((entry) => {
      const keys = [...changedKeys(entry.before, entry.after)];
      if (keys.length === 0) return null;
      const parts = keys.map((key) => (entry.before && Object.hasOwn(entry.before, key) ? `${key} ${formatValue(entry.before[key])} → ${formatValue(entry.after[key])}` : `${key} → ${formatValue(entry.after[key])}`));
      return `${objectsById.get(entry.object)?.name ?? entry.object}: ${parts.join(", ")}`;
    })
    .filter(Boolean)
    .join(" · ");
}

/**
 * The distinct screens of a flow in order of first use, each with the steps (number, mapping) that point at it. Numbers are 1, 2, …
 * for main steps and `2A.1` (fork step, letter, position) for branch steps; a branch before the first step leads (A.1).
 */
export function framesOf(steps, bundle, branches = []) {
  const frames = new Map();
  for (const { step, number, branch } of flowSequence(steps, branches)) {
    if (!step.target) continue;
    const found = mappingFor(bundle, step.id);
    let frame = frames.get(step.target.screen);
    if (!frame) {
      frame = { screen: step.target.screen, exists: found?.screen.exists !== false, steps: [] };
      frames.set(step.target.screen, frame);
    }
    frame.steps.push({ step, number, branch: Boolean(branch), mapping: found?.mapping ?? null, scope: stepScope(step, found?.mapping) });
  }
  return [...frames.values()];
}

/** `uc-frame-no`: the step number as a pill; a branch step's number is dashed. */
const frameNo = (number, branch) => h("span", { class: branch ? "uc-frame-no is-branch" : "uc-frame-no" }, String(number));

/**
 * @param {{
 *   root: HTMLElement,
 *   fetchRender: (screen: string, project: string) => Promise<{ ok: true, html: string } | { ok: false, message: string }>,
 *   handlers: { onBack: () => void, onVariantMenu: (anchor: HTMLElement) => void, onOpenScreen: (screen: string, node: string | null) => void, onPickTarget: (stepId: string) => void, onUnmap: (stepId: string) => void, onStep: (stepId: string) => void },
 * }} options
 */
export function createMappingView({ root, fetchRender, handlers }) {
  let token = 0;
  let selected = null;
  let frameEls = new Map();
  let stepEls = new Map();
  let steps = [];

  function select(stepId, { scroll = true } = {}) {
    selected = stepId;
    for (const [id, el] of stepEls) el.classList.toggle("is-selected", id === stepId);
    const frameScreen = steps.find((s) => s.id === stepId)?.target?.screen;
    for (const [screen, parts] of frameEls) {
      parts.label.classList.toggle("is-selected", screen === frameScreen);
      for (const pin of parts.pins) pin.el.classList.toggle("is-selected", pin.stepId === stepId);
    }
    if (scroll && frameScreen) frameEls.get(frameScreen)?.wrap.scrollIntoView?.({ behavior: "smooth", inline: "center", block: "nearest" });
  }

  function buildFrame(frame, ctx) {
    const { project } = ctx;
    const labelNumbers = frame.steps.map((s) => frameNo(s.number, s.branch));
    // The scope is said in words on the frame itself, not only in the step list: Element / Screen, plus Stale / Unstable.
    const kinds = [];
    if (frame.steps.some((s) => s.scope === "element")) kinds.push(["element", "Element"]);
    if (frame.steps.some((s) => s.scope === "screen")) kinds.push(["screen", "Screen"]);
    if (frame.steps.some((s) => s.scope === "stale") || !frame.exists) kinds.push(["stale", "Stale"]);
    if (frame.steps.some((s) => s.mapping?.unstable)) kinds.push(["unstable", "Unstable"]);
    const label = h("div", { class: "uc-frame-label" }, labelNumbers, h("span", { class: frame.exists ? "uc-frame-name" : "uc-frame-name is-stale" }, frame.screen), kinds.map(([kind, text]) => h("span", { class: "uc-scope-chip", dataset: { kind } }, text)));
    const parts = { pins: [], label };
    const stage = h("div", { class: "uc-frame-stage" });
    const box = h("div", { class: "uc-frame-box", dataset: { exists: String(frame.exists) } });
    parts.box = box;
    const wrap = h("div", { class: "uc-frame" }, label, box);
    parts.wrap = wrap;
    if (!frame.exists) {
      box.style.width = `${FRAME_WIDTH}px`;
      box.style.height = `${Math.round(FRAME_WIDTH * 1.6)}px`;
      box.append(h("div", { class: "uc-frame-missing" }, icon("link_off"), h("strong", null, "Screen not found"), h("p", null, `${plural(frame.steps.length, "step")} point${frame.steps.length === 1 ? "s" : ""} at a screen that no longer exists in this project.`)));
      return { wrap, parts }; // a frame for a missing screen is not a button: nothing to open
    }
    wrap.addEventListener("click", () => handlers.onOpenScreen(frame.screen, frame.steps.find((s) => s.step.id === selected)?.step.target?.node ?? frame.steps.find((s) => s.step.target?.node)?.step.target.node ?? null));
    wrap.setAttribute("role", "button");
    wrap.tabIndex = 0;
    wrap.setAttribute("aria-label", `Open ${frame.screen} in Screens`);
    wrap.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        wrap.click();
      }
    });
    box.style.width = `${FRAME_WIDTH}px`;
    box.style.height = `${Math.round(FRAME_WIDTH * 1.6)}px`;
    box.dataset.loading = "true";
    const iframe = createFittingIframe(() => fit());
    iframe.title = `${frame.screen} (mapping)`;
    iframe.tabIndex = -1;
    stage.append(iframe);
    box.append(stage);

    // Overlays: one outline per element step, one whole-frame outline for screen steps — siblings of the iframe in the
    // parent document, in the iframe's own coordinate space (the stage carries the scale).
    const overlays = [];
    for (const item of frame.steps) {
      if (item.scope === "screen") {
        const outline = h("div", { class: "uc-screen-outline", dataset: { step: item.step.id } }, h("span", { class: "uc-pin-no", title: `Step ${item.number}: whole screen` }, String(item.number)), h("span", { class: "uc-screen-chip" }, "Whole screen"));
        stage.append(outline);
        parts.pins.push({ el: outline, stepId: item.step.id });
      } else if (item.scope === "element" || (item.scope === "stale" && item.step.target.node)) {
        const pin = h("div", { class: "uc-pin", dataset: { step: item.step.id, stale: item.scope === "stale" ? "true" : "false", unstable: item.mapping?.unstable ? "true" : "false" }, hidden: true }, h("span", { class: "uc-pin-no", title: item.mapping?.node?.tag ? `${item.step.target.node} · <${item.mapping.node.tag}>` : item.step.target.node }, String(item.number)));
        stage.append(pin);
        overlays.push({ pin, item });
        parts.pins.push({ el: pin, stepId: item.step.id });
      }
    }

    function fit() {
      const naturalWidth = parseFloat(iframe.style.width) || FRAME_WIDTH;
      const naturalHeight = parseFloat(iframe.style.height) || Math.round(FRAME_WIDTH * 1.6);
      const target = naturalWidth > WIDE_THRESHOLD ? WIDE_FRAME_WIDTH : FRAME_WIDTH;
      const scale = target / naturalWidth;
      box.style.width = `${target}px`;
      box.style.height = `${Math.round(naturalHeight * scale)}px`;
      stage.style.width = `${naturalWidth}px`;
      stage.style.height = `${naturalHeight}px`;
      stage.style.transform = `scale(${scale})`;
      stage.style.setProperty("--inv", String(1 / scale));
      delete box.dataset.loading;
      if (!iframe.srcdoc) return; // the empty document every new iframe starts with: nothing to measure yet
      const doc = iframe.contentDocument;
      for (const { item } of overlays) {
        const el = doc?.getElementById(item.step.target.node);
        if (el) revealInScrollParents(el);
      }
      for (const { pin, item } of overlays) {
        delete pin.dataset.missing;
        pin.dataset.stale = item.scope === "stale" ? "true" : "false";
        updateInspectOverlay(pin, doc, item.step.target.node);
        if (pin.hidden) {
          // The element is not in the render: a warning pin in the frame's corner instead of an outline.
          pin.dataset.stale = "true";
          pin.dataset.missing = "true";
          pin.style.left = "";
          pin.style.top = "";
          pin.style.width = "";
          pin.style.height = "";
          pin.hidden = false;
        }
      }
    }

    fetchRender(frame.screen, project).then((result) => {
      if (token !== ctx.token) return;
      iframe.srcdoc = result.ok ? result.html : `<p style="font-family:system-ui;color:#900;padding:16px">${String(result.message).replace(/[<>&]/g, "")}</p>`;
    });
    return { wrap, parts };
  }

  function show(ctx) {
    token++;
    const myToken = token;
    const { bundle, variantId, variants, pool, project } = ctx;
    const useCase = bundle.use_case;
    const mainSteps = useCase.steps ?? [];
    const branches = useCase.branches ?? [];
    const sequence = flowSequence(mainSteps, branches);
    steps = sequence.map((item) => item.step);
    const frames = framesOf(mainSteps, bundle, branches);
    const variantLabel = variantId ? (variants.find((v) => v.id === variantId)?.title ?? variantId) : "Base";
    frameEls = new Map();
    stepEls = new Map();

    const stepItem = ({ step, number, branch }) => {
      const found = mappingFor(bundle, step.id);
      const scope = stepScope(step, found?.mapping);
      const dataLine = dataChangeLine(step, pool.objectsById);
      const row = h(
        "li",
        { class: "uc-map-step", dataset: { step: step.id, scope, branch: branch ? branch.branch.id : "" } },
        h(
          "button",
          { type: "button", class: "uc-map-step-btn", "aria-label": `Step ${number}: ${step.action}`, onClick: () => { select(step.id); handlers.onStep(step.id); } },
          avatar(avatarOf(step.actor, pool.personasById), "sm", actorName(step.actor, pool.personasById)),
          h("span", { class: "uc-map-step-text" }, h("span", { class: "uc-map-step-action" }, frameNo(number, Boolean(branch)), step.action), step.target ? targetChip(scope, step.target.screen, step.target.node) : h("span", { class: "uc-muted" }, "Not mapped")),
        ),
        dataLine ? h("p", { class: "uc-map-data" }, dataLine) : null,
        scope === "stale"
          ? h(
              "div",
              { class: "uc-map-stale" },
              h("p", null, icon("warning"), found?.screen.exists === false ? `The screen ${step.target.screen} was removed or renamed. Artisign never rewrites mappings on its own.` : `The element ${step.target.node} is gone from ${step.target.screen}. Artisign never rewrites mappings on its own.`),
              h("div", { class: "uc-map-stale-actions" }, h("button", { type: "button", class: "chrome-btn chrome-btn--compact", onClick: () => handlers.onPickTarget(step.id) }, "Pick new target"), h("button", { type: "button", class: "chrome-btn chrome-btn--ghost chrome-btn--compact", onClick: () => handlers.onUnmap(step.id) }, "Leave unmapped")),
            )
          : found?.mapping?.unstable
            ? h("p", { class: "uc-map-warn" }, icon("warning"), "Generated node id — unstable after a rewrite.")
            : null,
      );
      stepEls.set(step.id, row);
      return row;
    };

    // Main steps in a list; each branch is a dashed block right under its fork step (a branch before the first step leads the list).
    const flowList = h("ol", { class: "uc-map-steps" });
    const branchBlock = (entry) => {
      const end = entry.branch.rejoin === undefined ? "ends the case" : `continues at ${mainSteps.findIndex((s) => s.id === entry.branch.rejoin) + 1 || entry.branch.rejoin}`;
      return h(
        "li",
        { class: "uc-map-branch", dataset: { branch: entry.branch.id } },
        h("div", { class: "uc-map-branch-head" }, icon("call_split"), branchLabel(entry)),
        h("ol", { class: "uc-map-steps" }, sequence.filter((item) => item.branch?.branch.id === entry.branch.id).map(stepItem)),
        h("p", { class: "uc-map-branch-end" }, end),
      );
    };
    const numbered = numberBranches(useCase);
    flowList.append(...lanesAtStep(numbered, null).map(branchBlock));
    sequence.filter((item) => !item.branch).forEach((item) => {
      flowList.append(stepItem(item));
      flowList.append(...lanesAtStep(numbered, item.step.id).map(branchBlock));
    });

    const canvas = h("div", { class: "uc-map-canvas", tabindex: "0", "aria-label": "Mapped screens in flow order" });
    const track = h("div", { class: "uc-map-track" });
    frames.forEach((frame, index) => {
      if (index > 0) track.append(h("span", { class: "uc-map-arrow", "aria-hidden": "true" }, icon("arrow_forward")));
      const built = buildFrame(frame, { project, token: myToken });
      frameEls.set(frame.screen, built.parts);
      track.append(built.wrap);
    });
    canvas.append(frames.length === 0 ? h("div", { class: "uc-map-none" }, h("p", null, "No step of this use case is mapped to a screen yet."), h("button", { type: "button", class: "chrome-btn", onClick: () => handlers.onPickTarget(mainSteps[0]?.id ?? "") }, "Edit steps")) : track);

    fill(
      root,
      h(
        "div",
        { class: "uc-mapping" },
        h(
          "div",
          { class: "uc-map-bar" },
          h("button", { type: "button", class: "chrome-icon-btn", "aria-label": "Back to use case", title: "Back to use case", onClick: handlers.onBack }, icon("arrow_back")),
          h("strong", { class: "uc-map-title" }, useCase.title),
          variants.length > 0 ? filterChip({ label: variantLabel, onClick: (e) => handlers.onVariantMenu(e.currentTarget) }) : null,
          h("span", { class: "uc-map-spacer" }),
          branches.length > 0 ? h("span", { class: "uc-legend-item" }, frameNo(2, false), "Main step") : null,
          branches.length > 0 ? h("span", { class: "uc-legend-item" }, frameNo("2A.1", true), "Branch step: fork, letter, position") : null,
          h("span", { class: "uc-legend-item" }, h("span", { class: "uc-swatch", dataset: { kind: "element" } }), "Element"),
          h("span", { class: "uc-legend-item" }, h("span", { class: "uc-swatch", dataset: { kind: "screen" } }), "Whole screen"),
          h("span", { class: "uc-legend-item" }, h("span", { class: "uc-swatch", dataset: { kind: "stale" } }), "Stale"),
        ),
        h("div", { class: "uc-map-body" }, h("aside", { class: "uc-map-flow" }, h("h2", { class: "uc-map-flow-head" }, "Flow", h("span", { class: "uc-h2-meta" }, `${plural(mainSteps.length, "step")}${branches.length > 0 ? ` · ${plural(branches.length, "branch", "branches")}` : ""} · click a step to focus its screen`)), flowList), canvas),
      ),
    );
    select(ctx.stepId ?? null, { scroll: Boolean(ctx.stepId) });
  }

  return {
    show,
    select,
    hide() {
      token++;
      root.replaceChildren();
    },
  };
}
