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
5. **Ideas accepted but not built** (good next tasks, each one PR):
   - Skins: Dynamite (mushroom clouds from Mythic, casmictechthing), Burger (jaxoncool43), Basketball (jjcoolcid1),
     shiny Diamond (finnnnn), Origami or Graffiti (JBearr12), Beach. Rework the **Infinity** skin to match Singularity
     (kaz). Follow the rng-skin-design skill.
   - Wallpapers: underwater legendary with whales and dolphins (Ann Joe), F1 (YU CHUAN 23).
   - See friends of friends (kingston).
6. **To discuss with Sacha before building**: a second premium case / button case, poker or craps, playing the casino
   while a roll animates, a casino winner/loser badge (Ann Joe; current opinion: no), 6-digit "contains" badges
   (456456, 888888, 212121), Russian-roulette-style teddy (done as Teddy Roulette), a top-3 podium elsewhere.
7. Discord: the bot cannot read forum posts until "Message Content Intent" is enabled in the Discord developer
   portal (Sacha's account). Replies to Discord threads are posted by the RNG∞ bot.

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
