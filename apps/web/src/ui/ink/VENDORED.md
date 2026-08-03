# Vendored: Rallypoint "Ink" design system

Everything under `apps/web/src/ui/ink/` is a **copy** of the `@rallypoint/ui`
package from a different repository. Treat it as third-party source: do not
hand-edit outside the ledger below, or the next re-sync silently drops your
change.

| | |
|---|---|
| **Upstream repo** | `github.com/bbennetth/rallypoint-core` |
| **Upstream path** | `packages/ui/src` |
| **Vendored at** | `9524f88c980bf3f3a83dd273dcb7ff988345e58c` (2026-08-02) |
| **Vendored on** | 2026-08-03 |
| **Design** | "Soft Ink" — rallypoint-core issue [#762](https://github.com/bbennetth/rallypoint-core/issues/762) |

`@rallypoint/ui` is `private: true` and lives in another repo, so it cannot be
an npm dependency. It also ships raw source (its `exports` map points at
`./src/*`, there is no CSS build step) — which is what makes copying viable:
the consuming app's Vite + `@tailwindcss/vite` processes the CSS either way.

## Scope: dark-only, standalone

Upstream is dual-axis (`data-mode` × `data-color`, 2 chassis × 6 accents) with
a zustand theme store and a pre-hydration boot script. The panel ships the
**dark chassis + blue accent only** — no light mode, no accent switching, no
theme store, no zustand.

Two things are preserved anyway so re-adding those axes stays a paste-back
rather than a rewrite:

- Token files keep upstream's **selector shapes** (`:root, [data-mode='dark']`,
  `:root, [data-color='blue']`) even though the `:root` half alone would do.
- Every tint, wash and glow **derives via `color-mix()`** off `--acid`/`--ink`.
  Nothing downstream hardcodes an accent hex. Keep it that way.

`index.html` sets `data-mode="dark" data-color="blue"` statically for the same
reason.

## What was taken

### Verbatim

| File | Notes |
|---|---|
| `tokens/typography.css` | families, size scale, tracking, leading |
| `tokens/spacing.css` | spacing, control heights, radii, shadows, glass, motion |
| `focus-trap.ts` | upstream `lib/focus-trap.ts` — pure, no DOM deps |
| `fonts/*.woff2` (5) | Archivo Black 400, Space Grotesk 400/500/700, Space Mono 400/700 — 93 KB total |

### Trimmed

