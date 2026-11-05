# Handoff — RNG∞

Last updated: 2026-11-05 by Claude (skins lot 3 branch, merged with main). Update this file at the end of every session.



## Backfills run by the server itself (2026-11-05, branch `claude/auto-backfills`)

Sacha didn't want to run the backfill scripts by hand ("can't we do it another way?").

- `deploy/ovh/backfills.js`, started by `deploy/ovh/api-server.js`: 2 min after the API starts, each backfill that isn't
  done yet (`nc:ready`, `bown:ready`, `hof:ready`) runs on its own, one after the other. Each runs as a separate process
  (`nice -n 10 node tools/backfill-*.js --apply`), so the API never blocks.
- A Redis lock (`bfjob:<name>`, 6 h) means only one run happens even if the API restarts meanwhile. On failure the lock
  is released, so the next start retries. Once a flag is set nothing runs again: every roll keeps those counters up to
  date itself. The output is in `journalctl -u rng-api` (lines starting with `backfill`).
- `tools/backfill-hof.js` now skips suspended accounts (the `banned` set). A player suspended after the Hall of Fame was
  filled keeps their entries until someone removes them by hand.
- The scripts can still be run by hand (dry run without `--apply`).

## Limited tab by event (2026-11-05, branch `claude/limited-by-event`)

Sacha asked for the shop's Limited tab to be split by theme, with Halloween taken out for now but kept for next year.

- `js/shop.js`: `EVENTS` (`halloween`, `thanksgiving`, `christmas`: `ends` and the `last` day shown) and `eventById`. Every
  limited skin and wallpaper has `event: '<id>'`. `tools/test-api.mjs` checks that each item's `until` is its event's
  `ends`, because the server still reads `until`.
- `js/app.js`: `limitedEventsHTML()` builds one section per running event (`liveEvents()`, the soonest to end first),
  each with its banner (`LIMITED_FX`: Halloween bats, Thanksgiving leaves, Christmas snow), its skins
  (`[data-lim-skins]`) and its wallpapers (`[data-lim-walls]`). Ended events don't appear. Players who own items from a
  past event see a note pointing to their profile Inventory, where they can still equip them.
- **Next year**: bring Halloween back by updating `ends` in `EVENTS` and the `until` of its items (same date), plus the
  "until November 1" wording in their descriptions and the French dictionary.

## Delete my account (2026-11-05, branch `claude/delete-account`)

Sacha asked for a way for players to delete their account from Settings.
- **UI**: ⚙️ Settings → danger zone → "Delete my account" (only for a player with a name). A second window lists what is
  lost, says if Google or a password is linked, and enables "Delete forever" only when the exact player name is typed.
  After success `resetDevice()` gives the device a new identity (`Store.signOut`) and removes every other local key
  except the language, the Store key (device settings) and the anonymous visit dates.
- **Server**: `api/_account.js`, routed from `api/auth.js` (`action: 'deleteAccount'`, no new public file). It needs
  the secret and the exact name.
  - **Refused**: suspended accounts (423 from `ownsPlayer`); owner and viewer accounts (`canViewOwner`, 403); a player
    seated at a poker table, in a live duel, with a duel roll still being revealed, signed up to an unfinished
    tournament, or in the team of a pending or running clan war (409); the leader of a clan that has other members
    (409: pass the leadership or disband first). A leader alone in the clan: the clan is disbanded.
  - **Deleted**: one SCAN of the whole keyspace, then: every key whose name has the id; the id as a field or member of
    every shared hash, set or sorted set whose name has no player id (like `banPlayers`); every `name:<key>` that
    points to the player (current name and stale old ones); `google:<sub>`, the Discord link (`discord:links`), the
    password and the recovery code; the id in other players' `fr:`, `frin:`, `frout:`, `dmblock:`, `dmu:`, `dw:` and
    `h2h:` keys (one-sided entries too); gifts from the player in friends' lists; daily gift caps (`o:<id>`, `i:<id>`);
    open positions in `pos:open`; avatar tokens (`avtok`, `avpq`); clan requests; reactions (`…|<id>` fields); the
    player's global chat, clan chat and casino feed lines; the coins and casino board caches.
  - **Kept**: `player:<id>:secret = "deleted"` (tombstone with no data: an old device gets 403 and starts a new player;
    without it `claimPlayer` would recreate the id), `banned`, anonymous totals, ideas (`sugg:*`), moderation logs
    (`reports`, `avlog`, `gc:mutelog`, `gc:dellog`), and finished duel rooms, tournaments and clan wars, which expire
    on their own (1, 14 and 30 days). The clan log keeps "<name> left", like any other departure.
- **Tests**: the "Supprimer son compte" block at the end of `tools/test-api.mjs`. The key check scans the whole fake
  Redis for the id after deleting (keys, fields, members, values).
- **Inventory check** (scratch script, not committed): after the full suite, every named player was deleted (194 OK,
  89 refused: tournament, clan leader, duel) and the fake Redis was searched for each id. Only the kept records above
  were left (rooms, poker tables, tournaments, wars, ideas, moderation logs), plus a past giveaway's winners in
  `gw:item` and other players' global chat messages that reply to or mention the player (`ra`/`at`, never sent to the
  site, gone when the chat rolls past 100 messages).
- **Cost**: one SCAN of the whole database plus a TYPE per shared key. That should take a few seconds on the VPS; it
  has not been measured on the real data. `tools/fake-redis.mjs` gained `TYPE`.

## Thanksgiving: Turkey Roast skin and Thanksgiving Dinner wallpaper (2026-11-05, branch `claude/ideas-thanksgiving-e7c7c1`)

Planned ideas from the 2026-11-05 triage: qwertyuiop (a dinner table with Thanksgiving food), Idkwhatnamemyself (a
turkey roasted into the number), Kj13 (autumn leaves in brown, red, yellow and orange, limited until Thanksgiving
night), R77 (dinner table, turkey feathers, the iconic turkey look).

- **Turkey Roast** 🦃 skin, 1,126 coins, `idea: 'Idkwhatnamemyself'` (the 5 % share goes to that player; R77 and Kj13 are named in the
  comment and the update log). The card is a turkey's fanned tail (`.num-card.skin-turkey::before`, an SVG of 17
  feathers): it folds while rolling (`.charging`) and spreads out after the last digit. The digits are roasted skin:
  raw and pale with a heat shimmer while spinning, then a squash, a hot flash to golden-brown, a glaze sweep and a puff
  of steam on the reveal. `js/skinfx.js` `SCENES.turkey`: autumn leaves (Kj13) and steam on each digit, a shower of
  leaves on the reveal, and from Epic a fan of turkey feathers (two fans from Mythic). The base particle count is cut
  to 45 % and anything over the card is drawn at 40 % so the digits stay readable. Duel frame `.side-turkey` (plaid
  tablecloth, leaves, 🦃 / 🍂 🥧), Generate button `.btn-roll.gen-turkey`. The small history cards hide the fan.
- **Thanksgiving Dinner** 🥧 wallpaper, 1,126 coins, `idea: 'qwertyuiop'` (no 5 % share on wallpapers, as for all
  wallpapers). `WALL_LAYERS.feast` + `.wtg-*` in `css/style.css`: two windows with autumn trees and falling leaves, a
  table across the bottom, and the meal in two groups (`.wtg-food.a`: turkey, pumpkins, cranberry sauce, candle;
  `.wtg-food.b`: rolls, mashed potatoes, corn, pumpkin pie, candle). On wide screens the turkey is on the right and the
  side dishes on the left, on either side of the page content (centred, it was hidden behind it); on phones they sit
  side by side. Candles flicker, the turkey steams. Dark theme is the evening by candlelight, light theme an afternoon.
- **Sale dates**: both `until: '2026-11-28T08:00:00Z'` = the end of Friday November 27 in US Pacific time (Thanksgiving
  night is over everywhere in the US). Shown as "until November 27". Never in a case, outside the collections.
- **Limited tab**: a 🦃 THANKSGIVING banner (falling leaves, countdown "Ends after November 27") above the Christmas
  one, hidden after the date; limited skins and wallpapers are now sorted by end date (Thanksgiving first). The
  wallpaper note says "for the holidays only" instead of "for Christmas only". French in `js/i18n.js`.
- Update log entry `2026-11-05-thanksgiving` (en + fr) credits all four players.
- Tests (`tools/test-api.mjs`, section 55): prices, dates and ideas; not in any case or collection; CSS, scene and
  layers exist; buying a minute before the end works, a second after returns 422 (skin and wallpaper).
- Checked: skin filmed with `tools/skin-preview.mjs` and iterated (pointed feathers → broad rounded ones sized by
  height; bead-like steam → soft wisps; base leaves cut so a Mythic doesn't bury the digits; button tips split into
  feathers); the canvas scene filmed frame by frame (manual mode) in dark and light; shop preview in the real page;
  wallpaper at 1400, 1024 and 375 px in both themes; banner at 320 px in French; `overflow-check` OK.
  Frame rate: 60 fps in the app's browser pane (same as Cozy Fireplace and Snowy Village); headless Firefox (software
  rendering) is slow for every limited wallpaper, this one included (1–4 fps vs 3–5 for Cozy Fireplace).
- **After November 27**: nothing to do; the banner hides itself and both items leave the tab (owners keep them).

## Social and chat ideas (2026-11-05, branch `claude/ideas-social-chat-55a38b`)

Planned ideas of the "social-chat" group from the 2026-11-05 triage, one UPDATES entry `2026-11-05-social-chat`.
- **Best roll next to names in the global chat** (Loliarlex1248 `65af00fabee5`, MAYO `ddc646470eb0`): `api/_global.js`
  `bestRolls()` reads `best:all` for the authors in one HMGET; each message gets `best: { n, tier }`, shown as
  "(999,999)" in the tier colour (`.gc-best`). Normal mode only.
- **Hard mode rolls from Mythic in the chat** (Idkwhatnamemyself `837fc6261b3d`, Kag `1b08e800e866`): `HARD_BIG` in
  `api/_global.js`, used by `recordHardRoll`. Same 30 s / 10 min limits as Normal (they share the 30 s gap).
- **Report context** (jsand `d6af231d993f`): the Moderator page shows the 4 messages before and 3 after a reported one
  ("See the messages around it"), names and text only.
- **Moderators lift mutes** (pople `129e925537e9`): `gcUnmute` works for moderators from the Moderator page ("Muted
  right now"), only for a mute still running, never a Forever mute and never one the owner set (`bo: 1` on the mute
  record, and for older mutes the author's id in `gc:mutelog`). The history keeps who lifted it; the owner page never
  shows their id.
- **Friends**: ☆ star pins a friend at the top (Big Sexy `86b789a1f215`, key `frstar:<id>`, cleaned on remove).
  Friends leaderboard on the Friends page (Edward `73d46f7e12d3`): you + friends by XP, today's XP, best roll or rolls
  (`state().board`, 4 commands whatever the number of friends). The clan part of Edward's idea was not done (clans
  already have their member list).
- **Roadmap votes** (Trinity `7b6e1119e6eb`): ▲ on each Planned idea, "Most voted" (default) or "Newest". Name +
  100 rolls to vote, one vote per player per idea, removable. Keys `rmv` (hash id → count), `rmv:<suggId>` (voters),
  `rmv:by:<player>`. Ideas go out with an opaque key (sha256 of the id), never the suggestion id. "Report a bad idea"
  from Trinity's message was not done: Planned ideas are already approved by Sacha.
- **Emojis** (Jacksonw `cc4dca7290ca`, Deadshot `11bd0db13baf` `b3f73d2e94d5`, sennybex1 `66d54d6190d3`, Jguz01
  `e3db68e0f4d3`): 23 more in the chat grid (faces, 🎩 👌 🌮 🐳 🥦 🛡️ 🤴 🧀 🐄 🐴; Unicode has no knight, 🛡️ stands for it),
  the emoji button in the clan chat, and 8 of them as clan icons (`api/_clan.js` EMOJIS).
- **Duel chat ⋯** (Jacksonw `6dde4a6813f9`): Edit / Delete / Hide / Report behind one ⋯ button (`Room.chatMenu`).
- **Who is winning in a duel** (Jacksonw `610aa706bbdd`): score above each card with 👑 on the single leader,
  👑 in the scoreboard, and a "⇅ Put the leader first" link at the end of the duel subtitle for 2-player duels (setting
  `duelOrder`; the default keeps qwertyuiop's card order). A separate button row pushed the 2nd card under the sticky
  Roll bar at 320 px (overlap-audit), hence the link.
- Tests: `tools/test-api.mjs` block "Idées du 2026-11-05 (session social-chat)". Browser: Playwright script on the dev
  server at 320/360/375/390/414/1280 px, light and dark, EN and FR (friends, roadmap, moderator page, global chat, clan
  chat, duel), `tools/audit/overflow-check.mjs` clean, `tools/audit/overlap-audit.mjs 320` same as `main` (only the old
  Tournament tab overflow).
- Seen, not fixed: in a duel at 320 px the Rounds panel can overflow by ~18 px when the other player's name is long
  ("you: 880773" pushed out); it is older than this branch.

## Planned skins from the 2026-11-05 triage (session "skins", branches `claude/skins-lot<N>`)

Sacha asked to build every Planned idea; the 63 skin ideas are the "Session skins" list of
`ideas-planned-2026-11-05.md` (untracked, main checkout). Each skin follows `.claude/skills/rng-skin-design`
(brief, film with `tools/skin-preview.mjs` and `tools/reveal-film.mjs --skin <id> --crop`, critique, iterate). Each lot
is one PR; lots are stacked (lot 2 is branched from lot 1), so merge them in order.

**Lot 1 — `claude/skins-lot1`** (CSS: end of `css/style.css` and `css/premium.css`; buttons: end of `css/buttons.css`;
scenes: block "lot 1 du 2026-11-05" just before `function mount(` in `js/skinfx.js`):
- `overture` Overture 🎹 2,400 — 0casmictechthing [1fa8a0fc2680] (promised), merged with casmicgraything's music staff
  [751598325349] and 17black's jukebox notes [450c5598ed1e]. **Sound:** `js/sound.js` `piano()`; each digit plays its
  own note (C major, digit 0 = C4 … 9 = E5) and the rarity plays a chord (`OVERTURE_CHORDS`, Infinite = Am7). Hooked
  in `js/app.js` (`pianoSkin`, the lock `d` field, `tier` gets `skin`), also in the shop Preview. A sound pack does
  not replace the piano (like ASMR and Lab).
- `cheese` Cheese 🧀 1,500 — casmicgraything [1076e573c9d1] (idea share) + casmictechthing's detailed version [bfbb45cb9910].
- `dig` Archaeology 🦴 2,000 — casmicgraything [2b59f74fb5b6] (idea share) + Alt [4555c11ffa75].
- `angel` Angel 🪽 7,777 and `demon` Demon 😈 6,666, Legendary (`premium`) — qwertyuiop [3c452b1058ce], prices his;
  Demon also covers Roanono's fallen angel [2656e434fb62]. Shared wing drawing `l1Wing` / scene `l1Winged`.

**Lot 2 — `claude/skins-lot2`** (branched from lot 1; block "lot 2 du 2026-11-05" in `js/skinfx.js`):
- `deepsea` Deep Sea 🐋 2,600 — finnnnn [0555093cf3b9] (idea share) + Deadshot [e1cfcd646151] (fish, sharks, turtles,
  squid, seaweed, the 1-in-50 anchor), YeeHao2's whale [da859b846a6d], LEVIATHAN [ed2af64de7d0] (head and neck over
  the number from Divine). The old 700-coin Ocean skin stays.
