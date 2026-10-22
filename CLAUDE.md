# RNG∞ — guide for Claude

RNG∞ (https://rng-infinite.com) is an unlimited version of rngdle.com: every roll draws a number from 0 to 1,000,000,
scored by ~245 badges (233 from the original game + custom ones), with rarity tiers, XP, coins, a shop of skins,
live duels, a casino with in-game coins, daily tournaments, friends, quests and leaderboards. The owner is Sacha
(GitHub `sacha9214`). Players are mostly English-speaking kids and teens; the UI is English with a French translation.

Read `HANDOFF.md` for the current state and what to do next. Read `.claude/lessons.md` (mistakes already made on this
project, indexed by the kind of action that triggers them) before any non-trivial change.

## Stack

- **No framework, no bundler, no npm dependency for the site.** Plain HTML/CSS/JS served as static files.
  `index.html` loads `js/*.js` and `css/*.css` with a `?v=<hash>` cache-buster written by `tools/stamp.mjs`.
- **Shared modules** (`js/engine.js`, `js/shop.js`, `js/quests.js`, `js/achievements.js`, `js/events.js`,
  `js/config.js`) are UMD-style IIFEs: `window.RNGShop` in the browser, `module.exports` in Node. The API requires
  them, so the browser and the server always compute the same thing.
- **API**: `api/*.js` are Node CommonJS handlers `(req, res) => …`. Files starting with `_` are helpers, not
  endpoints. Production runs them all in one Node process on the VPS (`deploy/ovh/api-server.js`, systemd `rng-api`,
  `127.0.0.1:8787`). Keep the number of public files in `api/` (no `_`) at **12 or fewer** (old Vercel Hobby limit,
  still used as a fallback): new endpoints go in `api/_name.js` and are routed from an existing handler.
- **Database**: Redis on the VPS, reached through an Upstash-compatible REST relay (`deploy/ovh/redis-relay.py`).
  Code calls `redis([[cmd, ...args], ...])` from `api/_lib.js` (one pipeline per call).
- **Hosting**: Caddy on an OVH VPS serves the static files from `/home/emma/rng-infinite` and proxies `/api/*`.
  DNS stays at Vercel. Discord bot announcements come from `api/_discord*.js`.

## Folder map

| Path | What |
|---|---|
| `index.html` | the single page; routes are hashes (`#/shop`, `#/room/CODE`, `#/player/Name`, `#/owner`…) |
| `js/app.js` | the whole UI (~7,500 lines): `render*` per route, roll animation (`playReveal`), shop, casino, duels, friends, tournament, owner page, `UPDATES` (the public update log) |
| `js/engine.js` | badge engine: `createEngine(meta, percentiles).analyze(n)` → `{ total, tier, groups, earnedIds, scoringIds }` |
| `js/badge-meta.js`, `js/percentiles.js`, `data/*.json` | **generated** by `node tools/build.mjs`, never edit by hand |
| `tools/source/*.json` | badge sources: `meta.json` (original), `custom.json` (ours), `family.json` (only the best badge of a family scores) |
| `js/shop.js` | coins per rarity, skins, buttons, emotes, wallpapers, sound packs, cases, codes helpers |
| `js/skinfx.js` | canvas scenes of animated skins (`SCENES.<id>`) |
| `js/sound.js`, `js/synth.js` | all sounds are synthesized (no audio files) |
| `js/i18n.js` | French translation: an English → French dictionary applied to the rendered DOM |
| `css/style.css` | main styles, skins (`.skin-<id>`), duel frames (`.side-<id>`); `css/premium.css`, `css/buttons.css` |
| `api/` | endpoints: `roll`, `shop` (+ casino via `_gamble`), `room` (duels + tournament via `_tournament`), `friends`, `site` (ideas inbox, owner page, fund), `leaderboard`, `profile`, `history`, `name`, `auth`, `quests`, `title` |
| `tools/` | build, tests, dev server, migrations, renderers (trailer, skin previews) |
| `tools/audit/` | layout audits with Playwright (overflow, header fit, overlaps, dialogs) |
| `deploy/ovh/` | VPS install and deploy scripts |
| `roblox/` | separate Roblox port of the engine (Luau), not deployed with the site |

## Commands

```bash
node tools/dev.mjs                # site + API + in-memory Redis on http://localhost:8124 (no account needed)
python3 -m http.server 8123       # static site only (no API: rolls, shop and duels will not work)
node tools/build.mjs              # after ANY badge change (~15 s): regenerates meta + percentiles, validates 233/233 and 96/96
node tools/stamp.mjs              # before EVERY commit that touches js/ or css/ (cache-buster in index.html)
node tools/test-api.mjs           # main test suite, must end with "OK —"
node tools/test-server.mjs        # API server over real HTTP
node tools/casino-sim.mjs         # casino EV checks (house edge ~3%)
node tools/house-audit.mjs        # best-strategy audit: the house must win every game
node tools/e2e-duel.mjs <dir>     # real browser + real API: duel chat and owner buttons
node tools/skin-preview.mjs <id>  # contact sheet of a skin (see the rng-skin-design skill)
```

Playwright lives in `tools/.deps` (gitignored):
`npm i --prefix tools/.deps playwright@1 && npx --prefix tools/.deps playwright install firefox`.
Every test browser must be **muted** (`firefoxUserPrefs: { 'media.volume_scale': '0' }`, Chromium `--mute-audio`).

Gate publishing on the tests: start the command with `set -e -o pipefail &&` (a `| tail -1` hides failures).

## Conventions

- **Language**: code comments, commit-free notes and test messages are in **French** (match the surrounding code).
  Anything public on GitHub (README, commit messages, PR titles and bodies) is in **English**.
  **No `Co-Authored-By` line** in commits or PRs (Sacha's rule).
- **UI text** is written in English in `js/app.js`; add the French version of every new visible string to the big
  dictionary in `js/i18n.js` (same exact English key).
- **Style**: 2-space indent, single quotes, semicolons, `const` arrows, terse one-liners are normal here. Comments say
  *why* and *who asked* (`// idée de PRISMA123 (2026-10-22) : …`). Keep that habit: date + player name.
- **Naming**: Redis keys are short and lowercase with colons (`stats:<id>`, `hist:<id>`, `skins:<id>`, `lb:day:<date>`,
  `tn:<day>`). Player ids are 16 hex chars, secrets 32 hex. Never send a player id to other players: views use opaque
  tokens (see `_tournament.js`).
- **CSS**: new page-specific classes get a prefix (`g-` casino, `bj-` blackjack, `tn-` tournament, `ib-` inbox, `dm-`
  friends chat). Before adding a class, grep that it does not already exist.
- **Update log**: every shipped feature adds an entry at the top of `UPDATES` in `js/app.js`, `en` + `fr` arrays,
  crediting the player (`(idea by X)` / `(reported by X)`). Never list owner-only features there.
- **Shop items** are data in `js/shop.js`; prices and odds are read by both sides. Skins born from a player idea have
  `idea: '<player name>'` (that player gets 5% of every purchase).

## Game rules that are decisions, not bugs

- **Luck never changes.** No luck potions, no paid speed, no boosts, no 7-digit numbers. Odds are never changed after
  the fact (it would rewrite everyone's old rolls).
- **Coins are only earned in the game.** No buying coins, no free codes on request, no unlimited transfers (friend
  gifts exist: 10–500 coins, 1,000/day). The casino must keep a house edge (`casino-sim`, `house-audit`).
- **Nothing that was earned is taken back.** When a badge change lowers a roll's value, old stats stay.
- **Never use other people's brands or characters** (anime, Clash Royale, Angry Birds, Minecraft textures…). Evoke a
  style, never copy names, logos or assets.
- **The Drastix badge** (`235`) is a private joke: never show it in the trailer, screenshots or promo material.
- **Never reverse a "no".** An idea Sacha refused is never marked Added/Planned or promised to a player.

## Design and animation

- Light and dark themes everywhere (CSS variables `--surface`, `--prose`, `--outline`…); check both.
- Phones first: no horizontal scroll at 320/360/375/390/414 px. Fixed corner buttons must not cover controls.
  Run `tools/audit/overflow-check.mjs` and `tools/audit/overlap-audit.mjs` (dev server on 8124) after layout changes.
- `prefers-reduced-motion` is honoured by a global rule; anything that must stay visible needs its own override.
- Animations: anticipation → impact → settle; digits stay the most readable thing on screen at every frame.
  Skins are a *material*, not a palette. Follow the **rng-skin-design** skill (`.claude/skills/rng-skin-design`)
  for any skin, duel frame or reveal: brief, build, film with `tools/skin-preview.mjs`, critique, iterate twice.
- Judge motion on moving output, not stills: frame rate is not smoothness.

## Known pitfalls (details in `.claude/lessons.md`)

- After changing a badge, `node tools/build.mjs` **also recomputes rarity thresholds**: thousands of numbers can
  change tier. Then run `node tools/rescore-worst.js --apply` on the server (Trash leaderboards) and consider a
  one-off migration like `tools/migrate-badges.js` for upgrades. Before adding a badge, grep `js/engine.js` and
  `tools/source/*.json` for the same number (a duplicate "Error 404" shipped once).
- `tools/dev.mjs` caches API modules: restart it after editing `api/` or any shared `js/` module.
- Rolls, messages and history entries are identified by timestamps: tests that create two in the same millisecond
  flake. Wait 2–3 ms between them in tests.
- Pattern deletes (`replace_all`, `sed /…/d`) have removed the wrong lines twice: anchor edits on unique context.
- Slicing `js/skinfx.js` between two markers deleted a whole scene once: list the `SCENES.` names in the slice first.
- Never probe the live API with fake ids: some endpoints create players on first contact.
- Synthetic paste events are empty in Playwright Firefox: test clipboard features in a real browser.
- Tournament, duels and casino results are decided on the server with `crypto.randomInt`; never trust client values.

## Never

- Never commit secrets. There are none in the repo: tokens live on the VPS (`/etc/rng-relay/token`) and in Sacha's
  local folders. The two SHA-256 hashes in `api/_lib.js` (owner and viewer e-mails) are not secrets.
- Never write to the production database, deploy, or reply to players: only Sacha does (he has the VPS access).
- Never force-push `main`, rewrite history, or delete players' data.
- Never add a dependency to the site, a build step, or a framework.
- Never ship without `node tools/test-api.mjs` passing and `node tools/stamp.mjs` run.

## Working with two people

Sacha and a friend work on this repo, each with their own Claude.

1. **Start of session**: `git checkout main && git pull`, then create or update your branch:
   `git checkout -b <name>/<topic>` (for example `sacha/tournament-fix`), or `git checkout <branch> && git merge main`.
   Read `HANDOFF.md`.
2. **One branch per person and per topic.** Never commit directly to `main`.
3. **During the session**: small commits, English messages, no `Co-Authored-By`. Run the tests before each push.
4. **End of session**: update `HANDOFF.md` (what you did, what is half-done, decisions and why, new bugs), commit,
   `git push -u origin <branch>`, and open a pull request to `main` with `gh pr create` (English title and body:
   what changed, how it was tested, screenshots for visual work).
5. **Merging and deploying** are Sacha's: he reviews the PR, merges it, runs `node tools/stamp.mjs` if needed, and
   deploys with `ssh emma@<vps> 'bash ~/rng-infinite/deploy/ovh/deploy-api.sh'` (this also updates the static site).
   After a merge, everyone pulls `main` before continuing.
6. Two people editing the same big file (`js/app.js`, `css/style.css`, `js/i18n.js`) is normal: keep changes local
   to one feature, pull often, and resolve conflicts by keeping both sides (for `i18n.js`, merge both dictionaries).
