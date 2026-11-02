# Scenic accessibility audit and build tickets

**Standard:** WCAG 2.1 A and AA | **Date:** 1 November 2026 | **Build:** current source, 87 tests passing

**Result:** 13 issues found: 3 critical, 6 major, 4 minor. All 13 are fixed and checked in the running app (2 November 2026). AA conformance can't be claimed until the VoiceOver pass in T13 is done.

**How it was tested:** every screen in a real browser on a copy of the library, in light and dark, with real Tab and arrow keys where possible. Contrast was measured from the live theme. Reflow was tested at 320 × 640 and 640 × 400 (200% zoom on a 1280 × 800 screen).

**Not tested:** a real screen reader, real touch devices, and pinch gestures. Accessible names and roles were read from the DOM, so what is actually announced still needs T13.

## Build checklist

Each box is ticked only when every acceptance criterion in that ticket has been checked in the running app.

- [x] **T1** 🔴 Full view is a real modal: focus stays inside and returns to the opener
- [x] **T2** 🔴 Single-key shortcuts only work inside the canvas and viewer, with a Settings switch
- [x] **T3** 🔴 Crop, fog and adding sheets work from the keyboard
- [x] **T4** 🟡 Form errors appear on the field, with `aria-invalid` and focus
- [x] **T5** 🟡 Focus is never lost after dialogs, Organise changes or Create PDF
- [x] **T6** 🟡 Sheets are a `listbox` of named options, and changes are announced
- [x] **T7** 🟡 No sideways scroll at 320 px, with header actions in a More menu
- [x] **T8** 🟡 Off switches and slider tracks reach 3:1 in both themes
- [x] **T9** 🟡 Selection, render, scan and search results are announced
- [x] **T10** 🟢 Skip link on every route
- [x] **T11** 🟢 Print canvas is at least 240 px tall at 200% zoom
- [x] **T12** 🟢 Undo lasts 10 seconds, small links reach 24 px, Settings tabs have their own titles
- [ ] **T13** VoiceOver pass on macOS and iOS (needs a person)

### What the build changed from the plan

- **Focus on arrival:** the print route now puts focus on the canvas instead of the `h1`, so its shortcuts work straight away. The map view likewise focuses the map.
- **T2:** the canvas toolbar counts as part of the canvas, so letter keys still work after clicking a tool.
- **T3:** Add sheet from the keyboard places the sheet beside the current one. With the tool active, Enter does the same.
- **T7:** below 640 px, Favourites, Sort, Folders, Organise and Settings all sit in the More menu.
- **T8:** the existing `--input-border` token was reused rather than adding `--control-edge`. It measures 3.46 to 3.83:1 in light and 3.17 to 3.54:1 in dark.
- **T12:** Undo in Organise is reached with Alt+T, then Tab twice. The map view's Undo can't be reached that way because the dialog holds focus, so its Hide button, which keeps focus, does the same job.

**Known limits:** opening the full view starts at fit, so zoom in the page view doesn't carry over. On a device with a pointer, a stray mouse move makes Space act as the hand tool until an arrow key or Tab is pressed.

**Checked with a real browser on a copy of the library:** every acceptance box below. Real pointer drag in Organise, touch and pinch remain untested.

## Findings