- `bubble` Bubble 🫧 1,400 — finnnnn [d0de2e6104d2]. Shared bubble sprite `l2Bubble()` (also used by Aero).
- `yinyang` Yin and Yang ☯️ 6,000, Legendary — kaz [2a7c38aebff0] (idea share) + JBearr12 [959206f6ac9c]. The card
  inverts black/white at every landed digit with a CSS `:has()` rule on the count of `.slot.revealed` (works without
  the scene); Chinese numerals while rolling come from `spinChar` in `js/app.js`.
- `aero` Frutiger Aero 🌐 2,200 — jia jun [e7a0b771e530] (promised). Generic style, no logo.

**Lot 3 — `claude/skins-lot3`** (branched from lot 2; block "lot 3 du 2026-11-05" in `js/skinfx.js`):
- `blackout` Blackout 💡 1,700 — Mace_67 [f414eccc558b] (promised). CSS only for the main effect: the border is dark
  while any `.slot.spinning` remains, then lit; it takes the rarity colour (`--t-accent`) once the card loses `.neutral`.
- `prism` Prism 💠 2,600 — Idkwhatnamemyself [fb70cca99f40] (promised). Card and button take the colour of the last
  roll's rarity: `setLastRoll` in `js/app.js` now also sets `html[data-last-tier]` (and the reveal sets it to the new
  tier); the revealed card reads the `.result[data-tier]` section only once it is not `.neutral` (never before: it
  would leak the rarity). Colours per tier: `--pr-a/b/c` in `css/style.css`.
- `paint` Rainbow Paint 🎨 1,800 — finnnnn [7f9507fe5e51]. `grass` Touch Grass 🌱 1,500 — finnnnn [a841d12aea44].
- Note for future skins: the main roll card never has its own `data-tier`; the `.result` section has it from the start
  and `.neutral` hides it until the rarity reveal.

**Lot 4 — `claude/skins-lot4`** (branched from lot 3; block "lot 4 du 2026-11-05" in `js/skinfx.js`):
- `obsidian` Obsidian 🖤 2,200 — finnnnn [7ac4a115abd4]. `stable` Horse Stable 🐴 1,900 — R77 [988dcd01c381] (a
  Farm wallpaper with a barn already exists; this one is about horses). `crates` Crate Smash 📦 1,800 — jjcoolcid1
  [4bf26afedcb9] (balls thrown at crates and barrels; no birds, no slingshot). `crane` Construction 🏗️ 2,000 —
  yukitsunodaiscool [f727644461a7] (Mythic: a demolition, dust and bricks).

