# Releasing

A release is a version bump in a pull request: when it's merged to `main`, CI (`.github/workflows/publish.yml`) publishes every package whose version isn't on npm yet, through npm trusted publishing (no token, with provenance). Nobody publishes a release by hand.

- npm holds a new version as staged for some minutes, and `npm view` doesn't show it yet. CI treats the `409 previously staged version` a run in that window gets as published, and publish runs queue, so merging two pull requests in a row is fine.
- A package that fails to publish doesn't stop the others; the job fails at the end.

## First publish of a new package

A package can only trust a workflow once it exists on npm, so CI skips a package npm doesn't know yet (with a notice). And a trusted publisher **expires 48 hours after it is created unless a publish through it succeeds**; after that first CI publish it stays. So:

1. By hand, publish a placeholder version `0.0.0-stage` under the `stage` tag (below), so the package exists and `latest` stays free.
2. On npmjs.com, in the package's settings, add the trusted publisher: GitHub Actions, `usecds` / `cds`, workflow `publish.yml`, no environment.
3. Within 48 hours, merge the pull request with the package's real version: CI publishes it, which validates the trusted publisher.

If the trusted publisher expired (a 404 from `npm publish` in CI), delete it, create it again and release within 48 hours. Create it right before a release, never ahead of one.

### Token

If your npm 2FA is a hardware key, the CLI can't ask for a one-time code. Create a short-lived granular access token on npmjs.com instead: read and write, limited to the `@usecds` scope, "bypass two-factor authentication" on, expiry a day. Keep it out of the repo and revoke it afterwards. npm is restricting tokens that bypass 2FA, so this may stop working; then publish the placeholder from the browser-authenticated CLI (`npm login`, then `npm publish` opens the security key prompt in the browser).

### Build and pack

Set the version to `0.0.0-stage` for the pack only (don't commit it):

```bash
pnpm install
pnpm build                      # the package and everything it builds on
cd <package>                    # e.g. s3
npm pkg set version=0.0.0-stage
pnpm pack                       # writes usecds-<package>-0.0.0-stage.tgz
git checkout package.json
tar -tzf usecds-*.tgz           # only package.json, README, LICENSE and dist/ (server and client: schemas/)
```

Pack with pnpm, never `npm publish` from the folder: pnpm turns `workspace:^` into a version range, npm would publish it as is.

### Publish with the token

```bash
printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > ~/.npmrc-usecds
npm publish usecds-*.tgz --access public --tag stage --userconfig ~/.npmrc-usecds
rm ~/.npmrc-usecds usecds-*.tgz
npm view @usecds/<package> dist-tags
```

Then add the trusted publisher (step 2), revoke the token, and release (step 3).
