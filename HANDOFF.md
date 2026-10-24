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
- **Idea Managers** (10-23): players Sacha picks (Owner page → Idea Managers tab) review ideas on `#/ideas` with a verdict and a mandatory reason (20+ characters, server-checked). They see nothing else; Sacha sees their reviews in the Inbox and decides.
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
2. Badges: ends in 250 "Quarter Millennium" (WpBejs [3c8e159b40ec]); contains 99 "Ninety-Nine" + Exact 99 (kaz [4d50fddccb81]); 727 "WYSI" (Phong254 [cbf3a830e791]); exact 142857 (JBearr12 [15430f4307b5]). Grep first: no duplicates.
3. Show the coins earned by a roll next to its XP on the result screen (jaxoncool43 [505eebd5889c]). The coins per rarity are in `Shop.COINS`. ✅ Done by Drastix on `drastix/result-coins` (PR, not merged yet): `/api/roll` now returns `coins` (Weekend Rush included).
4. Let players reorder the casino game tabs (drag or arrows), saved in `Store.settings` (jia jun [f0aeec582de9]).
5. Monthly leaderboard rewards: coins for the top 10 of the month, paid once on the 1st like the Trash King (`api/_discord_tasks.js`, `api/_rank.js`) (furcoat0 [efecba4e19e6], LwsBoi [58ee3ff2c7a9]). Keep amounts modest (ask Sacha: suggest 1,000 / 500 / 250).
6. Sort History by how many times a number was rolled (CococoC [7ffd06d8ff64]).
7. Attach up to 3 images to an idea or bug report (Phong254 [6a25a130793b]).
8. Emote "money spread" (finnnnn [9044fe933f8b]).

### B. Skins (follow `.claude/skills/rng-skin-design`, film them, put the preview in the PR)
9. Rework **Infinity** so it matches Singularity (kaz [f221766d5b41]) — first, it is the rarest skin.
10. Burger (jaxoncool43 [be2e597cbe99]).
11. Dynamite / TNT: explosions reveal the digits, mushroom clouds from Mythic (casmictechthing [c1b8d0692aaa], ichi [bac7cdca55c8]).
12. Waterfall with a nature backdrop (JBearr12 [532fd4c22dda], jjcoolcid1 [9d0b104252d4]).
13. Money: a 100-dollar bill with gold digits that melt on Mythic+ (JBearr12 [c512cd0b2fa2]) and coins (finnnnn [2457889a6d20]): one skin.
14. Bowling (JBearr12 [fa910f1e244b]), Basketball (jjcoolcid1 [e937ad77450c]), Mini golf (Kj13 [f42cca32bbe2]): pick one sport first.
15. Rock smash: a fist smashes a rock to reveal the digit (HSI [5b5f29b0cc52]); Cracked screen (KMC [a677e62ae02d]); Medieval castle (BIGBOIJONER69 [c10d8e68d556]); Chocolate (finnnnn [89626248c340]); Floppy Fish (AnnJoe [47b7afc07c18]); Stick man with axes (jjcoolcid1 [9e4d04f5b906]); Metal balls breaking crates (jjcoolcid1 [4bf26afedcb9]); Math symbols (sennybex1 [359f2e6f81a9]).
16. Legendary: **Christmas** (six presents that pop open, two trees, red and green lights) (JBearr12 [238c54c3daf9], Angelicide9 [1d43563c63f7]) — should ship before December as a limited skin (`until`); Divine Judgment (Gray alt [917364bbc5dd]).

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
