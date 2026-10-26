# Web assets

The landing page, guides and app styling come from the designer's handoff (React/Vite, 2026-11-01), adapted to this Bun build. Their text was rewritten for the Base MVP; the source is `src/copy/site.json` and `src/copy/guides.json`, and the banned-words gate checks both.

| File | Source |
|---|---|
| `public/assets/canopy-hero-liquid-loop.*`, `canopy-landscape-loop.*` | Ten-second films the designer generated for Canopy, with matching posters. The hero film also plays in the footer |
| `public/assets/canopy-logo.png`, `public/icon-*.png` | Resized from the designer's transparent cut of the official Canopy mark |
| `public/assets/scenario-*.jpg` | Unsplash, under the Unsplash License: coast by John Towner, mountain valley by Jimmy Liu, forest by Jon Flobrant |
| `public/assets/integrations/*` | Official brand-kit marks for Base, Morpho, Telegram, Robinhood Chain and Uniswap. They name what Canopy works with and imply no endorsement |
| `src/site/geist.woff2` | Geist, SIL Open Font License 1.1 (`public/fonts/Geist-OFL.txt`). It is inlined into the stylesheets |

Left out on purpose: the Conicorn template's own media, including its footer film, the reference copies of the template, rejected film drafts and the sample dashboard data.
