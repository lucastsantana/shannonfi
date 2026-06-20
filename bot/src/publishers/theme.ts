/**
 * Shared dark "retro CRT" theme — the single source of truth for the color
 * palette, fonts, and base typography classes used by both the live HTML
 * dashboard (dashboard.ts) and the investor-facing monthly PDF report
 * (reporting/src/html-report.ts). Keeping this in one place means a palette
 * change made for the dashboard never has to be re-applied by hand to the
 * report — both consumers import the same CSS source.
 */

/** `<head>` font preconnect + stylesheet tags for VT323 / Share Tech Mono. */
export const GOOGLE_FONTS_HTML = `
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=VT323&family=Share+Tech+Mono&display=swap" rel="stylesheet">`;

/** Dark-mode CSS custom properties — the contents of a `:root { ... }` block. */
export const DARK_THEME_VARS = `
  --g:    #a9c9ff; --g-rgb:    169,201,255;
  --G:    #2979ff; --G-rgb:    41,121,255;
  --b:    #445166; --b-rgb:    68,81,102;
  --B:    #2a323f; --B-rgb:    42,50,63;
  --c:    #00ffff; --c-rgb:    0,255,255;
  --m:    #ff00ff; --m-rgb:    255,0,255;
  --y:    #ffff00; --y-rgb:    255,255,0;
  --r:    #ff4500; --r-rgb:    255,69,0;
  --d:    #8fa3c4; --d-rgb:    143,163,196;
  --bg:   #000000; --bg-rgb:   0,0,0;
  --p:    #010108; --p-rgb:    1,1,8;
  --neut: #cccccc;
  --ov-rgb:    0,0,0;
  --hdr2-bg:   #010102;
  --hdr3-bg:   #01010e;
  --nscr-bg:   #330000;
  --nscr-fg:   #ff6666;
  --fn: 'Share Tech Mono', 'Courier New', monospace;
  --ft: 'VT323', monospace;`;

/** Shared text-color utility classes (gain/loss/cyan/yel/mag/dim/etc). */
export const SHARED_TEXT_CLASSES = `
    .gain { color: var(--G); }
    .loss { color: var(--r); }
    .neut { color: var(--neut); }
    .buy  { color: var(--G); }
    .sell { color: var(--r); }
    .cyan { color: var(--c); }
    .yel  { color: var(--y); }
    .mag  { color: var(--m); }
    .dim  { color: var(--d); }
    small { font-size:.78em; opacity:.8; }`;
