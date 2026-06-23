// Amplify Data schema (DESIGN §6, Phase 1). Maps the local IndexedDB shape
// (db.js) onto DynamoDB-backed models, one row per user via owner auth.
//
// Design notes / divergences from DESIGN §6:
//  - DESIGN §6 sketches a hand-rolled single-table design (PK USER#<uid>).
//    Amplify Data models each map to their own table with owner-based
//    authorization; that achieves the same per-user scoping and last-write-wins
//    goals without us managing partition keys by hand. The DynamoDB *data model*
//    intent is unchanged: tiny per-user items + an append-only log.
//  - We keep Amplify's auto-generated `id` as the primary key (NOT a custom
//    identifier of cardId) so the schema stays correct if a second user is ever
//    added — business keys like cardId are not globally unique across users.
//    Sync upserts CardState by listing the owner's rows and matching on cardId.
import { type ClientSchema, a, defineData } from "@aws-amplify/backend";

const schema = a.schema({
  // Per-card FSRS state — the schedule. One row per (owner, cardId).
  // `fsrs` is the opaque ts-fsrs blob; `lastReview` drives last-write-wins.
  CardState: a
    .model({
      cardId: a.string().required(),
      fsrs: a.json().required(),
      due: a.datetime(),
      lastReview: a.datetime(),
    })
    .secondaryIndexes((index) => [index("cardId")])
    .authorization((allow) => [allow.owner()]),

  // Append-only review log (DESIGN §4.5). Immutable rows, never updated, so
  // they never conflict across devices. `clientSeq` is the local IndexedDB
  // autoincrement key, carried for idempotent push / de-duplication.
  ReviewLog: a
    .model({
      clientSeq: a.integer(),
      cardId: a.string().required(),
      lemma: a.string(),
      rating: a.integer(),
      correct: a.boolean(),
      latency_ms: a.integer(),
      recall_ms: a.integer(),
      discarded: a.boolean(),
      overridden: a.boolean(),
      cram: a.boolean(),
      ts: a.datetime(),
    })
    .authorization((allow) => [allow.owner()]),

  // One settings row per user (active levels, budgets, toggles).
  UserSettings: a
    .model({
      activeLevels: a.string().array(),
      newPerDay: a.integer(),
      requestRetention: a.float(),
      colorCoding: a.boolean(),
      theme: a.string(),
    })
    .authorization((allow) => [allow.owner()]),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "userPool",
  },
});
