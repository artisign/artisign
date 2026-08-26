// Design-system view: tokens as swatches, components with every variant
// rendered side by side. Uses `rendered_html` from /api/design-system
// (already resolved server-side — same render pipeline as a screen), so
// each variant cell is just a sandboxed iframe with that HTML as srcdoc.

import { createFittingIframe } from "./iframe-fit.js";

/** @param {string} camel */
function toKebabCase(camel) {
  return camel.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/** @param {unknown} value @returns {string} */
function objectToInlineStyle(value) {
  return Object.entries(value)
    .map(([prop, val]) => `${toKebabCase(prop)}: ${val}`)
    .join("; ");
}

/**
 * @param {string} bucket
 * @param {string} name
 * @param {unknown} value
 * @returns {HTMLElement}
 */
function renderTokenSwatch(bucket, name, value) {
  const swatch = document.createElement("div");
  swatch.className = "ds-swatch";

  const sample = document.createElement("div");
  if (bucket === "color" && typeof value === "string") {
    sample.className = "ds-color-chip";
    sample.style.background = value;
  } else if (bucket === "spacing" && typeof value === "string") {
    sample.className = "ds-sample-spacing";
    sample.style.width = value;
  } else if (bucket === "radius" && typeof value === "string") {
    sample.className = "ds-sample-radius";
    sample.style.borderRadius = value;
  } else if (bucket === "shadow" && typeof value === "string") {
    sample.className = "ds-sample-shadow";
    sample.style.boxShadow = value;
  } else if (bucket === "typography") {
    sample.className = "ds-sample-typography";
    sample.textContent = "Aa";
    sample.setAttribute("style", typeof value === "string" ? value : objectToInlineStyle(value));
  }
  if (sample.className) swatch.appendChild(sample);

  const nameEl = document.createElement("div");
  nameEl.className = "ds-name";
  nameEl.textContent = name;
  swatch.appendChild(nameEl);

  const valueEl = document.createElement("div");
  valueEl.className = "ds-value";
  valueEl.textContent = typeof value === "string" ? value : JSON.stringify(value);
  swatch.appendChild(valueEl);

  return swatch;
}

/** @param {{ name: string, rendered_html: string }} variant */
function renderVariantCell(variant) {
  const cell = document.createElement("div");
  cell.className = "ds-variant-cell";

  const label = document.createElement("div");
  label.className = "ds-variant-label";
  label.textContent = variant.name;
  cell.appendChild(label);

  const iframe = createFittingIframe();
  iframe.srcdoc = variant.rendered_html;
  cell.appendChild(iframe);

  return cell;
}

/** @param {string} idea @returns {HTMLElement | null} */
function renderIdeaSection(idea) {
  if (!idea) return null;
  const section = document.createElement("section");
  section.className = "ds-section";
  const heading = document.createElement("h2");
  heading.textContent = "Idea";
  section.appendChild(heading);

  const body = document.createElement("div");
  body.className = "ds-idea-body";
  const p = document.createElement("p");
  p.textContent = idea;
  body.appendChild(p);
  section.appendChild(body);
  return section;
}

/**
 * @param {{ id: string, date: string, title: string, body: string, status: "active" | "superseded" }[]} decisions
 * @returns {HTMLElement | null}
 */
function renderDecisionsSection(decisions) {
  if (!decisions || decisions.length === 0) return null;
  const section = document.createElement("section");
  section.className = "ds-section";
  const heading = document.createElement("h2");
  heading.textContent = "Decisions";
  section.appendChild(heading);

  const list = document.createElement("div");
  list.className = "ds-decisions-list";
  for (const decision of decisions) {
    const superseded = decision.status === "superseded";
    const row = document.createElement("div");
    row.className = superseded ? "ds-decision ds-decision-superseded" : "ds-decision";

    const date = document.createElement("span");
    date.className = "ds-decision-date";
    date.textContent = decision.date;
    row.appendChild(date);

    const body = document.createElement("div");
    body.className = "ds-decision-body";

    const titleRow = document.createElement("div");
    titleRow.className = "ds-decision-title-row";
    const title = document.createElement("span");
    title.className = "ds-decision-title";
    title.textContent = decision.title;
    titleRow.appendChild(title);
    const pill = document.createElement("span");
    pill.className = superseded ? "ds-decision-status ds-decision-status-superseded" : "ds-decision-status";
    pill.textContent = decision.status;
    titleRow.appendChild(pill);
    body.appendChild(titleRow);

    if (decision.body) {
      const text = document.createElement("p");
      text.className = "ds-decision-text";
      text.textContent = decision.body;
      body.appendChild(text);
    }

    row.appendChild(body);
    list.appendChild(row);
  }
  section.appendChild(list);
  return section;
}

/** @param {unknown} usage @returns {HTMLElement | null} */
function renderUsage(usage) {
  if (typeof usage !== "string" || usage.length === 0) return null;
  const p = document.createElement("p");
  p.className = "ds-usage";
  p.textContent = usage;
  return p;
}

/**
 * @param {HTMLElement} container
 * @param {Record<string, unknown>} data — full-view /api/design-system response
 */
export function renderDesignSystem(container, data) {
  container.innerHTML = "";

  const ideaSection = renderIdeaSection(/** @type {string} */ (data.idea));
  if (ideaSection) container.appendChild(ideaSection);

  const decisionsSection = renderDecisionsSection(/** @type {any[]} */ (data.decisions));
  if (decisionsSection) container.appendChild(decisionsSection);

  const tokensByBucket = new Map();
  for (const { path, value } of /** @type {{path: string, value: unknown}[]} */ (data.token_values ?? [])) {
    const dot = path.indexOf(".");
    const bucket = dot === -1 ? path : path.slice(0, dot);
    const name = dot === -1 ? path : path.slice(dot + 1);
    if (!tokensByBucket.has(bucket)) tokensByBucket.set(bucket, []);
    tokensByBucket.get(bucket).push([name, value]);
  }

  const tokensSection = document.createElement("section");
  tokensSection.className = "ds-section";
  const tokensHeading = document.createElement("h2");
  tokensHeading.textContent = "Tokens";
  tokensSection.appendChild(tokensHeading);

  for (const [bucket, entries] of tokensByBucket) {
    const bucketHeading = document.createElement("h3");
    bucketHeading.textContent = bucket;
    tokensSection.appendChild(bucketHeading);

    const grid = document.createElement("div");
    grid.className = "ds-swatch-grid";
    for (const [name, value] of entries) grid.appendChild(renderTokenSwatch(bucket, name, value));
    tokensSection.appendChild(grid);
  }
  container.appendChild(tokensSection);

  container.appendChild(renderDefinitionSection("Components", data.component_definitions));
  container.appendChild(renderDefinitionSection("Patterns", data.pattern_definitions));
}

/**
 * One "Components"/"Patterns" section — both arrive from /api/design-system in
 * the same {name, variants[]} shape, so they render identically.
 *
 * @param {string} heading
 * @param {unknown} definitions
 * @returns {HTMLElement}
 */
function renderDefinitionSection(heading, definitions) {
  const section = document.createElement("section");
  section.className = "ds-section";
  const title = document.createElement("h2");
  title.textContent = heading;
  section.appendChild(title);

  const defs = /** @type {{ name: string, variants: { name: string, rendered_html: string }[], usage?: string }[]} */ (
    definitions ?? []
  );
  for (const def of defs) {
    const block = document.createElement("div");
    block.className = "ds-component";

    const name = document.createElement("h3");
    name.textContent = def.name;
    block.appendChild(name);

    const row = document.createElement("div");
    row.className = "ds-variant-row";
    for (const variant of def.variants) row.appendChild(renderVariantCell(variant));
    block.appendChild(row);

    const usage = renderUsage(def.usage);
    if (usage) row.after(usage);

    section.appendChild(block);
  }
  return section;
}
