import type { Move } from "chess.js";

type SoundKind = "start" | "move" | "capture" | "check" | "win" | "loss" | "draw" | "undo";

/** Small Web Audio soundscape: warm, restrained, and dependency-free. */
export class ChessSounds {
  private context: AudioContext | null = null;
  private closed = false;

  constructor(private readonly volume: () => number) {}

  playMove(move: Move, isCheck: boolean, outcome: "win" | "loss" | "draw" | null): void {
    if (outcome) return this.play(outcome);
    if (isCheck) return this.play("check");
    this.play(move.captured ? "capture" : "move");
  }

  play(kind: SoundKind): void {
    const level = Math.max(0, Math.min(1, this.volume()));
    if (level <= 0) return;

    const audio = this.getContext();
    if (!audio) return;
    if (audio.state === "suspended") void audio.resume();

    const now = audio.currentTime + 0.008;
    const gain = level * 0.32;
    switch (kind) {
      case "move":
        this.woodTap(audio, now, 175, gain);
        break;
      case "capture":
        this.woodTap(audio, now, 128, gain * 1.12);
        this.tone(audio, now + 0.018, 92, 0.13, gain * 0.36, "sine", 68);
        break;
      case "check":
        this.woodTap(audio, now, 150, gain * 0.75);
        this.tone(audio, now + 0.025, 659.25, 0.24, gain * 0.34, "sine", 523.25);
        this.tone(audio, now + 0.09, 987.77, 0.28, gain * 0.22, "sine", 783.99);
        break;
      case "start":
        this.pluckChord(audio, now, [261.63, 329.63, 392], gain * 0.28, 0.06);
        break;
      case "undo":
        this.tone(audio, now, 392, 0.12, gain * 0.22, "triangle", 293.66);
        this.tone(audio, now + 0.055, 293.66, 0.15, gain * 0.18, "triangle", 220);
        break;
      case "win":
        this.tone(audio, now, 261.63, 0.36, gain * 0.28, "sine", 329.63);
        this.tone(audio, now + 0.1, 329.63, 0.4, gain * 0.26, "sine", 392);
        this.pluckChord(audio, now + 0.21, [392, 493.88, 659.25], gain * 0.24, 0.04);
        break;
      case "loss":
        this.tone(audio, now, 329.63, 0.42, gain * 0.22, "triangle", 293.66);
        this.tone(audio, now + 0.11, 246.94, 0.48, gain * 0.2, "sine", 196);
        this.tone(audio, now + 0.22, 164.81, 0.52, gain * 0.16, "sine", 146.83);
        break;
      case "draw":
        this.pluckChord(audio, now, [220, 293.66, 329.63], gain * 0.2, 0.04);
        break;
    }
  }

  close(): void {
    this.closed = true;
    if (this.context) void this.context.close();
    this.context = null;
  }

  /** Once closed, stay closed: a bot move can still land after the pane is gone,
   *  and re-creating a context there leaks one nobody will ever close. */
  private getContext(): AudioContext | null {
    if (this.closed) return null;
    if (this.context) return this.context;
    try {
      this.context = new window.AudioContext();
      return this.context;
    } catch {
      return null;
    }
  }

  private woodTap(audio: AudioContext, at: number, frequency: number, level: number): void {
    this.tone(audio, at, frequency, 0.085, level, "triangle", frequency * 0.62);
    this.tone(audio, at + 0.006, frequency * 2.7, 0.045, level * 0.22, "sine", frequency * 1.4);
  }

  private pluckChord(audio: AudioContext, at: number, notes: number[], level: number, stagger: number): void {
    notes.forEach((note, index) => {
      this.tone(audio, at + index * stagger, note, 0.42, level, "sine", note * 0.997);
      this.tone(audio, at + index * stagger, note * 2, 0.22, level * 0.12, "triangle", note * 1.6);
    });
  }

  private tone(
    audio: AudioContext,
    at: number,
    frequency: number,
    duration: number,
    level: number,
    type: OscillatorType,
    endFrequency = frequency
  ): void {
    const oscillator = audio.createOscillator();
    const envelope = audio.createGain();
    const filter = audio.createBiquadFilter();

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, at);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), at + duration);
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(2400, at);
    filter.frequency.exponentialRampToValueAtTime(900, at + duration);
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0001, level), at + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration);

    oscillator.connect(filter);
    filter.connect(envelope);
    envelope.connect(audio.destination);
    oscillator.start(at);
    oscillator.stop(at + duration + 0.02);
  }
}
