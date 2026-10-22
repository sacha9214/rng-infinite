---
name: rng-skin-design
description: Design, animate and ship a skin (number-card look) or any animation for RNG∞ (~/Projets/Web/rng-infinite). Use whenever Sacha asks for a new skin, a skin redesign, a duel frame, a reveal/spin animation, or says an animation "isn't good / not stylish enough". Forces a reference-driven design brief, motion principles, frame-by-frame visual verification with tools/skin-preview.mjs, and a quality checklist before anything is published.
---

# RNG∞ — skins and animations that actually look good

The recurring failure: designing animations blind (one still screenshot, or none), shipping the first draft,
and discovering later that the idea did not read. This skill replaces that with: **brief → build → film → critique →
iterate (at least twice) → ship**.

## 0. Where things live

- Catalogue: `js/shop.js` (`SKINS`: id, name, emoji, price, desc; sorted by price automatically).
- Look: `css/style.css`. Each skin = `.num-card.skin-<id>` (card), `.skin-<id> .slot` (digits),
  `.skin-<id> .slot.spinning` (while rolling), `.skin-<id> .slot.revealed` (the moment a digit locks),
  `.side-<id>` (duel frame: `--side-bg`, `--side-border`, `--side-glow`, `--side-ink`, `--deco-a/--deco-b`).
  If `.slot` gets a box (width/height/background), add `.skin-<id> .slot.collapsed { width:0;height:0;margin:0;box-shadow:none;background:none }`.
- Leading zeros are `.slot.ghost` (opacity .18): never end a reveal keyframe with an explicit `opacity: 1`
  and `forwards/both` fill — use `backwards`, or the ghost zeros become fully visible.
- `.num-card::after` is the tier sheen, `.num-card` has `overflow:hidden`; `::before` is free on the card.
- 3+ player duels add `.room-stage.many`: permanent decoration animations are switched off there (performance).
- Reduced motion: a global rule forces every animation to .01ms. Anything that must stay visible (like reaction
  bubbles) needs its own `!important` override under `prefers-reduced-motion`.
- Trademarks: never copy a game's name, textures, fonts or logos (Minecraft, Clash Royale…). Evoke the style.

## 1. Brief before code (write it in the chat, 5 lines)

1. **Material / world** — what is the number *made of*? (gel candy, glass nixie tube, grass block, polished gem…)
   A skin is a material, not a colour palette.
2. **References** — 2-3 concrete real-world or game references and the one trait taken from each.
3. **Spin verb** — what the digits *do* while rolling, tied to the material (mined, sloshing, flickering filament…).
4. **Reveal beat** — the single satisfying moment when a digit locks (impact, freeze, pop, strike) and its sound
   if it had one: the animation should "sound" like that.
5. **Frame story** — what the duel panel tells around the card (setting + 1-2 small animated props).

## 2. Motion principles (apply every time)

- **Anticipation → action → follow-through**: a reveal needs a wind-up (scale down / pull back 1-2 frames), the hit,
  then overshoot and settle. Pure fade-ins look cheap.
- **Squash & stretch** for soft materials (candy, jelly, water), **none** for hard ones (metal, gem, stone) —
  hard materials get flashes, sparks, cracks and rigid bounces (`steps()` for pixel styles).
- **Timing**: spin loops 80-300 ms; reveal 450-800 ms; decoration loops ≥ 1.5 s. Ease-out for impacts,
  `cubic-bezier(.3,1.6,.5,1)`-style overshoot for pops, `linear` only for continuous motion.
- **One focal point**: digits must stay the most readable thing on screen at every frame; decoration sits behind
  (`z-index`), below 40 % contrast of the digits.
- **Layer depth**: background texture + light (glow/gradient) + digits + highlight/sheen. Flat = unfinished.
- **Readability test**: digits must read at the smallest size (duel card `md`, and `.room-stage.many`).

## 3. Build → film → critique loop (mandatory, at least 2 iterations)

1. Write the CSS (and `shop.js` entry) following section 0.
2. Film it: `node tools/skin-preview.mjs <id>` then **Read** `skin-previews/<id>.png`.
   It shows: card at rest (+ ghost zeros), 5 spin frames, 6 reveal frames (0-700 ms), duel frame dark and light.
   First time on a machine: `npm i --prefix tools/.deps playwright@1 && npx --prefix tools/.deps playwright install firefox`.
3. Critique against the checklist below, **write the critique down** (what is weak, what to change), fix, re-film.
   Do not publish after the first render. Compare with 1-2 existing strong skins (`matrix`, `slots`, `blocks`) by
   filming them too.
4. For live motion that the sheet cannot show (loops, timing feel), open the page in the preview browser and watch;
   note that a hidden preview pane throttles animations to ~1 fps, so measure performance headless
   (measure with Playwright Firefox, muted, and a requestAnimationFrame counter).

## 4. Checklist before shipping

- [ ] Material reads instantly at rest (someone could name it without the label).
- [ ] Digits readable at every captured frame, dark and light theme, and with ghost zeros.
- [ ] Spin frames differ visibly from rest (the roll feels alive) without becoming unreadable mush.
- [ ] Reveal has anticipation, impact and settle — visible across the 0-700 ms frames.
- [ ] Duel frame: themed background + 1-2 animated props, nothing overlapping the name/number, works in light theme.
- [ ] Nothing new animates permanently inside `.room-stage.many`; no JS added per frame.
- [ ] `node tools/test-api.mjs` green, `node tools/stamp.mjs` run, committed (English message, no Co-Authored-By),
      pushed, and the live `js/shop.js?v=` / `css/style.css?v=` stamp checked on https://rng-infinite.com.
- [ ] Show Sacha the final preview sheet (SendUserFile) — he judges style, not the description.
