# RNG∞

A random number game with **no daily limit**, inspired by [rngdle.com](https://www.rngdle.com/).
Each roll gives a number between 0 and 1,000,000, scored by the original game's 233 badges (palindromes, primes, sequences, meme numbers…) that award XP,
plus custom badges defined in `tools/source/custom.json` — currently **Drastix** 💥: the number contains "235", 25,000 XP.

**[Play →](https://rng-infinite.com/)** (with the online leaderboard)

![Roll screen](docs/apercu.png)

## What it adds to the original

- Unlimited rolls (press **Space** to roll again); as in the original, neither the digits nor the badges can be skipped
- Full **history**: search by number or badge, filter by rarity, sort by XP
- **Stats**: rarity distribution vs. expected odds, XP per roll, digit frequency, streaks without a Rare
- **Collection** of all 233 badges with a counter, first roll and odds for each badge
- Previously rolled numbers are flagged, new badges are marked **NEW**
- Online **leaderboard** with clickable **player profiles** (best rolls and badge collection of each friend), and a full **side-by-side comparison** with yours
- **Achievements and titles**: 21 achievements (Mythic, Daily King, Flawless, Drastix Fan…) checked by the server; equip one and its title shows next to your name on the leaderboard, your profile and in duels
- **Skins and coins**: earn coins by rolling (by rarity) and by winning duels, and buy skins that change how your number looks (Neon, LCD, Pixel, Jersey, Slots, Scoreboard, Dice, Chrome, Gold, Matrix, Fire, Galaxy, Rainbow), on your rolls and on your cards in duels. In-game coins only
- **Generate button skins**: the button that rolls takes the look of your equipped skin (a neon sign, a gold ingot, a grass block to mine…). You can also wear the button of any skin you own, or one of 8 buttons sold on their own (keycap, terminal, arcade button, raffle ticket…). Only you see your button; suggested by a player through the in-game suggestion box
- **Legendary skins**: Sakura, Storm, Dragon and Singularity each come with a full animated signature around the number (a branch that blooms digit by digit, a storm that strikes each digit, a dragon that circles the card and coils beside it, an accretion disc that collapses into two jets). Every skin can be previewed in the shop before buying, and every skin's sequence also plays in duels
- **Special emotes**: eight animated emotes (GG, Zzz, Phew, Love, Rage, Clown, Rich, Mind blown), drawn in SVG, bought once with coins and added to your reaction bar in duels
- **Duel chat**: players in a duel can chat in free text; messages are filtered on the server (insults, links, long numbers), rate limited, and any player can be hidden
- **Gamble**: roulette (single zero) and blackjack played with in-game coins only, drawn on the server; bets from 10 to 1,000 coins, unlocked after 30 rolls. Coins cannot be bought or cashed out
- **Bots**: play a duel against 1 to 9 bots right away, or fill empty seats with bots. They are always ready, get a random skin and react after each round. Bot games count your rolls as usual but not duel wins, rivalries or duel achievements, so they cannot be farmed
- **Rivalries**: every profile shows duel wins, win rate, most played rivals and your head-to-head record
- **Live duels** (Duel tab) for 2 to 10 players with a 5-character code: everyone rolls at the same time and all numbers are revealed together, digit by digit. Each round goes to the highest roll; win by being first to 1–10 round wins, or first to an XP total (25K to 1M). The host can start before the room is full, a round starts by itself 15 s after the first player is ready, live emote reactions (an original dice mascot that laughs, cries, rages, plays it cool, gasps or crowns itself) pop over the cards, and rematch is one click. Duel rolls are normal server rolls, so they stay in your history and can make the leaderboard
- **Sound**: the reels tick while they spin, each digit lands on a note one step higher than the last, each badge rings, and the
  rarity gets its own impact, from a dull thud for a Trash roll to the full chord of a Mythic; duels sound too, more quietly.
  No audio files: the browser computes every sound with the same synthesizer as the trailer's soundtrack. The speaker in the top
  bar, or Sound in Player & settings, turns it off
- JSON export/import of the history, 3 badge reveal speeds, light/dark theme

## Faithful to the original game

The engine (`js/engine.js`) is a rewrite, validated by `tools/build.mjs`:

1. all 1,000,001 possible numbers are analyzed, and each badge's score is derived from its actual frequency
   (`100 × 1,000,001 / number of matching numbers`); it must equal the reference score → **233/233**
2. the XP totals of 96 real rolls taken from the original leaderboard must match exactly → **96/96**

The percentile table (card rarity, "TOP x %") is computed from the same enumeration.

A Roblox version of the game, with the same Luau-ported engine, lives in [`roblox/`](roblox/).

## Run locally

Static site, no dependencies:

```bash
python3 -m http.server 8123
```

Regenerate the data after changing the engine:

```bash
node tools/build.mjs
```

Before each commit, version the CSS/JS files to bust the GitHub Pages cache:

```bash
node tools/stamp.mjs
```

Test the leaderboard functions against an in-memory Redis:

```bash
node tools/test-api.mjs
```

Run the site together with the API and an in-memory database (no account needed) on http://localhost:8124:

```bash
node tools/dev.mjs
```

Check the roll sounds (with `tools/dev.mjs` running): real rolls in a muted browser, every sound logged against the reveal's
timing, the audio output recorded, checked for clipping and compared with the trailer's mix:

```bash
node tools/sound-check.mjs
```

## Trailer

`trailer/` is a code-driven trailer in 16:9 and 9:16 at 60 fps: a 30 s film, plus 15 s and 6 s cut-downs. One function of time draws
every frame on top of the game's own styles and engine, so every number, badge, rarity and XP total on screen is real.

- The 30 s film is on the site: **Watch the trailer** on the home page and on the How it works page opens it (`media/`, loaded
  only on click; phones held upright get the 9:16 file)
- The edit sits on a 120 BPM grid (one beat = 0.5 s): digit locks, skin changes and scene changes land on beats, the key moments
  on bar downbeats, so any 120 BPM track drops straight in
- Watch it in a browser: serve the repo (`python3 -m http.server 8123`) and open `/trailer/` (`?format=v` for 9:16, `?cut=15` or
  `?cut=6` for the cut-downs)
- Quick render (Playwright with the system Chrome, plus ffmpeg): `node tools/trailer-render.mjs` → `trailer/out/`
- Final render: `node tools/trailer-render.mjs --pro` (add `--cut 15` or `--cut 6`) adds real motion blur (16 sub-frames per
  frame, averaged in linear light), a fine grain against banding in dark gradients, and the soundtrack, using 6 browsers in parallel
- The soundtrack is synthesized by `tools/trailer-audio.mjs` from the cue list and the score the trailer exposes (every digit
  lock, impact and skin change, plus one chord and intensity per bar), so sound and picture share the same timestamps; no
  samples, no licensed music. Its instruments live in `js/synth.js`, which the game also uses for its roll sounds (`js/sound.js`).
  `variants/` gets an effects-only mix (to lay another track under it), a silent copy and a light copy
- Every render is checked for stutter: a frame-by-frame motion measure flags any moment where the picture freezes in the
  middle of a movement

## Online leaderboard

Hosted on Vercel, deployed on every push to `main`.

- `POST /api/roll`: the **server draws the number**, so nobody can pick their own 1337. It scores the roll with the same engine as the site and keeps each player's best roll for the day, the week and all time.
- `GET /api/leaderboard?period=day|week|all`: top 50, plus the caller's own rank and the number of rolls today.
- `POST /api/auth`: **Sign in with Google** (Google Identity Services). The server checks the ID token against Google's public keys, links the Google account to a player and gives each device its own secret, so the same account gets the same player on every device. Only the Google account ID is stored, never the email ([privacy policy](https://rng-infinite.com/privacy.html)).
- **Anti-cheat**: numbers are always drawn by the server; new players' achievement counters start verified, so a device can no longer push fake rolls into the history (only players from before the achievements, once); a duel round waits for a ready player's 8 s cooldown, so parallel games cannot multiply rolls; names are limited to Latin letters, digits, spaces and `_ . - '` (no look-alike names); an in-memory per-IP limit (300 requests/minute) stops floods before they reach the database.
- `POST /api/history`: the player's full roll history, so history, stats and badges follow a Google account on every device. Online rolls are added by `/api/roll`; on sign-in each device uploads the rolls only it had, and downloads the rest. Signing out only clears the device once every roll is confirmed on the account.
- `GET /api/profile?name=`: a player's **public profile**, opened by clicking a name on the leaderboard: 10 best rolls, badge collection, roll count, lifetime XP and all-time rank, computed from their history. Players without Google also upload their local rolls for it. Player ids and the full history never leave the server.
- `GET /api/shop?me=` / `POST /api/shop` (`buy`, `equip`, `case`, `button`, `buybutton`): coins are computed from the server-side counters minus what was spent, with a per-player lock against double spending.
- `POST /api/title`: equip the title of an unlocked achievement (or none). Achievements are read from server-side counters (`stats:<id>`, `badges:<id>`) updated by every server roll and duel result, rebuilt once from the history for older players, so a title cannot be claimed without being earned.
- `POST /api/room` (`create`, `join`, `start`, `ready`, `react`, `rematch`), `GET /api/room?code=` and `GET /api/room?live=1` (public games active in the last 10 minutes): live duel rooms for 2 to 10 players, in `rounds` or `xp` mode. When everyone is ready, or 15 s after the first player is, one request (a per-round lock) draws every player's number at once and records them like normal rolls; the round carries a shared `revealAt` 2.5 s later, and each client aligns its clock on the server's (fastest round trip, NTP-style) so both reveals start together. Clients poll every 1.5 s while the tab is visible; rounds are at least 8 s apart; rooms expire after a day.
- Storage: Upstash Redis (Vercel Marketplace, free plan), one sorted set per period.
- Since rolls are unlimited, players are ranked by their **best single roll**, not by total XP.
- Each browser gets a random player id and a secret; only the holder of the secret can roll under that id. An 8 s cooldown matches the length of a reveal.
- Days reset at midnight UTC, like the original. If the server can't be reached, the roll still happens locally but doesn't count.

## License

[MIT](LICENSE)
