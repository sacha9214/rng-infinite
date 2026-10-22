# Handoff — RNG∞

Last updated: 2026-10-23 by Sacha (with Claude). Update this file at the end of every session.

## Current state

The game is live on https://rng-infinite.com, served by the OVH VPS (Caddy + Node API + Redis). Vercel only keeps the
domain's DNS (Vercel Pro was cancelled; the Hobby team was paused once for CPU overuse, which is why everything moved
to the VPS on 2026-10-22). About a hundred player ideas and bug reports arrive every day through the 💡 button;
Sacha triages them on the Owner page (`#/owner`, Inbox tab) and answers each one.

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
- **Codes**: `EPITECH>42`, `SORRY404` (until Oct 29), `ICHI` (100 coins).

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
- Plane numbers: contains 737, 747, 757, 767, 777 is taken (Jackpot), 787 → one family "Jet" (TibotyTWO [bee00d9ad046], CococoC [604a068a6275]).
- 727 "WYSI" (osu! meme), contains + exact (Phong254 [cbf3a830e791]).
- Ends in 250, "Quarter Millennium" (WpBejs [3c8e159b40ec]); fits next to QUARTER_CENTURY in `ENDS`.
- 142857, the cyclic number: exact, Godlike tier (JBearr12 [15430f4307b5]).
- Abundant numbers, Celestial-ish (JAKECisthebest [12119924aa11]): a CHECK in `CHECKS`, measure its frequency first.
- Exact 61 (schoolroller [0b360f91f13a]); Exact 55 (qwertyuiop [ebad7c189306]): same pattern as EXACT_82.
- 4992 / 9249 "Vortrox and Gina" and the GD numbers 554992… (CococoC [e1df4dbc83ca], [47675b79a768]): low priority, fun.

**Skins** (follow `.claude/skills/rng-skin-design`; each needs a material, a spin verb and a reveal beat):
- Rework **Infinity** to match Singularity (kaz [f221766d5b41]): most valuable, it is the rarest skin.
- Dynamite / bombs: explosions reveal the digits, mushroom clouds from Mythic (casmictechthing [c1b8d0692aaa], jjcoolcid1 [cbd62f5eb1af], jaxoncool43 [4c5860edfce5]).
- Burger: each digit adds a topping (jaxoncool43 [89f54801e139]).
- Bowling: a ball knocks pins that reveal the digits (JBearr12 [3c6a579a405c], [fa910f1e244b]).
- Basketball: a ball drops in a hoop per digit (jjcoolcid1 [e937ad77450c]).
- Wood carving: a knife carves each digit (jjcoolcid1 [ff005e13b704], JBearr12 [0fa76af413d3]).
- Shiny Diamond (finnnnn [719ff8538e67]), Chocolate (finnnnn [89626248c340]), Coins/Money (finnnnn [2457889a6d20]).
- Supernova: neon blue/purple with shockwaves (jjcoolcid1 [0f487aa749b5]).
- Floppy Fish: a goofy fish jumps per digit, a giant fish on Mythic+ (AnnJoe [47b7afc07c18]).
- Greek: roman numerals spinning on a pillar (kaz [b1ba92122752]); Scroll of Alchemy (R77 [16886be362f8]); DNA helix (R77 [4b77fa49c03e]); Fairy dust (R77 [d5a4ac437aae]).
- Construction crane (yukitsunodaiscool [f727644461a7]), Mini golf (Kj13 [f42cca32bbe2]), Origami / Graffiti (JBearr12 [80a769fdea4c]), Beach, Safari, Space (dylanbuckleyisjewish).
- Elemental legendary (rock → ice → fire → wind as digits land) (kaz [c51ae4e06e9d], [e680a2e9f98e]).

**Wallpapers** (`js/shop.js` WALLPAPERS + `css/style.css` `.wp-<id>`):
- Underwater legendary with whales and dolphins (AnnJoe [4a54d5b3ada2]).
- F1 race track (YU CHUAN 23 [3c1460493ede]).
- ASMR bubbles you can pop by clicking (kingston [ed5d1985429b]).
- Aether: a glowing ball that always follows the trail, faster on better rolls (Angelicide9 [e4fb4bb75a32]).

**Features**:
- Sort History by how many times a number was rolled (CococoC [7ffd06d8ff64]).
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

## Decisions and why

- **Everything on the VPS** (2026-10-22): Vercel paused the team for CPU; Sacha cannot pay Pro every month.
- **No luck or speed for sale, no free coins**: fairness; kids notice and complain fast, and the economy breaks.
- **Tournament shared rolls**: many players cannot be online all day; rolls are random anyway, so rolling for an
  absent player is fair and removes forfeits.
- **Two tournaments instead of a bigger bracket**: 32 players already means 5 rounds in 12 hours.
- **5% to idea authors** (not 10%): rewards ideas without inflating coins much; coins are created, the buyer pays the
  normal price.
- **Badge changes never take earned rewards away**, but upgrades can be migrated (only Mythic+ upgrades were, to keep
  the economy stable: ~140,000 coins over 214 players on 2026-10-23).
- **Owner-only features are never in the public update log.**

## Bugs in progress

- None known to be broken right now. See "Open bug reports" above.

## Session log

<!-- Add one line per session: date, who, branch, what changed, what is left. -->
- 2026-10-23 · Sacha · main · repo prepared for two people (CLAUDE.md, HANDOFF.md, skills, audits in tools/audit).
