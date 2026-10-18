/* RNG∞ — événement de la semaine (2026-10-17) : chaque semaine (lundi 00:00 UTC → dimanche), un thème de badges et un
 * objectif, calibrés pour ~400 tirages (fréquences mesurées sur 120 000 nombres au hasard). Un tirage compte une fois
 * s'il obtient au moins un badge du thème. Les thèmes tournent dans l'ordre, sans changer l'XP ni les classements.
 * Partagé par le site et le serveur (api/quests.js, api/_lib.js, api/_discord_tasks.js). */
(function (root) {
  const WEEK = 7 * 86400000;
  const EPOCH = Date.parse('2026-10-19T00:00:00Z'); // un lundi : semaine 0 (la semaine -1, de lancement, prend le dernier thème)
  const REWARD = 500;
  const THEMES = [
    { key: 'prime', example: '7919 is prime', emoji: '🔢', title: 'Prime Time', goal: 30, badges: ['PRIME'], desc: 'Roll 30 prime numbers' },
    { key: 'happy', example: '19 is happy: 1²+9²=82 → 68 → 100 → 1', emoji: '😊', title: 'Happy Week', goal: 55, badges: ['HAPPY', 'HAPPY_PRIME'], desc: 'Roll 55 happy numbers' },
    { key: 'round', example: '4500 ends in 00', emoji: '💯', title: 'Round Numbers', goal: 4, badges: ['CENTURY', 'MILLENNIUM', 'EPOCH', 'EON'], desc: 'Roll 4 numbers ending in 00 or more' },
    { key: 'seq', example: '81234 contains 1234', emoji: '📈', title: 'Sequence Week', goal: 22, badges: ['SEQUENCE_3', 'SEQUENCE_4', 'SEQUENCE_6'], desc: 'Roll 22 numbers with a sequence (like 123 or 4567)' },
    { key: 'mirror', example: '512215 is mirrored', emoji: '🪞', title: 'Mirror Week', goal: 22, badges: ['POCKET_MIRROR', 'MIRROR_BOOKENDS'], desc: 'Roll 22 mirrored numbers' },
    { key: 'fib', example: '11235 is a Fibonacci slice', emoji: '🐚', title: 'Fibonacci Week', goal: 2, badges: ['FIBONACCI', 'FIB_CONTAINS_3', 'FIB_CONTAINS_4', 'FIB_CONTAINS_5'], desc: 'Roll 2 Fibonacci numbers or slices (like 112 or 1123)' },
    { key: 'pal', example: '12321 reads the same both ways', emoji: '🔁', title: 'Palindrome Week', goal: 1, badges: ['PALINDROME'], desc: 'Roll a palindrome (reads the same both ways)' },
    { key: 'meme', example: '142069 contains 69', emoji: '😂', title: 'Meme Week', goal: 22, badges: ['NICE', 'BOTANIST', 'DEVIL', 'LEET', 'HELL'], desc: 'Roll 22 meme numbers (69, 420, 666, 1337, 7734)' },
  ];

  // L'événement de l'instant t : son numéro de semaine (identifiant), son thème, son début et sa fin.
  function current(t = Date.now()) {
    const week = Math.floor((t - EPOCH) / WEEK);
    const theme = THEMES[((week % THEMES.length) + THEMES.length) % THEMES.length];
    return { id: `w${week}`, week, start: EPOCH + week * WEEK, end: EPOCH + (week + 1) * WEEK, reward: REWARD, ...theme };
  }
  // Un tirage (identifiants des badges obtenus) compte-t-il pour l'événement ?
  const counts = (ev, earnedIds) => (earnedIds || []).some(id => ev.badges.includes(id));

  // Weekend Rush (2026-10-18) : samedi et dimanche (jours UTC), les pièces des tirages et des quêtes sont doublées.
  // Le casino, les duels, les niveaux et le reste ne changent pas.
  const rush = (t = Date.now()) => [0, 6].includes(new Date(t).getUTCDay());
  const rushMult = t => (rush(t) ? 2 : 1);
  const rushEnd = (t = Date.now()) => { const d = new Date(t); d.setUTCHours(0, 0, 0, 0); return d.getTime() + (d.getUTCDay() === 6 ? 2 : 1) * 86400000; };
  const api = { rush, rushMult, rushEnd, THEMES, REWARD, current, counts, key: ev => `ev:${ev.id}` };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RNGEvents = api;
})(typeof window !== 'undefined' ? window : globalThis);