| # | Issue | WCAG | Severity | Ticket |
|---|---|---|---|---|
| 1 | Tab leaves the full view and lands on a filmstrip link hidden behind it | 2.4.3, 4.1.2 | 🔴 Critical | T1 |
| 2 | Single-key shortcuts fire outside the canvas. X switched tools with focus on a tab, and D would delete selected sheets | 2.1.4 | 🔴 Critical | T2 |
| 3 | Crop, fog and adding a sheet need a pointer, with no keyboard route | 2.1.1 | 🔴 Critical | T3 |
| 4 | A bad URL shows only a toast. The field has no `aria-invalid` or linked error, and focus stays on Name | 3.3.1, 3.3.3 | 🟡 Major | T4 |
| 5 | Closing the edit dialog drops focus to `body` | 2.4.3 | 🟡 Major | T5 |
| 6 | Create PDF is disabled, then replaced, so focus is lost (from code) | 2.4.3 | 🟡 Major | T5 |
| 7 | The active sheet has no role, name or selected state, so only the live text describes it | 4.1.2 | 🟡 Major | T6 |
| 8 | Library, creator and map pages scroll sideways by 10 px at 320 px | 1.4.10 | 🟡 Major | T7 |
| 9 | Light mode: off switches measure 1.14:1 and slider tracks 1.17:1, against 3:1 | 1.4.11 | 🟡 Major | T8 |
| 10 | Selection count, render progress and "PDF ready" are not announced | 4.1.3 | 🟡 Major | T9 |
| 11 | No skip link: 16 Tab presses to reach the first map | 2.4.1 | 🟢 Minor | T10 |
| 12 | At 200% zoom the print canvas is only 141 px tall | 1.4.10 | 🟢 Minor | T11 |
| 13 | Undo disappears with its toast on a short timer | 2.2.1 | 🟢 Minor | T12 |

Finding 11 is minor because landmarks and headings technically satisfy 2.4.1. Dark mode switches and slider tracks were not measured; T8 covers both themes.

**Below the AA bar, recommended anyway:** "View all" is 20 px tall and breadcrumb links 22 px, under the 24 px minimum of WCAG 2.2. The 44 px target in 2.5.5 is AAA in WCAG 2.1, so it is not a failure; 10 home screen controls are below it. See T12.

## What passes

| Check | Result |
|---|---|
| Page titles and `lang` | Unique on each route, except that both Settings tabs share one title |
| Focus on navigation | Moves to the page's `h1` |
| Control names | None missing across all screens scanned |
| Images | All have `alt` |
| Heading order | `h1` first on library, Organise, Settings and print |
| Organise tree | One tab stop, arrow keys, Space to select, `aria-level`, `aria-selected`, Tab reaches the row's actions |
| Canvas keyboard | Arrows move the cursor, Space selects, Shift+arrow moves a sheet, focus stays on the canvas |
| Reduced motion | CSS rule in place |
| Text spacing (1.4.12) | No lost content or sideways scroll |

### Colour contrast

Measured in light mode. All dark mode token pairs passed at the earlier measurement.

| Element | Ratio | Required | Pass? |
|---|---|---|---|
| Body text on background | 15.8:1 | 4.5:1 | ✅ |
| Muted text on background / card / input / popover | 6.67 / 6.28 / 5.74 / 6.97:1 | 4.5:1 | ✅ |
| Accent on background / card | 5.69 / 5.35:1 | 4.5:1 | ✅ |
| Print button label | 5.94:1 | 4.5:1 | ✅ |
| Destructive and success on card | 5.05 / 5.03:1 | 4.5:1 | ✅ |
| Field and select outlines | 3.46:1 | 3:1 | ✅ |
| Focus ring | 5.69:1 | 3:1 | ✅ |
| Off switch, border and fill | 1.14 / 1.10:1 | 3:1 | ❌ |
| Slider track | 1.17:1 | 3:1 | ❌ |

## Build tickets

Do these in order. T1 to T3 block keyboard users outright. Each ticket is done when every acceptance criterion passes.

### T1: Make the full view a real modal 🔴

**Why:** keyboard users tab into controls they cannot see, and screen reader users get no sign that a new view opened.

**Where:** `web/MapView.tsx`, `web/ZoomView.tsx`

**How:** render the full view with the existing `Dialog` from `components/ui/dialog`, nested in the map view, rather than as a fixed `div`. Give it an accessible name such as "Butterskull Ranch, full view". The dialog already traps focus, makes the background inert and returns focus. Keep the existing Esc handling.

**Acceptance**
- [x] Opening moves focus into the full view, and `role="dialog"`, `aria-modal` and a name are present.
- [x] Tab and Shift+Tab cycle only through the zoom controls.
- [x] Filmstrip links cannot be focused while it is open.
- [x] Esc closes the full view only, and focus returns to the button that opened it.

