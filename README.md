# ReelFrame — new UI

A full redesign of the shell (`index.html` + `styles.css`) built to sit on top of your
existing `js/*.js` files, completely unmodified. Concept: a darkroom/screening-room
archive — warm near-black stock, projector-lamp amber as the one loud accent, a
sprocket-hole motif carried structurally on the sidebar rail instead of as decoration.

## How this was built

You didn't have the original HTML in the zip, only the 36 JS files (12k lines, 415+
`getElementById` targets). I read through the scripts to reverse-engineer the DOM
contract — which IDs, classes and structural nesting each module expects — and wrote a
brand-new markup/CSS layer against that contract. Every element ID your JS looks up
exists in the new HTML. I did not touch any file under `js/`.

Given the size of the app, the depth of polish isn't even everywhere:

- **Fully redesigned, primary surfaces:** gate/loading/lock screens, sidebar +
  category list, tab bar, video grid + watch view + next-up, photo grid + focus
  viewer + pop-out, music grid + player bar, mini player, footer, global search,
  toast.
- **Functional but plainer (shares the same modal/button/form components rather
  than bespoke layouts):** settings, pairing, watch party, share/receive, remote
  host, playlists, chapters, duplicates, subtitles, equalizer, wallpaper picker +
  cropper, keyboard shortcuts, import/URL modals.

Since I was inferring structure from behavior rather than from a spec, there's a
decent chance a few less-common flows (deep, multi-step ones like the P2P share
flow or wallpaper cropper) have a rough edge or two the first time you click
through them. Flag whatever's off and I'll patch it — normal workflow for this app.

## Running it

Needs `showDirectoryPicker`, so Chrome or Edge, served over `http://localhost` or
`https://` (GitHub Pages, same as your existing setup) — not from a `file://` URL.
