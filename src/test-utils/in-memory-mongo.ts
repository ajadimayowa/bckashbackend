import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, connect } from 'mongoose';

/**
 * Shared helper for tests that need real Mongoose behavior (unique indexes,
 * atomic findOneAndUpdate guards, transactions) rather than a mocked model —
 * mocking Mongoose's fluent query builder is brittle and proves little for the
 * things that actually matter here (concurrency guards, index enforcement).
 *
 * Uses a single-node replica set (not a plain standalone) because several
 * modules rely on multi-document transactions (see project brief — Atlas is
 * assumed to run as a replica set in production).
 *
 * `start()` both boots the replica set and opens a direct mongoose connection
 * (useful for setup/teardown/index inspection in the test itself); pass
 * `getUri()` to `MongooseModule.forRoot(...)` for Nest's own, separate
 * connection to the same replica set.
 */
export class InMemoryMongo {
  private replSet?: MongoMemoryReplSet;
  private connection?: Connection;

  async start(): Promise<Connection> {
    this.replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const mongooseInstance = await connect(this.replSet.getUri());
    this.connection = mongooseInstance.connection;
    return this.connection;
  }

  getUri(): string {
    if (!this.replSet) {
      throw new Error('InMemoryMongo.start() must be called before getUri()');
    }
    return this.replSet.getUri();
  }

  async stop(): Promise<void> {
    await this.connection?.close();
    await this.replSet?.stop();
  }

  async clearAllCollections(): Promise<void> {
    if (!this.connection?.db) {
      return;
    }
    const collections = await this.connection.db.collections();
    await Promise.all(collections.map((collection) => collection.deleteMany({})));
  }
}
