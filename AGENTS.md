# AGENTS.md

## Scope

These instructions apply to the entire repository. SecretGram is an English-first product; keep source comments, UI copy, runtime errors, tests, and documentation in English.

## Product and trust model

SecretGram provides temporary end-to-end encrypted rooms for messages and files. The browser is the cryptographic trust boundary. Cloudflare Workers, Durable Objects, Durable Object SQLite, and R2 may route, order, retain, and delete opaque ciphertext, but must not receive or persist message plaintext, attachment plaintext, plaintext filenames, plaintext MIME types, file keys, or room secrets.

Read these documents before changing protocol or storage behavior:

- `docs/ARCHITECTURE.md`
- `docs/SECURITY.md`
- `docs/DEPLOYMENT.md`
- `docs/OPERATIONS.md`

Do not describe this project as independently audited, anonymous, forward-secret, identity-verified, or compliant by default.

## Commands

Use Node.js 20 or later and npm.

```bash
npm ci
npm run dev
npm run lint
npm run typecheck
npm test
npm run test:worker
npm run build
npm run check
```

`npm run check` is the required pre-commit and pre-deployment gate. It runs linting, browser and Worker TypeScript checks, browser tests, Worker/Durable Object/R2 tests, the dependency audit, and a production build.

Deployment is intentionally build-before-deploy:

```bash
npm run deploy -- --dry-run
npm run deploy
```

Do not perform a real deployment, create Cloudflare resources, commit, or push unless the user explicitly requests it.

## Repository map

- `src/components/`: React UI, dialogs, attachment rendering, and previews
- `src/hooks/useRoomChannel.ts`: history, WebSocket lifecycle, retries, acknowledgements, recall events, and timeline merging
- `src/lib/`: browser API client, cryptography, session state, and file transfer
- `src/shared/protocol.ts`: strict shared schemas and product limits
- `worker/index.ts`: Worker routing, request validation, R2 streaming, and response handling
- `worker/room.ts`: room Durable Object, SQLite schema, ordering, WebSockets, uploads, recalls, alarms, and cleanup
- `worker/rate-limiter.ts`: source-scoped rate-limit Durable Object
- `public/_headers`: static response security and caching headers
- `wrangler.jsonc`: Cloudflare bindings, migrations, assets, and production defaults
- `docs/`: architecture, security, deployment, and operations documentation

## Non-negotiable protocol invariants

1. Keep all sensitive content encryption and decryption in the browser. Server code must remain unable to decrypt room content.
2. Room codes contain 120 bits of random secret material plus checksum characters. Formatting and checksums must not reduce secret entropy.
3. Derive routing, authentication, message, and file contexts with separate versioned HKDF labels. Treat labels and authenticated-data formats as protocol commitments.
4. Messages use a random sender epoch, a sender-specific key, a monotonic counter, and a deterministic nonce. Never permit AES-GCM nonce reuse under one key.
5. A retry of the same message ID must reuse the identical encrypted envelope. Reject conflicting message IDs and sender epoch/counter reuse.
6. Message recall is capability-based. Keep the raw recall token in the sender browser, persist only its verifier, authenticate the verifier as part of the message envelope, never log either value, and preserve an ordered tombstone for history and WebSocket peers.
7. WebSocket URLs may contain only short-lived one-time tickets. Never put a room code or long-lived room authentication token in a WebSocket URL.
8. File retries must reuse byte-identical encrypted chunks. Content-addressed R2 keys are shared by identical retries; a request-local `created` result is not exclusive ownership and must never justify deleting an object referenced by committed SQLite metadata.
9. Durable Object SQLite and R2 do not share a transaction. Make cross-storage transitions idempotent, reconcile ambiguous outcomes, and prefer safe orphan cleanup over destructive compensation when ownership is uncertain.
10. Reject expired rooms logically on every read and write path. Alarms and R2 lifecycle rules provide eventual physical cleanup, not access control.
11. Preserve explicit resource ceilings. The authoritative schemas and environment limits live in `src/shared/protocol.ts`, `worker/room.ts`, and `wrangler.jsonc`.
12. D1 is not part of the real-time content data path.

