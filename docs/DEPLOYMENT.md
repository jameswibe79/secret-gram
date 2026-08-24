# Deployment guide

This guide deploys the React application, Worker API, Durable Objects, SQLite migrations, and R2 binding as one Cloudflare Worker project.

## 1. Prerequisites

- Node.js 20 or later
- npm
- a Cloudflare account with Workers, Durable Objects, and R2 enabled
- permission to deploy Workers, create Durable Objects, and manage R2 buckets/lifecycle rules
- Cloudflare account MFA

Install exact dependencies:

```bash
npm ci
```

Authenticate Wrangler without putting credentials in the repository:

```bash
npx wrangler login
npx wrangler whoami
```

For CI, use a narrowly scoped Cloudflare API token through the CI secret store. Never commit it to `.env`, `wrangler.jsonc`, documentation, or source.

## 2. Review production policy

Before creating resources, review `wrangler.jsonc`:

| Variable | Current default | Purpose |
| --- | ---: | --- |
| `ROOM_TTL_MAX_SECONDS` | 2,592,000 | maximum room lifetime, 30 days |
| `MESSAGE_RETENTION_SECONDS` | 604,800 | message history retention, 7 days |
| `MAX_ROOM_CONNECTIONS` | 100 | concurrent WebSocket sessions per room |
| `MAX_FILE_BYTES` | 67,108,864 | encrypted file plaintext ceiling, 64 MiB |
| `MAX_ROOM_FILE_BYTES` | 536,870,912 | total encrypted file reservations per room, 512 MiB |

The browser protocol has the same 64 MiB ceiling and assembles downloads in memory. Lower this limit in both `src/shared/protocol.ts` and `wrangler.jsonc` if target clients cannot safely handle it. Do not raise it without implementing and testing a streaming client-side file sink.

Also choose the R2 location/jurisdiction before bucket creation if your organization has data-residency requirements. A location hint is not itself a legal residency guarantee; verify the current Cloudflare R2 terms and product controls.

## 3. Create the R2 bucket

The binding expects this exact bucket name:

```bash
npx wrangler r2 bucket create secret-gram-files
```

If it may already exist, inspect the account first:

```bash
npx wrangler r2 bucket list
```

Do not use a public R2 development URL or custom domain for this bucket. File access must remain behind the authenticated Worker route.

## 4. Configure defense-in-depth object expiration

Room alarms delete ciphertext at room expiration. Configure an independent R2 lifecycle rule so an object orphaned by a prolonged cleanup failure is eventually removed.

The maximum room lifetime is 30 days. A 35-day object rule allows for room lifetime and asynchronous cleanup delay:

```bash
npx wrangler r2 bucket lifecycle add \
  secret-gram-files \
  expire-orphaned-room-ciphertext \
  rooms/ \
  --expire-days 35 \
  --force
```

Verify it:

```bash
npx wrangler r2 bucket lifecycle list secret-gram-files
```

If you increase the maximum room lifetime, update this lifecycle policy deliberately. If you reduce retention, remember that an age-based lifecycle rule measures object age, while room expiration is measured from room creation; the Durable Object remains the primary exact logical policy.

## 5. Generate bindings and run quality gates

```bash
npx wrangler types
npm run check
```

`npm run check` must finish with no lint, type, test, Worker test, or production build failures.

The Vite build writes a deployable Worker configuration to `dist/secret_gram/wrangler.json` and client assets to `dist/client`. Wrangler recognizes the generated Vite build after `vite build`.

## 6. Perform a deployment dry run

```bash
npx wrangler deploy --dry-run
```

Review the reported bindings. They must include:

- `ROOMS` → `RoomDurableObject`
- `RATE_LIMITERS` → `RateLimiterDurableObject`
- `FILES` → `secret-gram-files`
- static assets

No plaintext encryption key or long-lived application secret is required by the Worker.

## 7. Deploy

```bash
npm run deploy
```

The script reruns all quality gates before invoking Wrangler. Record the Worker version ID and deployed URL printed by Wrangler.

The first deployment creates the SQLite-backed Durable Object classes through migration tag `v1`. Never edit a migration that has already reached production. Add a new, monotonically increasing migration tag for future Durable Object class changes.

## 8. Optional custom domain

A custom domain is preferred for a stable production origin. Configure it as a Worker custom domain rather than a route in front of an unrelated origin. For example, add a reviewed route entry to `wrangler.jsonc`:

```jsonc
"routes": [
  { "pattern": "secure.example.com", "custom_domain": true }
]
```

Re-run `npx wrangler types`, `npm run check`, and deployment after any config change.

Invitation links are origin-specific but keep the room code in the URL fragment. Existing copied invitation links continue to point at the old origin after a domain change.

## 9. Post-deployment verification

Replace `$BASE_URL` with the exact HTTPS origin. Do not append a room code to shell history.

### Static application and headers

```bash
curl -fsS -D - -o /dev/null "$BASE_URL/"
curl -fsS -D - -o /dev/null "$BASE_URL/assets/<fingerprinted-asset>.js"
```

Verify at least:

- HTTPS succeeds;
- `Content-Security-Policy` is present;
- `Referrer-Policy: no-referrer` is present;
- `Strict-Transport-Security` is present;
- `X-Content-Type-Options: nosniff` is present;
- `X-Frame-Options: DENY` is present;
- the HTML is not cached persistently;
- fingerprinted assets use immutable caching.

### Health endpoint

```bash
curl -fsS "$BASE_URL/api/v1/health"
```

Expected shape:

```json
{"data":{"status":"ok","version":1}}
```

The response must include `Cache-Control: no-store` and an `X-Request-ID`.

### Browser end-to-end test

Use two independent browser profiles, not two tabs sharing extension or process state:

1. Browser A creates a 24-hour room.
2. Copy the invitation through a trusted test channel.
3. Browser B joins.
4. Both show `Connected` and the correct online session count.
5. A sends text; B decrypts it.
6. B replies; A decrypts it.
7. Upload a small PNG and verify local image preview in both browsers.
8. Upload a small PDF and verify the decrypted Blob opens in the browser-native PDF viewer; confirm selectable text or browser OCR when the test browser supports it.
9. Upload a small MP4 and verify browser-local playback controls work in both browsers.
10. Upload a generic file and verify its downloaded bytes or checksum locally.
11. Pin a retained message in Browser A and verify Browser B receives the pin, can replace or clear it, and restores the current pin after reload.
12. Reload Browser B and verify history catch-up and attachment decryption.
13. Briefly disable networking, send/retry as appropriate, restore networking, and verify no duplicate messages.
14. Inspect browser developer tools: no plaintext message or room code should appear in HTTP request URLs or server responses.

Use synthetic test content only.

## 10. Rollback and release records

Before exposing the deployment broadly:

- record the Wrangler version;
- record the deployed Worker version ID;
- retain the reviewed source/build inputs;
- identify the previous known-good version;
- verify that the operator can roll back through Wrangler or the Cloudflare dashboard.

A Worker rollback does not automatically reverse Durable Object schema changes or restore deleted room data. Design every future schema migration for forward compatibility and rehearse rollback before applying it to production data.

## CI/CD recommendations

- Pin Node and use `npm ci`.
- Run `npm run check` before deployment.
- Use a dedicated Cloudflare API token with minimum required permissions.
- Protect the production environment with approvals.
- Do not upload source maps publicly if they expose private implementation details.
- Keep deployment logs free of room credentials and request bodies.
- Use separate staging resources and a distinct R2 bucket if a staging environment is added; Wrangler environment bindings are not inherited automatically.
