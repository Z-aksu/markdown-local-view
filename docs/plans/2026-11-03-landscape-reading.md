# Landscape Reading Implementation Plan

**Goal:** Add a reversible landscape reading control at the right edge of the existing mobile toolbar, with a helpful fallback when native rotation is unavailable.

**Architecture:** Keep reading mode separate from native screen orientation. A small controller owns only the orientation lock and fullscreen session it creates. Use the same mobile media query in the startup script, styles, and application so landscape phones retain drawer navigation.

**Tech Stack:** Existing HTML, CSS, vanilla JavaScript, Node test runner, and optional Playwright browser regression tests.

## Accepted design

- Pin a rotation button after the tab overflow control. Use the current blue accent for its active state and retain a 44px minimum touch target.
- Clicking enters a wide reading layout; the same button exits. Keep the current document, tabs, and reading position. Restore the previous drawer state on exit.
- Match `D:/pdf-local-preview`: request fullscreen directly from the click, then try native landscape locking. Keep usable fullscreen when locking fails. Release only locks/fullscreen created by this mode.
- On missing or rejected APIs, retain a usable reading mode and show a dismissible, accessible hint to rotate the phone manually. Do not claim the native rotation succeeded.
- Keep drawer navigation on touch devices in landscape even above the existing 768px width breakpoint. Account for display cutouts and dynamic viewport height.
- Hide the search label and input in landscape reading so the directory has more vertical room. Suspend any existing filter while hidden, retaining the query and folder expansion; restore search and filtering on exit.
- A narrow desktop window only shares the mobile layout. Check for a coarse primary pointer before entering native reading mode; desktop clicks show a dismissible hint without any fullscreen or orientation request, preventing fullscreen-resize-exit flashes.

## Task 1: Toolbar and responsive layout

**Files:** `public/index.html`, `public/style.css`, `public/script.js`

1. Add the labeled, pressed-state rotation control and live hint to the existing toolbar.
2. Share the mobile layout criterion with initial sidebar rendering and sidebar behavior.
3. Style the active reading mode, compact controls, safe areas, and hint without covering the exit control.

**Validation:** Browser checks at 320px, 390px, and 844px landscape; desktop control remains hidden; overflow dropdown and drawer remain usable.

## Task 2: Native rotation and reversible state

**Files:** `public/script.js`

1. Centralize sidebar state updates so reading mode can temporarily collapse and restore it without overwriting desktop preferences.
2. Implement entry/exit, fullscreen before orientation locking, and fallback hints.
3. Handle pending requests, fullscreen dismissal, Escape, and cleanup. Preserve document state and reading position.

**Validation:** Simulate API success, missing APIs, fullscreen requirements, rejection, external fullscreen ownership, cancellation, and re-entry in a real browser test harness.

## Task 3: Regression checks and documentation

**Files:** `test/landscape.browser.test.js`, `README.md`

1. Add behavioral browser regression coverage for the new control and its interaction with the existing toolbar.
2. Run `npm test` with the bundled Playwright runtime available through `NODE_PATH`.
3. Capture and inspect portrait, fallback-hint, and landscape screenshots from the test harness.
4. Review the final diff and document the mobile feature and manual-rotation fallback.

**Completion:** All applicable tests pass, screenshots show usable controls without clipping, and unsupported browsers have a clear manual rotation path.
