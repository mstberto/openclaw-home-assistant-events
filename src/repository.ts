import { documentSchema, emptyDocument, type StateDocument } from './model.js';

export interface DocumentStore {
  lookup(key: string): Promise<unknown>;
  register(key: string, value: StateDocument): Promise<void>;
}
/** One service instance per Gateway. A single record commits subscriptions and outbox atomically. */
export class Repository {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: DocumentStore) {}
  transact<T>(change: (document: StateDocument) => T): Promise<T> {
    const operation = this.tail.then(async () => {
      const stored = await this.store.lookup('document');
      const document = stored === undefined ? emptyDocument() : documentSchema.parse(stored);
      const result = change(document);
      // Schema check also bounds stored state; failed writes never update an in-memory cache.
      await this.store.register('document', documentSchema.parse(document));
      return result;
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }
  read(): Promise<StateDocument> {
    const operation = this.tail.then(async () => {
      const stored = await this.store.lookup('document');
      return stored === undefined ? emptyDocument() : documentSchema.parse(stored);
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }
  async settled(): Promise<void> { await this.tail; }
}
