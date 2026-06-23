// amplifyAdapter.js — the Amplify/AppSync implementation of the sync backend
// interface consumed by sync.js. ALL aws-amplify imports live here, so the rest
// of the app (engine, db, UI) stays backend-agnostic and the adapter can be
// swapped (DESIGN extensibility principle). If Amplify isn't configured or the
// user is signed out, isReady() returns false and the app stays local-only.
import { generateClient } from "aws-amplify/data";
import { getCurrentUser } from "aws-amplify/auth";

export class AmplifyAdapter {
  constructor() {
    this._client = null;
    this._idByCardId = new Map(); // cardId -> remote row id (cached from list)
  }

  client() {
    // Lazy: generateClient must run after Amplify.configure().
    if (!this._client) this._client = generateClient();
    return this._client;
  }

  // Configured (Amplify.configure ran) AND a user is signed in.
  async isReady() {
    try {
      await getCurrentUser();
      return true;
    } catch {
      return false;
    }
  }

  // All CardState rows for the signed-in owner. Caches cardId->id for upserts.
  async listCardStates() {
    const out = [];
    let nextToken = undefined;
    do {
      const res = await this.client().models.CardState.list({ nextToken, limit: 1000 });
      for (const r of res.data ?? []) {
        this._idByCardId.set(r.cardId, r.id);
        out.push({ cardId: r.cardId, fsrs: r.fsrs, lastReview: r.lastReview });
      }
      nextToken = res.nextToken;
    } while (nextToken);
    return out;
  }

  // Create-or-update a card's state, keyed on cardId within this owner.
  async upsertCardState({ cardId, fsrs, due, lastReview }) {
    const existing = this._idByCardId.get(cardId);
    if (existing) {
      await this.client().models.CardState.update({ id: existing, fsrs, due, lastReview });
    } else {
      const res = await this.client().models.CardState.create({ cardId, fsrs, due, lastReview });
      if (res?.data?.id) this._idByCardId.set(cardId, res.data.id);
    }
  }

  // Append immutable review-log rows. Distinct rows never conflict.
  async createReviewLogs(entries) {
    for (const e of entries) {
      await this.client().models.ReviewLog.create(e);
    }
  }
}