| File | Upstream | Here | Dropped |
|---|---|---|---|
| `tokens/colors.css` | 129 | ~80 | light chassis + its shadow/accent overrides, the 5 non-blue accents, `data-theme` back-compat |
| `tokens/primitives.css` | 213 | ~70 | `.chip*`, `.btn-brutal/-ghost/-hot`, `.cyber-input` (superseded by shell.css's `.pl-*`), `.checkbox-field*`, `.image-picker*`. **Gains** the four type roles, which upstream duplicates into shell.css — see below. |
| `theme.css` | 381 | ~110 | light Tailwind remap, `[data-platform='android']`, `.star-clip`, planner/lists layout helpers, and the legacy `.app-*` shell + `.sidebar-link`/`.tabbar-link` + PWA-standalone block |
| `shell.css` | 1373 | ~760 | `.pl-app-row`/`.pl-theme-row`/`.tt-*`, `.pl-topaction-btn`, `.pl-check`, `.rp-swipe-*`, `.pl-pritag`/`.pl-donebtn`, `.pl-fab-*`, `.rp-subbar`/`.rp-fab`, and the duplicated type roles |
| `fonts.css` | 75 | ~65 | the Inter back-compat face |
| `AppChrome.tsx` | 213 | ~165 | swipe-between-tabs navigation |

Each file's own header comment explains its cuts in detail.

### Skipped entirely

| Skipped | Reason |
|---|---|
| `fonts/inter-latin.woff2` | 344 KB back-compat face for siblings that hardcode `font-family: Inter`. No such call-site here — and bigger than all five Ink faces combined. |
| `store/theme.ts`, `ThemeToggle.tsx` | dark-only; zustand consumers |
| `store/toast.ts`, `Toaster.tsx`, `toast-queue.ts` | would add **zustand** as a runtime dep for something `AppChrome` already ships inline (`showToast` + `.pl-toast`) |
| `store/connection.ts`, `connection-status.ts` | `useSseLines` already reports `connected` |
| `AppSwitcher.tsx`, `apps.ts`, `BrandLockup.tsx`, `embedded-shell.ts` | cross-app launcher / PWA embedding; the panel is standalone |
| `swipe-nav.ts`, `SwipeActions.tsx`, `swipe-actions.ts` | see the `AppChrome.tsx` ledger note |
| `PullToRefresh.tsx`, `pull-to-refresh.ts` | every page already polls at 3–5s |
| `useViewportHeight.ts`, `viewportResumeGate.ts` | only the dropped `.app-*` shell needs `--app-vh`; `.plapp` is `height: 100%` |
| `standalone.ts`, `SwUpdateBanner.tsx`, `Fab.tsx`, `SubBar*.tsx`, `fab-anchor.ts`, `Drawer.tsx` | chrome the panel does not render |
| `Button.tsx` | defaults `type="button"` — would silently no-op all five of the panel's form-submit buttons, Sign in included |
| `Field.tsx` | owns its `<input>`; the panel's `Field` wraps arbitrary children (selects, textareas) and the e2e `getByLabel` assertions depend on that wrapping shape |
| `Table.tsx`, `sort.ts` | value-model + click-to-sort; the panel's three tables are JSX-cell and unsorted. `DataTable.tsx` borrows only the `<th>` recipe. |
| `Banner.tsx`, `EmptyState.tsx`, `Avatar.tsx`, `initials.ts` | no `actions` slot / heavier than the panel's one-line empty states / the session carries only a username and `.pl-avatar` already exists |
| `ConfirmDialog.tsx` | `Dialog.tsx` here is modelled on it but takes a children slot — `RestoreDialog` needs a `<dl>`, a warning and a type-to-confirm input |

## Local-edit ledger

The **only** permitted hand-edits. Re-apply these after any re-sync.

| File | Edit |
|---|---|
| `icons.tsx` | 5 glyphs (`terminal`, `users`, `puzzle`, `upload`, `stop`) appended in a marked trailing block on both the `IconName` union and `PATHS`. Kept trailing so the diff is two clean hunks. |
| `AppChrome.tsx` | swipe-nav removed (import, `SwipeStart`, both touch handlers, the `activeIndex` block that only fed them, and `useLocation`/`useNavigate`); `AppChromeNavItem.badge` added and rendered in both nav variants. |
| `theme.css` | its four `@import './tokens/*.css'` lines deleted — hoisted into `apps/web/src/index.css`. A nested `@import` inherits its parent's cascade layer, and the tokens must stay unlayered while `theme.css` is imported `layer(components)`. See the note in `index.css`. |
| `tokens/primitives.css` + `shell.css` | the four type roles (`.display`, `.mono`, `.eyebrow`, `.meta`) are defined in **primitives.css only**. Upstream duplicates them into both, with shell.css winning on source order; `.mono` here takes shell.css's real `font-family` rather than upstream's deliberately-empty primitives copy. Splitting them apart keeps the type layer usable without shell.css, which carries `html, body { overflow: hidden }` and therefore can only be imported once a `.plapp` scroll container exists. |
| `*.css` | `@import` paths rewritten to local relative paths. |

## Known interactions with Tailwind

Two things to keep in mind when editing `apps/web/src/index.css`.

**Cascade layers.** `index.css` imports the token files **unlayered** and the
rule-bearing files into **`layer(components)`**. Both halves matter:

- Unlayered tokens beat Tailwind's `@layer theme` defaults (see the collision
  table below).
- Layered rules lose to Tailwind utilities, which is what a Tailwind codebase
  expects. Imported unlayered, `.pl-input { font-size: 16px }` would silently
  beat `text-xs` on the Settings raw-editor textarea — no error, just a
  16px monospace wall of INI. That textarea is the sentinel: if it stops
  rendering at 12px, the layering broke.

**Variable-name collisions.** Tailwind 4.3.3 and Ink both define
`--text-xs/-sm/-lg`, `--radius-sm/-md/-lg/-xl`, `--tracking-tight`,
`--leading-tight`, `--ease-out` and `--font-mono`. Ink wins (unlayered), which
shifts `text-sm` 14px→13px and `rounded-lg` 8px→12px app-wide. **This is
intentional** — 13px is the Ink dense-row scale and one step rounder is the
Soft Ink brief. If it ever needs undoing, rename Ink's `--text-*`/`--radius-*`
rather than un-layering.

## Re-syncing

Upstream nests components and libs one level deeper, so the paths are not a
straight mirror:

```bash
UP=/path/to/rallypoint-core/packages/ui/src
HERE=apps/web/src/ui/ink

for f in tokens/colors.css tokens/typography.css tokens/spacing.css \
         tokens/primitives.css theme.css shell.css fonts.css; do
  diff -u "$UP/$f" "$HERE/$f"
done
diff -u "$UP/components/icons.tsx"     "$HERE/icons.tsx"
diff -u "$UP/components/AppChrome.tsx" "$HERE/AppChrome.tsx"
diff -u "$UP/lib/focus-trap.ts"        "$HERE/focus-trap.ts"
```

Then re-apply the ledger, update the SHA in this file, and run
`npm run check && npm run e2e`.
