**English** · [日本語](./emulator-hosting-design.ja.md)

# Emulator hosting — public client-only vs authenticated per-user ROM

How we host the PC-8801 emulator on the web. The emulator is **pure client-side
JS** — [`z80.js`](../z80.js), [`machine88.js`](../machine88.js),
[`ym2203.js`](../ym2203.js), [`ym2608.js`](../ym2608.js), [`crt.js`](../crt.js)
and the rest run entirely in the browser ([`demo/machine.html`](../demo/machine.html),
[`demo/opn-scope.html`](../demo/opn-scope.html)). There is no server-side
emulation and there is nothing NEC-copyrighted in the repo. That shapes the
whole hosting story: **the interesting question isn't "where does the CPU run"
(it runs in the tab) — it's "where do the ROMs live".**

This is a design contract for two hosting layers, grounded in the code that
already exists ([`demo/romstore.js`](../demo/romstore.js)) and the platform we
deploy on (volta). It says what to build, in what order, and how to verify it.
Anything not yet confirmed is flagged **[needs confirmation]**.

## 1. The ROM problem sets the shape

The machine boots from NEC's **N-BASIC / N88-BASIC** ROM and runs game **`.d88`
disk images**. All of it is copyrighted (NEC's runs to 2049; game publishers'
longer). **We do not distribute any of it.** The user brings their own dump —
BYO-ROM. So the only design decision that matters is: once a user has supplied
their bytes, *where do those bytes rest between sessions?*

Two answers, two layers:

| | **3301.unlaxer.org** (public) | **emulator.unlaxer.org** (authenticated) |
|---|---|---|
| Auth | none | volta login required |
| ROM at rest | this browser's IndexedDB | (Phase 1) same + gate · (Phase 2) **your server-side folder** |
| Bytes leave device? | **never** | only to *your own* encrypted per-user store |
| Use case | "try it on this machine" | "upload once, use on all my devices" |
| Status | **shipped** (Phase 0) | **to build** (Phase 1 → 2) |

## 2. Architecture

```
                        Cloudflare (wildcard *.unlaxer.org, TLS)
                                       │
                 ┌─────────────────────┴──────────────────────┐
                 │                                             │
        3301.unlaxer.org                             emulator.unlaxer.org
        (PUBLIC LAYER)                               (AUTH LAYER)
                 │                                             │
        static files, no-cache                       volta-gateway (:80)
        (serve.py / any static host)                 route: app_id set → auth
                 │                                    ┌────────┴─────────┐
                 ▼                                    │ AuthChecked      │
        ┌──────────────────┐                         │  ← volta /verify │
        │  browser tab     │                         └────────┬─────────┘
        │  ┌────────────┐  │                            (authenticated)
        │  │ machine88  │  │                                  │
        │  │ z80 / OPN  │  │                                  ▼
        │  └─────┬──────┘  │                         ┌──────────────────┐
        │   romstore.js    │                         │  browser tab     │
        │        │         │                         │  romstore.js     │
        │        ▼         │                         │    │      │      │
        │  ┌────────────┐  │                         │  local    remote │
        │  │ IndexedDB  │  │  ← ROM never            │ IndexedDB  sync  │
        │  │ (this PC)  │  │    leaves the tab       │  (cache)    │    │
        │  └────────────┘  │                         └───────────┼─────┘
        └──────────────────┘                                     ▼
                                                        per-user ROM store
                                                      (object storage / files,
                                                       encrypted, owner-keyed)
```

The public layer is the emulator as it ships today: static files behind
Cloudflare, ROMs held only in the visitor's own IndexedDB. The auth layer is the
*same static app* placed behind volta-gateway so it knows who the user is, plus a
per-user server store that the client treats as an **optional sync target**, not
the source of truth.

## 3. Phase 0 — public client-only (shipped)

This already works and is the baseline. Nothing here is aspirational.

- **Hosting**: static files. [`serve.py`](../serve.py) sends
  `Cache-Control: no-cache` so Cloudflare revalidates instead of serving stale
  modules after a deploy. `3301.unlaxer.org` is just this directory behind CF.
- **Persistence**: [`demo/romstore.js`](../demo/romstore.js) keeps each uploaded
  blob in IndexedDB (`DB 'upd3301-roms'`, store `blobs`, `keyPath: 'role'`).
  Roles today: `rom` (boot ROM), `font` (CGROM), `disk` (a `.d88`). API:
  `putRom / getRom / listRoms / clearRoms`.