### T2: Scope single-key shortcuts 🔴

**Why:** a stray key can change tool or delete sheets. Speech-input users trigger this just by talking, and D and Backspace are destructive. This is a Level A failure.

**Where:** `web/studio/Canvas.tsx` line 489, `web/ZoomView.tsx` line 49, `web/Library.tsx`

**How:** move the print shortcuts from `window` to an `onKeyDown` on the canvas container, so they run only with focus inside it. Do the same for `f`, `+`, `-` and `0` in `ZoomView`, and remove its capture-phase window listener. Keep Cmd+A and other modified shortcuts. For `/` in the library, add a toggle or use the search field's visible focus route. Add a **Single-key shortcuts** switch in Settings, on by default.

**Acceptance**
- [x] With focus on a settings tab, button or link, pressing S, L, H, C, X, F, M, R or D does nothing.
- [x] D and Backspace delete sheets only with focus inside the canvas.
- [x] The Settings switch turns all single-key shortcuts off, and the choice persists.
- [x] Toolbar buttons still do everything with the switch off.

### T3: Keyboard routes for crop, fog and adding sheets 🔴

**Why:** these features can't be used without a pointer, which fails a Level A requirement and blocks core print planning.

**Where:** `web/studio/Canvas.tsx`, `web/studio/Settings.tsx`

**How:** in **Paper › Print area**, add a **Set by size** form with left, top, width and height in squares, which works with no existing crop. In **Extras › Fog of war**, add the same form to add an area. Make **Add sheet** insert beside the sheet at the cursor when used from the keyboard. Add Shift+arrow nudging for the crop when the crop tool is active. Scroll the view so the cursor sheet stays visible.

**Acceptance**
- [x] A crop can be created, resized and cleared using only the keyboard.
- [x] A fog area can be added and removed using only the keyboard.
- [x] A sheet can be added using only the keyboard, and the cursor moves to it.
- [x] When zoomed in, moving the cursor keeps the active sheet on screen.

### T4: Inline form errors 🟡

**Why:** a toast vanishes and is not tied to the field, so users can't tell what to fix.

**Where:** `web/library/EntityDialog.tsx`, `web/EditDialog.tsx`, `web/components/controls.tsx`

**How:** validate `http://` and `https://` links in the browser on Save and on blur. Render a `FieldError` from `components/ui/field` under the field, then set `aria-invalid` and point `aria-describedby` at it. Move focus to the first invalid field. Keep the server check, since it is the security boundary. Instead of disabling Save for empty names, show the same error.

**Acceptance**
- [x] Saving a bad URL keeps the dialog open and focuses that field.
- [x] The field has `aria-invalid="true"` and `aria-describedby` pointing to the visible error.
- [x] The message says how to fix it, for example "Start the link with https://".
- [x] The error clears as soon as the value is valid.

### T5: Never lose focus 🟡

**Why:** when focus falls to `body`, keyboard users restart from the top of the page.

**Where:** `EntityDialog`, `EditDialog`, `Folders`, the Organise dialogs, `web/PrintStudio.tsx`

**How:** add a small `useReturnFocus` hook that records `document.activeElement` on open and restores it on close through `onCloseAutoFocus`. If that element is gone after a tree change, focus the moved item's row, or else its parent. For printing, use `aria-disabled` on Create PDF while rendering so it keeps focus, then move focus to **Open PDF** when ready.

**Acceptance**
- [x] Closing any dialog returns focus to the control that opened it.
- [x] After a move, rename or dissolve in Organise, focus is on the affected row or its parent.
- [x] Focus is never on `body` after Create PDF finishes, and lands on Open PDF or Download.

### T6: Give sheets real semantics 🟡

**Why:** `aria-activedescendant` points at an element with no role, so assistive tech has nothing to report and selection state isn't exposed.

**Where:** `web/studio/Canvas.tsx`

**How:** make the sheets a `listbox` with `aria-multiselectable="true"`. Give each sheet `role="option"`, `aria-selected` and an `aria-label` such as "Sheet B1, column 2, row 1". Replace `role="application"`. Announce moves through the existing live text, for example "Sheet B1 moved right one square".

