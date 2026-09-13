import type { Db } from 'mongodb';
import { COLLECTIONS, type SearchCacheDoc } from '@lumina/contract';
import type { SearchCacheStore } from '../providers/search/cached.js';

/** L2 of the search cache. Rows expire via the TTL index on `expiresAt`; never delete by hand. */
export function makeSearchCacheRepo(db: Db): SearchCacheStore {
  const col = db.collection<SearchCacheDoc>(COLLECTIONS.searchCache);
  return {
    async get(key) {
      return col.findOne({ _id: key });
    },
    async set(doc) {
      await col.replaceOne({ _id: doc._id }, doc, { upsert: true });
    }
  };
}
