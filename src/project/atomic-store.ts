export class AtomicResourceStore<T> {
  #current: T;

  constructor(initial: T) {
    this.#current = initial;
  }

  snapshot(): T {
    return this.#current;
  }

  async reload(buildCandidate: () => Promise<T>): Promise<T> {
    const candidate = await buildCandidate();
    this.#current = candidate;
    return candidate;
  }
}
