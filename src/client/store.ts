/** Immutable snapshots; synchronous mutation guards do not depend on React render timing. */
export class Store<State extends object> {
  protected state: Readonly<State>;
  private readonly listeners = new Set<() => void>();
  constructor(initial: State) {
    this.state = Object.freeze(initial);
  }
  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  protected patch(changes: Partial<State>) {
    this.state = Object.freeze({ ...this.state, ...changes });
    for (const listener of this.listeners) listener();
  }
}
