# Publishing `@everos-ai/convex`

## One-time setup

- `npm login` with an account that can publish under the `@everos-ai` scope
  (a member of the `everos-ai` npm org).
- Ensure the scope allows public publishing (`npm access` / org settings).

## Release checklist

1. **Build & test**

   ```bash
   npm install
   npm run build:codegen   # convex codegen for the component + tsc build
   npm test                # component tests (mocked EverOS API)
   npm run typecheck
   ```

2. **Verify the package contents**

   ```bash
   npm pack --dry-run
   ```

   Confirm `dist/` and `src/` are included and the entry points resolve:
   - `.` → `dist/client/index.js` (the `EverOS` client)
   - `./convex.config` + `./convex.config.js` → `dist/component/convex.config.js`
   - `./_generated/component` + `./_generated/component.js` → component types
   - `./test` → `src/test.ts` (the `register()` helper)

3. **Bump the version**

   ```bash
   npm version patch   # or minor / major
   ```

4. **Publish**

   ```bash
   npm publish --access public
   ```

   (`prepublishOnly` runs a clean build automatically.)

5. **Tag the release** and push:

   ```bash
   git push --follow-tags
   ```

## Submit to the Convex components directory

After publishing, submit at
**https://www.convex.dev/components/submit** with:

- npm package: `@everos-ai/convex`
- repo link
- the demo app in [`example/`](./example) (deploy it or link a walkthrough)
- README highlighting the `@convex-dev/agent` integration

## Notes

- Peer deps (`convex`, `@convex-dev/agent`, `zod`) are intentionally not
  bundled — consumers provide their own versions.
- `convex-helpers` is a runtime dependency (used for `paginator`).
- The `./test` entry points at source (`src/test.ts`) on purpose, so consuming
  apps' Vitest can glob the component's TypeScript modules.
