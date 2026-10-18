# Tonedot
Local: `node server.js` then open http://localhost:3000

Cloudflare Pages: upload the CONTENTS of the `public` folder (index.html + _worker.js) by drag-and-drop,
or connect a Git repo with build command empty and output directory `public`.
Manga V2.5: `lib/manga.js` is the source for the API (MangaDex + Comick + Mangapill, merged); `public/_worker.js` = lib/manga.js + lib/worker-footer.js.
Rebuild the worker after editing: `cat lib/manga.js lib/worker-footer.js > public/_worker.js`
