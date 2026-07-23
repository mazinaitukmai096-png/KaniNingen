const CUES = Object.freeze({
  attack: Object.freeze([[180, 0.1, 'square', 0.15, 50]]),
  swish: Object.freeze([[600, 0.15, 'triangle', 0.3, 40]]),
  hit: Object.freeze([[60, 0.2, 'sawtooth', 0.1, 20]]),
  splat: Object.freeze([[40, 0.15, 'sawtooth', 0.4, 10]]),
  'tank-fire': Object.freeze([[120, 0.45, 'sawtooth', 0.35, 10], [50, 0.25, 'triangle', 0.4, 5]]),
  roar: Object.freeze([[70, 0.8, 'sawtooth', 0.5, 25], [110, 0.5, 'square', 0.3, 40]]),
  rumble: Object.freeze([[35, 0.3, 'sawtooth', 0.15, 10]]),
  acid: Object.freeze([[800, 0.25, 'square', 0.18, 150]]),
  atomic: Object.freeze([[28, 2.5, 'sawtooth', 0.65, 3], [95, 1.2, 'square', 0.4, 8]]),
});

export function createW8AudioDirector({ globalObject = globalThis, volume = 0.5 } = {}) {
  let context = null;
  let masterGain = null;
  let currentVolume = Math.max(0, Math.min(1, volume));
  let disposed = false;
  let playedCueCount = 0;

  function ensureContext() {
    if (disposed) return null;
    const Context = globalObject.AudioContext ?? globalObject.webkitAudioContext;
    if (typeof Context !== 'function') return null;
    if (!context) {
      context = new Context();
      masterGain = context.createGain();
      masterGain.gain.value = currentVolume;
      masterGain.connect(context.destination);
    }
    if (context.state === 'suspended') void context.resume?.();
    return context;
  }

  function beep(frequency, duration, type, gainValue, endFrequency) {
    const audio = ensureContext();
    if (!audio || !masterGain) return false;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, audio.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, endFrequency), audio.currentTime + duration);
    gain.gain.setValueAtTime(gainValue, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + duration);
    oscillator.connect(gain); gain.connect(masterGain);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    oscillator.start(); oscillator.stop(audio.currentTime + duration);
    return true;
  }

  function play(cue) {
    const voices = CUES[cue];
    if (!voices) return false;
    let played = false;
    for (const voice of voices) played = beep(...voice) || played;
    if (played) playedCueCount += 1;
    return played;
  }

  return Object.freeze({
    schemaVersion: 'w8-finite-web-audio-director-1',
    play,
    consume(events = []) {
      for (const event of events) if (event.soundCue) play(event.soundCue);
    },
    setVolume(value) {
      currentVolume = Math.max(0, Math.min(1, Number(value)));
      if (masterGain) masterGain.gain.value = currentVolume;
      return currentVolume;
    },
    snapshot: () => Object.freeze({
      contextCreated: context !== null, volume: currentVolume, playedCueCount, disposed,
    }),
    async dispose() {
      if (disposed) return;
      disposed = true;
      try { masterGain?.disconnect?.(); await context?.close?.(); } catch { /* browser shutdown */ }
    },
  });
}
