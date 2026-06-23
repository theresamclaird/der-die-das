# Deploying to production (AWS Amplify Hosting)

This deploys the **fullstack** app — the React PWA *and* its Gen 2 backend
(Cognito + DynamoDB) — via Amplify Hosting's Git-based CI/CD. Every push to
`main` rebuilds and redeploys.

**Important:** the production backend is a **separate** Cognito pool + DynamoDB
from your local `ampx sandbox`. Accounts and progress do **not** carry over — you
create a fresh account on the deployed site. The sandbox stays for local dev.

## 0. Commit and push (from your machine, not the sandbox)

The Phase 1 code is in your working tree but not yet committed. From the repo
root:

```bash
# If git complains about an existing .git/index.lock, remove it first:
#   rm -f .git/index.lock
git add -A
git commit -m "Phase 1: Amplify Gen 2 auth + cross-device sync"
git push origin main
```

`amplify_outputs.json` is git-ignored on purpose — production generates its own
during the build.

## 1. Create the Amplify Hosting app

1. AWS console → **Amplify** → **Create new app** (or "Deploy an app").
2. Source: **GitHub** → authorize → pick repo **`theresamclaird/der-die-das`**,
   branch **`main`**.
3. Amplify detects the monorepo `amplify.yml` (appRoot `web/`) and the Gen 2
   backend under `web/amplify/`. It should offer a **fullstack** deployment —
   accept it; the build settings come from the committed `amplify.yml`, so don't
   override them.
4. **Region:** create the app in **us-west-2 (Oregon)** to match your sandbox /
   existing CDK bootstrap. (Any region works, but keeping one region is tidiest.)

## 2. Service role (backend deploy permissions)

The first fullstack build runs `npx ampx pipeline-deploy`, which provisions the
backend via CloudFormation/CDK. Amplify will prompt to **create/select an IAM
service role** with deploy permissions — let it create the default one. (CDK
bootstrap already exists in us-west-2 from your sandbox, so no extra bootstrap
step is needed there.)

## 3. Deploy

Save and deploy. The first build takes ~5–10 min and runs two phases:
`backend` (provision Cognito + DynamoDB, emit `amplify_outputs.json`) then
`frontend` (`vite build`). Watch the build log if anything fails — the most
common first-time issue is the service role missing a permission, which the log
names explicitly.

## 4. Verify

1. Open the `https://main.<app-id>.amplifyapp.com` URL.
2. **Sign in to sync** → create a **new** account (prod pool) → confirm via the
   emailed code (check spam).
3. Do a couple of reviews; the footer should show your email + a "synced …" time.
4. Optional cross-device check: open the same URL on your phone, sign in, and
   confirm progress matches after a sync.

## 5. Optional follow-ups

- **Custom domain:** Amplify console → your app → **Hosting → Custom domains**.
- **PWA install:** once on HTTPS, "Add to Home Screen" works on the phone.
- **Cost:** Cognito + DynamoDB + Amplify Hosting all sit at/near free tier at this
  scale.
- **Tear down a bad first attempt:** delete the Amplify app in the console; it
  removes the hosted site and the backend stack it created.