## Browser rules

- Room credentials belong only in active in-memory session state. Do not store them in Local Storage, IndexedDB, cookies, analytics, logs, or request URLs. Theme preference is the intentional Local Storage exception.
- Parse invitation secrets from the URL fragment and remove the fragment immediately.
- Validate all API success payloads with strict Zod schemas. A successful HTTP status alone is not trusted input.
- Propagate `AbortSignal` through history, upload, download, and room-lifecycle operations.
- Revoke every Blob URL on replacement, cancellation, and unmount. Download-only URLs should be short-lived.
- Treat decrypted filenames, MIME values, timestamps, and preview data as untrusted input. Render fail-safe.
- Keep previews browser-local. PDF.js workers and other runtime assets must be bundled locally; do not add external scripts, fonts, analytics, or CDNs without an explicit trust-model review.
- Preserve accessible semantics: labelled controls, keyboard-operable tabs, focus trapping/restoration for dialogs, Escape handling, status announcements, and reduced-motion behavior.

## Worker and Durable Object rules

- Parse bounded JSON bodies and validate route inputs before invoking a Durable Object or R2.
- Never log authorization headers, room codes, URL fragments, WebSocket tickets, request bodies, encrypted envelopes, filenames, MIME values, R2 bodies, or recall capabilities.
- Durable Object methods must be idempotent across retries and safe across `await` interleavings.
- Keep SQLite schema upgrades compatible with existing Durable Object instances. Add migration tests for old schemas and make schema initialization idempotent.
- Persist before broadcasting or acknowledging.
- History must be strictly sequence ordered, paginated without gaps, and able to carry both message and recall events.
- Preserve uploader checks, chunk bounds, digest/size reconciliation, quota accounting, and ready-state idempotency in upload paths.
- Verify R2 object size, digest, and custom metadata before accepting or serving a chunk.
- Maintain security headers on both static and API responses.

## Code style

- Use strict TypeScript, ES modules, two-space indentation, single quotes, and no semicolons, matching neighboring files.
- Prefer narrow types and strict Zod schemas at trust boundaries. Avoid `any`, unchecked casts, and duplicated protocol shapes.
- Keep changes focused. Do not rename, reformat, or refactor unrelated code.
- Trace definitions and all call sites before changing shared types or Durable Object RPC methods.
- Add dependencies only when necessary; commit matching `package-lock.json` changes and keep runtime dependencies browser-bundle compatible.

## Testing expectations

- Add or update regression tests with every behavior change.
- Browser and cryptographic tests live under `src/**/*.test.ts(x)`.
- Worker, Durable Object, SQLite, WebSocket, alarm, and R2 tests live under `worker/**/*.test.ts` and run with `vitest.worker.config.ts`.
- For retry, concurrency, and cross-storage bugs, force the relevant interleaving rather than testing only the happy path.
- Cover malformed and out-of-range protocol input, unauthorized callers, duplicate retries, conflicting content, expiration, cleanup, aborts, and component unmounts where relevant.
- A green suite does not close a known unmodeled race. Add a regression that fails before the fix and passes afterward.

## Change checklist

Before handing off a change:

1. Review the complete diff and confirm no unrelated edits were introduced.
2. Run `npm run check`.
3. For deployment-related changes, also run `npm run deploy -- --dry-run`.
4. Run `git diff --check` and scan staged content for credentials and accidental payload logging.
5. Confirm `.env*`, `.dev.vars*`, `dist/`, `.wrangler/`, and generated bindings remain untracked.
6. Update architecture, security, deployment, and operations docs when protocol, limits, schema, bindings, retention, or runbooks change.
7. For a production release, record the Git commit and Cloudflare Worker version, verify online headers/API/WebSocket/message/attachment flows, and confirm the R2 lifecycle policy.
