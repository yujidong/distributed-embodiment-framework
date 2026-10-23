/**
 * Procedural walk audio — no asset files. A filtered noise burst makes the
 * footstep (classic synth-as-foley trick); pitch and brightness jitter a
 * little per step so it doesn't sound like a machine gun.
 *
 * The AudioContext must be created from a user gesture: the page calls
 * unlockAudio() from its canvas click. Everything degrades to a no-op when
 * audio is unavailable — walking must never depend on sound.
 */

let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;
let muted = false;

export function unlockAudio(): void {
  if (ctx || muted) return;
  try {
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    const len = Math.floor(ctx.sampleRate * 0.09);
    noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  } catch {
    ctx = null;
  }
}

export function toggleMuted(): boolean {
  muted = !muted;
  return muted;
}

/** intensity 0..1（步行→疾跑）：每步一个短噪声脉冲。 */
export function footstep(intensity: number): void {
  if (muted || !ctx || !noise) return;
  try {
    if (ctx.state === 'suspended') void ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.playbackRate.value = 0.85 + Math.random() * 0.3;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420 + Math.random() * 260;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.04 + intensity * 0.05, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.085);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    src.start();
  } catch {
    /* 音频失败不影响行走 */
  }
}
