# Markdown Viewer Rendering Quality Design

Date: 2026-10-31

## Goal

Make the local Markdown viewer reliably render common, complex Markdown documents with community-standard behavior, especially GFM features, KaTeX math, code blocks, tables, images, links, and responsive layout. Preserve the existing directory tree, tabs, deep links, and local-only workflow.

## Decisions

- Use Marked's GFM-compatible options for tables, task lists, strikethrough, and URL autolinking.
- Treat math using explicit, conventional delimiters only: `$...$`, `$$...$$`, `\\(...\\)`, and `\\[...\\]`. Remove heuristic conversion of arbitrary parenthesized prose to math.
- Render KaTeX after Markdown insertion, with safe error-tolerant handling and support for common environments such as `aligned`, `cases`, `matrix`, and `array` when KaTeX supports them.
- Keep raw HTML disabled/sanitized at the Markdown boundary rather than allowing arbitrary document HTML to inject UI content.
- Improve Markdown layout for readable line length, heading rhythm, lists, task checkboxes, tables, blockquotes, images, math overflow, code blocks, links, and print/mobile behavior.
- Fix UTF-8/semantic HTML issues in the shell UI and use accessible controls/focus states.
- Harden asset/content path resolution so a sibling path sharing the target directory prefix cannot bypass the boundary.
- Add a repeatable Node test suite covering server APIs, Markdown output, image URL rewriting, traversal rejection, GFM features, and math delimiter preservation. Add a representative complex Markdown fixture.

## Out of scope

- Full syntax highlighting language support without adding a new highlighter dependency.
- Mermaid/PlantUML execution or arbitrary embedded application widgets.
- Translating the UI into multiple languages.

## Acceptance criteria

1. Common GFM Markdown renders as expected without breaking existing files.
2. Explicit inline and display math renders through the bundled KaTeX assets; code blocks and escaped dollars remain untouched.
3. Complex tables, long formulas, code, images, and links remain usable on desktop and narrow mobile viewports.
4. No malformed UTF-8 UI text or broken icon markup remains.
5. Content and assets cannot escape the selected directory.
6. `npm test` passes from a clean checkout and tests exercise the representative fixture.
