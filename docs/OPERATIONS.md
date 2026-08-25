# Operations runbook

## Scope

This runbook covers the deployed SecretGram data plane:

- static React assets;
- Worker HTTP API;
- Room Durable Objects and SQLite;
- Rate Limiter Durable Objects;
- hibernatable WebSockets;
- encrypted R2 file chunks.

It does not define organization SSO, billing, enterprise audit, legal hold, DLP, or content moderation.

## Operational principles

1. Never ask a user to send a room code, authentication token, WebSocket ticket, plaintext message, or real attachment for troubleshooting.
2. Use request IDs, timestamps, status codes, Worker version IDs, and synthetic rooms.
3. Treat room expiration as a logical access boundary; physical deletion is asynchronous.
4. Do not enable request-body logging, broad tracing payload capture, or R2 public access.
5. Acknowledge service receipt as “ciphertext stored,” never “recipient received” or “read.”

## Health and synthetic checks

### Stateless health

Check every minute from at least two regions:

```text
GET /api/v1/health
```

Success criteria:

- HTTP 200;
- JSON status `ok`;
- latency within the chosen service objective;
- `Cache-Control: no-store`;
- non-empty `X-Request-ID`.

This check does not exercise Durable Objects, R2, WebSockets, or encryption.

### Stateful synthetic room

Run a scheduled synthetic test with non-sensitive generated content:

1. generate a room credential in a controlled browser runner;
2. create and authenticate the room;
3. obtain and consume a WebSocket ticket;
4. send one encrypted message and verify sequence/acknowledgement;
5. pin it, verify the versioned pin state over HTTP and WebSocket, then clear it;
6. fetch history and decrypt locally;
7. upload two encrypted test chunks, complete the upload, download them, and verify local integrity;
8. allow the synthetic room to expire or explicitly track it until cleanup.

Never reuse production user room codes. Tag synthetic monitoring through an out-of-band operator record, not plaintext inside the encrypted service.

## Recommended alerts

Alert on sustained rates rather than individual expected client errors.

### Availability

- elevated Worker 5xx rate;
- health check failure from multiple regions;
- Durable Object invocation errors/timeouts;
- R2 5xx or storage-unavailable responses;
- WebSocket upgrade failures above baseline.

### Cleanup

- `expired_room_cleanup_failed` events;
- `abandoned_upload_cleanup_failed` events;
- growth in R2 object count or bytes inconsistent with room creation/expiration;
- missing or changed R2 lifecycle rule;
- repeated alarm failures.

### Abuse and capacity

- sustained 429 response growth;
- room creation spikes;
- repeated maximum-connection responses;
- unusual encrypted upload volume;
- R2 operation or egress cost anomalies.

### Security

- unexpected deployment outside the release process;
- Cloudflare account login or API token anomalies;
- CSP/header regression;
- accidental logging of Authorization or URL query values;
- dependency or runtime advisories affecting cryptography or request validation.

## Structured log fields

Safe operational fields include:

- event category;
- Worker version;
- generated request ID;
- HTTP method;
- normalized API path without query values;
- status code;
- coarse duration and response-size bucket;
- Cloudflare error category;
- cleanup failure category.

Do not log room locator values unless a reviewed incident procedure proves they are necessary. A locator is not a decryption key, but it is stable room metadata.

Never log room codes, fragments, bearer tokens, tickets, request bodies, ciphertext envelopes, filenames, MIME types, file keys, nonces, or plaintext.

## Common incidents

### Static application unavailable, health endpoint healthy

1. Check the latest Worker deployment and static asset manifest.
2. Fetch `/` and inspect status and security headers.
3. Check that the Vite-generated deployment configuration points assets to `dist/client`.
4. Verify `_headers` was included in the asset build.
5. Roll back the Worker if the asset deployment is incomplete.

### Health endpoint fails

1. Check Cloudflare status and Worker error analytics.
2. Identify the first failing Worker version.
3. Search structured logs by request ID and normalized path.
4. Roll back if the failure correlates with a deployment.
5. Do not disable authentication, validation, or CSP as a workaround.

### Rooms create but cannot connect in real time

1. Verify `/socket-ticket` returns success for a synthetic room.
2. Verify the WebSocket URL uses `wss:` on HTTPS and contains only a short-lived ticket.
3. Check WebSocket upgrade status and Durable Object errors.
4. Confirm the `ROOMS` binding and migration are present.
5. Test HTTP message fallback and history separately.
6. Check per-source limits and `MAX_ROOM_CONNECTIONS` before raising limits.

### Message history gaps after reconnect

1. Reproduce with a synthetic room and more than 100 queued messages.
2. Confirm the client drains every history page and performs a post-open catch-up.
3. Compare sequence numbers only; do not request plaintext.
4. Check Durable Object SQLite errors or retention cutoff configuration.
5. Do not manually fabricate missing sequence rows.

