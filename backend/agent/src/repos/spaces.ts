/**
 * spaces repo — ARCHITECTURE.md §2.2 (repos/, one per collection). Ownership is part of
 * every filter, never a read-then-check: a Space belonging to someone else comes back as
 * `null` and the route turns that into a 404, so a probing client cannot tell a foreign
 * Space from one that does not exist.
 */
import type { Db } from 'mongodb';
import { COLLECTIONS, type SpaceDoc } from '@lumina/contract';

export interface SpaceRow {
  spaceId: string;
  userId: string;
  name: string;
  createdAt: string;
}

export interface SpacesRepo {
  insert(row: SpaceRow): Promise<void>;
  listByUser(userId: string): Promise<SpaceRow[]>;
  findOwned(args: { spaceId: string; userId: string }): Promise<SpaceRow | null>;
}

const iso = (v: string | Date): string => (typeof v === 'string' ? v : v.toISOString());

const toRow = (doc: SpaceDoc): SpaceRow => ({
  spaceId: doc._id,
  userId: doc.userId,
  name: doc.name,
  createdAt: iso(doc.createdAt)
});

export function makeSpacesRepo(db: Db): SpacesRepo {
  const col = db.collection<SpaceDoc>(COLLECTIONS.spaces);
  return {
    async insert(row) {
      await col.insertOne({
        _id: row.spaceId,
        userId: row.userId,
        name: row.name,
        createdAt: row.createdAt
      });
    },

    async listByUser(userId) {
      const docs = await col.find({ userId }).sort({ createdAt: -1 }).toArray();
      return docs.map(toRow);
    },

    async findOwned({ spaceId, userId }) {
      const doc = await col.findOne({ _id: spaceId, userId });
      return doc ? toRow(doc) : null;
    }
  };
}
