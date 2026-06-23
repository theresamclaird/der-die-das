// Amplify Gen 2 backend entrypoint (Phase 1). Wires auth + data; `npx ampx
// sandbox` (dev) or a pipeline deploy provisions Cognito + DynamoDB and emits
// amplify_outputs.json, which the client loads at runtime (see main.jsx).
import { defineBackend } from "@aws-amplify/backend";
import { auth } from "./auth/resource";
import { data } from "./data/resource";

defineBackend({
  auth,
  data,
});
