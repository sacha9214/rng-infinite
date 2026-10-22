# Lessons — rng-infinite

### Deleting code by pattern (Edit replace_all, sed '/…/d', regex replace)
- Did: removed every `const top = Engine.topLabel(a.percentile);` with replace_all while moving the percentile display to `percentileHTML`, and reported the change as verified. Again on 2026-09-23: ran `sed -i '' '/^state = r.body;$/d' tools/test-api.mjs` to drop one stray test line.
- Was: the first also deleted the declaration inside `shareText` (bare `top` became `window.top`, Share threw); the second also deleted the `state = r.body;` the XP race test needed, and the broken test got committed.
- Check: before any pattern delete, `grep -n '<exact pattern>' <files>` and confirm the match count equals the number of lines you mean to remove; if it is higher, edit with a unique anchor (the surrounding lines) instead of the bare pattern. For a removed declaration, also `grep -n "\b<name>\b" js/*.js api/*.js` for remaining uses, then real-click every button whose handler reaches the edited code (`node tools/dev.mjs` running, `node tools/stamp.mjs` re-run).
- Seen: 2

### Reading a terse or typo'd request that could mean the opposite
- Did: read "and ze should be able to skip the badge" as "add a Skip badges button", built it and tried to push it. Again on 2026-10-02: read the dictated "des animations comme la vidéo … pour les rôles … pour chacun des rôles, faire une petite vidéo" as "restage the base roll reveal like the trailer" (because "rôles" had meant "rolls" one message earlier), restated it in one line but kept working: read the trailer code, wrote a filming tool, designed a whole stage.
- Was: Sacha meant "should NOT be able to skip", continuing his previous message ("we should not be able to skip number roll"); he rejected the push. The second time he meant the skins, not the base animation ("je parle des skins, pas de l'animation de base") and had to interrupt me; no game code was changed yet.
- Check: when a short request reverses or contradicts the message just before it, restate the reading in one line ("tu veux qu'on NE puisse PAS … ?") and wait for the answer before writing code. When a dictated or typo'd request says "for each X" with X garbled, or would cost more than an hour of work, list the things X could be in this project (`grep -n "id:" js/shop.js` for skins, the 7 rarities, the badges, the pages), ask which one with AskUserQuestion, and do nothing but read-only exploration until he answers: a restatement he has not answered is not a confirmation.
- Seen: 2

### Changing how a synced record is identified (timestamp source, key format)
- Did: in 805d1d9 made online rolls use the server's timestamp in the `t:n` history key and shipped it as "same key on both sides", with exact-key dedupe in `mergeRolls`, `syncHistory` and `/api/history`.
- Was: tabs still running the old JS kept saving the device's timestamp (0.7 s apart), so every roll made in that window was stored twice on the server and pulled back twice into local histories; found only when profiles showed 252552 twice (Sacha 64 → 60 rolls, Drastix235 73 → 69).
- Check: before changing a record's identity, `grep -n "+ ':' +\|:\${n}\|t:n" js/*.js api/*.js` to list every exact-key comparison, then feed a record in the old format and the same record in the new format through merge/upload/fetch in `tools/test-api.mjs` and assert it is counted once.
- Seen: 1

### Gating a commit on a test command
- Did: ran `node tools/test-api.mjs | tail -1 && … && git commit && git push` and pushed commit 98d73fc.
- Was: the tests had failed; the `&&` saw the exit code of `tail`, not of the tests, so the broken test file went out.
- Check: start EVERY publish command (tests + stamp + commit + push + deploy) with `set -e -o pipefail &&`; never write `node tools/test-api.mjs 2>&1 | grep … | tail -1 && …` without it. Read "OK —" in the output before pushing.
- Seen: 2 (2026-10-16: `test-api | grep -v kofi | tail -1 && … && deploy` published the Sky/Deck skins with a failing test — button styles in the wrong CSS file)

### Probing the live API to check a fix
- Did: to check the new name rule in production, POSTed `/api/name` with a made-up player id `0000000000000000` and an all-zero secret.
- Was: `claimPlayer` registers unknown ids, so this created a real player named "h" in production and reserved the name.
- Check: before sending anything to the live API, open the handler: if it calls `claimPlayer`, `claimName`, `markFresh` or writes (SET/HSET/RPUSH/INCR/ZADD) for an unknown id, do not send it; check with GET endpoints or on `node tools/dev.mjs` instead.
- Seen: 2 (2026-10-17: POSTed /api/discord state with the all-zero test player without opening the handler first; it only read, and matched the ghost player "h" left by the first incident)