- **Auto-boot**: [`machine.html`](../demo/machine.html)'s file `onchange`
  handlers call `putRom(...)` after a pick; `restoreFromStore()` on load reads
  `font`/`disk`/`rom` back and boots — **"upload once", not "upload to us".** The
  UI even says so: *"保存済み(このブラウザのみ)"*.
- **Privacy invariant**: the bytes never leave the tab. There is no upload
  endpoint. This is the property we must not break when we add a server.

## 4. Why client-first is the default (and when to add a server)

The server-side store is **opt-in and secondary** on purpose:

- **Copyright exposure.** The moment ROM/disk bytes touch our disk, we are
  storing (and potentially, if careless, *serving*) NEC's BIOS and publishers'
  games. Keeping bytes in the user's IndexedDB means we possess nothing. The
  server layer must preserve "we hold ciphertext for one owner, we never
  redistribute" — see §7.
- **Privacy.** A user's disk library is a fingerprint of what they own. Not
  collecting it is the strongest privacy guarantee.
- **Cost.** Disk images are hundreds of KB to a few MB each; a library is tens
  of MB per user. Free for us while it lives in their browser; real storage +
  egress once it's ours.

So we **only** add server storage when a demand appears that IndexedDB
structurally cannot serve:

1. **Cross-device** — "I dumped my ROMs on the PC, now I want them on my phone."
   IndexedDB is per-origin-per-browser; it cannot cross devices. This is the
   primary driver for the auth layer.
2. **Large / many-disk management** — a big game library the user wants
   organized and re-selectable across sessions and machines.
3. **[needs confirmation] shared/kiosk machines** — where per-browser storage is
   wiped or shared and a logged-in identity is the only stable key.

If none of these bite, the public layer is the whole product.

## 5. The authenticated layer

### 5.1 Auth model (volta as the gate)

`emulator.unlaxer.org` is a **protected backend behind volta-gateway**, not its
own auth system. On volta:

- The production `:80` is **volta-gateway** (traefik is a relic). Cloudflare is
  wildcard, so `emulator.unlaxer.org` resolves without new DNS.
- Routing is prod-yaml direct-edit. A route with an `app_id` set is
  auth-enforced (the gateway's `AuthChecked` state calls volta `/auth/verify`
  and redirects unauthenticated requests to login); a route marked
  `public: true` bypasses auth. We want the **former** — the emulator route
  carries an `app_id` and is *not* public:

  ```yaml
  routing:
    - host: emulator.unlaxer.org
      backend: http://localhost:<static-emulator-port>
      app_id: app-emulator      # ⇒ auth required (no `public: true`)
  ```

- volta's auth spec (`auth-methods-landscape.md`) reports the **RP / client
  side complete** (the emulator is just a protected app behind it) and **Device
  Authorization Grant (RFC 8628) / QR shipped in Phase 1**. That matters for
  cross-device UX (§5.3).

The emulator app itself stays auth-agnostic: it receives an authenticated
session from the gateway and reads the user identity from whatever header the
gateway injects (**[needs confirmation]** exact header name/claim — likely
`X-Volta-*`; confirm against the gateway config before Phase 2 wiring).

### 5.2 Per-user storage

Behind the gate, each user gets a private ROM folder, keyed by their volta
identity:

- **Store**: object storage (one prefix per user) or a plain per-user directory.
  **[needs confirmation]** which of the two volta already provisions; if neither,
  object storage is the default choice (cheap, per-key ACL, no filesystem quota
  games).
