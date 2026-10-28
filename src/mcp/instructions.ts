/**
 * Compact augmentation-grammar cheat sheet surfaced to the client as the
 * server's `instructions` — a design agent's first look at how to
 * write screens, before it ever calls a tool. Kept to a single copy: tool
 * descriptions point back here instead of repeating the grammar.
 */
export const INSTRUCTIONS = `Artisign — augmentation grammar for screen HTML (html_aug).

PROJECT: start with list_projects. Every tool but list_projects/init_project/
get_guide takes a required "project": a project name or an absolute path.
init_project returns it.

WORKFLOW: tokens -> components -> screens; inline values only while exploring
screen one of a direction, promoted before screen two; second occurrence of a
value/pattern gets promoted, named by role. One write, one look
(get_screenshot/inspect_node).

COMPONENT INSTANCE — two equivalent syntaxes:
  class="$btn-primary"            (token-style ref)
  data-component="btn-primary"    (explicit, wins if both present)
A child with data-slot="label" fills that slot; other children fill
positional slots (slot-0, slot-1, ...) in document order.
In a definition, never style the data-slot element — style a wrapper.

TOKEN REF — inside a style VALUE, mixable with literal text, multiple per value:
  style="border: 1px solid $color.border; padding: $spacing.sm $spacing.lg"
Flat names ($primary) resolve if unambiguous. Modifier functions wrap a
ref: alpha($color.primary, 0.1), oklab($color.primary), mix($a, $b, 0.5).

VARIANT:
  data-variant="hover"            selects a component variant

FLOWS:
  data-flow-target="checkout"     screen id, or "checkout.node-id" for a node
  data-flow-trigger="tap"         optional; tap (default) | hover | longpress
                                   | swipe-left | swipe-right

NODE IDS:
  id="btn-login"  stable, human-chosen; generated if omitted — keep it
  stable across writes (patches and comments address nodes by id).
NODE REFS: "<screen>.<node-id>"; a definition node is
"component:<name>#<variant>.<node-id>" or "pattern:<name>.<node-id>"; a mockup
node (patch_html, inspect_node only) "mockup:<name>#<variant>.<node-id>". Taken by
get_node, update_refs, patch_html, inspect_node, get_screenshot; returned by
find_nodes. A definition node without an explicit id keeps its ref for one call
only (find_nodes: id_stability "derived"; writes warn missing_id). A node in a
slot fill is no ref for get_node/update_refs; with an authored id,
patch_html/inspect_node take "<screen>.<id>".

EXAMPLE:
  <section id="hero" style="padding: $spacing.lg">
    <button id="btn-login" class="$btn-primary" data-variant="hover"
            data-flow-target="dashboard">
      <span data-slot="label">Log in</span>
    </button>
  </section>

REVIEW LOOP: after every write_html / patch_html, call get_screenshot
{screen} and check the image before the next edit — red outlines mark an
unresolved token, component, or variant ref.

METADATA: set_meta (targets in its description). A tag's notes (a spec spanning
several screens) surface as tag_notes in get_project/get_screen; find screens or
mockups by tag via get_project {tags: [...]}. Notes, idea, decisions and usage
render as Markdown in the preview.

LIFECYCLE: write_html kind:"component"|"pattern" writes a definition (default
variant + <template data-variant> siblings); delete_entity removes a
screen/component/pattern/mockup.

MOCKUPS: several options of one screen, or early directions before a design
system exists — raw HTML, outside the ref model, no drift warnings.
write_mockup per variant -> get_screenshot {mockup, variant} in a loop ->
promote_mockup {mockup, variant, screen} copies the chosen one into a real
screen (the mockup stays as history; delete_entity it when done). Refs/drift
discipline applies to that screen from then on.
Small edits: patch_html on mockup:<name>#<variant>.<id> — never edit the files directly.

RENDER ENVIRONMENT (guaranteed, no re-declare needed): border-box sizing,
zero body margin — declared widths/heights render exactly as given. A screen
renders at its root's declared width/height; undeclared = 390x844, a phone
— a desktop product needs a desktop root width. Fonts
named in tokens.json typography values are auto-loaded. Icons: bundled
Material Symbols Rounded, outline only (no FILL), predefined .icon class
(never declare your own or load another family): <span class="icon">close</span>,
size via font-size. A full-<html> mockup gets none of this baseline.
Local images: src="assets/x.png" / url(assets/x.png), from the project's
assets/ folder only — copy local files in.`;
