/* RNG∞ — moteur de badges.
 * Pur JS sans dépendance, chargeable dans le navigateur (window.RNGEngine) et dans Node (module.exports).
 * createEngine(meta, percentiles) : meta = [{id,label,desc,emoji,score,family}], percentiles = [[score, pct], ...] triés.
 */
(function (root) {
  'use strict';

  const MAX_ROLL = 1000000;

  // ---------------------------------------------------------------- helpers numériques
  function isPrime(n) {
    if (n < 2) return false;
    if (n < 4) return true;
    if (n % 2 === 0 || n % 3 === 0) return false;
    for (let i = 5; i * i <= n; i += 6) if (n % i === 0 || n % (i + 2) === 0) return false;
    return true;
  }
  function isSquare(n) { if (n < 0) return false; const r = Math.round(Math.sqrt(n)); return r * r === n; }
  function isCube(n) { const r = Math.round(Math.cbrt(n)); return r * r * r === n; }
  function isPerfectPower(n, k) {
    if (n === 0 || n === 1) return true;
    return Math.pow(Math.round(Math.pow(n, 1 / k)), k) === n;
  }
  function isPowerOf(n, base) {
    if (n <= 0) return false;
    let p = 1;
    while (p < n) p *= base;
    return p === n;
  }
  const isFibonacci = n => isSquare(5 * n * n + 4) || isSquare(5 * n * n - 4);
  function isPronic(n) { const k = Math.round((Math.sqrt(1 + 4 * n) - 1) / 2); return k * (k + 1) === n; }
  function isPalindrome(s) {
    for (let i = 0, j = s.length - 1; i < j; i++, j--) if (s[i] !== s[j]) return false;
    return true;
  }
  const FACTORIALS = new Set([1, 2, 6, 24, 120, 720, 5040, 40320, 362880]);
  const SELF_POWERS = new Set([1, 4, 27, 256, 3125, 46656, 823543]);

  const hasLeadingZero = p => p.length > 1 && p[0] === '0';
  const range = (a, b) => { const out = []; for (let i = a; i < b; i++) out.push(i); return out; };
  const indicesOf = (s, ch) => { const out = []; for (let i = 0; i < s.length; i++) if (s[i] === ch) out.push(i); return out; };

  function isRunSet(nums) {
    const a = nums.slice().sort((x, y) => x - y);
    for (let i = 1; i < a.length; i++) if (a[i] - a[i - 1] !== 1) return false;
    return true;
  }
  function isStrictlyMonotonic(nums) {
    let up = true, down = true;
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] <= nums[i - 1]) up = false;
      if (nums[i] >= nums[i - 1]) down = false;
    }
    return up || down;
  }

  // Suite de `len` chiffres adjacents qui montent ou descendent de 1 à chaque pas. Renvoie l'index de départ ou -1.
  function findDigitRun(d, len) {
    for (let i = 0; i + len <= d.length; i++) {
      const step = d[i + 1] - d[i];
      if (step !== 1 && step !== -1) continue;
      let ok = true;
      for (let k = 2; k < len; k++) if (d[i + k] - d[i + k - 1] !== step) { ok = false; break; }
      if (ok) return i;
    }
    return -1;
  }

  // Tous les chiffres triés forment une suite +1 (donc sans doublon).
  function isScrambledRun(str, minLen) {
    if (str.length < minLen) return false;
    const a = str.split('').map(Number).sort((x, y) => x - y);
    for (let i = 1; i < a.length; i++) if (a[i] !== a[i - 1] + 1) return false;
    return true;
  }

  // Découpe s en k morceaux sans zéro de tête ; renvoie le premier découpage (ordre lexicographique des coupes) validé par pred.
  function findSplit(s, k, pred) {
    const starts = new Array(k), nums = new Array(k);
    function rec(part, from) {
      if (part === k - 1) {
        const p = s.slice(from);
        if (hasLeadingZero(p)) return false;
        starts[part] = from; nums[part] = Number(p);
        return pred(nums);
      }
      const remaining = k - part - 1;
      for (let to = from + 1; to <= s.length - remaining; to++) {
        const p = s.slice(from, to);
        if (hasLeadingZero(p)) continue;
        starts[part] = from; nums[part] = Number(p);
        if (rec(part + 1, to)) return true;
      }
      return false;
    }
    if (!rec(0, 0)) return null;
    const groups = starts.map((st, i) => range(st, i + 1 < k ? starts[i + 1] : s.length));
    return { nums: nums.slice(), groups };
  }

  const hasMultiDigit = nums => nums.some(v => v >= 10);

  // Le nombre entier se découpe en k entiers consécutifs (au moins un morceau à 2+ chiffres).
  const findConsecutiveSplit = (s, k) => findSplit(s, k, nums => hasMultiDigit(nums) && isRunSet(nums));

  // Deux sous-chaînes collées qui sont des entiers consécutifs (sans couvrir tout le nombre).
  function findConsecutivePairAdjacent(s) {
    const L = s.length;
    for (let t = 0; t < L; t++) {
      for (let len = 1; len <= L - t - 1; len++) {
        const a = s.slice(t, t + len);
        if (hasLeadingZero(a)) continue;
        const av = Number(a);
        for (const bv of [av + 1, av - 1]) {
          if (bv < 0) continue;
          const b = String(bv), end = t + len + b.length;
          if (end > L || s.slice(t + len, end) !== b) continue;
          if (a.length < 2 && b.length < 2) continue;
          if (t === 0 && end === L) continue;
          return [range(t, t + len), range(t + len, end)];
        }
      }
    }
    return null;
  }

  // Deux sous-chaînes disjointes, non collées, qui sont des entiers consécutifs.
  function findConsecutivePairNearby(s) {
    const L = s.length, subs = [];
    for (let i = 0; i < L; i++) {
      for (let len = 1; len <= L - i; len++) {
        const p = s.slice(i, i + len);
        if (!hasLeadingZero(p)) subs.push({ v: Number(p), start: i, end: i + len });
      }
    }
    for (let x = 0; x < subs.length; x++) {
      for (let y = x + 1; y < subs.length; y++) {
        const a = subs[x], b = subs[y];
        if (Math.abs(a.v - b.v) !== 1) continue;
        if (a.end - a.start < 2 && b.end - b.start < 2) continue;
        if (a.end < b.start || b.end < a.start) return [range(a.start, a.end), range(b.start, b.end)];
      }
    }
    return null;
  }

  // k entiers consécutifs (montants ou descendants) écrits à la suite quelque part dans le nombre.
  function chainFrom(s, i, len, v, step, k) {
    const groups = [range(i, i + len)];
    let pos = i + len, multi = len >= 2;
    for (let j = 1; j < k; j++) {
      const nv = v + j * step;
      if (nv < 0) return null;
      const str = String(nv);
      if (pos + str.length > s.length || s.slice(pos, pos + str.length) !== str) return null;
      groups.push(range(pos, pos + str.length));
      if (str.length >= 2) multi = true;
      pos += str.length;
    }
    return multi ? { start: i, end: pos, groups } : null;
  }
  function findConsecutiveRunAdjacent(s, k) {
    for (let i = 0; i < s.length; i++) {
      let found = null;
      for (let len = 1; len <= s.length - i - (k - 1) && !found; len++) {
        const first = s.slice(i, i + len);
        if (hasLeadingZero(first)) continue;
        const v = Number(first);
        found = chainFrom(s, i, len, v, 1, k) || chainFrom(s, i, len, v, -1, k);
      }
      if (found && !(found.start === 0 && found.end === s.length)) return found.groups;
    }
    return null;
  }

  function findArithmeticSplit(s) {
    for (let k = 3; k <= s.length; k++) {
      const m = findSplit(s, k, nums => {
        const diff = nums[1] - nums[0];
        if (diff >= -1 && diff <= 1) return false;
        for (let i = 2; i < nums.length; i++) if (nums[i] - nums[i - 1] !== diff) return false;
        return true;
      });
      if (m) return m;
    }
    return null;
  }

  function findGeometricSplit(s) {
    for (let k = 3; k <= s.length; k++) {
      const m = findSplit(s, k, nums => {
        if (nums.some(v => v <= 0) || nums[0] === nums[1]) return false;
        for (let i = 0; i + 2 < nums.length; i++) if (nums[i + 1] * nums[i + 1] !== nums[i] * nums[i + 2]) return false;
        return true;
      });
      if (m) return m;
    }
    return null;
  }

  function findEquation(s) {
    let op = null;
    const m = findSplit(s, 3, ([a, b, c]) => {
      if (a === 0 || b === 0 || c === 0) return false;
      if (a + b === c) op = '+';
      else if (a - b === c) op = '−';
      else if (a * b === c) op = '×';
      else if (a % b === 0 && a / b === c) op = '÷';
      else return false;
      return true;
    });
    return m ? Object.assign(m, { op }) : null;
  }

  // Runs maximaux de chiffres identiques : [[start, end), ...]
  function runsOf(s) {
    const out = [];
    let st = 0;
    for (let i = 1; i <= s.length; i++) {
      if (i === s.length || s[i] !== s[st]) { out.push([st, i]); st = i; }
    }
    return out;
  }

  // ---------------------------------------------------------------- contexte partagé par tous les checks
  function contextOf(n) {
    const s = String(n), L = s.length, d = new Array(L), cnt = new Array(10).fill(0);
    let sum = 0, prod = n === 0 ? 0 : 1;
    for (let i = 0; i < L; i++) {
      const v = s.charCodeAt(i) - 48;
      d[i] = v; cnt[v]++; sum += v; prod *= v;
    }
    let distinct = 0;
    for (const x of cnt) if (x) distinct++;
    let runs = null;
    return {
      n, s, L, d, cnt, sum, prod, distinct,
      get runs() { return runs || (runs = runsOf(s)); },
    };
  }

  // ---------------------------------------------------------------- tables de badges simples
  const CONTAINS = {
    NICE: '69', VERY_NICE: '6969', BOTANIST: '420', DEVIL: '666', LEET: '1337', HELL: '7734',
    BOOB_8008: '8008', BOOB_58008: '58008', BOOB_80085: '80085', HELLO: '07734', MEANING: '42',
    EMERGENCY: '911', ERROR: '404', DEEPER_MEANING: '4242', SECRET_AGENT: '007', BIG_BROTHER: '1984',
    PI_CONTAINS_3: '314', PI_CONTAINS_4: '3141', PI_CONTAINS_5: '31415',
    E_CONTAINS_3: '271', E_CONTAINS_4: '2718', E_CONTAINS_5: '27182',
    TAU_SLICE_4: '6283', TAU_SLICE_5: '62831',
    SIXTY_SEVEN: '67', SIXTY_SEVEN_DOUBLE: '6767', EIGHTY_SIX: '86', ORIENTATION: '101', CALENDAR: '365',
    LUCKY_7: '7', JACKPOT: '777', JACKPOT_FOUR: '7777', JACKPOT_FIVE: '77777', JACKPOT_SIX: '777777',
    ROYAL_FLUSH: '56789',
    DRASTIX: '235', // badge perso, absent de l'original
    FULL_STACK: '64', // badge perso : 64, une pile complète de blocs
    DEEP_VOID: '00', DEEP_VOID_THREE: '000', DEEP_VOID_FOUR: '0000', DEEP_VOID_FIVE: '00000',
  };
  const EXACT = {
    NICE_EXACT: ['69'], JACKPOT_EXACT: ['777'], BOTANIST_EXACT: ['420'], DEVIL_EXACT: ['666'],
    LEET_EXACT: ['1337'], EXACT_HELL: ['7734'], EXACT_BOOB_80085: ['80085'], MEANING_EXACT: ['42'],
    EMERGENCY_EXACT: ['911'], ERROR_EXACT: ['404'], INFERNAL: ['666666'], FOOTBALL_17776: ['17776'],
    VERY_VERY_NICE: ['696969'], HOTBOX: ['420420'], MAYDAY: ['911911'], UNIVERSAL_ANSWER: ['424242'],
    BIG_BROTHER_EXACT: ['1984'], SIXTY_SEVEN_EXACT: ['67'], EIGHTY_SIX_EXACT: ['86'],
    ORIENTATION_EXACT: ['101'], CALENDAR_EXACT: ['365'], BRAINROT: ['676767'], GROUNDHOG_DAY: ['365365'],
    FULL_DAY: ['86400'], ONE_MILLION: ['1000000'],
    EXACT_BOOB: ['8008', '58008'], ULTIMEME_EXACT: ['69420', '42069'], ALWAYS: ['247365', '365247'],
    PI: ['314', '3141', '31415', '314159'], E: ['271', '2718', '27182', '271828'],
    TAU: ['6283', '62831', '628318'], GOLDEN_RATIO: ['1618', '16180', '161803'],
    DIGIT_ZERO: ['0'], DIGIT_ONE: ['1'], DIGIT_TWO: ['2'], DIGIT_THREE: ['3'], DIGIT_FOUR: ['4'],
    DIGIT_FIVE: ['5'], DIGIT_SIX: ['6'], DIGIT_SEVEN: ['7'], DIGIT_EIGHT: ['8'], DIGIT_NINE: ['9'],
  };
  const ENDS = {
    CLEAN: '0', CENTURY: '00', MILLENNIUM: '000', EPOCH: '0000', EON: '00000',
    SEMI_CLEAN: '5', SEMI_CENTURY: '50', SEMI_MILLENNIUM: '500', SEMI_EPOCH: '5000', SEMI_EON: '50000',
    QUARTER_CENTURY: '25', THREE_QUARTER_CENTURY: '75',
    DOUBLE_NINE: '99', TRIPLE_NINE: '999', QUAD_NINE: '9999', QUINT_NINE: '99999',
  };
  const SINGLE_DIGIT_COUNT = {
    GHOST: 0, HYDROGEN: 1, HELIUM: 2, LITHIUM: 3, BERYLLIUM: 4, BORON: 5, CARBON: 6, NITROGEN: 7, OXYGEN: 8, FLUORINE: 9,
  };
  const POWERS = {
    FOURTH_POWER: 4, FIFTH_POWER: 5, SIXTH_POWER: 6, SEVENTH_POWER: 7, EIGHTH_POWER: 8, NINTH_POWER: 9,
    TENTH_POWER: 10, ELEVENTH_POWER: 11, THIRTEENTH_POWER: 13, SEVENTEENTH_POWER: 17, NINETEENTH_POWER: 19,
  };
  const LENGTHS = { ONE_DIGIT: 1, TWO_DIGITS: 2, THREE_DIGITS: 3, FOUR_DIGITS: 4, FIVE_DIGITS: 5, SIX_DIGITS: 6 };
  const DIVISORS = { DOZEN: 12, LUCKY_SEVEN_DIV: 7, ELEVEN: 11 };
  const STROBO = { 0: '0', 1: '1', 6: '9', 8: '8', 9: '6' };

  // ---------------------------------------------------------------- checks : id -> (ctx) => bool
  // Chaque check peut aussi exposer des "groupes" de chiffres à surligner via HIGHLIGHTS plus bas.
  const CHECKS = {
    PRIME: c => isPrime(c.n),
    PALINDROME: c => isPalindrome(c.s),
    POCKET_MIRROR: c => findPocketMirror(c.s) !== null,
    HEAVY: c => c.sum > 45,
    FEATHER: c => c.sum < 15,
    BLACKJACK: c => c.sum === 21,
    VOID: c => c.cnt[0] === 0,
    EVEN: c => c.n % 2 === 0,
    ODD: c => c.n % 2 === 1,
    COLOSSAL: c => c.n > 999000,
    GROUNDED: c => c.L >= 2 && c.d[0] < c.d[c.L - 1],
    LIFTOFF: c => c.L >= 2 && c.d[0] > c.d[c.L - 1],
    EQUILIBRIUM: c => c.L >= 2 && c.d[0] === c.d[c.L - 1],
    GAP_ONE: c => c.L >= 2 && Math.abs(c.d[0] - c.d[c.L - 1]) === 1,
    SANDWICH: c => {
      if (c.L < 3 || c.d[0] !== c.d[c.L - 1]) return false;
      for (let i = 1; i < c.L - 1; i++) if (c.d[i] !== c.d[0]) return true;
      return false;
    },
    TURTLE: c => {
      if (c.L < 2) return false;
      for (let i = 1; i < c.L; i++) if (Math.abs(c.d[i] - c.d[i - 1]) > 1) return false;
      return true;
    },
    FIREFLY: c => c.L >= 4 && c.distinct === 2 && c.cnt.some(x => x === 1),
    ECHO: c => c.L >= 2 && c.L % 2 === 0 && c.s.slice(0, c.L / 2) === c.s.slice(c.L / 2),
    BALANCED: c => {
      if (c.L < 2 || c.L % 2 !== 0) return false;
      let a = 0, b = 0;
      for (let i = 0; i < c.L; i++) (i < c.L / 2 ? (a += c.d[i]) : (b += c.d[i]));
      return a === b;
    },
    BOOKENDS: c => c.L >= 4 && c.s.slice(0, 2) === c.s.slice(-2),
    MIRROR_BOOKENDS: c => c.L >= 4 && c.s[0] === c.s[c.L - 1] && c.s[1] === c.s[c.L - 2],
    PAIRED_BOOKENDS: c => c.L >= 4 && c.s[0] === c.s[1] && c.s[c.L - 2] === c.s[c.L - 1] && c.s[0] !== c.s[c.L - 2],

    ASCENSION: c => monotone(c.d, (a, b) => b > a),
    DECAY: c => monotone(c.d, (a, b) => b < a),
    CASCADE: c => monotone(c.d, (a, b) => b === a + 1),
    WATERFALL: c => monotone(c.d, (a, b) => b === a - 1),
    STEPS: c => monotone(c.d, (a, b) => b >= a) && c.d.some((v, i) => i > 0 && v > c.d[i - 1]),
    SLOPES: c => monotone(c.d, (a, b) => b <= a) && c.d.some((v, i) => i > 0 && v < c.d[i - 1]),
    MOUNTAIN: c => strictPeak(c.d, 1),
    VALLEY: c => strictPeak(c.d, -1),
    MESA: c => softPeak(c.d, 1),
    CANYON: c => softPeak(c.d, -1),
    HILLS: c => {
      if (c.L < 4) return false;
      for (let i = 1; i < c.L; i++) if (c.d[i] === c.d[i - 1]) return false;
      return zigzag(c.d);
    },
    DUNES: c => {
      const squashed = [c.d[0]];
      for (let i = 1; i < c.L; i++) if (c.d[i] !== c.d[i - 1]) squashed.push(c.d[i]);
      return squashed.length >= 4 && zigzag(squashed);
    },
    EVEN_SPACING: c => {
      if (c.L < 3) return false;
      const step = c.d[1] - c.d[0];
      for (let i = 2; i < c.L; i++) if (c.d[i] - c.d[i - 1] !== step) return false;
      return true;
    },
    EVEN_SPACING_ABS: c => {
      if (c.L < 3) return false;
      const gap = Math.abs(c.d[1] - c.d[0]);
      for (let i = 2; i < c.L; i++) if (Math.abs(c.d[i] - c.d[i - 1]) !== gap) return false;
      return true;
    },
    SEQUENCE_3: c => findDigitRun(c.d, 3) >= 0,
    SEQUENCE_4: c => findDigitRun(c.d, 4) >= 0,
    STRAIGHT: c => findDigitRun(c.d, 5) >= 0,
    SEQUENCE_6: c => findDigitRun(c.d, 6) >= 0,
    SCRAMBLE: c => isScrambledRun(c.s, 2),
    MINI_SCRAMBLE: c => findMiniScramble(c.s) !== null,
    NEIGHBORS: c => {
      for (let i = 1; i < c.L; i++) if (Math.abs(c.d[i] - c.d[i - 1]) === 1) return true;
      return false;
    },
    STRAIGHT_FLUSH: c => ['02468', '13579', '86420', '97531'].some(x => c.s.includes(x)),
    FLUSH: c => c.d.every(v => v % 2 === 0) || c.d.every(v => v % 2 === 1),
    ALTERNATOR: c => {
      if (c.L < 2) return false;
      for (let i = 1; i < c.L; i++) if (c.d[i] % 2 === c.d[i - 1] % 2) return false;
      return true;
    },
    LOW_BALL: c => c.d.every(v => v <= 4),
    HIGH_ROLLER: c => c.d.every(v => v >= 5),
    DIVISIBLE_BY_THREE: c => c.d.every(v => v % 3 === 0),
    BINARY_SOUL: c => c.d.every(v => v <= 1),
    STROBOGRAMMATIC: c => {
      let rotated = '';
      for (let i = c.L - 1; i >= 0; i--) {
        const r = STROBO[c.s[i]];
        if (r === undefined) return false;
        rotated += r;
      }
      return rotated === c.s;
    },

    DUALITY: c => c.distinct === 2,
    TRINITY: c => c.distinct === 3,
    QUARTET: c => c.distinct === 4,
    HETEROGENEOUS: c => c.distinct === c.L,
    HOMOGENEOUS: c => c.L >= 2 && c.distinct === 1,
    ZIPPER: c => {
      if (c.L < 2 || c.distinct !== 2) return false;
      for (let i = 1; i < c.L; i++) if (c.s[i] === c.s[i - 1]) return false;
      return true;
    },
    HOPSCOTCH: c => findHop(c.s, c.distinct) !== null,
    DOUBLE_HOP: c => findDoubleHop(c.s, c.distinct) !== null,
    MINI_ECHO: c => findMiniEcho(c.s) !== null,
    RHYME: c => findRhyme(c.s) !== null,

    PAIR: c => c.cnt.some(x => x >= 2),
    TWO_PAIR: c => c.cnt.filter(x => x >= 2).length >= 2,
    THREE_PAIR: c => c.cnt.filter(x => x === 2).length >= 3,
    TRIPS: c => c.cnt.some(x => x === 3),
    QUADS: c => c.cnt.some(x => x >= 4),
    FIVE_OF_A_KIND: c => c.cnt.some(x => x >= 5),
    BOAT: c => c.cnt.some(x => x >= 3) && c.cnt.filter(x => x >= 2).length >= 2,
    SNAKE_EYES: c => c.cnt[1] === 2 && c.cnt.every((x, dg) => dg === 1 || x < 2),
    CONTIGUOUS_PAIR: c => c.runs.some(([a, b]) => b - a >= 2),
    CONTIGUOUS_TRIPS: c => c.runs.some(([a, b]) => b - a >= 3),
    CONTIGUOUS_QUADS: c => c.runs.some(([a, b]) => b - a >= 4),
    CONTIGUOUS_FIVES: c => c.runs.some(([a, b]) => b - a >= 5),
    CONTIGUOUS_SIXES: c => c.runs.some(([a, b]) => b - a >= 6),
    CONTIGUOUS_TWO_PAIR: c => findContiguousTwoPair(c.s) >= 0,
    CONTIGUOUS_THREE_PAIR: c => findContiguousThreePair(c) !== null,
    CONTIGUOUS_BOAT: c => findContiguousBoat(c) !== null,
    FRAMED_PAIR: c => c.L === 4 && c.s[1] === c.s[2] && c.s[0] !== c.s[1] && c.s[3] !== c.s[1],
    FRAMED_TRIPLE: c => c.L === 5 && c.s[1] === c.s[2] && c.s[2] === c.s[3] && c.s[0] !== c.s[1] && c.s[4] !== c.s[1],
    FRAMED_QUAD: c => c.L === 6 && c.s.slice(1, 5) === c.s[1].repeat(4) && c.s[0] !== c.s[1] && c.s[5] !== c.s[1],
    FRAMED_DOUBLE: c => c.L === 6 && c.s[1] === c.s[2] && c.s[3] === c.s[4] && c.s[1] !== c.s[3] &&
      c.s[0] !== c.s[1] && c.s[5] !== c.s[3],

    SQUARE: c => isSquare(c.n),
    CUBE: c => isCube(c.n),
    FIBONACCI: c => isFibonacci(c.n),
    POWER_OF_TWO: c => c.n > 0 && (c.n & (c.n - 1)) === 0,
    POWER_OF_THREE: c => isPowerOf(c.n, 3),
    POWER_OF_FIVE: c => isPowerOf(c.n, 5),
    POWER_OF_SEVEN: c => isPowerOf(c.n, 7),
    OUROBOROS: c => SELF_POWERS.has(c.n),
    FACTORIAL: c => FACTORIALS.has(c.n),
    PRONIC: c => isPronic(c.n),
    HARSHAD: c => c.n > 0 && c.sum > 0 && c.n % c.sum === 0,
    SPY: c => c.n !== 1 && c.n !== 2 && c.sum === c.prod,
    EQUATION: c => findEquation(c.s) !== null,
    ARITHMETIC: c => findArithmeticSplit(c.s) !== null,
    GEOMETRIC: c => findGeometricSplit(c.s) !== null,
    ULTIMEME: c => c.s.includes('69') && c.s.includes('420'),

    CONSEC_PAIR_EXACT: c => findConsecutiveSplit(c.s, 2) !== null,
    CONSEC_TRIPLE_EXACT: c => { const m = findConsecutiveSplit(c.s, 3); return !!m && isStrictlyMonotonic(m.nums); },
    CONSEC_TRIPLE_SCRAMBLED: c => { const m = findConsecutiveSplit(c.s, 3); return !!m && !isStrictlyMonotonic(m.nums); },
    CONSEC_QUAD_EXACT: c => { const m = findConsecutiveSplit(c.s, 4); return !!m && isStrictlyMonotonic(m.nums); },
    CONSEC_QUAD_SCRAMBLED: c => { const m = findConsecutiveSplit(c.s, 4); return !!m && !isStrictlyMonotonic(m.nums); },
    CONSEC_PAIR_ADJACENT: c => findConsecutivePairAdjacent(c.s) !== null,
    CONSEC_PAIR_NEARBY: c => findConsecutivePairNearby(c.s) !== null,
    CONSEC_TRIPLE_CONTAINS: c => findConsecutiveRunAdjacent(c.s, 3) !== null,
    CONSEC_QUAD_CONTAINS: c => findConsecutiveRunAdjacent(c.s, 4) !== null,
  };
  for (const [id, str] of Object.entries(CONTAINS)) CHECKS[id] = c => c.s.includes(str);
  for (const [id, list] of Object.entries(EXACT)) CHECKS[id] = c => list.includes(c.s);
  for (const [id, str] of Object.entries(ENDS)) CHECKS[id] = c => c.s.endsWith(str);
  for (const [id, dg] of Object.entries(SINGLE_DIGIT_COUNT)) CHECKS[id] = c => c.cnt[dg] === 1;
  for (const [id, k] of Object.entries(POWERS)) CHECKS[id] = c => isPerfectPower(c.n, k);
  for (const [id, len] of Object.entries(LENGTHS)) CHECKS[id] = c => c.L === len;
  for (const [id, div] of Object.entries(DIVISORS)) CHECKS[id] = c => c.n > 0 && c.n % div === 0;

  // ---------------------------------------------------------------- helpers de forme
  function monotone(d, ok) {
    if (d.length < 2) return false;
    for (let i = 1; i < d.length; i++) if (!ok(d[i - 1], d[i])) return false;
    return true;
  }
  // dir=1 : monte strictement jusqu'au premier pic puis descend strictement. dir=-1 : l'inverse.
  function strictPeak(d, dir) {
    if (d.length < 3) return false;
    let peak = -1;
    for (let i = 1; i < d.length - 1; i++) {
      if (dir * (d[i] - d[i - 1]) > 0 && dir * (d[i] - d[i + 1]) > 0) { peak = i; break; }
    }
    if (peak < 0) return false;
    for (let i = 1; i <= peak; i++) if (dir * (d[i] - d[i - 1]) <= 0) return false;
    for (let i = peak + 1; i < d.length; i++) if (dir * (d[i] - d[i - 1]) >= 0) return false;
    return true;
  }
  // Monte puis descend (dir=1), paliers autorisés, une seule inversion.
  function softPeak(d, dir) {
    let rose = false, fell = false;
    for (let i = 1; i < d.length; i++) {
      const delta = dir * (d[i] - d[i - 1]);
      if (delta > 0) { if (fell) return false; rose = true; } else if (delta < 0) fell = true;
    }
    return rose && fell;
  }
  function zigzag(d) {
    for (let i = 2; i < d.length; i++) {
      const a = d[i - 1] - d[i - 2], b = d[i] - d[i - 1];
      if ((a > 0 && b > 0) || (a < 0 && b < 0)) return false;
    }
    return true;
  }
  function findPocketMirror(s) {
    for (let len = 4; len <= s.length; len++)
      for (let i = 0; i + len <= s.length; i++) if (isPalindrome(s.slice(i, i + len))) return range(i, i + len);
    return null;
  }
  function findMiniScramble(s) {
    for (let len = 3; len <= s.length; len++)
      for (let i = 0; i + len <= s.length; i++) if (isScrambledRun(s.slice(i, i + len), 3)) return range(i, i + len);
    return null;
  }
  function findHop(s, distinct) {
    if (s.length < 3 || distinct < 2) return null;
    for (let i = 0; i + 2 < s.length; i++) {
      if (s[i + 2] !== s[i]) continue;
      const extendsRight = s.length > i + 4 && s[i + 4] === s[i];
      const extendsLeft = i >= 2 && s[i - 2] === s[i];
      if (!extendsRight && !extendsLeft) return [i, i + 2];
    }
    return null;
  }
  function findDoubleHop(s, distinct) {
    if (s.length < 5 || distinct < 2) return null;
    for (let i = 0; i + 4 < s.length; i++) if (s[i] === s[i + 2] && s[i] === s[i + 4]) return [i, i + 2, i + 4];
    return null;
  }
  function findMiniEcho(s) {
    for (let i = 0; i + 4 <= s.length; i++) if (s.slice(i, i + 2) === s.slice(i + 2, i + 4)) return i;
    return null;
  }
  function findRhyme(s) {
    if (s.length < 4) return null;
    for (let len = 2; len <= Math.floor(s.length / 2); len++) {
      for (let i = 0; i + len <= s.length; i++) {
        const j = s.indexOf(s.slice(i, i + len), i + len);
        if (j !== -1) return [range(i, i + len), range(j, j + len)];
      }
    }
    return null;
  }
  function findContiguousTwoPair(s) {
    for (let i = 0; i + 4 <= s.length; i++) if (s[i] === s[i + 1] && s[i + 2] === s[i + 3] && s[i] !== s[i + 2]) return i;
    return -1;
  }
  // Trois paires collées "aabbcc" où chaque chiffre n'apparaît que dans sa paire.
  function findContiguousThreePair(c) {
    const r = c.runs;
    const isLonePair = ([a, b]) => b - a === 2 && c.cnt[c.d[a]] === 2;
    for (let i = 0; i + 2 < r.length; i++) {
      if (isLonePair(r[i]) && isLonePair(r[i + 1]) && isLonePair(r[i + 2])) return [range(...r[i]), range(...r[i + 1]), range(...r[i + 2])];
    }
    return null;
  }
  // Un brelan collé (3+) directement voisin d'une paire collée (2+) d'un autre chiffre.
  function findContiguousBoat(c) {
    const r = c.runs;
    for (let i = 0; i + 1 < r.length; i++) {
      const a = r[i][1] - r[i][0], b = r[i + 1][1] - r[i + 1][0];
      if ((a >= 3 && b >= 2) || (a >= 2 && b >= 3)) return [range(...r[i]), range(...r[i + 1])];
    }
    return null;
  }

  // ---------------------------------------------------------------- surlignage des chiffres (groupes d'index)
  const all = c => [range(0, c.L)];
  const ends = c => [[0], [c.L - 1]];
  const digitsWhere = (c, pred) => c.cnt.map((x, dg) => (pred(x) ? indicesOf(c.s, String(dg)) : null)).filter(Boolean);
  const HIGHLIGHTS = {
    GROUNDED: ends, LIFTOFF: ends, EQUILIBRIUM: ends, GAP_ONE: ends, SANDWICH: ends,
    ECHO: c => [range(0, c.L / 2), range(c.L / 2, c.L)],
    BALANCED: c => [range(0, c.L / 2), range(c.L / 2, c.L)],
    BOOKENDS: c => [[0, 1], [c.L - 2, c.L - 1]],
    MIRROR_BOOKENDS: c => [[0, 1], [c.L - 2, c.L - 1]],
    PAIRED_BOOKENDS: c => [[0, 1], [c.L - 2, c.L - 1]],
    SEQUENCE_3: c => [range(findDigitRun(c.d, 3), findDigitRun(c.d, 3) + 3)],
    SEQUENCE_4: c => [range(findDigitRun(c.d, 4), findDigitRun(c.d, 4) + 4)],
    STRAIGHT: c => [range(findDigitRun(c.d, 5), findDigitRun(c.d, 5) + 5)],
    SEQUENCE_6: c => [range(findDigitRun(c.d, 6), findDigitRun(c.d, 6) + 6)],
    STRAIGHT_FLUSH: c => {
      for (const x of ['02468', '13579', '86420', '97531']) { const i = c.s.indexOf(x); if (i >= 0) return [range(i, i + 5)]; }
      return null;
    },
    MINI_SCRAMBLE: c => [findMiniScramble(c.s)],
    POCKET_MIRROR: c => [findPocketMirror(c.s)],
    NEIGHBORS: c => { for (let i = 1; i < c.L; i++) if (Math.abs(c.d[i] - c.d[i - 1]) === 1) return [[i - 1, i]]; return null; },
    HOPSCOTCH: c => [findHop(c.s, c.distinct)],
    DOUBLE_HOP: c => [findDoubleHop(c.s, c.distinct)],
    MINI_ECHO: c => { const i = findMiniEcho(c.s); return [[i, i + 1], [i + 2, i + 3]]; },
    RHYME: c => findRhyme(c.s),
    DUALITY: c => digitsWhere(c, x => x > 0),
    TRINITY: c => digitsWhere(c, x => x > 0),
    QUARTET: c => digitsWhere(c, x => x > 0),
    FIREFLY: c => digitsWhere(c, x => x === 1),
    PAIR: c => digitsWhere(c, x => x >= 2),
    TWO_PAIR: c => digitsWhere(c, x => x >= 2),
    THREE_PAIR: c => digitsWhere(c, x => x === 2),
    TRIPS: c => digitsWhere(c, x => x === 3),
    QUADS: c => digitsWhere(c, x => x >= 4),
    FIVE_OF_A_KIND: c => digitsWhere(c, x => x >= 5),
    BOAT: c => digitsWhere(c, x => x >= 2),
    SNAKE_EYES: c => [indicesOf(c.s, '1')],
    CONTIGUOUS_PAIR: c => [range(...c.runs.find(([a, b]) => b - a >= 2))],
    CONTIGUOUS_TRIPS: c => [range(...c.runs.find(([a, b]) => b - a >= 3))],
    CONTIGUOUS_QUADS: c => [range(...c.runs.find(([a, b]) => b - a >= 4))],
    CONTIGUOUS_FIVES: c => [range(...c.runs.find(([a, b]) => b - a >= 5))],
    CONTIGUOUS_SIXES: c => [range(...c.runs.find(([a, b]) => b - a >= 6))],
    CONTIGUOUS_TWO_PAIR: c => { const i = findContiguousTwoPair(c.s); return [[i, i + 1], [i + 2, i + 3]]; },
    CONTIGUOUS_THREE_PAIR: c => findContiguousThreePair(c),
    CONTIGUOUS_BOAT: c => findContiguousBoat(c),
    FRAMED_PAIR: c => [[1, 2]],
    FRAMED_TRIPLE: c => [[1, 2, 3]],
    FRAMED_QUAD: c => [[1, 2, 3, 4]],
    FRAMED_DOUBLE: c => [[1, 2], [3, 4]],
    ULTIMEME: c => { const a = c.s.indexOf('69'), b = c.s.indexOf('420'); return [[a, a + 1], [b, b + 1, b + 2]]; },
    EQUATION: c => findEquation(c.s).groups,
    ARITHMETIC: c => findArithmeticSplit(c.s).groups,
    GEOMETRIC: c => findGeometricSplit(c.s).groups,
    CONSEC_PAIR_EXACT: c => findConsecutiveSplit(c.s, 2).groups,
    CONSEC_TRIPLE_EXACT: c => findConsecutiveSplit(c.s, 3).groups,
    CONSEC_TRIPLE_SCRAMBLED: c => findConsecutiveSplit(c.s, 3).groups,
    CONSEC_QUAD_EXACT: c => findConsecutiveSplit(c.s, 4).groups,
    CONSEC_QUAD_SCRAMBLED: c => findConsecutiveSplit(c.s, 4).groups,
    CONSEC_PAIR_ADJACENT: c => findConsecutivePairAdjacent(c.s),
    CONSEC_PAIR_NEARBY: c => findConsecutivePairNearby(c.s),
    CONSEC_TRIPLE_CONTAINS: c => findConsecutiveRunAdjacent(c.s, 3),
    CONSEC_QUAD_CONTAINS: c => findConsecutiveRunAdjacent(c.s, 4),
  };
  for (const [id, str] of Object.entries(CONTAINS)) HIGHLIGHTS[id] = c => { const i = c.s.indexOf(str); return [range(i, i + str.length)]; };
  for (const id of ['LUCKY_7']) HIGHLIGHTS[id] = c => [indicesOf(c.s, '7')];
  for (const [id, str] of Object.entries(ENDS)) HIGHLIGHTS[id] = c => [range(c.L - str.length, c.L)];
  for (const [id, dg] of Object.entries(SINGLE_DIGIT_COUNT)) HIGHLIGHTS[id] = c => [indicesOf(c.s, String(dg))];

  // ---------------------------------------------------------------- raretés
  const BADGE_TIERS = [[1e3, 'common'], [1e4, 'uncommon'], [1e5, 'rare'], [1e6, 'epic'], [1e7, 'anomaly']];
  // Carte : au-dessus de Mythic (top 1 %), trois raretés découpent le sommet : Celestial (top 0,1 %, 900 nombres),
  // Divine (top 0,01 %, 90 nombres) et Infinite (top 0,001 %, les 9 meilleurs nombres du jeu). Les badges s'arrêtent à Mythic.
  const CARD_TIERS = [[1, 'trash'], [50, 'common'], [75, 'uncommon'], [90, 'rare'], [95, 'epic'], [99, 'anomaly'], [99.9, 'mythic'], [99.99, 'celestial'], [99.999, 'divine']];
  const TIER_ORDER = ['trash', 'common', 'uncommon', 'rare', 'epic', 'anomaly', 'mythic', 'celestial', 'divine', 'infinite'];

  function badgeTier(score) {
    for (const [limit, tier] of BADGE_TIERS) if (score < limit) return tier;
    return 'mythic';
  }

  // ---------------------------------------------------------------- moteur
  function createEngine(meta, percentiles) {
    const badges = meta.map(b => {
      const check = CHECKS[b.id];
      if (!check) throw new Error('Badge sans check : ' + b.id);
      return Object.assign({}, b, { check, tier: badgeTier(b.score) });
    });
    const byId = new Map(badges.map(b => [b.id, b]));
    const pctKeys = percentiles ? percentiles.map(p => p[0]) : [];

    // Chemin rapide pour le build : total + callback par badge obtenu.
    function scoreOf(n, onBadge) {
      const c = contextOf(n);
      const bestByFamily = new Map();
      let total = 0;
      for (const b of badges) {
        if (!b.check(c)) continue;
        if (onBadge) onBadge(b);
        if (!b.family) { total += b.score; continue; }
        const cur = bestByFamily.get(b.family);
        if (!cur || b.score > cur.score) bestByFamily.set(b.family, b);
      }
      for (const b of bestByFamily.values()) total += b.score;
      return total;
    }

    function percentileOf(total) {
      if (!pctKeys.length) return 0;
      let lo = 0, hi = pctKeys.length - 1, found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (pctKeys[mid] <= total) { found = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return found < 0 ? 0 : percentiles[found][1];
    }

    function cardTier(total) {
      const p = percentileOf(total);
      for (const [limit, tier] of CARD_TIERS) if (p < limit) return tier;
      return 'infinite';
    }

    // Analyse complète pour l'affichage.
    function analyze(n) {
      const c = contextOf(n);
      const earned = badges.filter(b => b.check(c));
      const sorted = earned.slice().sort((a, b) => b.score - a.score);
      const families = new Map(), groups = [];
      for (const b of sorted) {
        if (!b.family) { groups.push({ badge: b, subsidiary: [] }); continue; }
        const g = families.get(b.family);
        if (g) g.subsidiary.push(b);
        else { const ng = { badge: b, subsidiary: [] }; families.set(b.family, ng); groups.push(ng); }
      }
      groups.sort((a, b) => b.badge.score - a.badge.score);
      const total = groups.reduce((acc, g) => acc + g.badge.score, 0);
      const percentile = percentileOf(total);
      return {
        number: n,
        str: c.s,
        total,
        percentile,
        tier: cardTier(total),
        groups,
        earnedIds: earned.map(b => b.id),
        scoringIds: groups.map(g => g.badge.id),
      };
    }

    function highlight(id, n) {
      const c = contextOf(n);
      const fn = HIGHLIGHTS[id];
      let groups = null;
      try { groups = fn ? fn(c) : null; } catch (e) { groups = null; }
      if (!groups || !groups.length || groups.some(g => !g)) return all(c);
      return groups;
    }

    // Tirage uniforme sur [0, 1 000 000] via crypto (rejet pour éviter le biais du modulo).
    function roll() {
      const span = MAX_ROLL + 1;
      const cryptoObj = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto : null;
      if (!cryptoObj) return Math.floor(Math.random() * span);
      const limit = Math.floor(0x100000000 / span) * span;
      const buf = new Uint32Array(1);
      do { cryptoObj.getRandomValues(buf); } while (buf[0] >= limit);
      return buf[0] % span;
    }

    function topLabel(percentile) {
      const top = 100 - percentile;
      // Jamais « <1 % » : sous 1 %, le chiffre exact (0,4 %, 0,05 %, 0,001 %).
      const exact = v => (v < .001 ? '<0.001' : formatPct(v));
      if (top <= 50) return 'TOP ' + exact(top) + '%';
      if (top > 90) return 'BOTTOM ' + exact(100 - top) + '%';
      return null;
    }

    return { badges, byId, analyze, scoreOf, highlight, percentileOf, cardTier, badgeTier, roll, topLabel, MAX_ROLL, TIER_ORDER };
  }

  function formatPct(v) {
    if (v >= 1) return String(Math.round(v));
    if (v >= 0.1) return v.toFixed(1).replace(/\.0$/, '');
    if (v >= 0.01) return v.toFixed(2).replace(/0$/, '');
    return v <= 0 ? '<0.001' : v.toFixed(3);
  }

  const api = { createEngine, MAX_ROLL, TIER_ORDER, badgeTier, formatPct };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RNGEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
