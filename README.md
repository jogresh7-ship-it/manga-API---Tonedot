# Tonedot
Local: `node server.js` then open http://localhost:3000

Cloudflare Pages: upload the CONTENTS of the `public` folder (index.html + _worker.js) by drag-and-drop,
or connect a Git repo with build command empty and output directory `public`.
`lib/mangadex.js` is the source for the API; `public/_worker.js` = lib/mangadex.js + lib/worker-footer.js.
