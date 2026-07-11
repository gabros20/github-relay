// The four injectable seams every adapter shares (design §2 Adapters):
// a fetch implementation, a sleep, a clock, and a retry budget. Tests pass
// fakes; production uses the real globals. `withSeamDefaults` lets each
// adapter be constructed with only the seams a given test cares about.

export interface Seams {
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  maxRetries: number;
}

export const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function withSeamDefaults(o: Partial<Seams> = {}): Seams {
  return {
    fetchImpl: o.fetchImpl ?? fetch,
    sleep: o.sleep ?? defaultSleep,
    now: o.now ?? Date.now,
    maxRetries: o.maxRetries ?? 3,
  };
}
