export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Relógio controlado para testes: só anda quando alguém manda. */
export class FixedClock implements Clock {
  private current: number;

  constructor(start: Date | string) {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  set(at: Date | string): void {
    this.current = new Date(at).getTime();
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
