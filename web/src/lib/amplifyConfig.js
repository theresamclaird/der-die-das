// amplifyConfig.js — configure Amplify *only if* the backend has been deployed.
//
// `amplify_outputs.json` is generated at the project root by `npx ampx sandbox`
// / a pipeline deploy and is git-ignored. We load it with import.meta.glob so a
// missing file is a no-op at build time (an empty match) rather than a build
// error — that keeps the app fully usable in local-only mode before any AWS
// exists. Returns true when Amplify was configured.
import { Amplify } from "aws-amplify";

export function configureAmplify() {
  const matches = import.meta.glob("/amplify_outputs.json", { eager: true });
  const mod = Object.values(matches)[0];
  const outputs = mod && (mod.default || mod);
  if (!outputs) return false;
  try {
    Amplify.configure(outputs);
    return true;
  } catch {
    return false;
  }
}

export const amplifyConfigured = configureAmplify();
