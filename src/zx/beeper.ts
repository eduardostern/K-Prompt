/**
 * The beeper: the ULA's EAR and MIC output bits (port FEh bits 4 and 3)
 * drive one speaker, so all Spectrum sound is the CPU toggling a bit at
 * the right moments. Each change is noted with its T-state; at the end of
 * a frame every output sample is the average level over its stretch of
 * T-states, which keeps the square waves free of aliasing whistles.
 */
export class Beeper {
  /** The current level, 0..1. */
  private level = 0;
  private changeT: number[] = [];
  private changeL: number[] = [];
  /** Fraction of a sample carried between frames. */
  private carry = 0;
  private out: number[] = [];

  constructor(public clock: number, readonly sampleRate: number) {}

  private ear = false;
  private mic = false;
  private tape = false;

  /** Port FEh output at T-state `t` (from the start of the frame). */
  setOutput(t: number, ear: boolean, mic: boolean): void {
    this.ear = ear;
    this.mic = mic;
    this.change(t);
  }

  /** The tape's signal, heard quietly while it plays (as through the recorder's speaker). */
  setTape(t: number, level: boolean): void {
    this.tape = level;
    this.change(t);
  }

  private change(t: number): void {
    // EAR is by far the loudest; MIC and the tape leak in quietly.
    const level = (this.ear ? 0.75 : 0) + (this.mic ? 0.08 : 0) + (this.tape ? 0.12 : 0);
    if (level === this.level) return;
    this.changeT.push(Math.max(t, 0));
    this.changeL.push(level);
    this.level = level;
  }

  /** Turns `frameT` T-states into samples, appended to the output. */
  endFrame(frameT: number): void {
    const tPerSample = this.clock / this.sampleRate;
    let level = this.startLevel;
    let i = 0;
    let t = -this.carry * tPerSample;
    while (t + tPerSample <= frameT) {
      const end = t + tPerSample;
      let sum = 0;
      let from = Math.max(t, 0);
      while (i < this.changeT.length && this.changeT[i] < end) {
        const at = Math.max(this.changeT[i], from);
        sum += level * (at - from);
        from = at;
        level = this.changeL[i++];
      }
      sum += level * (end - from);
      this.out.push(sum / (end - Math.max(t, 0)));
      t = end;
    }
    this.carry = (frameT - t) / tPerSample;
    this.changeT.length = 0;
    this.changeL.length = 0;
    this.startLevel = this.level;
  }

  private startLevel = 0;

  /** The samples made since the last call. */
  take(): Float32Array<ArrayBuffer> {
    const s = new Float32Array(this.out);
    this.out.length = 0;
    return s;
  }
}
