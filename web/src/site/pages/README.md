# Pages

Each `.jsx` file here default-exports one page component, named after the file: `exits.jsx` is the page with
`data-page="exits"`. Give it a matching `web/public/exits.html` (copy `roadmap.html` and change the title,
description and `data-page`), and wrap it in `Shell` from `../Shell.jsx`. `tools/build-web.sh` picks the file up,
so nothing else needs editing.