**Still to build** (in this order; ids in `ideas-planned-2026-11-05.md`):
**Lot 5 — `claude/skins-lot5`** (block "lot 5 du 2026-11-05" in `js/skinfx.js`): `carousel` Carousel 🎠 1,900 — KMC
[93f869da718a]; `reaper` Void Reaper 💀 2,600 — Dylanrulez123 [9d067ec79413] (no scythe: no weapons); `cyber` Cyberpunk
🌃 2,200 — leo [a7dba4706e5d]; `stage` Stage 🎭 2,400 — casmicgraything's spotlight [abe1d36527c4] and stage
[610304ef1cdb] merged. **Not built:** HSI's knuckle smashing a rock [5b5f29b0cc52] is the existing Rock Smash skin
(already HSI's idea, `rocksmash`): Sacha can mark it Done.

**Lot 6 — `claude/skins-lot6`** (block "lot 6 du 2026-11-05" in `js/skinfx.js`): `sticky` Sticky Notes 🗒️ 1,200 —
finnnnn [990feb185db6]; `souvenir` Souvenir Coin 🪙 1,500 — finnnnn [9112be331011]; `ducksing` Duck Singularity 🦆 7,000,
Legendary — Gray alt [96c078cbf980] (the reveal plays the existing `quack` sound from the scene); `centipede` Centipede
🐛 1,600 — finnnnn [5ff030cbb940].

**Lot 7 — `claude/skins-lot7`** (block "lot 7 du 2026-11-05" in `js/skinfx.js`): `pencil` Pencil ✏️ 1,200 — IXOLAF2
[dcce6323beca] (the card is clipped into a pencil shape, nothing leaves its box); `pom` Pomeranians 🐶 2,000 —
DandoriNinja [4d0e7ba5b3ed] [c9b3b2f47459] (the second idea was an image I could not see); `atom` Atom ⚛️ 2,000 —
finnnnn [b402f6ca6d8a]; `witch` Witch 🧙 1,800 — mark [35a850f4e8ba] (he wanted it limited for Halloween, which is over:
normal skin; Witch's Brew is the cauldron one).

**Lot 8 — `claude/skins-lot8`** (block "lot 8 du 2026-11-05" in `js/skinfx.js`): `tv` Black & White TV 📺 1,300 — Jguz01
[81a45cb40646]; `checkers` Checkers ⛀ 1,800 — sennybex1 [b71a59c908a7]; `iq` My IQ 🧠 1,000 — G8_floppa
[78bc6f4f973b]; `dill` Pickle 🥒 1,200 — Dylanrulez123 [6df5ef142466] (id `dill`: `pickle` is the button's id, and the
tests forbid a skin and a button sharing one).

**Lot 9 — `claude/skins-lot9`** (block "lot 9 du 2026-11-05" in `js/skinfx.js`): `menagerie` Menagerie 🐇 1,600 —
kingston [4aa8530580c8] (2 animals at page load, one more every 40 s of the session, up to 24; each landed digit adds
one); `cafe` Café ☕ 1,500 — 0casmictechthing [6804dcd7e33e] (Epic: a latte-art heart; Mythic and above: the rosetta);
`sentinel` Robot Sentinel 🤖 2,400 — costoroll [055a03dcf2d5] (no weapons: the laser is a scanner beam and Mythic is a
light show and a happy spin instead of blowing up the moon); `jigsaw` Jigsaw 🧩 900 — number 1 [2da86f4fdadb] (his price).

- Next: Lunar New Year night market [6cb1f4688a12], old cinema [dcab5d0c34cc], plane through clouds [2812b102f0fd],
  lightspeed [2a72aa7dad04], zodiac [44322bde56ff], Chronos [2cd4d69c8b28], minesweeper-style tiles [2b9e53745d67],
  mimic chests [c6da83a9d7bb], fried egg [5a933aa2e82f], American football [1bf863024c74], Earth with rockets
  [9df2cb94ab37] (no laser battle: no weapons), amethyst [a92a400e42d6] (no copyrighted music), water balloon
  [773ca9b1b6e4], puzzle cube [3518354c582f].

## Player ideas, features-misc group (2026-11-05, branch `claude/ideas-features-misc-2b38b0`)

Six Planned ideas built, four big ones written up as proposals only (below). Credits are in the UPDATES entry
`2026-11-05-features-misc`.

- **5% share on wallpapers** (qwertyuiop, `b06fde58b160`, `bd2f68f5442e`): `api/shop.js` `payIdea` now also runs for
  `buywall` and for a wallpaper won from a paid Wallpaper Case (same rules as skins: not for yourself, nothing for a key,
  nothing for a duplicate). Wallpaper tiles show "💡 Idea by", and the "Your creations" text no longer says walls pay nothing.
- **Quest rerolls** (Mace_67, `c2fe91fcbdc7`): `js/quests.js` `REROLLS_PER_WEEK = 3`. `POST /api/quests { action: 'reroll',
  quest }` swaps one unclaimed daily quest for another quest of the same group (`crypto.randomInt`), stored as
  `rr:<group>` in `q:<day>:<id>`; the weekly count is `rerolls` in `qw:<week>:<id>` (taken with HINCRBY first, given back
  on refusal, so two clicks never pass 3). The group keeps its counters, so progress carries over. Rewards follow the
  group's difficulty, so a reroll never pays more. Daily quests only, not weekly ones. UI: 🔄 button on each unfinished
  quest (asks first), "N rerolls left this week" in the quest footer.
- **Badge owner counter** (Tumored, `7db9506f94c0`): `recordRoll` / `recordHardRoll` now send one `SADD` per earned badge
  (instead of one for all), so the server knows which badges are new to the player and adds `HINCRBY bown <badge> 1`
  (`hbown` in Hard mode). Read by `GET /api/leaderboard?badges=1[&mode=hard]` (cached 1 min, numbers only), shown in the
  badge window as "👥 N of M players". Nothing shows before `bown:ready`.
- **Hall of Fame** (Avaneesh_17, `0375af55c59a`): `api/_hof.js`, one hash `hof`, one field per milestone set once with
  HSETNX by the roll that reaches it: first to roll each of the 10 Infinite numbers, first to 100M / 1B / 10B / 100B
  lifetime XP, first to 10k / 100k / 1M rolls, first Mythic / Celestial / Divine / Godlike / Infinite in Hard mode. Page
  `#/hall`, a second tab next to Leaderboard (subnav). `GET /api/leaderboard?hof=1` sends names, never ids. The page says
  "being filled in" until `hof:ready`. The 10 Infinite numbers are a constant in `_hof.js` (finding them takes 45 s),
  re-checked at load; redo the list after a badge change (command in the comment).
  - **What can't be reconstructed** (also on the page and in `tools/backfill-hof.js`): offline rolls; the oldest rolls of
    players above 100,000 rolls (history cap), except an Infinite that stayed their best roll (`best:all` is read too);
    the exact time of an XP or roll milestone crossed before a player's oldest saved roll (dated to that roll, shown
    "before <date>"); and XP is recomputed at today's badge values, so an old XP milestone may be dated a bit differently
    from what it was at the time.
- **Keyboard ASMR** (dog `a65d5a6548e9`, Infin6 `3b90b3f8a464`, LEVIATHAN): measured the old key sound: almost nothing above
  1 kHz (high-frequency energy −62 dB vs −44 dB for the Wax button), which is why it was inaudible on phone and laptop
  speakers. `js/sound.js` `keyThock` now adds the ASMR wax `crackle` and a short bottom-out click; it measures like the Wax
  button and plays ~3 dB louder, still under roll sounds. Real keys: every key, including Shift/Ctrl/Alt/Cmd, symbols and
  F-keys (read on `e.code`, so Shift+1 and AZERTY "&" press the 1), while typing in the chat too, and the key stays
  down while held (keyup / window blur releases it). Never in a password field. Listeners are in capture.
- **Solar System** (deadshot44474, `aa5e1b3867f6`, `10efc2799eed`): asteroid belt (260 rocks, Kepler speeds) between Mars
  and Jupiter, Ceres with the Occator bright spot (a bluish glow that turns with it), Pluto on an offset, tilted orbit
  that crosses Neptune's, the comet's dust trail drawn along its real past path (the straight ion tail is now short and
  faint and never points ahead), and the first orbit always clears the sun and its rays (in landscape Mercury's orbit
  used to pass over the sun). I read "the sun is over the line" as that orbit; if he meant something else, ask him.

**To do after deploying (Sacha, on the VPS, same env as the other tools):**
`node tools/backfill-badge-owners.js` (dry run) then `--apply` (sets `bown:ready`), and `node tools/backfill-hof.js` then
`--apply` (sets `hof:ready`; read the dry-run list first: bots or suspended accounts could hold a spot). Until then the
badge counter and the Hall of Fame page show nothing.

Tests: `tools/test-api.mjs` "features-misc" block (wallpaper share incl. case/key/self/duplicate, rerolls incl. the 3/week
cap and all-done with swapped quests, badge owners normal + hard + backfill, Hall of Fame live + backfill + approx +
no ids). Browser (dev server on 8132): rerolled a quest, Hall of Fame at 320–1280 px light/dark FR/EN, badge window in
French, keyboard key events (held keys, Shift+1, Ctrl+C, AZERTY, password field), Solar System filmed headless dark
1280 px and light 390 px. `tools/audit/overflow-check.mjs` and `overlap-audit.mjs` now include `#/hall`.

### Proposals only (not built, for Sacha to decide)

- **Season pass** (PRISMA123, `4b0ec58e1959`, "on the list for later"). Free only: no paid track (coins are only earned in
  the game). A 30-day season, 50 tiers; tier XP comes from what players already do (daily quests 1 tier-point each, the
  all-done bonus 2, weekly quests 3, rolls 1 point per 100), so it rewards regular play, not luck. Rewards: a few small
  coin drops (≤ 15% of what a regular player earns from quests in a month, checked against the economy page), case keys,
  and 2–3 season-only cosmetics (a title, a button, a wallpaper) that are never sold. Data: `sp:<season>:<id>` hash
  (points, claimed tiers), the season list in `js/events.js`. Needs: a new home card, owner page tool to create a
  season. About 1–2 days of work.
- **Community quests** (jjcoolcid1, `93faee78788f`). Sacha sets a goal from the owner page ("the whole game rolls 2M times
  this week", "1,000 Mythic+ rolls"); one global counter `cq:<id>` (INCR in `recordRoll`, like the weekly event); a
  progress bar on the home page. When it's reached, every player who contributed at least N (e.g. 50 rolls, `cq:<id>:p`
  sorted set) claims the reward: coins or a cosmetic. Rewards must stay small (it's free coins for everyone) and luck
  never changes. About 1 day.
- **Craps and blackjack lobbies** (JBearr12, `f017e780fb7f`). Craps: pass / don't pass / field bets only at first
  (house edge 1.41% / 1.36% / 2.78%, decided on the server with `crypto.randomInt`), new tab in `api/_gamble.js`, must
  pass `casino-sim` and `house-audit` before shipping (don't-pass needs the bar-12 rule to keep the edge). Blackjack
  lobbies: up to 5 players at one table against the same dealer, each playing their own hand, 20 s per turn, built on
  the open-table code of `api/_poker.js` (seats, idle cash-out, `pending` settlement). Same edge as solo blackjack.
  Craps ~1 day, lobbies ~2 days.
- **"also cyber punk"** (leo, `a7dba4706e5d`). No other context; it reads as a follow-up to a skin request, and it sits in
  the skins group's list, so the skins session should own it. Note: "Cyberpunk" is also a game's name, so name it
  something like "Neon City" (rainy neon streets, holographic digits). We already have the Synthwave and Cyber Void
  wallpapers, so a wallpaper alone would be a near-duplicate.

## Planned ideas, batch 1: small settings and display (2026-11-05, branch `claude/ideas-batch-1`)

Sacha: "let's do all of the idea that are planned". There are 132 Planned ideas: about 70 are skins and wallpapers,
the rest are features. They ship in batches, one PR each; the full list is in `ideas-triage-2026-11-05.md`.

- **Settings** (`openSettings`):
  - `autoEquip`: buying sends `equip: false` and `api/shop.js` skips the HSET. Applies to skins, wallpapers,
    buttons and sounds.
  - `bestNote`: hides "contains your best roll".
  - `wakeLock`: Screen Wake Lock while auto-roll runs (`syncWake`, re-requested every 2 s and when the tab
    becomes visible again).
- **Auto-roll "stop on New badge"** (`newbadge` in `STOP_OK`): `autoStops(a, fresh)` is told whether the roll
  gave a badge never owned. This works on all three paths: reveal, background tab and other page.
- **Session window**: tap "🔥 N rolls this session" to open `openSessionModal`. It shows the last N rolls of this
  mode: best 5, worst 3 when there are more than 5 rolls, and rarities.
- **Badges page**: badges found since the last visit get a NEW tag and are listed at the top
  (`badgesSeen` / `hbadgesSeen` settings). They stay marked for one minute across re-renders.
- **Profile "most rolled"**: `api/profile.js` keeps `reps` (the top 20 numbers rolled 2+ times) in the cached
  totals and updates them incrementally. Numbers that repeat for the first time only show up at the next full
  recompute (6 h at most).
- **Leaderboard lifetime XP**: always 4 significant digits (`compact4`).
- **Small Infinite cards** without a skin: rainbow border.
- **Pitfall**: the dev server caches the version stamp at start. Re-stamping while it runs makes the page reload in a
  loop (the Updater). Restart the dev server after `tools/stamp.mjs`.

## Hard mode titles (2026-11-05, branch `claude/hard-titles`)

Planned ideas from the 2026-11-05 triage: PRISMA123 (`2a0ce3902f9f` a title for a Mythic or better in Hard mode,
`e3e0cb767c33` titles for 5k / 10k / 50k / 100k Hard rolls) and Liam123456 (`e3bd823a458c` "Hard mode title").
- `js/achievements.js`: `hardmythic` 🔥 Forged in Fire (any `h:t:<tier>` from Mythic up, Hard Mythic = top 0.02%),
  `hard5k` 🍪 Tough Cookie, `hard10k` ⛓️ Hardened, `hard50k` ⛏️ Hardcore, `hard100k` 🗻 Unbreakable (`h:rolls` only).
  Normal rolls never count for them (the older roll and rarity titles still count both modes, as before).
- No server change: the stats `h:rolls` and `h:t:<tier>` already exist, so players who already qualify see the titles
  unlocked as soon as the new `js/achievements.js` is deployed.
- French in `js/i18n.js`, UPDATES entry `2026-11-05-hard-titles`. Test in `tools/test-api.mjs` (Hard mode block).
- Checked on the dev server (port 8133): the five titles show locked in Me → Badges, in English and French, and the
  update shows in the news.
- Not answered to players yet (Sacha does it).

## Ideas triage and full Roadmap (2026-11-05, branch `claude/roadmap-all`)

- Sacha asked for all new ideas to be sorted and answered. 269 ideas: 68 Planned, 7 Done, 50 Seen (skin and wallpaper
  idea lists, details asked), 144 no / already exists. 243 replies sent with his OK, without Discord roadmap posts. The
  work list is `ideas-triage-2026-11-05.md` and the replies are in `ideas-replies-2026-11-05.md` (both untracked, in
  the repo folder).
- `api/_roadmap.js`: the public Roadmap showed only the 50 newest Planned ideas, which hid 84 of the 134 after the
  triage. It now shows every Planned idea (`MAX_PLANNED = 500`); "Recently added" stays at 50. There is a test in
  `tools/test-api.mjs`, and I checked the page on the dev server with 134 ideas (all shown, no overflow).

## Roll counter per number (2026-11-05, branch `claude/roll-counter`)

Idea from a friend of Sacha: "when someone roll a number, it tells how many people have already rolled it". Related
player ideas: Tumored (a serial number for Infinite rolls) and Gray (the most rolled number).

- `api/_lib.js` `recordRoll`: `BITFIELD nc INCRBY u32 #<n> 1` on every Normal roll, duel rolls included. That is one
  32-bit counter per number, 4 MB for 0 to 1,000,000; I checked it on a real Redis. `nc:since` = time of the first
  counted roll.
  - The roll response gets `seen` (rolls of that number before this one, all players), but **only once `nc:ready`
    exists**. Before that, every number would look "never rolled".
  - Not in Hard mode: there are 10 billion numbers.
- `tools/backfill-number-counts.js`: adds the rolls saved in `hist:<id>` before `nc:since`, so nothing is counted twice,
  then sets `nc:ready`. It is a dry run by default, `--apply` writes, and it refuses to run twice. On 2026-11-05 the
  server had about 9.9 million saved rolls in 3,408 histories. Older rolls of players above 100,000 rolls and offline
  rolls are not there.
- **To do after deploying (Sacha, on the VPS):**
  `cd ~/rng-infinite && RNG_REDIS_URL=http://127.0.0.1:7379 RNG_REDIS_TOKEN="$(cat /etc/rng-relay/token)" node tools/backfill-number-counts.js`,
  then the same command with `--apply`. Until then nothing shows on the site.
- `js/app.js` `notesHTML`: under the reveal, "🔢 X was rolled N times before you · you're #N+1", or "🌟 Nobody had ever
  rolled X before you!". French is in `js/i18n.js`.
- Tests: `tools/test-api.mjs` "Compteur par nombre" (nothing sent before the backfill; dry run; apply; only once;
  counts across players), `BITFIELD` added to `tools/fake-redis.mjs`. Checked in the browser on the dev server
  (both messages, English and French).

## Open poker tables (2026-11-04, branch `claude/poker-open`)

Sacha: "add in poker an open table when people can join whenever they want for like 6 people max, and choose how many
they want to put to come in".

- `api/_poker.js`: `op 'open' { stake, buyin }` seats the player at the fullest table of that stake that still has a seat,
  or opens a new one (at most 8 per stake). `op 'join' { code, buyin }` sits at a given open table.
  Stakes are `OPEN`: 1/2, 5/10 and 10/20; each player brings 20 to 100 big blinds.
  - Open tables are `t.open = <stake index>`, always `status: 'play'`, 6 seats, no host and no invitations. Codes live
    in the `pkopen` set (the lobby reads it and drops dead codes). A lone player waits with `hand: null`; the next hand is
    dealt as soon as a second player sits down.
  - Each seat has its own `buyin`. `cashOut`, the casino ledger, `last` and `over.net` use it (`seatBuyin`, which falls
    back to `t.buyin` for tables created before this change).
  - Before each deal, a player who has not polled the table for 45 s (`OPEN_IDLE_MS`) is cashed out (reason `away`). The
    table closes when its last player leaves. If nobody looks at it for 2 min, the `pending` queue settles it as before.
  - Same limits as friend tables: 300 rolls, account 3 days old. The 2,500 coins a day (`pkday:`) are shared by friend
    and open tables. The day-limit message now says "tables with other players".
- `js/app.js`: an "Open tables" block at the top of the Poker lobby. It has a blinds picker, a "You bring" slider, the
  list of tables at those blinds (player names, n/6, Join) and Sit down. At an open table, "Waiting for another player
  to sit down…" shows while you are alone, the footer shows "you brought", and there is no invite button.
  CSS prefix `pko-`. French strings are in `js/i18n.js`.
- Tests (`tools/test-api.mjs`, "Tables ouvertes"):
  - the gates and the per-seat buy-in;
  - joining mid-hand;
  - the away cash-out;
  - the table closing when it is empty;
  - coins + rake conserved;
  - the 7th player getting a new table;
  - abandoned tables settled by `pending`.
- Browser check on the dev server: I played against two scripted players. I checked leave and cash-out (650 in, 610
  out, −40), waiting alone, the hand starting when a second player joined, French, 320 px, and the light theme.

## Bot farms: network cap, suspensions, 3-day gate (2026-11-04, branch `claude/anti-bot`)

Reported by jonahfr on Discord ("all the TRING names", then forge, shieis, cosmicly…). Read-only look at the live data:
- **2026-11-03 21:05**: 10 accounts "X CID" (630 rolls each). **22:46–23:13**: ~340 accounts "CID …" and "TRING …"
  created in bursts of ~50 per minute. The TRING accounts donated ~16k coins to the clan **CHIPER [CID]** (vault
  104,680). realwhxx (real Google account, 13.8k rolls) made the bot "TRING Plasma" leader and promoted 6 TRING bots
  one or two seconds apart, then TRING Plasma kicked realwhxx and 36 members.
- **2026-11-04 01:34**: 100 accounts with random names in the same minute, ~4,500 rolls each by 19:00 UTC (≈35 % of
  the day's rolls). No coins moved yet, but all past the 300-roll gate for gifts and friend poker.

What changed:
- `api/_lib.js`: `clientIp(req)` (shared with the rate limit), `NEW_PER_HOUR = 20` / `NEW_PER_DAY = 60` new players per
  address (`newp:h:<ip>:<hour>`, `newp:d:<ip>:<day>`), checked in `claimPlayer` only when an id is about to be created
  (roll, name and room pass `req`). No address (local, tests) → no cap. Error 429 "Too many new players from this network…".
- Suspension: set `banned`. `claimPlayer` / `ownsPlayer` throw **423** "This account is suspended" for the right
  secret (a wrong secret is still 403). 423 and not 403 because the site resets its player id on a 403 roll.
  `banPlayers(ids)` also ZREMs them from every `lb…`, `hlb…`, `coinless:lb`, `seen`, `presz` sorted set (SCAN TYPE zset).
  Nothing is deleted; `unbanPlayers` gives access back but not the leaderboard spots. Suspended players still read
  the global chat and the tournament as visitors.
- Owner page → Chat → "Suspend a player" (Suspend / Restore), API `site` action `ban { name, on }`.
- Gifts and friend poker tables: `accountWait(stats)` → 3 days after `stats.first` (players without `first` are old).
- Client: `blockedRoll(err)` shows the server message and stops auto-roll on 423 or the network cap, without a local roll.
- `tools/ban-bots.js`: finds minutes with 6+ new accounts since a date, skips Google, friends, photos and `--keep`
  names, prints the clans they donated to. Dry run by default; `--apply` suspends.

**To do for Sacha after deploying** (on the VPS, same env as the other tools):
`node tools/ban-bots.js` (dry run: 447 accounts as of 2026-11-04 19:00 UTC), then `--apply`. Look at two by hand:
"Hehe michael jackson" (created 23:05 among 51 bots, 350 rolls, no spending) and "Venom" (01:34 like the 100 bots, but
gambled 30,500); add `--keep "Name"` to spare one. Then decide on realwhxx and the CHIPER vault (104,680 coins, led by
a bot): nothing was changed there.

Not done: clan donations have no account-age gate (a vault only buys clan things); duel stakes are random so they
can't funnel coins on purpose.

## Poker tables with up to 6 friends (2026-11-04, branch `claude/poker-multi`)

Sacha: "can we be more than two at the table and play with more friends?"
- **Engine (`api/_holdem.js`):** N seats (2–6, `null` = free seat). Button rotates over occupied seats, SB/BB to its
  left (heads-up keeps button = SB), action order, incomplete all-in raise does not reopen betting (`noRaise`),
  uncalled bets returned only to a live bettor, **side pots** by contribution level (`pots()`), 5% rake per pot,
  odd chips to the first winner left of the button, folded hands never shown. `hand.in` = dealt this hand.
  Heads-up output is unchanged: `tools/poker-sim.mjs` gives bit-identical numbers to before the change.
- **Tables (`api/_poker.js`):** `create { seats: 2..6 }`; `start` (host, ≥2 seated; a full table starts itself);
  `join` also works mid-match while a seat is free (dealt from the next hand, daily friend cap counted at once).
  Leaving / two timeouts / busting cash that player out and free the seat (`t.gone` keeps their result view);
  the table goes on while ≥2 players remain. Any seated player can invite while a seat is free.
- **UI:** 2-seat tables keep the old layout; 3–6 seats use an oval grid (opponents as pods around the top,
  pots row, board, you at the bottom). Lobby has a Seats picker (default 4), waiting room lists who sat + Start.
- **Not done:** no chat at the table; spectators who were never seated can't watch.

## Casino poker (2026-11-03, branch `claude/poker`)

Sacha: "in casino, add a poker table so you can play against bot or against your friend to bet your money".
- **Game:** Texas Hold'em heads-up No-Limit, casino tab "Poker". `api/_holdem.js` = pure engine (7-card evaluator,
  hand flow, uncalled bets returned, auto run-out on all-in, split pots, 5% rake on every pot) + the bot.
  `api/_poker.js` = tables in Redis (`pk:<code>` JSON, lock `pkl:<code>`, presence `pks:<code>`, seat pointer
  `pkp:<id>`, invites `pkinv:<id>`, last match `pklast:<id>`, totals `pkstats`), routed from `api/shop.js`
  (`action: 'poker'`, ops state/bot/create/invite/join/decline/act/next/leave/ack). No new public api file.
- **Money:** buy-in 100–5,000 (blinds 1%/2%), debited under `wallet()` (`spent`), stack paid back at cash-out
  (`bonus`) + `ledger(id, 'poker', buyin, cashout, hands)`. Rake and bot winnings show up as house profit.
  A table nobody polled for 2 min is finished (current hand played out as timeouts) and cashed out by the `pending`
  queue (`flushDue` → `Poker.check`). A waiting table is refunded in full. Friend tables: 30 s per action, timeout =
  check else fold, two in a row = leave. A finished table stays visible 2 min (`op 'ack'` returns to the lobby).
- **Bot:** sees only `botView` (own cards, board, bets). Monte-Carlo equity vs the range it reads from the player's
  past actions, pot odds incl. rake, random bluffs/leads. Tuned with `node tools/poker-sim.mjs` (knobs `P` in
  `_holdem.js`, `POKER_TUNE='{…}'` to try values): all 15 strategies lose at buy-ins 100, 1,000 and 5,000.
- **Friend tables vs coin transfers:** losing on purpose would move coins between accounts beyond the gift limits, so
  friend tables need **300 rolls** (like gifts) and each player can buy in at most **2,500 coins a day** at friend
  tables (`pkday:<day>` hash, counted for both players when the match starts; the host is re-checked at join). The bot
  keeps the casino's 30 rolls and no daily cap. Change `FRIEND_ROLLS` / `FRIEND_DAY` in `api/_poker.js` if needed.
## Image emotes in the shop (2026-11-03, branch `claude/dice-emotes`)

Sacha had ChatGPT draw new emotes in the style of the six free ones (glossy 3D dice, octagonal frame, gold crown).
Five are sold as **image emotes** (`img: true` in `Shop.EMOTES`, files `img/emotes/<id>.png`, 192 × 192): Salty 300,
Hmm 300, Praying 350, K.O. 400, On fire 450. GG, Sleepy and Clown were drawn too but left out on purpose: animated GG,
Zzz and Clown are already sold, and players paid for them. The site shows `img: true` emotes as images
(`emoteImg` / `emoteReady` in app.js: shop tiles, duel bar, bubbles, Emote Case); the server needed no change.
- **Emote Case 400 → 350:** the cheaper emotes lower its average prize to ≈ 461 (weights are 1 / price); at 400 it would
  have been 0.87 of its value, worse than every other case (rule: 0.7–0.8, checked by test-api).
- Shop wording no longer says every bought emote "moves".
- Tested: test-api OK; in the browser (dev server): buy, duel bar, reaction bubble, case strip and a case win, French text.








## Bug reports sweep (2026-11-03, branch `claude/bug-reports-1103`)

All 57 open bug reports in the inbox were read (screenshots included) and checked. Fixed (each comment names the reporter):

- **Leaderboard rows** (Alt, infinity, qwertyuiop ×2): the monthly Top chip ("Top 10 · Oct 2026 · Normal", too long since
  hard mode) covered names, coins and XP. In rows it is now the emoji only (`topHTML(award, true)`, 🔥 for hard), the
  full text stays in the tooltip, on profiles and in the trophies box. Names come first in `.lb-who` (ellipsis), the
  rest is clipped. The trophies box wraps at 320 px (it overflowed by 1 px before).
- **Message stays in the chat box** (Niall, randomguy, Jacksonw, Idkwhatnamemyself): a chat refresh during the send
  redrew the footer with a new textarea holding the draft; only the detached one was cleared. `GChat.send` now clears
  the textarea on screen if it still holds the sent text.
- **Duel chat one letter per line** (Idkwhatnamemyself): 🙂+, Edit and Delete squeezed `.chat-text`; it now keeps 8rem
  and the buttons wrap.
- **Badges tab vs collection titles** (Thermonuclear Bomb, Trial): the tab grouped by colour, the titles by real odds
  (`Achievements.collectionSets`). The tab now uses the same rule (`collTier`, checked equal to the server sets): Exact
  Natural / Exact RTX 5090 / Important Birthday move to Celestial, Current Year and RTX 5090 to Epic, Natural to Rare.
- **Tower shows wrong multipliers before playing** (infinity): the client used a 0.99 edge; now 0.94 / 0.97 like the server.
- **Leading zero peeks out after the reveal** (randomguy, "....", Christmas Morning and every skin with its own
  `.slot.ghost` opacity): `.num-card .slot.collapsed { opacity: 0 !important }`.
- **Skip known badges re-locked in Hard** (Jacksonw): counts both modes (`skipRolls`).
- **Hard mode totals** (jsand): `ServerLife` cached rolls/XP for 60 s without the mode, so switching showed the other
  mode's numbers; Infinite odds showed "0.%" (`pctStr` under 0.0001 %).
- **Lifetime XP stuck past 100k rolls** (kaz): the after-roll counter is the server total + rolls since (`lifeXP`).
- **Case closes on outside click** (Ben good): during the reel (and ~1 s after) a backdrop click = Skip.
- **Keyboard ASMR** (LEVIATHAN): real keystrokes press the matching key with its sound (never while typing in a field).
- **Lost accounts** (Deadshot, CMC_Nate / Naet_161; 8 `id_reset` on 11-02): no code wipes an identity; their devices
  lost local storage (school Chromebooks) and they had no Google or password. New: **Owner → Chat tab → Account
  recovery** creates a one-time code (7 days, `recover:<code>`), the player types it in ⚙️ Settings ("Lost your player?")
  and the device gets a new secret for the old id (`api/auth.js` `recoverLogin`, IP-limited like passwords). Check it's
  really them first (Discord). Deadshot's old account (5,010 rolls) is intact. Players with 300+ rolls and no
  password/Google get a weekly toast to set a password.

Checked, not bugs (answers to send): 75k rolls without an Infinite is ~47 % likely (Big Sexy); 3 is Godlike (Idk…);
a skin preview is not a roll (000001, Idk…); blackjack pays 3:2, two aces are not a blackjack (Mace_67); 0 has no
Century badge (it does not end in 00, Liam123456); a 100M XP roll can be Celestial, tiers come from the percentile of
the total (GamblrGod); 1,769 XP is "10 XP above Land waste" by design (lnbBUChuoi); trash ties share 1st place since
10-30 as R77 asked, so many players can be 1st (TibotyTWO, R77's 11-02 report likely from an old page); profile tops
and badges come from the last 100k rolls kept (jsand, documented 10-30); duels work (6,050 coins of wins on 11-03,
e2e test passes) so IXOLAF2 needs details; casino losses are the house edge (Liconc); Fwm's frozen wallpaper on a work
laptop is the OS "reduce motion" setting. Need more info: PRISMA123 level-75 key (claims pay every pending level's
key; his account shows level 160, nothing missing we can see), PRISMA123 "profile unavailable" (before the 11-02 profile
speed fix), Kag 4 vs 3 Godlikes (t:godlike = 4 on the server), Jacksonw negative duel points, Thermonuclear Bomb's
disappearing 💡 button, Edward skipped roll, GamblrGod can't roll, JUAN SEBASTIAN wrong sound, colt −9 coins.
Ideas, not bugs: Nine to five exact containing "925" (family change = rarity recompute, Sacha's call), Exact Natural /
RTX 5090 / Important Birthday scores (Kag, Trial), quest claim stops auto-roll (shadow2), Tower variety (JULIO_3020).

## Security audit (2026-11-02, branch `claude/security-fixes`)

Sacha asked for a pentest. Three local-only passes (economy, accounts/permissions, new features/DoS), every finding
re-run against the fixed code with the original attack scripts.
- **Account takeover (high):** Google sign-in created players without `player:<id>:secret`, so the first request with
  that id and any secret owned it. `auth.js` now reserves a random main secret; `claimPlayer` never creates a secret
  for an id that has `:google` or device secrets (also protects older Google-only players).
- **Coins (high/medium):** shared `wallet(id, fn)` lock (`shop:<id>`, own token) in api/_lib.js for duel stakes (create,
  join, rematch via `wallets`), rename, avatar upload. Avatar cancel refunds only when its DEL removes the picture.
  Leverage `close` sets `levdone:<id>:<pos>` NX before HDEL (an `edit` could revive a closed position). Duels reserve
  `cooldown:<id>` with SET NX (parallel bot duels rolled 8× faster). Staked rematch is unstaked if a player left or was
  not seen for 60 s.
- **Freezes (high):** suggestion text cut before regexes (250k spaces = 33 s), global chat length checked before
  `hideCodes` (120k chars = 23 s).
- **Other:** hard duel `ask`/`accept` check the unlock; tournament rolls lock per match; `x-vercel-*` headers only on
  Vercel; IPv6 rate limit per /64 and bounded map; `&avatar=` exemption only for real avatar URLs; look-alike letters
  refused in new names; moderators can't delete the owner's or other mods' messages; `Object.hasOwn` for mute durations;
  images on ideas need 30 rolls (40 MB/day site cap); reporting needs a name and 20 rolls; friend requests 10 rolls.
- **For Sacha (needs sudo):** `bash ~/rng-infinite/deploy/ovh/harden-caddy.sh` hides `*.md` and `roblox/` from the
  public site and adds HSTS, nosniff, X-Frame-Options SAMEORIGIN, Referrer-Policy and Permissions-Policy.
- **Not done (low):** 500 replies on crafted JSON (`{"toString":null}`) still count as errors; password-login lockout by
  8 wrong guesses; hard profile is not cached.

## Hard rolls and clan XP (2026-11-02, branch `claude/hard-clan-xp`)

Sacha: hard rolls count for the clan, but only at the Normal value of their rarity. `normalTierMin(tier)` (api/_lib.js)
= the smallest Normal score of that rarity (from the Normal percentile table): Common 2,315, Rare 16,411, Mythic
315,754, Divine 25,017,717, Infinite 112,726,134. `recordHardRoll` passes it to `Clan.rollWrites` instead of the hard XP.

## Duel Normal / Hard choice + Divine unlock (2026-11-02, branch `claude/duel-mode`)

Sacha: duels get a "1 · Normal or Hard?" step at creation (`duelPrefs().level`, defaults to the current mode, Normal when
locked); only players who unlocked Hard mode can create or join a Hard duel (server `checkHardOpen`). The unlock is now
**Divine or higher** in Normal mode (`t:divine`, `t:godlike`, `t:infinite`), was Godlike. A player still in Hard mode
when the server says locked is sent back to Normal (not during a roll or in a duel).

## Hard mode 50× rarer (2026-11-02, branch `claude/hard-50x`)

Sacha, the same evening: "make it actually harder: higher XP needed for the rarities". `HARD_CARD_TIERS` now makes every
tier above Common **50×** rarer than Normal (was 10×): Uncommon 0.50%, Mythic 0.018%, Infinite 1 in 5 million. Same
`HARD_COINS`, so Hard pays ~37% of Normal's coins per roll; XP per roll unchanged. Tier odds recomputed from the stored
table (`data/hard-odds.json`, `js/hard-data.js`), no rebuild. Hard rarities already counted today (`h:t:*`) stay.

## Hard mode lock (2026-11-02, branch `claude/hard-lock`)

Players' idea, Sacha's go: Hard mode opens after the first **Godlike or Infinite** roll in Normal mode (`t:godlike` +
`t:infinite` > 0). Enforced on the server (`checkHardOpen` in api/_lib.js: `/api/roll` mode hard, creating or joining a
hard duel, the hard tournament sign-up; 403 with `locked: true`, which the site never treats as a stolen id). The lite
profile returns `hardOpen`; the site keeps it in `settings.hardOpen`, shows 🔒 on the Hard button with the rule on
hover (title) or on tap (toast), and unlocks right after the reveal of a first Godlike/Infinite.
At launch 36 players had already rolled in Hard mode (662 rolls), 11 of them with a Godlike or Infinite: the other 25
keep their hard rolls, history and leaderboard spots, but cannot roll in Hard again until they unlock it.

## Visitor countries on the VPS (2026-11-02, branch `claude/geoip`)

Sacha: "13,000 visits from no location" on the Owner traffic page. Since the site moved to the VPS (2026-10-21) no
request carries Vercel's `x-vercel-ip-country`, so every visit was counted as `ZZ` (the Vercel copy now answers 402).
- `api/_geo.js`: country from the free DB-IP "IP to Country Lite" database (CC BY 4.0, credit on the Owner traffic
  panel), only when the Vercel header is missing. The IP is used for the lookup and never stored. Binary file
  `~/geo/dbip-country.bin` (~10 MB, loads in ~0.2 s, reloaded when it changes); without it, `ZZ` as before.
- `tools/geoip-pack.mjs` converts the CSV (parsing it in the server took ~3 s of blocking and ~400 MB).
- `deploy/ovh/geoip-update.sh [--install]`: downloads the month's file (or last month's), packs it, `--install` adds
  a crontab line for emma (3rd of each month, 04:17 UTC). No sudo.
- Not back: the map dots (they need the much bigger city database). Visits before the fix stay `ZZ` (no IP was kept).

## No more roll freezes during big profiles (2026-11-02, branch `claude/profile-no-freeze`)

Sacha: "why does auto-roll take so much time / latency". Production log (3 h): 23 rolls over 2 s (median 2.4 s, up to
8 s), always at the same second as a `GET /api/profile` of a big player (7-8 s). The profile replays up to 100,000
rolls and only yielded every 2,000 analyses (~0.15 s blocks); a roll does several Redis round trips and waited behind
each block. Now `breather(5)` (api/_lib.js) yields after 5 ms of work: in a benchmark, a roll made during a 100,000-roll
profile went from 1.7 s median to 55 ms, the profile itself takes the same time. (The 41 s roll in the log was a
client that gave up, "Error: aborted".)
## Current state

The game is live on https://rng-infinite.com, served by the OVH VPS (Caddy + Node API + Redis). Vercel only keeps the
domain's DNS (Vercel Pro was cancelled; the Hobby team was paused once for CPU overuse, which is why everything moved
to the VPS on 2026-10-22). About a hundred player ideas and bug reports arrive every day through the 💡 button;
Sacha triages them on the Owner page (`#/owner`, Inbox tab) and answers each one.

## Hard mode (2026-11-02, branch `claude/hard-mode`, based on `claude/chat-reactions`)

Sacha: "under RNG∞, Normal or Hard mode; hard mode has 10 digits instead of 6; adapt everything to make it fair; not
the same leaderboards". His choices: rarer tiers that pay more; separate stats + badge collection, duels + tournament;
shared coins, skins, XP/level, quests, achievements, chat.

- **Engine** (`js/engine.js`): `createEngine(meta, pct, { hard: true })` = 0..9,999,999,999, `HARD_CARD_TIERS` (every
  tier above Common 10× rarer), 52-bit `roll()`. Primes and divisors go through a sieve (same answers, checked on all
  1,000,001 normal numbers; ODD_ABUNDANT was 0.4 ms per 10-digit number). Fibonacci uses a list (5n² overflowed 2^53),
  POWER_OF_TWO no longer uses 32-bit `&`.
- **Data** (`tools/build-hard.mjs`, ~1 h on 10 cores): exact counts up to 7 digits, fixed-seed samples for 8/9/10
  digits; badge XP = 100 × 10^10 / count (same rule as normal), rare-in-sample badges extrapolated from 6→7 digits,
  then every score scaled so the expected XP per roll equals normal mode (shared levels). Writes `data/hard-*.json`
  and `js/hard-data.js` (loaded by the site only when a player switches to Hard; `<script type="text/plain" id="hard-data">`
  in index.html just carries the stamped URL).
- **Coins**: `Shop.HARD_COINS` (Uncommon 15 … Infinite 45,000), counted from `h:t:<tier>` in `Shop.earned`. `test-api`
  checks the average per roll is within 3% of normal mode.
- **Server**: `recordHardRoll` in `api/_lib.js` (keys `hhist:`, `hbadges:`, `hlb:*`, `hbest:*`, `hcount:*`, `hrolls:*`,
  `hlbx:*`, `hlb:worst`, `hlbw:*`; stats fields `h:rolls`, `h:xp`, `h:best`, `h:first`, `h:t:*`; shared `xpLife`, quests,
  clan XP, `rc:<day>` diminishing returns, cooldown). `hhist` members are `t:n:s` (XP stored: no re-analysis).
  `/api/roll` `mode:'hard'`, `/api/leaderboard?mode=hard` (no event/median), `/api/history` `mode:'hard'` → `[n,t,s]`,
  `/api/profile?mode=hard` (own light profile), duels `create {hard:true}` (room hash `hard=1`), tournament `which: 4`
  (`<day>-h`, same hours as tournament 1). Big rolls tagged hard in chat, Discord and friend alerts.
- **Site**: `Mode` + `Engines` at the top of `js/app.js` (`Engine` is a Proxy to the current mode's engine; page
  globals BADGE_ODDS/TIER_ODDS/… swapped). `Store` keeps two histories (`rnginf.v1` normal, `rnginf.hard`). Switch under
  the logo (`#mode-switch`), blocked during a roll/auto-roll/duel; opening a duel of the other mode switches mode.
  10-digit cards shrink (`.num-card:has(> .slot:nth-child(10))`); 10 digits reveal in the same total time as 6.
- **Monthly trophies**: both modes settle their own top 10 (`api/_rank.js`); a hard trophy's month is `AAAA-MM-h` in
  `topawards:<id>` / `topbest`, the badge shows "· Normal" or "· 🔥 Hard" (Sacha's request).
- **Real data (build of 2026-11-02, 10 cores, ~70 min)**: tier odds Uncommon 2.50%, Rare 1.50%, Epic 0.50%, Anomaly
  0.41%, Mythic 0.085%, Celestial 0.0091%, Divine 0.00046%, Godlike 0.00040%, Infinite 0.000098%; expected XP 32,622
  scaled ×0.987 to the normal 32,194. All 125 skins checked with a 10-digit reveal at 375 px (no overflow, no error).
- **Not done / ideas**: no weekly event or median board in hard mode; the client rebuilds the hard badge collection from
  local rolls (0.2 ms per roll: slow after ~50k hard rolls).

## Emoji reactions on chat messages (2026-11-02, branch `claude/chat-reactions`)

Sacha: "react with emoji to someone's chat, like WhatsApp". His choices: all four chats, 6 fixed emojis.

- `api/_react.js`: shared helper. 👍 ❤️ 😂 😮 😢 🔥 only, one reaction per player and message (another replaces it,
  the same removes it). One hash per chat, field `<message>|<player>` = emoji index (no lost update when two players
  react at once). Stale fields are pruned on the next reaction; the hash expires with the chat. 300 ms between reactions.
- Global chat: `gcReact` (a name and not muted; the 100-roll rule is only for writing). `rx:gc`, `gc:rxrev` (counter):
  `gcList` sends `rx` only when the client's `rxrev` differs (or on a full list); the closed-panel peek never gets it.
- Friends: `react` in `/api/friends` (friends both ways, nobody blocked), `rx:dm:<a>:<b>`, message = its time.
- Duels: `chatReact` in `/api/room` (seated players), `room:<code>:rx`. Clan: op `react`, `clanrx:<cid>` (deleted
  with the clan).
- UI: `Rx` in `js/app.js` (one capture click listener, each chat registers `send` + `redraw`); 🙂+ opens the bar,
  pills under the message, hover shows who. CSS prefix `rx-`. Duel messages are now wrapped in `.chat-item`.
- Tested: `test-api` (all four chats), real browser on the dev server for all four, 375 px light theme.

## Discord giveaways (2026-11-01, branch `claude/discord-giveaways`)

Asked by Sacha, to bring players to the Discord: free skin giveaways. His choices: anyone on the Discord can enter,
and he starts each one himself.
- **Owner → 🎁 Giveaways**: pick a skin (any paid shop skin) and a length (1, 24, 48 or 72 h; 24 by default), press
  Start. The first one creates the 🎁 GIVEAWAYS category and the read-only 🎁・giveaways channel (members can only react).
- The bot posts an embed and adds 🎉; members enter by reacting 🎉. Bot REST API only (reactions are read at the end):
  no gateway, no interactions endpoint, nothing to set in the Developer Portal.
- `api/_giveaway.js`: `deploy/ovh/api-server.js` calls `tick()` every minute; a finished giveaway is drawn once (lock),
  winner by `crypto.randomInt`. Linked players who already own the skin are left out. Linked winner: the skin is added
  (`skins:<id>`) and announced. Unlinked winner: `gw:claim` keeps the prize 7 days; linking (or "Update my roles")
  in Me grants it and the site shows a toast.
- Update-log entry added: it is also posted automatically in 🆕・updates on deploy.

## Smoother server (2026-11-01, branch `claude/server-speed`)

Asked by Sacha: make the server as smooth as possible, fewer failed requests. Measured on the VPS (read only):
~2.9 million requests a day (2.1 million rolls), 0.15–0.3% over 2 s, a few up to 43 s; Redis itself is fast
(~830 ops/s, microseconds per command), but every call went through the Python relay, which opened a new thread and
a new Redis connection each time (143 million connections in 38 days): ~1 ms per call, ~7 ms when 20 arrive at once.
Redis' slow log was full of `ZRANGE hist:<id> 0 -1` (whole 100,000-roll histories, up to 96 ms each, blocking Redis).
- `api/_resp.js`: direct RESP connection (pool of 4 persistent sockets, resumable parser, same answers as the relay,
  same deny-list). `deploy/ovh/api-server.js` turns it on (`RNG_REDIS_DIRECT=127.0.0.1:6379`); if Redis refuses the
  connection (nothing sent) the call goes through the relay. To go back: `Environment=RNG_REDIS_DIRECT=off` in the
  `rng-api` unit, or revert. Tested by `tools/test-resp.mjs` (identical results; 2,000 calls 17 ms vs 721 ms locally;
  200 simultaneous rolls fine, the relay reset connections under the same burst).
- `/api/history` takes `since`: the site now downloads only rolls newer than its last counted roll on each visit, and
  the whole history once a day per player (`histFull:<id>` in localStorage) and at sign-in.
- Profiles: big players whose best roll predates the history (`padded`) re-read all 100,000 rolls on every visit
  (~7 s of CPU). They now take the incremental path; the added roll is kept as `pad` so counts match a full recompute.
  `lastT` now advances past skipped duplicates (they were re-read and counted at the next visit).
- Health (Owner → Server): refused requests (429) per day and per route, the longest event-loop freeze and minutes
  with a freeze over 0.5 s; unknown `/api/*` paths (vulnerability scanners) are counted as `unknown`.
- Not changed (Sacha's call, needs sudo): Redis saves a snapshot every minute (`save 60 10000`) *and* keeps an AOF;
  each snapshot forks a 1 GB process (~40 ms freeze). `save ""` with AOF alone would remove that.

## Chat moderators section (2026-11-01, branch `claude/chat-moderators`)

Asked by Sacha: a section like the Idea Managers, for chat moderators, so he can see whether they mute fairly.
- **Owner → 🛡️ Moderators** (new tab; the moderators box left the Chat tab): give or remove the role, a card per
  moderator (since when, mutes, deleted messages, reports checked, actions this week, mutes Sacha lifted), and "What
  moderators did": every mute and deleted message with the reason and the message, filterable by moderator, with Unmute
  on mutes still running.
- **#/mod** (moderators and owner; link "🛡️ Mod" in the chat header): the rules, the reported global-chat messages
  still in the chat (✓ Nothing wrong / 🗑️ Delete / 🔇 Mute…), and their last 30 actions. They never see who reported,
  nor reports about themselves.
- Server (`api/_global.js`): `gcModPage`, `gcReportOk`; moderator deletes go to `gc:dellog` (last 200); deleting or
  muting a reported message settles its reports (`reports:by` in `api/_reports.js`: by, act ok/deleted/muted), shown
  on the Owner Reports tab as "Handled by Modo · …". `gc:modsince` = when the role was given. Log entries keep `bi`
  (moderator id) server-side only. Messages by moderators carry `mod: true` (🛡️ next to the name).
- Follow-up (branch `claude/delete-reason`): deleting another player's message now needs a reason too (same list
  and note as mutes, `checkWhy` in `api/_global.js`); own messages and game announcements don't. The reason shows in
  "What moderators did" and on the moderator page.

## Chat mutes with reasons (2026-11-01, branch `claude/chat-mutes`)

Asked by Sacha: moderators mute for a time, with a reason Sacha can check on the Owner page, and never ban.
- `api/_global.js`: durations `5m`, `10m`, `1h`, `24h`; `perm` (forever) is now **owner only**. A reason is required
  (`spam`, `rude`, `mean`, `personal`, `inappropriate`, `other`; `other` needs a note). The mute record keeps the
  duration, reason, note (120 chars) and the deleted message text. Every mute is also pushed to `gc:mutelog` (last
  200; it keeps the player id `p` server-side only). Unmuting from the Owner page marks the log entry `lift: { by, t }`.
- `gcAdmin` now returns `history` (mutes that ended or were lifted, newest first) and `modMutes` (mutes per moderator).
- The muted player sees the reason under "You are muted until…", never the moderator's note.
- Chat UI: "🔇 Mute…" opens a small form (duration chips, reason, note). The list stops redrawing while it is open.
- The chat box is now a `<textarea>` that grows to 4 lines (Enter sends, line breaks become spaces): long messages
  scrolled out of the one-line field before. The duel keyboard shortcuts now ignore textareas and selects.
- Old mutes made before this change have no reason; they show "No reason given".

## Profile picture price (2026-11-01, branch `claude/avatar-price`)

Sacha's answers to the open questions: Gray is now an Idea Manager; Phong254 was asked to send his casino track (it
would play on the casino page only); no Pride skin (the Rainbow skin exists); no Exact 41. MereTera's idea, decided by
Sacha: the first approved profile picture stays free, then each new one costs `Shop.AVATAR_PRICE` (500) coins, paid
when sent (`paid` in `avp:<id>`, eco `out:avatar`) and refunded if rejected or withdrawn. Replacing a paid pending
picture costs nothing more. MereTera's idea (`sugg:2f8cd25cd6fe`) gets its "Added" reply once this is live.

## Player ideas update (2026-11-01, branch `claude/ideas-2026-11-01`)

402 new ideas were sorted (`integration-review/ideas-2026-11-01.md`, untracked): 71 for this update, 70 for later,
105 no, 107 already in the game, 28 duplicates, 19 questions (Sacha still has to answer: Phong254's casino music, Gray
as Idea Manager, a Pride skin, a coin price for profile picture changes, Exact 41). Replies to players are drafted in
that file but not sent.

Built by 7 agents in parallel worktrees, merged here with `git merge-file --union` and checked by hand:
- 13 skins (Mini Golf, Soccer, Basketball, Safari, Mining, Cat, Toaster, Billiards, Pirate, T-Rex, Birthday Cake,
  Carnival, White Chocolate), touch-ups to Singularity, Lightbulb and Infinity; 6 wallpapers (Farm, Keyboard ASMR,
  Thunderstorm, Solar System, Meteor Shower, Party; Farm, Meteor Shower and Party are legendary).
- Buttons Cardboard Box, Free Download, Bread, Last Roll, Bubble Wrap; sound packs Slime, Boing, Meow; emote Hungry;
  an Emote Case. The Button Case stays at 350 (Sacha's price) although its average value rose to ~482.
- 9 badges (Thirteen and o7 were dropped by Sacha: they moved 72k numbers). 35,672 numbers change tier (24,657 down);
  only 360 (Anomaly → Divine) and 10987 (Divine → Celestial) move among Infinite/Godlike/Divine. Palindromic Prime
  starts at 2 digits so 24 stays Infinite. **Run `node tools/rescore-worst.js --apply` after deploy.**
- Titles: levels 10–250, Generous (uses the existing `giftOut` counter), 100%, streaks 30/100/365 (`streakBest`),
  Full Spectrum. Odd Week in the event rotation (first on Dec 7).
- The Wheel casino game (96.9 % return, bets 1–1,000 like Plinko).
- Quality of life: session counter, shop search, preview rarity picker, equip from Inventory, History period filter,
  digit-length stats, XP-above for every tier and a setting to hide it, compare in the XP checker, sign out for
  password players, auto-roll keeps going on other pages, "N players online" on the Roll page, in the chat and live in
  a footer at the bottom of every page (asked by Sacha; hidden under 5 players, refreshed every 30 s).
- Chat: emoji picker in friend/duel chat, clan tags, compact lines, Send button styled, friend ping, secret codes
  hidden (note: the phrase "roll forever" is one of them), proxy/unblocker talk refused. Duel stake: any 1–1,000.
- Fixed: profile rarity counts mixed old and new rarities (casmicgraything).

Known: `tools/casino-sim.mjs` fails about 1 run in 6 on the old blackjack "double without coins" assertion
(line ~429, untouched since 2026-10-10); rerun it.

## Christmas event (2026-11-01, branch `claude/christmas-event`)

Asked by Sacha: Halloween out of the Limited tab, Christmas in, with as much as Halloween had. The Limited tab icon,
banner (night blue, falling snowflakes) and countdown now point to December 25 (`until: '2026-12-26T00:00:00Z'`).
Zombie Moon was due to end on November 2 and left with the rest of Halloween on November 1. Owners keep everything.

New limited items (never in a case, 5% share where an idea is credited):
- Skins: Snow Globe (1,225, idea Gray alt), Gingerbread (1,100), Ugly Sweater (999), plus Christmas Morning (2,512,
  JBearr12, already live). Each has a Generate button and a duel frame.
- Wallpapers: Snowy Village (777, credited to IXOLAF2, whose "Snowy Cabin" asked for the same), Cozy Fireplace (1,224),
  Sleigh Ride (1,031).
Built by three agents in parallel worktrees, each following the rng-skin-design skill (captures in the session
scratchpad). Merging them: use `git merge-file --union` per conflicted file and fix edited lines by hand (see
.claude/lessons.md).

## Bug reports sweep (2026-10-30, branch `claude/bug-reports-1030`)

All 49 open bug reports in the inbox were checked against the code. Fixed (each comment names the reporter):

- **Profiles past 100,000 rolls** (jsand, kaz, Raynarr00, LeSombre): `api/profile.js` takes the roll count from
  `count:all`, lifetime XP from `lb:xp` and rarity counts from `stats.t:<tier>`; luck, best/worst and badges still come
  from the last 100k rolls kept in `hist:<id>` (new `window` field).
- **Two players on one device** (costoroll): `Store.setIdentity` / `signOut` empty the device's rolls when the player
  changes; `syncHistory` reloads the account's own. Already-merged devices: Settings → Clear history, then reload.
- **Badges tab "Roll once"** (A Dude): `?lite=1` finds the player by id (`me`), not by the name saved on the device.
- **Menu pulled back to the roll** (Stepa, daddy finger, Chromebooks on slow school networks): a roll answer that
  arrives after the player left the page is saved with a toast, no reveal.
- **Big roll lost in a hidden tab** (ann Joe worst gamble): the away summary is kept on the device until shown.
- **Auto-roll "presses but nothing"** (MereTera, Sean): two tabs or devices on one account share the 8 s server
  cooldown; no click sound on a refused roll, and a toast after two refusals. Timers have a fallback.
- **9 Infinites instead of 10** (kaz): `tools/build.mjs` dropped every second top score (0.0001 % step). 4 numbers
  go up one rarity: 24 → Infinite, 224224 → Godlike, 10987 → Divine, one Mythic → Celestial. `js/percentiles.js` is
  261 KB (was 193 KB).
- **Leaderboard ties** (R77): equal scores share the rank, the monthly Top badges/coins and Trash King. Ties can pay a
  reward more than once.
- **Friends "Offline · last roll just now"** (kingston): a roll in the last 150 s counts as online.
- **Duel score boxes swapped** (qwertyuiop), **"Leave the game" after the end**, **duel bets stuck 12 h** (lobbies
  nobody is on for 30 s are refunded within a minute), real messages for 400/403 (dylanbuckleyisjewish).
- **Crash cash-out lost** (GamblrGod): polling 150 → 300 ms (it alone exceeded the IP limit), cash-out retried ~1.8 s.
- **IP rate limit 300 → 900/min** (MAYO saw "Unavailable right now"): schools and families share one IP.
- **Other tournament greyed out** (casmicgraything), **Lake fish head first** (TibotyTWO), **Window Cleaner arm**
  (Deadshot), **Workshop elves' heads** under the top bar (costoroll), **Battle tab → Duel** (idea by Kag).

Not bugs (answers drafted): rarity moves after new badges (911911, 3435), 1234 Sequence (4) under Cascade, 1,000,000 is
in range, Weekend Rush is UTC and +25 %, leading zeros, one Premium key shows on several cases, multi-device XP,
ads/Shein (adware on the player's device). Ideas: RTX 5090 / Exact Natural / Important Birthday scores (Kag; balance
call for Sacha, they are 1-in-a-million badges scored far below 100 M), stop auto-roll on quest claim, Tower variety.
Need more info: GamblrGod "can't roll", colt −9 coins, PRISMA123 −60k, JUAN SEBASTIAN wrong sound, Edward skipped roll.
Open weakness, not changed: a chat mute is per account and a new account needs only 100 rolls to chat.

After deploying: run `node tools/rescore-worst.js --apply` (rarity table changed).

Later the same day (branch `claude/bug-reports-1030b`): the Sky skin gets its colour on Anomaly and Godlike too (Deadshot;
Godlike was added after the skin and left the sky blue), and the chat filter masks blowjob / handjob / rimjob, joined
or in two words (Yooooooooo). "job" alone stays allowed; "second hand jobs" is now masked too, an accepted false positive.

## Clearer menu (2026-10-29, branch `claude/clearer-layout`, not merged)

Sacha: "now it's like hard to know where stuff are … do a version of the site that you think is easier to understand".
He approved the plan (and "Gamble → Casino") before it was built. Nothing in the pages themselves changed: only how you
reach them.

- Top menu: 7 entries with their names on every screen (before: 8 icons with no name under 1110 px): Roll, Shop,
  Battle, Leaderboard ("Top" on phones), Casino, Social, Me. Under 1080 px the menu is its own row under the bar, icon
  above the name (`.nav` is now a direct child of `.topbar`, CSS block "menu regroupé" at the end of style.css).
- Sections (`SECTION_OF` / `SUBNAV` / `drawSubnav` in js/app.js, `#subnav` in index.html): Battle = Duels · Tournaments,
  Social = Friends · Clan · Global chat (opens the chat panel), Me = Profile · Badges · Stats · History. No tabs in a
  duel room. Every old route still works (`#/friends`, `#/clan`, `#/tournament`, `#/player/Name`, `#/room/CODE`…).
- New route `#/me` (`renderMe`): the "My profile" summary that was at the top of Profile & Friends (level and rewards,
  XP, best roll, rank, Discord link, settings). The Discord OAuth return now lands on `#/me`. Own public profile
  (`#/player/<me>`) highlights Me and has no "← Leaderboard" link.
- The player button (top right) is now a link to `#/me`; ⚙️ opens the settings and is shown on phones too.
  Gamble page title is "Casino" (route stays `#/gamble`). Roadmap link added to What's new.
- Audits updated: overflow-check and overlap-audit include `#/me` and `#/tournament`; header-fit takes `RNG_BASE` and
  reports `gap: "row2"` and cut labels; modal-audit and sound-check open the settings with `#gear-btn`.

## Player ideas batch (2026-10-28, branch `claude/ideas-2026-10-28`)

Sacha: "refuse all the no's with a friendly reply, then start the to-do list". 83 ideas were declined in the inbox
(18 from 2026-10-28 and 65 from the 2026-10-27 triage); mixed ideas, "your call" ideas, Phong254's casino music,
single-player poker and Gray alt's friend-coins exception stay open. Drastix235 got a one-off 300,000-coin creator
gift (`stats.ownerGift`), asked by Sacha as an exception to the coin rule. Built by 8 parallel agents, merged here.

- Badges: Pythagorean (100 numbers), Prime Digits, So Close (exact 97); `Engine.prevTier()`. **10,343 numbers change
  tier** (97 → Godlike, 24 Infinite → Godlike, 224224 and 911911 Godlike → Divine): run `tools/rescore-worst.js --apply`
  on the server after deploy. Unique-number titles (100 → 100k, from `nums:<id>`). Auto-roll can stop on up to 5 badges
  (`Store.settings.autoBadges`). "XP short of" also in history and other players' roll detail; Common and worse show the
  margin above the tier below. Bot duels follow the player's speed (`pace` from `speedLv`, api/room.js).
- Leaderboards: XP per day / week / month (`lbx:*` zsets written in `recordRoll`, TTL set on the day's first roll) and
  all time; Median roll (`med:<id>` histogram, `lb:med`, 200+ rolls). `MIGRATION` bumped to 7 in api/leaderboard.js:
  the background `migrateXp` re-reads every history once after deploy to build the median histograms (watch the load).
- 16 skins (lots A–D in js/skinfx.js, 109 skins in total) with buttons and duel frames; optional `scene.miss(tier)`
  hook in `mount()`. 5 wallpapers in the new `js/wallfx.js` (canvas): The Fisher, Condensation, Your Last Rolls,
  Spinning Bread (in the case, reacts to rolls), Zombie Moon (limited until 2026-11-03 00:00 UTC). `RNGWallFX._debug`
  is still exported.
- Shop: Clicky sound pack, Sound Case (`snd: true`, opened by a Premium key too), Power Core and Black Hole buttons
  (`eventhorizon`, because `blackhole` is the Singularity skin); Button Case 320 → 350 (Sacha) to keep a 0.75
  value ratio. Owned / not owned filter. Owner counts in the `owners` hash (`GET /api/shop?owners=1`, counts only):
  run `node tools/backfill-owners.js --apply` on the server right after deploy. "Your creations" panel for idea authors.
  **Behaviour change:** the first drop of an idea skin from a paid case now pays its author 5% of the case price
  (reported by finnnnn: case drops paid nothing before). ASMR crunch, smoother Infinity border (Safari keeps the old
  animation, untested), brighter Open Ocean.
- Tests: the 2026-10-28 blocks use player ids `28ed…` (badges), `28ee…` (leaderboards) and `28ef…` (fillers).
- Not checked by hand: the new sounds (recordings were made, nobody listened), Safari.

## Player ideas batch (2026-10-27, branch `claude/ideas-2026-10-27`)

Sacha approved a yes list from the 374 open inbox ideas + Discord #ideas ("do all the ones you said yes, nothing about
the rest"). Built by 7 parallel agents, merged here. Ideas not on the yes list were left untouched in the inbox.

- Badges (tools/source/custom.json, js/engine.js): Forever family (224/224224), 1987, 505, Beverly Hills (90210), 1738,
  Around the Clock (24), Jumbo Jet Set (747747), Summer Break (104), Narcissistic, Silver Ratio (2414/24142), Quantum
  Chaos; Leap Day reads 2902YY and YY0229. ~48,600 numbers changed tier: run `tools/rescore-worst.js --apply` on the
  server after deploy; a migration for the ~980 new Mythic+ numbers is optional. `build.mjs` now writes
  `data/badge-odds.json` and checks 96/96 (only the best badge of a custom family is subtracted).
- `Engine.nextTier()` and the "X XP short of <tier>" line after a roll.
- Titles: rarity collectors (server flags from `badges:<id>`, versioned by `colv`), coin-earned tiers, Sound Collector,
  Shopaholic, Clan Benefactor/Pillar, Decabillionaire (earned at 10B XP, not a Prestige item), Clan MVP.
- Global chat: replies (`gc:gone` keeps deleted/edited ids), emoji picker, big-roll system messages (Divine+, 15 s after
  the roll, rate-limited, queue `gc:sysq`), owner pin. About me (`bio` hash, `api/_bio.js`, owner can clear, reportable).
- Most rolls leaderboard (`lb:rolls`, backfilled by `migrateRolls` every 5 s), unique numbers (`SCARD nums:<id>`),
  weekly quests (`qw:<week>:<id>`, `in:weekly`), quest chest (`stats.qdays`, `in:chest`), clan co-leader rank.
  The "all quests done" bonus is now counted in the economy (`in:quests`).
- Casino: Duck Race (`duck()` in api/_gamble.js, 97% RTP per duck), How to play modal on every game. Shop: Button Case
  (a Premium key opens it too), Pickle button, Meme and Soft Taps sound packs.
- 7 wallpapers (Comic Book, Black Hole, Rain to Rainbow, City Heights, Crystal Cave, Jungle, Lake): their CSS block was
  generated, edit it by hand now. 14 skins in two blocks of js/skinfx.js ("lot A", "lot B"): 77 scenes in total.
- Tests: the simulated clock now starts at 10:00 UTC (`TEST_START_HOUR` to override) and the duel coin check ignores
  monthly awards; the suite used to fail near midnight UTC and at month end.
- Known weak points (agents' own critique): Ship Wake / Stickman / elves are small on phones; Baseball's bat-for-1 is
  hard to read; Torn Paper's tear is a straight wipe; the 🁫 Domino emoji may not render on some phones.

## Trailer v2 (2026-10-26, merged in PR #43 and live)

- Asked by Sacha: a new promo film replacing the 30 s one. `trailer/trailer.js` (38 s, 16:9 + 9:16, cuts `?cut=15` and
  `?cut=6`), soundtrack `tools/trailer-audio.mjs` (new cues: whip, hit, chat, coin, peg, card, roll, infinite impact;
  drop with a lead melody). Render: `node tools/trailer-render.mjs --pro` then `--pro --cut 15`.
- Shot list: hook (only 10 numbers are Infinite) → Mythic roll 808808 + badges → legendary skins (Divine Judgment,
  Comic Book, Milky Way, Christmas Morning, Infinity, real skinfx sequences) → Blackjack/Bowling/Dynamite → wallpapers
  (Open Ocean, Deep Dive, Summit) → global chat (@mention, avatars, friend alert) → clans + 5v5 war → 3 tournaments +
  bracket → casino (Plinko, Dice, Blackjack, in-game coins only) → Prestige titles → roadmap → 777777 Infinite → end card.
- Made-up players (Nova, Pixel, Rex…) and drawn avatars only. The page still refuses any number that earns badge 235.
- `media/trailer-*.mp4` are web encodes (two-pass, grain removed) of the `--pro` masters; posters are the 33.6 s frame.

## Profile pictures (2026-10-26, branch `claude/avatars`, not merged)

- Asked by Sacha (idea by kingston and JAKECisthebest). Logic in `api/_avatar.js`, routed from `/api/profile`
  (POST `action: 'avatar'`, GET `?avatars=1` map name → token, GET `?avatar=<token>` image, immutable cache).
- Upload from ⚙️ Player & settings (name + 30 rolls, 5/day): the browser crops to a 256×256 JPEG on a canvas (strips
  EXIF); the server checks the JPEG structure, square ≤ 512, no APP1/EXIF, ≤ 60 KB. Stored as pending (`avp:<id>`),
  invisible to everyone else until Sacha approves it on Owner → 🖼️ Avatars (reject with a reason, remove later,
  last 200 decisions in `avlog`). Images are served by an opaque token (`avtok`), never by player id.
- Shown on the header button, profile, leaderboards, global chat, clan members, friends. Report → Reports tab
  (`where: 'avatar'`) with a Remove picture button.
- Not done: no ban from uploading after repeated rejections; the dev/VPS rate limit (300 req/min/IP) also counts
  avatar image requests (they are cached by the browser after the first load).

## Done on 2026-10-25 (all merged and deployed, PRs #22–#31)

- **Player-idea update (#22)**: badges Exact 61/55, Odd Abundant (abundant AND odd, ~1 in 500, stays Anomaly-level:
  Sacha's decision), Vortrox and Gina (4992/9249); monthly top-10 coins (1,000 / 500 / 250, first payout Nov 1);
  18 skins (Christmas until Dec 26, Money, Bowling, Rock Smash, Cracked Screen, Castle, Chocolate, Floppy Fish, Axe
  Thrower, Math, Supernova, Wood Carving, Shiny Diamond, Greek, DNA, Fairy Dust, Elemental, Divine Judgment) and 5
  wallpapers (Open Ocean, Summit, ASMR Bubbles, Windy Beach, Grand Prix). Wallpaper `idea` authors get no 5% (Sacha:
  no). Two diamond skins are fine (different names). 40 credited players answered; 54 done/refused ideas closed.
- **Economy (#23)**: Weekend Rush +25% (was ×2); daily roll-coin tiers (1–500 full, 501–2,000 50%, then 20%; Common
  rolls can pay 0 after roll 500); paid rename 5,000; Prestige titles (Tycoon 25k ×200, Magnate 60k ×100, Coin Emperor
  150k ×25); Owner → Economy tab (supply, top-1% share, casino net). Coins granted by the owner are logged as `in:owner`.
- **Global chat (#24, #26, #27)**: 100 rolls to write (no Google needed since #26), filters, reports, moderators,
  mutes; red unread dot on 💬 (peek every 30 s while closed).
- **Clans (#25)**: 10k to create, vault and upgrades (coins destroyed), clan chat, weekly title, 5v5 wars (3% cut).
  Page `#/clan` (not in the top menu). No Discord announcements for clans yet.
- **Google hint (#28)**: note under the Google button when a pop-up/ad blocker stops sign-in.
- **Server speed (#29, #30, #31)**: profiles read only new rolls once cached (100k-roll profiles took ~7.7 s and
  stalled everyone); profile totals of 2,000+ roll histories kept in Redis (`pagg:<id>`) across restarts; XP
  recalculation after badge changes runs in batches of 3 every 5 s in the background; Badges tab uses
  `/api/profile?lite=1` (fixes "Achievements unavailable"). Slow requests dropped from ~100+/min bursts to a few.
- **Checked, not bugs**: zscepz's +330k casino profit is luck (Plinko High risk 1000× / Dice); every coin-spending
  path is already serialized by the `shop:<id>` lock (no parallel-request exploit).
- **Left**: the History page of a big player still reads the whole history; clan Discord announcements; the global
  chat closes when changing page (Sacha to decide).

## Done recently (2026-10-20 → 2026-10-23)

- **Casino**: Tower (Hard: 3% edge, max bet 100), Keno (max 100), Dice and Teddy Roulette (97% RTP each).
- **Skins**: ASMR (natural crunch sound since 10-23), Blinds, Lab, Marshmallow, Sonic Wave, UFO, Wheelie, Polygon Donut,
  Cursed Energy; Preview button on every skin; 5% of each purchase goes to the player who had the idea (`idea` field).
- **Sound packs** in the Shop (Arcade, Coins, Drums, Space, Glass).
- **Tournaments** (10-23): two per day (32 players each, one per player); shared rolls: when a player rolls, the
  server rolls for the opponent too, and missing rolls are made for both at the end of a round. No forfeits anymore.
- **Badges** (10-22): American 1776, Angel Number 82 (+ Exact 82), Vortrox Curse 92 (+ Exact 92), Sixty-One, Juice WRLD
  (999 anywhere), Brainrot King (6741/4167), Brainrot Emperor (676741/674141). A duplicate "Error 404" was added and
  removed the same day. Old rolls that became Mythic+ were migrated (`tools/migrate-badges.js`, 214 players).
- **Titles**: King/God of Unemployment (1M/10M rolls), Button Masher, Emote Lord, Interior Designer.
- **Social**: edit your messages, images in friend chats (📷, paste, drag & drop), friends' presence, duel kick.
- **Owner inbox** reworked: compact list, filters (type, sort), next item opens after triage, no 200 limit.
- **Fixes**: Collectible Connoisseur no longer requires Classic; coins no longer reveal a good roll early; auto-roll
  no longer cut by Generate / Roll again; Wheelie rider visible; tooltips open on tap (iPad); duel chat and owner
  buttons after a player joins; Trash leaderboards rescored (`tools/rescore-worst.js`).
- **Idea Managers** (10-23): players Sacha picks (Owner page → Idea Managers tab) review ideas on `#/ideas` with a verdict and a mandatory reason (20+ characters, server-checked). They see nothing else; Sacha sees their reviews in the Inbox and decides.
- **Codes**: `EPITECH>42`, `SORRY404` (until Oct 29), `ICHI` (100 coins).

- **Clans** (2026-10-25, branch `claude/clans`, not merged; idea by BIGBOIJONER69 and KMC): `#/clan` (entry card on
  Profile & Friends), logic in `api/_clan.js` routed from `/api/friends` (`action: 'clan', op`). Create 10,000 coins
  (destroyed, `eco out:clans`), invite/request, roles, vault (donations 10–10,000, 10/hour, never paid back to players),
  upgrades (slots 20→40: 5k/10k/20k/40k; banner 2k; tag color 3k, rainbow 15k), clan chat (report → Reports, 10-min
  edit), weekly clan XP counted in `recordRoll` (`clanxp:<week>`), Clan Champion title settled once per week
  (`clanweek:done:<week>` NX), 5v5 wars (stake 100–50,000 from both vaults, 5 server rolls each over 6 h, shared rolls,
  3% cut destroyed, `paid` HSETNX). Tags (`clantag` hash) on leaderboards, profiles and duel seats. Audit scripts take
  `RNG_BASE` for another dev port. Not done: no nav tab (header width), no Discord announce, no war forfeits.
- **Global chat** (2026-10-25, branch `claude/global-chat`, not merged): 💬 corner button (bottom-right on desktop, bottom row
  on phones) opens a panel. Everyone reads; writing needs a linked Google account + 100 rolls. 1 message / 5 s, 200 chars,
  last 100 kept (`gc:msgs`). Server filter (`api/_global.js`, routed from `api/friends.js` actions `gc…`) rejects links,
  insults (the `_chat.js` list + spaced letters) and personal info (phone, e-mail, addresses, @handles, snap/insta/discord
  invitations). Report → Reports tab (`where: 'global chat'`). Owner + **Moderators** (Owner page → Chat tab, by name)
  delete and mute (1 h / 24 h / forever); the Chat tab lists mutes with Unmute (owner only). Polls every 3 s only while
  the panel is open and the tab visible (`same: true` when nothing changed). Decision: changing page closes the panel.
  Not done: clan tags (no `clanTag` helper exists yet); the filter is a list, so moderators remain necessary.
- **Economy (2026-10-25, branch `claude/economy`, not merged)**: Weekend Rush is +25% (was x2); roll coins have daily
  diminishing returns (rolls 1-500 full, 501-2,000 50%, then 20%; counter `rc:<day>:<id>`, withheld part in
  `stats.rollCut`, subtracted by `Shop.earned`); renaming costs 5,000 coins (first name free, case-only free; rolls and
  duels no longer rename); Shop > Prestige tab (Tycoon 25k x200, Magnate 60k x100, Coin Emperor 150k x25, hidden
  achievements from `pr:<id>`, stock in `prestige:sold`); Owner > Economy: total supply (SCAN `stats:*`, cached 10 min
  in `eco:supply`), top-1% share, casino net per day.

## To do, by priority

1. **Watch the new tournament rules** on the first full day (2026-10-24): two brackets fill, shared rolls appear
   ("🤖 rolled for you"), round-end fill happens once, prizes are paid for both tournaments.
2. **Best-roll leaderboards may be slightly stale** after badge rebuilds (same cause as the Trash fix: stored scores
   vs. current scores). Sacha has not decided yet whether to rescore them (it can move players down).
3. **Unconfirmed fix**: tapping Roll again during an auto-roll reveal on phones (jaxoncool43, kingston). Code fix is in;
   wait for player feedback.
4. **Open bug reports waiting for details**: Matthew (Equip of Gold does nothing, cannot reproduce), Tiller / tiler
   (shop on a Chromebook), Yentizx (duels; probably the old Vercel outage).
5. **Player ideas**: see the "Idea backlog" section below (triaged on 2026-10-23, players not answered yet).
6. **To discuss with Sacha before building**: see "To discuss" in the backlog.
7. Discord: the bot cannot read forum posts until "Message Content Intent" is enabled in the Discord developer
   portal (Sacha's account). Replies to Discord threads are posted by the RNG∞ bot.

## Idea backlog (triaged 2026-10-23)

Players have **not** been answered yet: Sacha replies once a thing ships (he credits the player in `UPDATES`).
The id in brackets is the suggestion id on the Owner page. One idea = one branch = one pull request.

### Yes: build these (rough priority)

**Badges** (quick; grep `js/engine.js` and `tools/source/*.json` first, then `node tools/build.mjs`, then
`tools/rescore-worst.js` on the server after deploy):
- ~~Plane numbers: contains 737, 747, 757, 767, 777 is taken (Jackpot), 787 → one family "Jet" (TibotyTWO [bee00d9ad046], CococoC [604a068a6275]).~~ Done by Drastix on `drastix/jet-badges` (PR, not merged yet).
- 727 "WYSI" (osu! meme), contains + exact (Phong254 [cbf3a830e791]).
- Ends in 250, "Quarter Millennium" (WpBejs [3c8e159b40ec]); fits next to QUARTER_CENTURY in `ENDS`.
- 142857, the cyclic number: exact, Godlike tier (JBearr12 [15430f4307b5]).
- Abundant numbers, Celestial-ish (JAKECisthebest [12119924aa11]): a CHECK in `CHECKS`, measure its frequency first.
- Exact 61 (schoolroller [0b360f91f13a]); Exact 55 (qwertyuiop [ebad7c189306]): same pattern as EXACT_82.
- 4992 / 9249 "Vortrox and Gina" and the GD numbers 554992… (CococoC [e1df4dbc83ca], [47675b79a768]): low priority, fun.

**Skins** (follow `.claude/skills/rng-skin-design`; each needs a material, a spin verb and a reveal beat):
- Rework **Infinity** to match Singularity (kaz [f221766d5b41]): most valuable, it is the rarest skin.
- Dynamite / bombs: explosions reveal the digits, mushroom clouds from Mythic (casmictechthing [c1b8d0692aaa], jjcoolcid1 [cbd62f5eb1af], jaxoncool43 [4c5860edfce5]).
- ~~Burger: each digit adds a topping (jaxoncool43 [89f54801e139]).~~ Done by Drastix on `drastix/burger-skin` (PR, not merged yet).
- Bowling: a ball knocks pins that reveal the digits (JBearr12 [3c6a579a405c], [fa910f1e244b]).
- Basketball: a ball drops in a hoop per digit (jjcoolcid1 [e937ad77450c]).
- ~~Wood carving: a knife carves each digit (jjcoolcid1 [ff005e13b704], JBearr12 [0fa76af413d3]).~~ ✅ Done on `claude/woodcarving-skin` (not merged yet; 2,000 coins, V-cut digits in a pine plank, `SCENES.woodcarving` shavings, gold varnish from Mythic).
- Shiny Diamond (finnnnn [719ff8538e67]) ✅ Done on `claude/diamond-skin` (id `shinydiamond`, not merged yet), Chocolate (finnnnn [89626248c340]), Coins/Money (finnnnn [2457889a6d20]).
- ~~Supernova: neon blue/purple with shockwaves (jjcoolcid1 [0f487aa749b5]).~~ ✅ Done on `claude/supernova-skin` (not merged yet).
- Floppy Fish: a goofy fish jumps per digit, a giant fish on Mythic+ (AnnJoe [47b7afc07c18]).
- ~~Greek: roman numerals spinning on a pillar (kaz [b1ba92122752])~~ ✅ Done on `claude/greek-skin`; Scroll of Alchemy (R77 [16886be362f8]); ~~DNA helix (R77 [4b77fa49c03e])~~ ✅ done on `claude/dna-skin`; ~~Fairy dust (R77 [d5a4ac437aae])~~ ✅ done on `claude/fairydust-skin` (all three merged in `claude/integration-2026-10-25`, not on main yet).
- Construction crane (yukitsunodaiscool [f727644461a7]), Mini golf (Kj13 [f42cca32bbe2]), Origami / Graffiti (JBearr12 [80a769fdea4c]), Beach, Safari, Space (dylanbuckleyisjewish).
- Elemental legendary (rock → ice → fire → wind as digits land) (kaz [c51ae4e06e9d], [e680a2e9f98e]). ✅ Done on `claude/elemental-skin` (not merged yet).

**Wallpapers** (`js/shop.js` WALLPAPERS + `css/style.css` `.wp-<id>`):
- Underwater legendary with whales and dolphins (AnnJoe [4a54d5b3ada2]).
- F1 race track (YU CHUAN 23 [3c1460493ede]).
- ASMR bubbles you can pop by clicking (kingston [ed5d1985429b]).
- Aether: a glowing ball that always follows the trail, faster on better rolls (Angelicide9 [e4fb4bb75a32]).

**Features**:
- ~~Sort History by how many times a number was rolled (CococoC [7ffd06d8ff64]).~~ Done by Drastix on `drastix/history-sort-count` (PR, not merged yet): sort "Most rolled" in History.
- XP checker: compare two numbers you have not rolled (CrazyMiner22 [0cdfcaf764db]); the Compare panel already exists.
- Session roll streak ("rolls this sitting") on the home screen or Stats (kingston [5834fea93493]).
- Attach several images to an idea or bug report (Phong254 [6a25a130793b], R77 [272d6affd0bf]); reuse `shrinkImage` and the `sugg:<id>:shot` storage.
- Duel: type your own XP goal instead of the presets (Juju6995 [8ff90356809f]); keep the server caps in `api/room.js`.
- New emote "money spread" (finnnnn [9044fe933f8b]).
- More music: Phong254 made a casino track [341f63d6b70b] (ask Sacha for the file; music lives in `media/music/`, 3% volume).

### To discuss with Sacha first

- A button case and a second premium skin case (shadow2 [87cc95d84437], [66e370a5539a], shadow2 Jr [ff41d8857b11]).
- Cursed Energy in the Elite case (Lewis6767 [413dd18cabec]).
- Spin-the-wheel casino game (max 250×; must keep a house edge) (How yz got sticky [9679a84cee55], Gray [06f56f10e214]); poker / craps (Yentizx, Roanono, JBearr12).
- Playing the casino while a roll animates (jaxoncool43 [705caeb0b914]).
- Leaderboards by play time or by number of rolls (AnnJoe [0b9083cb6c34], WpBejs [5f30bc1bd0fe]).
- Profile avatars (kingston [96a17679d210], JAKECisthebest [b032493e43e3]): moderation risk if uploaded; a set of pre-made avatars would be safe.
- A message notification dot on a corner button (JAKECisthebest [6facc867183d]).
- Reversed rare numbers giving a share of the XP (CrazyMiner22 [73754a765b05]): changes scoring, probably no.
- Exact 2137 (Phong254 [e1f371cd9c2c]): it is a meme about a pope's death time, probably no.

### No (already decided; do not build)

- Luck or coin potions, paid speed, multi-rolls (I like cum [80df82ba4b9b], logannn, Marcoooo…).
- Free rarities or coins on request (poopy bean baby 2x [054f107612e8], [7c4de6007a63], colt [1ae96b88bf2d]).
- Removing the gift limit (JAKECisthebest [b4560c0a61b1]).
- Uploading your own background image, even paid (logannn [3a42860f42ac]): cannot be moderated.
- Changing the odds or tiers after the fact (Infinite rarer, rainbow rarity variants, new rarities) (Har [d4b8955ef239], Angelicide6).
- Brands and characters: Jujutsu Kaisen techniques (R77 [272d6affd0bf]), Angry Birds, anime, guns (jaxoncool43 [e7a0b245c12e]), "carnival robotic horse" (KMC).
- Slots odds higher (Annjoe soon no1 [4811c026f80e]): the house edge stays.
- Exact 4 "security key" (Nero [25d9088c5496]), 12 months (ichi): too arbitrary.

### Already in the game (just needs a reply)

- Exact 47 / contains 47 (R77), Area 51 (hii), 456 (pilot56), Juice WRLD 999 (CrazyMiner22 [9bb12fedcf66] asked for 999,999: tell him 999 anywhere counts),
  contains-your-best-roll note (spookiedookie), shop previews (kingston, JAKECisthebest), friends' online status (kingston),
  daily rewards and quest streaks (LwsBoi, JohnLawrence, Marcoooo), hidden codes (PRISMA123), contributor titles
  (JBearr12: Contributor and Bug Hunter), skip known badges (TetoEnthusiast, MayonnaiseGmdGmd), XP checker (MyInternetNoWork),
  ideas author share (Gray alt: done at 5%).


### Every other open thread (so nothing is lost)

**Yes, more skins and wallpapers** (same rules as above):
- Metal-ball launcher breaking crates (jjcoolcid1 [4bf26afedcb9]; original-style version of his Angry Birds idea [2b073a551ccc], no birds).
- Stick man throwing axes (jjcoolcid1 [9e4d04f5b906]); also asked on Discord as a legendary.
- Waterfall pushing digits down (jjcoolcid1 [9d0b104252d4]); Hell with a pitchfork (jjcoolcid1 [46debbb33cb5], close to Hellborn: make it a variant or skip);
  black hole that swallows digits after each roll (jjcoolcid1 [e91629641d04], close to Black Hole: check first).
- Grass block (finnnnn [a841d12aea44]: close to Blocks, check first), rainbow painting (finnnnn [7f9507fe5e51]), deep ocean / bloop (finnnnn [0555093cf3b9]),
  obsidian "really strong" (finnnnn [7ac4a115abd4]), pickle (Dylanrulez123 [9b7bd2fd3aa4]).
- Barn with horses and hay (R77 [988dcd01c381]).
- Themes from dylanbuckleyisjewish: sports [8545cb3680cd], elemental [28fa71e7e07e] (merge with kaz's Elemental), space [19d44247eb7a], safari [49cc5dc9dfbc], American [2934d6bbe771], beach [a568c292ff53].
- Legendary skins from Gray alt: Unlimited Void [2a351387801c] (rename: the name is from Jujutsu Kaisen), Divine Judgment [917364bbc5dd].
- A skin paired with AnnJoe's aqua wallpaper [b4b16921441d] (do it with the underwater wallpaper).
- A board / frame skin around the number (daddy finger [5561e1e54259]): Buttons and Wallpapers partly cover it; a "card frame" category could be new.
- More music (shadow2 [d8def15e8470]): Phong254's casino track first.

**Yes, small features or badges**:
- Badges: exact 1987 (costoroll [11ad72757353]), 360 "Nailed it" (CococoC [a8da12a374dc]), 069420 (WormAttack [5a9f6a7eac92]: check ULTIMEME_EXACT covers 69420).
- "Against All Odds": a Rare after a long dry streak (Gray [875834a239f7]), as an achievement (the server already tracks streaks without a Rare in Stats).
- Badge filter "not unlocked yet" with hints, in the Badges page (kingston [c3ad9bec2887], [e874cbd1ce72]).
- Rewards for the monthly leaderboard top 10 (LwsBoi [58ee3ff2c7a9], Marcoooo_seeva [e37d6a0076c9]): Top 1/5/10 badges exist (`api/_rank.js`); coins on top could be added.
- Today's date as a bonus badge (kingston [edb200fb5ddc]): a "Today" badge for numbers that contain today's DDMMYY; it changes every day, so it cannot be in the static engine: discuss.
- Casino mastery levels (JBearr12 [94c8c484ddcd]): discuss (it rewards gambling volume).
- Faster XP count-up (Colt2 [4ede287e3458]): the speed setting exists; check the count-up duration.
- Duel layout: no scrolling to reroll in big games, team score under the Roll button (Calurion [b9b71c05dd53], LeSombre [eb104d9b4e3f]); mobile game modes in a dropdown (AiziX69 [ed9b79fb0372]).
- Daily shop with rotating skins (Rngroller123 [fa22f0bceabb]): discuss (it is a sales mechanic).
- Coin pusher machine in the casino (Calurion [002b51663509]): discuss with the other casino games.
- A fake "download" button in the Shop as a joke (Yentizx [4fdfd15538e5]): fun, cheap, Sacha's call.

**No**:
- Favourite-number badges for Sacha or a player (pilot56 [849db156f7d5], JAKECisthebest [6ae8dc57245b]): personal badges stay rare (Drastix is the exception).
- "12 months", "7 for a week" (ichi [c7a05ad0313e], [d5d218353c9a]); 5,000 XP Mythic badge under 100,000 (JAKECisthebest [f019893d9e8c]): unclear or arbitrary.
- 000000 worth the most (Deadshot [f7e536f658d7]): every number has the same chance; scoring is by badges.
- New rarities or rarity badges (Angelicide6 [7417cc644423], [08184af563d5], [2e15d61e5c2f]); worse luck (casmictechthing [3b8a4f01c88c]); "give me luck" (senny [d19f95173caf]).
- Infinite numbers rarer (PRISMA123 [9497b7b16ec3]); free codes (casmictechthing [2a94751eed96]); coin exception (Gray alt [64f373972bce]).
- Casino winner/loser badges (Ann Joe [d39c41a137fe]: Sacha already said no). Back win bonuses in duels (Deadshot [1af644f8e5e7]): coins from duels are balanced as they are.
- Gray helping to answer messages (Gray [66f92472c9c3]): only Sacha answers players.
- Carnival robot horse (KMC [93f869da718a]): a reference we should not copy.
- A native app (yukitsunodaiscool [5a46abe09659], JBearr12 [adb7502f381f]): the site works on phones; "Add to home screen" could be explained instead.
- Username + password sign-up (JAKECisthebest [bd8d684ab5ec]): Google sign-in exists (and a password option in `api/auth.js`).
- Crypto trading (Sacha [abc59d7f67c4]): already in the casino (Crypto tab).

**Already in the game or answered** (reply or close):
- 456 (pilot56 [b5ad628f87f5]), AK-47 (R77 [89a8328bd5cd]), Area 51 (hii [91d5106b916c]), Juice WRLD (Colt2 [98e5afc76f4b]: he was told "Triple Nine" in the past; Sacha decides), Error 404 (Gray [91823035e545]: existed already),
  852655 (CococoC [f9bb8feb116e]: added), contains-your-best-roll (spookiedookie [648d02967bd6]), more upgrades / levels (pilot56 [047434a2b070], shadow2 Jr [cd51401971f5]: levels with rewards exist),
  shop previews (JAKECisthebest [9c59584e02db]), live rare rolls and friends' status (kingston [e88dc3264aaa]), daily rewards (JohnLawrence [36011b657174], LwsBoi [0c5f9cc92bd5], Marcoooo_seeva [aa27e5864db5]),
  contributor titles (JBearr12 [67a9be36c2a5]), hidden codes (PRISMA123 [77daffe9be04]), skip badges / skip after 1k rolls (TetoEnthusiast [8387c2745e3a], MayonnaiseGmdGmd [6086246b9f20]),
  XP preview (MyInternetNoWork [03b8d35f70f7]), more gambling (Lewis6767 [dd3f00a3cbf5]: 10 casino games now), poker (Yentizx [c88e9dae282d], Roanono [28d4a65877c4]: in "To discuss"),
  craps and blackjack lobbies (JBearr12 [f017e780fb7f]: in "To discuss"), stats page (PRISMA123 [3a7197db97cb]: Stats tab exists; Coin Millionaire bug fixed), skin-idea share (Gray alt [5c543bf658bb]: done at 5%),
  more skins (leo [2034c6d8e60f]), 8686 (WpBejs [333c9af2ead8]: "we have it"), better rolls give more coins (schoolroller [700ba5a4abdf]: already true),
  how coins work (Roanono [b2ac31534003]: the Shop explains it), CONSOLECAT (Gray [ea0e27f2fd49]: a hidden code, 1 per player).

**Not ideas** (reports, thanks, chat; close them):
- Cheating suspicions about two accounts with 100k+ casino wins (Gray alt [fb94d3be72b1], number 1 [5ff9b34f79c7]) and a "hacker" name (casmictechthing [71a80f2f76af]): Sacha checked the casino; close.
- Thanks and chat: YU CHUAN 23 [cc03e936020f], [8169c7959d78], kingston [5e186aa0cf21], Marcoooo_seeva [353de3628c73], [08d5e19b0bf8], MereTera [21bd3aedfe86], MAYO [3f051de125d9], Avaneesh_The_Goat [bf0ded48c981], casmictechthing [e268fb31b28e].

## Work batch for the second contributor (2026-10-24)

Built from the Idea Manager reviews (254 ideas reviewed) and Sacha's rules. Do them **in this order**, one branch and
one pull request per item (or per small group of badges). Credit the players in `UPDATES` (`(idea by X)`).
Ids in brackets are suggestion ids; Sacha answers the players after merging.

### A. Quick wins (badges and small features)
1. Badges "Jet" (contains 737, 747, 757, 767, 787; 777 is Jackpot) (TibotyTWO [bee00d9ad046], CococoC [604a068a6275]).
2. Badges: ends in 250 "Quarter Millennium" (WpBejs [3c8e159b40ec]); contains 99 "Ninety-Nine" + Exact 99 (kaz [4d50fddccb81]); 727 "WYSI" (Phong254 [cbf3a830e791]); exact 142857 (JBearr12 [15430f4307b5]). Grep first: no duplicates. ✅ Done by Drastix on `drastix/badges-250-99-727-142857` (PR, not merged yet).
3. Show the coins earned by a roll next to its XP on the result screen (jaxoncool43 [505eebd5889c]). The coins per rarity are in `Shop.COINS`.
2. Badges: ends in 250 "Quarter Millennium" (WpBejs [3c8e159b40ec]); contains 99 "Ninety-Nine" + Exact 99 (kaz [4d50fddccb81]); 727 "WYSI" (Phong254 [cbf3a830e791]); exact 142857 (JBearr12 [15430f4307b5]). Grep first: no duplicates.
3. Show the coins earned by a roll next to its XP on the result screen (jaxoncool43 [505eebd5889c]). The coins per rarity are in `Shop.COINS`. ✅ Done by Drastix on `drastix/result-coins` (PR, not merged yet): `/api/roll` now returns `coins` (Weekend Rush included).
4. Let players reorder the casino game tabs (drag or arrows), saved in `Store.settings` (jia jun [f0aeec582de9]).
4. Let players reorder the casino game tabs (drag or arrows), saved in `Store.settings` (jia jun [f0aeec582de9]). ✅ Done by Drastix on `drastix/casino-tab-order` (PR, not merged yet).
5. Monthly leaderboard rewards: coins for the top 10 of the month, paid once on the 1st like the Trash King (`api/_discord_tasks.js`, `api/_rank.js`) (furcoat0 [efecba4e19e6], LwsBoi [58ee3ff2c7a9]). Keep amounts modest (ask Sacha: suggest 1,000 / 500 / 250).
6. Sort History by how many times a number was rolled (CococoC [7ffd06d8ff64]).
7. Attach up to 3 images to an idea or bug report (Phong254 [6a25a130793b]). ✅ Done by Drastix on `drastix/idea-images` (PR, not merged yet).
8. Emote "money spread" (finnnnn [9044fe933f8b]).
7. Attach up to 3 images to an idea or bug report (Phong254 [6a25a130793b]).
8. Emote "money spread" (finnnnn [9044fe933f8b]). ✅ Done by Drastix on `drastix/emote-money-spread` (PR, not merged yet).

### B. Skins (follow `.claude/skills/rng-skin-design`, film them, put the preview in the PR)
9. Rework **Infinity** so it matches Singularity (kaz [f221766d5b41]) — first, it is the rarest skin. ✅ Done by Drastix on `drastix/infinity-rework` (PR, not merged yet).
10. Burger (jaxoncool43 [be2e597cbe99]).
11. Dynamite / TNT: explosions reveal the digits, mushroom clouds from Mythic (casmictechthing [c1b8d0692aaa], ichi [bac7cdca55c8]). ✅ Done by Drastix on `drastix/dynamite-skin` (PR, not merged yet; cartoon dynamite sticks, no "TNT" block).
12. Waterfall with a nature backdrop (JBearr12 [532fd4c22dda], jjcoolcid1 [9d0b104252d4]).
11. Dynamite / TNT: explosions reveal the digits, mushroom clouds from Mythic (casmictechthing [c1b8d0692aaa], ichi [bac7cdca55c8]).
12. Waterfall with a nature backdrop (JBearr12 [532fd4c22dda], jjcoolcid1 [9d0b104252d4]). ✅ Done by Drastix on `drastix/waterfall-skin` (PR, not merged yet).
13. Money: a 100-dollar bill with gold digits that melt on Mythic+ (JBearr12 [c512cd0b2fa2]) and coins (finnnnn [2457889a6d20]): one skin.
14. Bowling (JBearr12 [fa910f1e244b]), Basketball (jjcoolcid1 [e937ad77450c]), Mini golf (Kj13 [f42cca32bbe2]): pick one sport first.
15. Rock smash: a fist smashes a rock to reveal the digit (HSI [5b5f29b0cc52]); Cracked screen (KMC [a677e62ae02d]); Medieval castle (BIGBOIJONER69 [c10d8e68d556]); Chocolate (finnnnn [89626248c340]); Floppy Fish (AnnJoe [47b7afc07c18]); Stick man with axes (jjcoolcid1 [9e4d04f5b906]); Metal balls breaking crates (jjcoolcid1 [4bf26afedcb9]); Math symbols (sennybex1 [359f2e6f81a9]).
16. Legendary: **Christmas** (six presents that pop open, two trees, red and green lights) (JBearr12 [238c54c3daf9], Angelicide9 [1d43563c63f7]) — should ship before December as a limited skin (`until`); Divine Judgment (Gray alt [917364bbc5dd]) ✅ done on `claude/divinejudgment-skin` (not merged yet).

### C. Wallpapers (`js/shop.js` WALLPAPERS, `css/style.css` `.wp-<id>`)
17. Underwater legendary with moving whales, sharks and dolphins (AnnJoe [cfc8a027d2a2], [4a54d5b3ada2]).
18. Mountain with the sun, and the moon rising on Mythic+ (JBearr12 [9ba43f2987c5]).
19. ASMR bubbles you can pop by clicking (kingston [ed5d1985429b]).
20. Windy beach with an umbrella (17black [85d47bbec419]: he offered to animate it; ask Sacha before using outside art).

### D. Ask Sacha before starting (the managers said yes, but each changes the game a lot)
- Clans and clan battles (BIGBOIJONER69 [a17b96727ae9], KMC [85dda2459b20]).
- Poker with friends (jaxoncool43 [e1547b646b5d], Roanono [28d4a65877c4]); F1 race betting (whywhywaylon [d10d0a3b344f]); chicken-crossing game (ANN JOE KAKAK SEXY [c14ecabadf1b]); multiplier wheel (Gray [06f56f10e214]). Every casino game must keep a house edge (`tools/casino-sim.mjs`, `tools/house-audit.mjs`).
- Dogecoin in the Crypto tab (Aussie Haüs [cf7dce1e6e3e]): uses the real price, like BTC and ETH.
- Group chats (furcoat0 [761f12575219]); preset avatars, no uploads (kingston [96a17679d210]).
- A public roadmap page of accepted ideas (Phong67 [90bacc79d264]).
- Auto-roll that keeps going on other pages of the site (kaz [ef720ee8447d]); playing the casino while a roll animates (jaxoncool43 [705caeb0b914]).
- Daily shop, today's-date badge, Against All Odds achievement (see the backlog above).

### E. Do not build, even if a manager said yes
- Ironman or any brand or character (finnnnn [9cd670c54c89]); uploading your own background image (logannn [3a42860f42ac]); a native app (yukitsunodaiscool, JBearr12).
- Badges for dead athletes' numbers (pilot56 [4a9c8d8e156e]): sensitive.
- Biggest winner / loser badges (Ann Joe [d39c41a137fe]): Sacha already said no.
- Follow button (randomguy [402d5f6e7966]): Sacha said "later".
- Friend requests asked in an idea (YU CHUAN 23 [8169c7959d78]): not an idea.

## Decisions and why

- **Everything on the VPS** (2026-10-22): Vercel paused the team for CPU; Sacha cannot pay Pro every month.
- **No luck or speed for sale, no free coins**: fairness; kids notice and complain fast, and the economy breaks.
- **Tournament shared rolls**: many players cannot be online all day; rolls are random anyway, so rolling for an
  absent player is fair and removes forfeits.
- **Two tournaments instead of a bigger bracket**: 32 players already means 5 rounds in 12 hours.
- **Evening tournament** (2026-10-26, asked by Me Cojoni and "Idea:Tournaments"): a third daily tournament (`<date>-e`),
  sign-ups 12:00-18:00 UTC, rounds 18:00 -> 06:00 UTC next day, same mode and prizes, own bracket and payout. It is
  separate from tournaments 1/2: a player may be in one of them AND in the evening one (`which: 3` on join/roll/view).
  The "never in both" rule only applies between 1 and 2.
- **5% to idea authors** (not 10%): rewards ideas without inflating coins much; coins are created, the buyer pays the
  normal price.
- **Badge changes never take earned rewards away**, but upgrades can be migrated (only Mythic+ upgrades were, to keep
  the economy stable: ~140,000 coins over 214 players on 2026-10-23).
- **Owner-only features are never in the public update log.**

## Bugs in progress

- None known to be broken right now. See "Open bug reports" above.
- `node tools/build.mjs` reports **93/96** real rolls (13, 25111, 679999 are each 699 XP short), already on `main` at
  e2a76c2 before any Jet change: one of the recent custom badges probably counts on numbers of the original
  leaderboard. Not investigated yet (found by Drastix, 2026-10-23).

## Session log

<!-- Add one line per session: date, who, branch, what changed, what is left. -->
- 2026-10-23 · Sacha · main · repo prepared for two people (CLAUDE.md, HANDOFF.md, skills, audits in tools/audit).
- 2026-10-23 · Drastix · drastix/history-sort-count · History: new sort "Most rolled" (count desc, same numbers grouped, newest first inside a group), FR string, `UPDATES` entry crediting CococoC (date to adjust at merge). Left: Sacha merges, deploys and replies to CococoC. Notes for Windows: set `git config core.autocrlf false` in the clone (see lessons.md: CRLF changes every `stamp.mjs` hash); Playwright Firefox does not start on Drastix's PC (Windows Insider 26300, "mozglue" side-by-side error) while Chromium works, so the audits that hardcode `firefox.launch` cannot run there yet.
- 2026-10-23 · Drastix · drastix/jet-badges · Jet family: JET_737, Jumbo Jet (747), JET_757, JET_767, JET_787 (contains, 25,737–25,787 XP, family JET so only the best one scores; 777 stays Jackpot; no "Boeing" in names). `build.mjs` rerun: 55,782 numbers change tier (18,325 up, 37,457 down). Left for Sacha after merge: deploy, `tools/rescore-worst.js --apply` on the server, reply to TibotyTWO and CococoC.
- 2026-10-23 · Drastix · drastix/burger-skin · Burger skin (1,700 coins, idea by jaxoncool43): six ingredients drop one per digit (CSS), the top bun is lifted while `.charging` and slams down when it is removed (CSS transition, so nothing replays on cards already shown), `SCENES.burger` throws crumbs and sesame on each digit and on the bun landing, steam on the reveal (sesame shower from Mythic). Roll button `gen-burger`, duel frame `side-burger`, FR description, `UPDATES` entry. `js/skinfx.js` now passes `env.el` (the card) to scenes. `tools/skin-preview.mjs`: runs on Windows, `PW_BROWSER=chromium` option, new row "Fin du tirage" (card transitions when `.charging` goes). Previews in `docs/skins/`. Left: Sacha merges, deploys, replies to jaxoncool43. The layout audits in `tools/audit/` were not run (Firefox only; they do not start on Drastix's PC): shop width checked by hand at 320–414 px.