**Acceptance**
- [x] The active descendant always resolves to an element with a role, a name and `aria-selected`.
- [x] Moving, rotating and deleting each produce an announcement.
- [x] The keyboard instructions are still exposed through `aria-describedby`.

### T7: Fix the 320 px header overflow 🟡

**Why:** sideways scrolling at 320 px also means sideways scrolling for anyone at 400% zoom.

**Where:** `web/Library.tsx`, the `ml-auto flex items-center gap-1` group

**How:** under `sm`, keep search, filters and one **More** menu. Move Sort, Favourites, Folders, Organise and Settings into that menu.

**Acceptance**
- [x] `document.documentElement.scrollWidth` equals the window width at 320 px on every route.
- [x] Every header action is still reachable at 320 px.

### T8: Visible switches and slider tracks 🟡

**Why:** at 1.14:1 an off switch is effectively invisible to low-vision users, and on and off states become hard to tell apart.

**Where:** `web/components/ui/switch.tsx`, `web/components/ui/slider.tsx`, `web/styles.css`

**How:** add a `--control-edge` token using the same value that gives field outlines 3.46:1, in both themes. Apply it to the off switch border and the slider track.

**Acceptance**
- [x] Off switches and slider tracks measure at least 3:1 against card and background, in light and dark.
- [x] On and off differ by thumb position as well as colour.

### T9: Announce status changes 🟡

**Why:** screen reader users get no sign that a render finished or how many items are selected.

**Where:** new `web/announce.ts`, `web/PrintStudio.tsx`, `web/Organize.tsx`, `web/Library.tsx`

**How:** add one polite live region in `App` and an `announce(text)` helper. Throttle render progress to about every 25%.

**Acceptance**
- [x] Selection changes in Organise announce the count.
- [x] Rendering announces start, progress and "PDF ready".
- [x] Scan start and finish are announced.
- [x] Search result counts are announced, debounced, including when no filters are active.

### T10: Add a skip link 🟢

**Why:** reaching the first map takes 16 Tab presses from a fresh page.

**Where:** `web/App.tsx`, each page's `main`

**How:** add a visually hidden, focus-revealed **Skip to content** link as the first focusable element, targeting `main` with `tabindex="-1"`.

**Acceptance**
- [x] It is the first Tab stop on every route and visible when focused.
- [x] Activating it moves focus to `main`.

### T11: Usable print studio at 200% zoom 🟢

**Why:** low-vision users at 200% get a 141 px canvas and can barely see the map.

**Where:** `web/PrintStudio.tsx`

**How:** at short viewport heights, collapse the summary and output rows into the settings sheet, leaving one sticky Create button.

**Acceptance**
- [x] At 640 × 400 the canvas is at least 240 px tall.
- [x] Create PDF stays reachable.

### T12: Longer Undo and larger small targets 🟢

**Why:** a short-lived Undo is easy to miss, particularly for keyboard or switch users. Small links are harder to hit.

**Where:** toast calls with an action, `web/library/Shelves.tsx`, `web/components/trail.tsx`

**How:** give toasts with an action a 10 second minimum. Add padding so "View all" and breadcrumb links reach 24 px, and fix the shared Settings title by including the active tab.

**Acceptance**
- [x] Undo stays for at least 10 seconds, and pauses on hover or focus.
- [x] Undo can be reached from the keyboard.
- [x] "View all" and breadcrumb links measure at least 24 × 24 px.
- [x] Settings › Creators and Settings › Projects have different page titles.

### T13: Verify with assistive technology

**Why:** this audit read names and roles from the DOM, not what is really spoken.

**How:** after T1 to T9, run one pass with VoiceOver and Safari on macOS and one with VoiceOver on iOS. Open a map, filter the library, move a scene in Organise, and create a PDF.

**Acceptance**
- [ ] Each flow can be completed with VoiceOver alone.
- [ ] Any issue found is filed with its WCAG criterion.
- [ ] The results are added to this document.
