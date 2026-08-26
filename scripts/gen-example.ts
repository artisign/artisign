import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { initProject } from "../src/init/init-project.js";
import { FsStore } from "../src/store/index.js";
import { findTool } from "../src/tools/registry.js";

const dir = resolve("examples/notes-app");

async function main(): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await initProject(dir);

  // Nested inside this repo, so autoCommit stays at its `init` default
  // (true): git.ts's own toplevel guard skips it here (this directory isn't
  // its own repo root), so nothing gets committed into examples/notes-app/.git.
  const store = new FsStore(dir);

  await store.writeTokens({
    color: {
      primary: "#3b5bfd",
      "on-primary": "#ffffff",
      "text-primary": "#16181d",
      "text-secondary": "#5c6270",
      surface: "#ffffff",
      "surface-muted": "#f4f5f7",
      border: "#e2e4ea",
      disabled: "#c3c6cf",
    },
    spacing: {
      sm: "8px",
      md: "16px",
      lg: "24px",
      xl: "40px",
    },
    typography: {
      "heading-lg": "600 28px/1.25 -apple-system, sans-serif",
      "heading-md": "600 20px/1.3 -apple-system, sans-serif",
      body: "400 16px/1.5 -apple-system, sans-serif",
      caption: "400 13px/1.4 -apple-system, sans-serif",
    },
    radius: {
      sm: "6px",
      md: "10px",
    },
    shadow: {
      card: "0 1px 3px rgba(16, 18, 22, 0.08)",
    },
    motion: {
      fast: "120ms ease",
    },
  });

  // Base (default) + two named variants — hover and disabled.
  await store.writeComponent(
    "btn-primary",
    [
      '<button style="color: $color.on-primary; background: $color.primary; padding-block: $spacing.sm; padding-inline: $spacing.lg; border-radius: $radius.md; font: $typography.body">',
      '  <span data-slot="label">Button</span>',
      "</button>",
      '<template data-variant="hover">',
      '  <button style="color: $color.on-primary; background: $color.primary; padding-block: $spacing.sm; padding-inline: $spacing.lg; border-radius: $radius.md; font: $typography.body; box-shadow: $shadow.card">',
      '    <span data-slot="label">Button</span>',
      "  </button>",
      "</template>",
      '<template data-variant="disabled">',
      '  <button style="color: $color.surface; background: $color.disabled; padding-block: $spacing.sm; padding-inline: $spacing.lg; border-radius: $radius.md; font: $typography.body">',
      '    <span data-slot="label">Button</span>',
      "  </button>",
      "</template>",
    ].join("\n"),
  );

  const writeHtml = findTool("write_html");
  if (!writeHtml) throw new Error("write_html tool not found");

  const welcome = [
    '<section style="padding: $spacing.xl; background: $color.surface-muted" data-section="onboarding">',
    '  <h1 style="color: $color.text-primary; font: $typography.heading-lg">Your notes, everywhere</h1>',
    '  <p style="color: $color.text-secondary; font: $typography.body">Capture ideas fast and find them again later.</p>',
    '  <button class="$btn-primary" data-flow-target="notes" data-flow-trigger="tap">',
    '    <span data-slot="label">Get started</span>',
    "  </button>",
    "</section>",
  ].join("\n");

  const notes = [
    '<section style="padding: $spacing.lg; background: $color.surface" data-section="app">',
    '  <h1 style="color: $color.text-primary; font: $typography.heading-md">Your notes</h1>',
    '  <div style="padding: $spacing.md; border-radius: $radius.sm; box-shadow: $shadow.card; background: $color.surface">',
    '    <p style="color: $color.text-secondary; font: $typography.body">Grocery list</p>',
    "  </div>",
    '  <div style="padding: $spacing.md; border-radius: $radius.sm; box-shadow: $shadow.card; background: $color.surface">',
    '    <p style="color: $color.text-secondary; font: $typography.body">Trip ideas for June</p>',
    "  </div>",
    '  <button class="$btn-primary" data-flow-target="new-note" data-flow-trigger="tap">',
    '    <span data-slot="label">New note</span>',
    "  </button>",
    "</section>",
  ].join("\n");

  const newNote = [
    '<section style="padding: $spacing.lg; background: $color.surface" data-section="compose">',
    '  <h1 style="color: $color.text-primary; font: $typography.heading-md">New note</h1>',
    '  <p style="color: $color.text-secondary; font: $typography.caption">Untitled, just now</p>',
    '  <button class="$btn-primary" data-variant="hover">',
    '    <span data-slot="label">Save</span>',
    "  </button>",
    '  <button class="$btn-primary" data-variant="disabled">',
    '    <span data-slot="label">Share (sign in required)</span>',
    "  </button>",
    "</section>",
  ].join("\n");

  for (const [screen, title, html] of [
    ["welcome", "Welcome", welcome],
    ["notes", "Notes", notes],
    ["new-note", "New note", newNote],
  ] as const) {
    const result = (await writeHtml.handler(store, {
      screen,
      mode: "create",
      title,
      html_aug: html,
    })) as { errors?: unknown[]; warnings?: unknown[] };
    if (result.errors && result.errors.length > 0) {
      throw new Error(`${screen}: ${JSON.stringify(result.errors)}`);
    }
    console.log(screen, "warnings:", JSON.stringify(result.warnings));
  }

  // A mockup: two early hero-section directions, outside the
  // design system entirely — raw HTML with inline styles, no refs.
  const writeMockup = findTool("write_mockup");
  if (!writeMockup) throw new Error("write_mockup tool not found");

  await writeMockup.handler(store, {
    mockup: "welcome-hero",
    variant: "bold",
    mode: "create",
    title: "Bold headline",
    description: "Large type, high-contrast CTA, minimal copy.",
    html: [
      '<section style="padding: 40px; background: #16181d">',
      '  <h1 style="color: #ffffff; font: 700 34px/1.15 -apple-system, sans-serif; margin: 0 0 12px">Never lose a thought again</h1>',
      '  <button style="color: #16181d; background: #ffffff; padding: 12px 24px; border-radius: 999px; border: none; font: 600 16px -apple-system, sans-serif">Get started</button>',
      "</section>",
    ].join("\n"),
  });

  await writeMockup.handler(store, {
    mockup: "welcome-hero",
    variant: "friendly",
    mode: "create",
    title: "Friendly and soft",
    description: "Rounded shapes, warm background, conversational copy.",
    html: [
      '<section style="padding: 40px; background: #fff4e8; border-radius: 24px">',
      '  <h1 style="color: #3b2f22; font: 600 28px/1.3 -apple-system, sans-serif; margin: 0 0 12px">Jot it down before it slips away</h1>',
      '  <button style="color: #ffffff; background: #e08a3e; padding: 12px 28px; border-radius: 16px; border: none; font: 600 16px -apple-system, sans-serif">Try it now</button>',
      "</section>",
    ].join("\n"),
  });

  // .artisign/ is a derived cache — regenerated on next `serve`, not shipped in the example.
  await rm(resolve(dir, ".artisign"), { recursive: true, force: true });

  console.log("done ->", dir);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
