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

Any static host works. The build must run `convex deploy` first so
`VITE_CONVEX_URL` points at the production deployment:

```
Build command:      npx convex deploy --cmd 'npm run build'
Output directory:   dist
Root directory:     example
Env var:            CONVEX_DEPLOY_KEY   (from the Convex dashboard, Production)
```

On Vercel that is the whole configuration. `npm run build` is
`tsc -b && vite build` and type-checks strictly, so a type error fails the
deploy rather than shipping a broken bundle.

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
video and before a launch so the first visitor sees a clean slate.

## Checklist before the demo link goes public

- [ ] Backend deployed, env vars set on production
- [ ] Frontend deployed, chat and escalation both work against production
- [ ] Escalation shows the specialist greeting the customer by name
- [ ] Memory panel is populated and readable
- [ ] Spending cap on the LLM key
- [ ] `demo:clearAll` run so the first visitor starts clean
