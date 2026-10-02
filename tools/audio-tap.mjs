// Enregistreur de la sortie audio d'une page, pour les outils qui pilotent un navigateur (sound-check, reveal-film).
// À poser avant les scripts de la page : page.addInitScript(TAP). Tout ce qui part vers la sortie audio est aussi copié,
// échantillon par échantillon, dans window.__rec :
//   __rec.samples()     nombre d'échantillons enregistrés
//   __rec.flat(depuis)  { L, R } en un seul tableau, à partir d'un échantillon
//   __rec.wav()         le tout en fichier WAV 16 bits, encodé en base64
//   __rec.rate, __rec.ctx, __rec.contexts   débit, sortie audio de la page, nombre de sorties ouvertes
export const TAP = () => {
  const Orig = window.AudioContext, connect = AudioNode.prototype.connect;
  const rec = (window.__rec = { L: [], R: [], rate: 0, ctx: null, contexts: 0 });
  window.AudioContext = function (opts) {
    const ctx = opts ? new Orig(opts) : new Orig();
    rec.ctx = ctx; rec.rate = ctx.sampleRate; rec.contexts++;
    const tap = ctx.createScriptProcessor(4096, 2, 2), mute = ctx.createGain();
    mute.gain.value = 0;
    tap.onaudioprocess = e => { rec.L.push(new Float32Array(e.inputBuffer.getChannelData(0))); rec.R.push(new Float32Array(e.inputBuffer.getChannelData(1))); };
    connect.call(tap, mute);
    connect.call(mute, ctx.destination);
    ctx.__tap = tap;
    return ctx;
  };
  window.AudioContext.prototype = Orig.prototype;
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (dest instanceof AudioDestinationNode && this.context.__tap) connect.call(this, this.context.__tap);
    return connect.apply(this, [dest, ...rest]);
  };
  rec.samples = () => rec.L.reduce((s, c) => s + c.length, 0);
  rec.flat = (from = 0) => {
    const n = rec.samples(), L = new Float32Array(n), R = new Float32Array(n);
    let at = 0;
    rec.L.forEach((c, i) => { L.set(c, at); R.set(rec.R[i], at); at += c.length; });
    return { L: L.subarray(from), R: R.subarray(from) };
  };
  rec.wav = () => {
    const { L, R } = rec.flat(), n = L.length, bytes = new Uint8Array(44 + n * 4), v = new DataView(bytes.buffer);
    const text = (at, s) => { for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i); };
    text(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); text(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
    v.setUint32(24, rec.rate, true); v.setUint32(28, rec.rate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); text(36, 'data'); v.setUint32(40, n * 4, true);
    for (let i = 0; i < n; i++) { v.setInt16(44 + i * 4, Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), true); v.setInt16(46 + i * 4, Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), true); }
    let bin = '';
    for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
    return btoa(bin);
  };
};
