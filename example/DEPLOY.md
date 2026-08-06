# Deploying the Mindy demo

The demo is the live link on the Convex components directory submission and the
source of launch screenshots, so it runs as a real deployment rather than a
local backend. Two pieces: a Convex production deployment for the backend, and
a static host for the Vite frontend.

Everything below except the two interactive logins is a single command.

## 1. Convex production deployment

```bash
cd example
npx convex login          # interactive, opens a browser
npx convex deploy         # creates/pushes to the production deployment
```

Then set the deployment's environment variables:

```bash
npx convex env set EVEROS_API_KEY <uuid> --prod
npx convex env set OPENROUTER_API_KEY sk-or-... --prod
# optional, defaults to https://api.evermind.ai
npx convex env set EVEROS_BASE_URL https://api.evermind.ai --prod
```

Use a **separate EverOS key for the demo**, not a personal one. Demo traffic is
public and its memories should be disposable.

## 2. Frontend

Live at **https://everos-convex-demo.vercel.app** (Vercel project
`everos-convex-demo`).

This app links the component with `file:..`, which cannot resolve if a host
only uploads `example/`, so the bundle is **built locally and uploaded
prebuilt**. `vercel.json` skips the install and build steps and serves `dist/`,
and `.vercelignore` (which replaces `.gitignore` for uploads) lets the
gitignored `dist/` ship while keeping `.env.local` and `node_modules` out.

Build and deploy in one go:

```bash
cd example
npx convex deploy --cmd 'npm run build'   # backend + frontend built against prod
npx vercel deploy --prod --yes
```

Build with `npx convex deploy --cmd 'npm run build'`, never a bare
`npm run build`: the wrapper injects the **production** `VITE_CONVEX_URL`,
while a bare build reads `.env.local` and bakes in the **dev** deployment URL.
After building, confirm the right deployment is in the bundle:

```bash
grep -o "https://[a-z0-9-]*\.convex\.cloud" dist/assets/*.js | sort -u
```

`npm run build` is `tsc -b && vite build` and type-checks strictly, so a type
error fails the build rather than shipping a broken bundle.

## 3. Cost and abuse

The demo has no sign-in and runs on our LLM key, so it is capped:
`DEMO_MESSAGE_LIMIT` in `convex/chat.ts` gives each conversation 12 messages,
after which the composer shows a notice pointing at `npm i @everos/convex`.
A visitor can start fresh from a new browser profile, so treat this as a spend
guard against loops and casual abuse, not as access control.

Before launch:

- Put a spending cap on the OpenRouter key used here.
- Confirm the EverOS key is demo-only and its memories are disposable.
- Consider lowering `DEMO_MESSAGE_LIMIT` if launch traffic is heavier than
  expected. It is one constant and a redeploy.

## 4. Resetting

`npx convex run demo:clearAll --prod` deletes every demo conversation, the
console state, and the customers' EverOS memories. Run it after recording a
video and before a launch so the first visitor sees a clean slate. Visitors
type into a memory store we own, so this is also the privacy hygiene step:
run it periodically once the link is public.

## 5. What the console shows

The right-hand console has a live pipeline line above the activity log: it
reports how many memories are still being written to EverOS and turns amber
with the reason if any failed. It is a reactive Convex query over the
component's `getPendingStatus`, so the count falls on its own as extraction
completes. Worth pointing a camera at: it makes the asynchronous write path
visible instead of looking like lag.

## Checklist before the demo link goes public

- [ ] Backend deployed, env vars set on production
- [ ] Frontend deployed, chat and escalation both work against production
- [ ] Escalation shows the specialist greeting the customer by name
- [ ] Memory panel is populated and readable
- [ ] Spending cap on the LLM key
- [ ] `demo:clearAll` run so the first visitor starts clean