- **Layout**: mirror the `role` model already in `romstore.js` — objects keyed by
  `{userId}/{role}` for singletons (`rom`, `font`) and `{userId}/disk/{name}` for
  a multi-disk library (an extension of today's single-`disk` role).
- **Metadata only** (name, size, role, updated-at, content hash) is what the UI
  lists; the bytes are fetched on demand.

### 5.3 Upload / sync flow

The client stays authoritative. IndexedDB is the working cache; the server is a
sync mirror.

```
pick ROM ─▶ putRom(role, name, bytes)      // local IndexedDB (unchanged)
              │
              └─▶ (auth layer only) if "sync on" ─▶ PUT /roms/{role}   // encrypted
                                                     server store

next visit ─▶ restoreFromStore():
   local hit?  ─ yes ─▶ boot immediately (fast path, offline-capable)
               ─ no  ─▶ (auth layer) GET /roms  → download → putRom locally → boot
```

**Cross-device story** (the reason this layer exists): on the PC, pick ROMs →
they sync up. On the phone, log in (Device Grant / QR from Phase 1 makes the
login itself painless) → `restoreFromStore()` finds nothing local, pulls from the
server, caches to IndexedDB, and auto-boots. **"Upload once" becomes account-wide,
not browser-wide.**

### 5.4 Owner pre-seed (demo-anywhere)

The site owner (the operator — you) is a user like any other, but with one extra
capability: the owner can **pre-seed** their own per-user folder with a full ROM
set + the main disks *ahead of time*, so a demo on a strange machine boots
instantly instead of re-uploading at the venue.

- **Mechanism**: the owner places a **seed set** (full boot ROM(s), CGROM, the
  headline `.d88` library) into *their own account's* server folder once — via the
  same authenticated upload path as any sync, or an admin-side bulk put. It is
  just their per-user store, pre-populated.
- **What it buys**: at an external demo (different venue, borrowed laptop, phone),
  the owner logs in → `restoreFromStore()` finds nothing local → pulls the seed
  set from the server → caches to IndexedDB → auto-boots. No file-picking on
  stage. Second time on that machine it's already local (offline-capable).
- **Copyright boundary — hard line**: the seed set is **the owner's own dump, in
  the owner's own account, for the owner's own use.** It is **not** distribution.
  Seeds are **per-owner and never shared** — there is no cross-user seed, no
  "default library" served to visitors, no public-fetch. Owner-scoping (§7)
  applies to seeds exactly as to any uploaded ROM; a seed is invisible to every
  identity but its owner's. The public `3301.unlaxer.org` layer has no seeds at
  all.

### 5.5 Sync strategy: client-first, server optional

- **Client wins by default.** A local IndexedDB hit boots without a network round
  trip. The server is consulted only on a local miss (fresh device/browser) or an
  explicit "sync now".
- **Conflict**: ROMs are effectively immutable content (a given dump doesn't
  change), so keying by content hash makes most "conflicts" no-ops. For genuinely
  different bytes under the same role, **last-write-wins with an explicit
  overwrite confirmation** — no silent clobber. **[needs confirmation]** whether
  users ever want multiple boot ROMs (then `role` grows a name dimension like
  `disk` already needs).
- **Offline**: the public layer's behavior is preserved — with a warm cache the
  app never needs the server.

## 6. Dependency direction & connection points

The whole auth layer hangs off **one existing seam**: `romstore.js`. Its
`putRom / getRom / listRoms / clearRoms` interface is exactly the abstraction a
remote store needs to implement.

```
machine.html ──uses──▶ romstore.js  (local IndexedDB)          ← Phase 0, unchanged
                            ▲
                            │  same interface
                     ┌──────┴───────────────────────────────┐
                     │ sync layer (Phase 2, new, auth-only)  │
                     │  local IndexedDB  ⇄  remote store      │
                     └───────────────────────────────────────┘
                                     │ HTTPS (authenticated by gateway)
                                     ▼
                          per-user server ROM store
```

- **Do not touch the emulator core.** `machine88.js` / `z80.js` / the chips never
  learn about hosting; they get bytes, same as today.
- **`machine.html` stays almost unchanged.** `restoreFromStore()` and
  `refreshStore()` already funnel through the storage API. Phase 2 introduces a
  *sync module* with the same signatures that wraps local IndexedDB and the remote
  store; `machine.html` calls the wrapper instead of `romstore.js` directly. On
  the public site the wrapper degrades to local-only (no remote configured), so a
  single code path serves both hosts.
- **Direction is one-way**: UI → sync layer → (local store, remote client). The
  core depends on nothing above it; the remote client depends on the gateway for
  identity, never the reverse.

## 7. Security & privacy

The ROMs are **the user's copyrighted data held on our infrastructure**. The
design goal is that adding the server changes *convenience*, not *exposure*.

- **Access control**: every object is owner-scoped to the volta identity. There is
  **no sharing, listing-across-users, or public-fetch endpoint** — the only way a
  byte comes out is the same authenticated user who put it in. This is the
  concrete "we never redistribute NEC/publisher ROMs" guarantee. **This is exactly
  what keeps the owner pre-seed (§5.4) legitimate**: a seed set is owner-scoped
  like any other object, so "the owner's dump for the owner's demo" never becomes
  "a library served to the public".
- **Encryption at rest**: server store encrypted. Two levels, a real trade-off:
  - *Server-side encryption* (we hold keys): simplest; cross-device "just works";
    but we *can* technically read the bytes.
  - *Client-side encryption* (**[needs confirmation]** worth it): the browser
    encrypts before upload under a user-held key, so we store ciphertext we cannot
    read — the strongest "we don't have your ROMs" claim. Cost: the key must reach
    the second device (derive from the volta login? a passphrase? a QR key
    transfer riding on Device Grant?). Decide by how strong the
    non-possession promise must be.
- **Transport**: HTTPS only (Cloudflare TLS), and the route is behind the auth
  gate — no unauthenticated request reaches the store.
- **Deletion**: `clearRoms()` must have a server twin — a real delete of the
  user's objects, so "forget me" actually removes the copyrighted bytes.
- **Public layer keeps its zero-exposure property untouched**: it has no server
  store at all, so nothing regresses there.

## 8. Phased plan

Each phase is independently shippable and verifiable.

**Phase 0 — public client persistence.** ✅ *Shipped.*
- Deliverable: `3301.unlaxer.org` static, `romstore.js` IndexedDB, auto-boot.
- Verify: pick ROM → reload → auto-boots; DevTools shows bytes only in IndexedDB,
  no network upload. (This is current behavior.)

**Phase 1 — volta auth gate.** *Next.*
- Deliverable: `emulator.unlaxer.org` = the same app, served behind volta-gateway
  with an `app_id` route (not `public`). Login required to load. **No server ROM
  storage yet** — still per-browser IndexedDB, now behind a login. This isolates
  the auth wiring from the storage work and establishes the identity that Phase 2
  keys on.
- Verify: unauthenticated hit → redirected to volta login; after login the
  emulator loads and behaves exactly like the public site; the gateway injects a
  user identity the app can read (**[needs confirmation]** header name).

**Phase 2 — server ROM sync + owner pre-seed.** *After Phase 1.*
- Deliverable: per-user encrypted store + the sync module wrapping `romstore.js`;
  "sync on" upload; cross-device download-on-miss; server-side delete; **owner
  pre-seed** (§5.4) — a way to pre-populate the owner's own folder with a full
  ROM + main-disk set for demo-anywhere.
- Verify: on machine A, pick ROMs + enable sync; on machine B (different browser),
  log in as the same user → `restoreFromStore()` pulls from server and auto-boots
  with no manual pick. **Pre-seed check**: with the owner folder seeded, log in on
  a *fresh* machine → pulls the seed set → auto-boots with zero file-picking, and
  is offline-capable on the second load. Confirm owner-scoping (user B cannot
  fetch user A's objects *or seeds*), encryption at rest, and that the **public
  site is unaffected** (sync module degrades to local-only when no remote is
  configured).

## 9. Open questions / risks

- **[needs confirmation] Gateway identity header** — exact header/claim the
  gateway passes to a protected backend (needed to key per-user storage). Check
  the volta-gateway config, not memory.
- **[needs confirmation] Storage backing** — does volta already provision
  object storage / per-user dirs, or do we stand one up? Default to object
  storage if unclear.
- **[needs confirmation] Client-side vs server-side encryption** — how strong the
  non-possession promise must be, and where the key lives for cross-device.
- **`role` model growth** — a multi-disk library needs `role` to carry a name
  dimension (today `disk` is a singleton). Cheap to extend in `romstore.js`; do it
  once, for both local and remote.
- **Auth-spec drift** — an older note recorded volta's OP (issuer) side as
  empty, but the current spec reports the RP side complete and Device Grant in
  Phase 1. The RP/protected-app path we depend on is the settled one; still,
  **confirm against the live spec** before wiring.

Related: [design.md](./design.md) (chip/emulator contracts),
[library.md](./library.md) (using the pieces as libraries),
[ice-design.md](./ice-design.md) (the debugger that also rides `romstore`/the
machine). Storage seam in code: [`demo/romstore.js`](../demo/romstore.js),
wired in [`demo/machine.html`](../demo/machine.html).
