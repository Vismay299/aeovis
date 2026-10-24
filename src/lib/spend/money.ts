const MICROS_PER_USD = 1_000_000;

export function toMicros(n: number): number {
  return Math.round(n * MICROS_PER_USD);
}

export function fromMicros(m: number): number {
  return m / MICROS_PER_USD;
}

export function usd6(n: number): number {
  return fromMicros(toMicros(n));
}