### Encrypted upload cannot complete

1. Use a synthetic file with known local checksum.
2. Check whether every chunk PUT succeeded and returned an ETag.
3. Distinguish `incomplete`, `chunk_conflict`, authorization, and R2 availability errors.
4. Retry the exact existing ciphertext. Never re-encrypt the same logical chunk under the existing file plan.
5. If a client lost its encrypted retry cache, restart with a new file ID, key, and nonce prefix.

### Download returns storage unavailable

1. Confirm the upload is marked ready in the synthetic room.
2. Check R2 object availability and Worker/R2 errors.
3. Do not make the bucket public.
4. If R2 metadata was manually modified, treat the upload as inconsistent and create a new encrypted upload.

### Expired data remains in R2

1. Verify the room is logically inaccessible; this is the immediate security boundary.
2. Search for cleanup failure events.
3. Verify the Room Durable Object has a future alarm after a failed cleanup.
4. Verify the `expire-orphaned-room-ciphertext` lifecycle rule exists.
5. Check Cloudflare R2 service status and retry cleanup through the normal alarm/state path.
6. Avoid deleting broad prefixes manually unless the exact opaque room locator and scope have been independently validated.

## Deployment procedure

1. Review source and dependency changes.
2. Run `npx wrangler types` after binding changes.
3. Run `npm run check`.
4. Run `npx wrangler deploy --dry-run` and inspect bindings.
5. Deploy through the approved production identity.
6. Record Worker version and build inputs.
7. Verify health, headers, two-browser text, pin/replace/unpin synchronization, WebSocket, image, PDF, and generic file flows.
8. Monitor errors and cleanup events through the observation window.

## Rollback

Rollback the Worker when a new release causes availability, integrity, or security regressions. Remember:

- rollback restores code/assets, not deleted room data;
- rollback does not reverse a Durable Object migration;
- old code must be compatible with the current SQLite schema;
- R2 objects written by the new version may remain until normal cleanup;
- invitation links continue to depend on the deployed origin.

If schema compatibility is uncertain, stop further rollout, preserve ciphertext state, and consult the migration owner before rollback.

## Retention operations

Current defaults:

- room maximum lifetime: 30 days;
- message retention: 7 days;
- room-wide message ceiling: 600 per minute;
- retained event ceiling: 10,000 rows or 256 MiB ciphertext characters per room; the authenticated
  room UI reports remaining row slots, while the character ceiling may be reached first;
- encrypted file reservations per room: 512 MiB;
- pending uploads per room: 32;
- total upload records per room: 128;
- total reserved file chunks per room: 4,096;
- pending upload cleanup: after 24 hours;
- maintenance cadence: hourly;
- WebSocket ticket lifetime: 30 seconds;
- defense-in-depth R2 lifecycle target: 35 days.

Review these values together. A room may outlive message history. Physical cleanup can lag logical expiration because Durable Object alarms and R2 lifecycle execution are asynchronous.

## Backup and recovery

SecretGram is an ephemeral communication service. The service does not possess room secrets and cannot decrypt or reconstruct user content from backups.

Before enabling backups or point-in-time recovery, define whether retaining ciphertext beyond the advertised deletion window is legally and contractually acceptable. A backup that restores expired ciphertext may violate user expectations even though the operator cannot decrypt it.

Recovery priorities are:

1. restore the reviewed application and bindings;
2. preserve logical expiration checks;
3. restore consistent Durable Object metadata and R2 ciphertext only if policy permits;
4. never generate replacement room secrets or claim that inaccessible content was recovered;
5. notify users honestly when ciphertext or room state cannot be restored.

## Account and credential hygiene

- require MFA for Cloudflare administrators;
- use separate human and CI identities;
- minimize API token permissions and expiration;
- rotate CI tokens on personnel or system changes;
- review deployment and account audit events;
- never store Cloudflare credentials in the repository;
- keep R2 private and accessible only through bindings;
- protect the DNS/custom-domain account with equivalent controls.

## Periodic maintenance

Monthly:

- review errors, limits, costs, and R2 growth;
- confirm lifecycle rules and security headers;
- review dependency advisories;
- exercise rollback in staging;
- verify synthetic room cleanup.

Quarterly:

- update and test the Workers compatibility date;
- regenerate Wrangler binding types;
- review Cloudflare Workers, Durable Objects, WebSocket, and R2 guidance;
- revisit file limits and supported browsers;
- review the threat model and public claims.

Before broad enterprise use:

- obtain independent cryptographic and application penetration tests;
- implement the selected identity and organization control plane;
- document residency, retention, DLP, eDiscovery, and abuse policies;
- publish security and privacy contacts;
- rehearse account compromise and malicious-deployment response.
