// Cognito auth (DESIGN §5, Phase 1). Email + password sign-in.
// Study works logged-out; signing in only enables cross-device sync, so this
// is intentionally minimal — no MFA, no social providers in v1.
import { defineAuth } from "@aws-amplify/backend";

export const auth = defineAuth({
  loginWith: {
    email: true,
  },
});