### Checking an API change in the browser against the running dev server
- Did: edited api/*.js, then tested the duel in the preview on the dev server started earlier; it showed the roll mid-reveal and I nearly concluded the fix did not work. Again on 2026-10-07: added four skins to js/shop.js only (no file under api/ touched), ran the purchase test, and the buy silently did nothing.
- Was: `tools/dev.mjs` had cached the old modules with require; after a restart the same test passed. The second time the stale module was js/shop.js, which the API requires too: the server answered "Unknown skin".
- Check: after any change under api/ OR in a module the API requires (js/shop.js, js/quests.js, js/achievements.js, js/engine.js, data/*.json), preview_stop + preview_start the "rng-infinite-dev" server before testing in the browser (the fake Redis restarts empty too). Quick test: `git status --short api js/shop.js js/quests.js js/achievements.js js/engine.js` prints nothing new since the last restart.
- Seen: 2

### Declaring a video or an animation smooth from still frames
- Did: checked the trailer on contact sheets (stills every 0.05 to 0.5 s) and on frames pulled from the MP4, then told Sacha the two videos were verified.
- Was: the leaderboard climb froze for 8 frames in the middle of a fast scroll (it followed the XP on a log scale, and the other players' XP has big gaps), and three skin holds were completely static for 7 to 10 frames; Sacha saw the lag the first time he watched it.
- Also (2026-10-11): told Sacha the Crash rocket ran "at a steady 60 frames per second" after measuring the interval between frames. It was true and useless: the rocket was drawn from the multiplier rounded to two decimals (my own change the day before), so it moved on only 10 frames out of 79. He had to report the lag twice.
- Check: after every render run `node tools/trailer-render.mjs --check trailer/out/*.mp4` and read "fluidité OK" for each file before saying the video is done (the render prints it by itself at the end); when a position on screen follows a data value, apply the easing to the position and derive the value from it, never the reverse.
- Seen: 2
- Check (motion): frame rate says nothing about smoothness. Record the moving object's position on every frame (`node tools/audit/crash-smooth.mjs` hooks the canvas for the rocket) and require it to change on nearly every frame; anything drawn from a rounded or stepped value will fail.

### Adding or widening something in a page layout (tab, switch, tile, card, grid)
- Did: added the Friends tab and the FR / EN switch, checked the page at 1100 px with a short nickname, shipped. Earlier, same root: shipped wide skin cards (Jersey, Blocks) in the Shop grid, looked at them on desktop only.
- Was: the header overflowed the page on phones (375 px) and the tabs overlapped the right-hand controls between 720 and 1180 px with a long nickname or French labels. The Shop page was 34 px wider than a 375 px phone (grid columns grew with their widest card); found on 2026-10-07 while adding the button skins, it had been live for days. 2026-10-08, asked to check every screen: the four fixed corner buttons covered roulette bets, mines cells and the duel roll button on every screen under 900 px; the tabs ran under the language switch at 320 px; on phones the casino intro text slid under the "Your coins" box and "BLACKJACK" overflowed its tab; page text was readable through the 88 % top bar. The two older scripts saw none of it (they only measure page width and the header gap), and the first overlap audit missed the last three, which I only caught by opening the screenshots.
- Also (2026-10-10): the 3D-tilted roulette wheel overflowed its box and covered the Red / Black / Even bets on phones, both visually and for clicks; live for two days. The audits skip canvases and transformed elements, so they said nothing; a script that really clicked each control found it.
- Check: with the dev server running, `node tools/audit/overflow-check.mjs` must end with "aucune page ne déborde" (every route at 320/360/375/414 px, in French). If the top bar changed, also `node tools/audit/header-fit.mjs 320 360 414 560 561 720 721 1020 1021 1180 1181 1320`: every line `pageOverflow: 0` and `gap` ≥ 0 (320 may scroll: `navScroll` > 0). Then `node tools/audit/overlap-audit.mjs` (pages, 11 widths; add `844x390 1024x600` for short screens) and `node tools/audit/modal-audit.mjs <dir>` (dialogs): only the two known false positives may remain ("texte coupé" on the Shop preview buttons and `.trailer-thumb`). Anything fixed-position must be checked against the controls it floats over. Finally open at least the 320 and 390 screenshots of the page touched: a script only finds the overlaps it was written for. For anything with `transform`, `perspective` or a canvas above controls: click every control below it with a real click (`tools/audit/e2e-casino-full.mjs` does it for the casino) and check `document.elementFromPoint` at its centre returns the control.
- Seen: 4

### Adding CSS classes for a new page
- Did: styled the casino chips as `.chips` / `.chip` at the end of style.css and shipped after testing only the Gamble page.
- Was: `.chip` already styled the XP-target buttons of the duel page; they turned into dashed blue circles in production until Sacha sent a screenshot.
- Check: before adding a class, `grep -n "class=\"[^\"]*\b<name>\b" js/app.js index.html` and `grep -n "^\.<name>\b" css/*.css` must both come back empty; otherwise prefix it with the page (`g-`, `bj-`).
- Seen: 1

### Waiting for a deployment to go live
- Did: looped `until curl -s https://rng-infinite.com/ | grep -q "$V"; do sleep 5; done` from the Mac, with no limit, after every push.
- Was: one push was never deployed by Vercel, so the loop ran for minutes; Vercel then put Sacha's home IP behind its "Security Checkpoint" (403 for curl), and the command timed out without telling me why.
- Check: poll from the VPS (`ssh emma@<vps> 'for i in $(seq 1 10); do …; sleep 10; done'`), at most 10 tries. If the version is still the old one, look at `gh api repos/sacha9214/rng-infinite/deployments?per_page=3` for a Production entry with the new sha; if there is none, push an empty commit to re-trigger.
- Also (2026-10-17): published the Discord linking with a new api/discord.js; Vercel refused the deployment (Hobby plan: 12 functions max, it was the 13th) and my publish output had no "LIVE" line, which I did not notice; Sacha could not find the button.
- Check (more): after every publish, read the LIVE line, and run `gh api "repos/sacha9214/rng-infinite/deployments/$ID/statuses" --jq '.[0].state'` (must be success). Before adding a file under api/, `ls api/*.js | grep -v '/_' | wc -l` must stay ≤ 12; VPS-only endpoints go in api/_name.js and are wired in deploy/ovh/api-server.js and tools/dev.mjs.
- Seen: 2

### Raising a user-facing limit (max goal, max size, max count)
- Did: raised the duel XP goal to 10M and rounds-to-win to 50, tested that the value was accepted and stored.
- Was: an older safety cap (100 rounds per duel) ended every long game around 1–2M XP; the new maximum was unreachable.
- Check: grep the module for every other constant that bounds the same flow (`MAX_`, `CAP`, `LIMIT`, `>=`), and add one test that actually plays to the new maximum (seed the state) instead of only creating it.
- Seen: 1

### Replacing a block of code by slicing between two markers
- Did: rebuilt the Mayo scene by replacing everything between `SCENES.mayo = custom(` and the next marker comment; the Haunted scene sat in between and was silently deleted (live for hours without ghosts).
- Was: the slice covered more than the block I meant to replace.
- Check: before writing, print the names of every top-level definition inside the slice (`grep -o "SCENES\.[a-z]*" <slice>`) and confirm only the intended one is there; after writing, `grep -c "SCENES.<each skin with a scene>"` still equals 1.
- Seen: 1

### Writing a new skin scene with custom(pieces({...}))
- Did: wrote SCENES.bloodlust with pieces() but no `drift` option, filmed it three times and kept moving the drops, thinking they were too dark or hidden behind the card.
- Was: pieces() reads cfg.drift.rate on every frame; the scene threw on each frame and drew nothing (the film shows no error).
- Check: copy the full pieces() option set from an existing scene (cols, shapes, size, g, spin, glowc, ring, drift), and when a film shows no canvas effect, mount it in the preview with `window.addEventListener('error', …)` and `SkinFX.mount(stage, card, id)` before changing the drawing.
- Seen: 1

### Inserting into a catalogue list by anchoring on an existing entry (js/shop.js)
- Did: inserted the Halloween wallpapers after `{ id: 'galaxy', name: 'Galaxy',` with s.index(), believing it was the Galaxy wallpaper.
- Was: the Galaxy skin has the same start and comes first; the two wallpapers landed in SKINS, and the Limited tab test timed out.
- Check: anchor on a string that also includes the emoji or price (`{ id: 'galaxy', name: 'Galaxy', emoji: '🌠'`) and assert `s.count(anchor) == 1` before inserting; afterwards `node -e "console.log(require('./js/shop.js').WALLPAPERS.map(w=>w.id))"`.
- Seen: 1

### Replying to suggestions / setting their status (Added, Planned)
- Did: on 2026-10-17, in a batch of 26 replies, marked as accepted an idea Sacha had already refused, and sent the player a "yes".
- Was: Sacha had to delete the suggestion so the player would not see it, and said "plus jamais".
- Check: before any reply batch, for each id read `HGET sugg:<id> status` and `LRANGE sugg:<id>:msgs 0 -1`; if the status is `declined` or the thread already has an owner message (`f: 'o'`), do not change it to done/planned and do not promise anything: list it to Sacha and wait. Also re-read this conversation for every idea Sacha refused before proposing it. The replies script refuses these by itself unless SACHA_OK=1.
- Seen: 1
