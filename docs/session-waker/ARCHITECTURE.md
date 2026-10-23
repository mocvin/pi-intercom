# Waking persisted sessions — architecture

This fork of `pi-intercom` lets a message reach a Pi session that is **persisted but not loaded** (for example a saved PI WEB conversation). The message is held once in the broker, the original session is reopened through a *wake provider*, and the message is then delivered through the normal intercom path. Diagrams are Mermaid.

User-facing behavior and settings are in the main [README](../../README.md#waking-persisted-sessions); installation and rollback are in [INSTALL.md](./INSTALL.md).

## 1. Components

```mermaid
flowchart LR
    subgraph host["PI WEB session daemon (hosts the sessions)"]
        direction TB
        S["Sender session<br/>pi-intercom extension<br/>(client + WakeProvider)"]
        D["Persisted session<br/>(JSONL on disk, NOT loaded)"]
        R["Reopened session<br/>pi-intercom extension"]
        API["Daemon routes (UNIX socket)<br/>GET /sessions?cwd=<br/>POST /sessions/:id/commands/run"]
    end
    B[("Intercom broker<br/>detached process, UNIX socket<br/>in-memory mailbox, 24 h")]
    S -- "1 send {wake}: held once" --> B
    S -- "2 run /intercom-wake messageId" --> API
    API -- "3 open" --> D
    D -.->|becomes| R
    R -- "4 register (piSessionId, cwd)" --> B
    B -- "5 mailbox flush: message" --> R
    R -- "6 receipts" --> B
    B -- "receipts" --> S
```

- The **broker never talks to the host.** It is shared by every session (TUI, CLI, PI WEB). The sender's extension reopens the session through its `WakeProvider`.
- The message lives in **one place** (the mailbox). The wake command carries only the message id.
- Delivery is the ordinary intercom path: duplicate suppression by id, receipts, `replyTo` tracking, the shared idle wake.

## 2. Identity: intercom id ≠ Pi session id

```mermaid
flowchart TB
    subgraph ext["extension (startSessionRuntime / buildRegistration)"]
        P["currentSessionId =<br/>sessionManager.getSessionId()<br/>(real Pi session id)"]
        C["identity claim event"]
        E["PI_INTERCOM_STABLE_ID / config.stableId"]
        I["intercom id =<br/>claim ?? stable ?? Pi session id"]
        P --> I
        C --> I
        E --> I
    end
    I -- "register.sessionId (intercom address)" --> BR
    P -- "register.session.piSessionId (new)" --> BR
    subgraph BR["broker"]
        V["isSessionRegistration: piSessionId optional,<br/>non-empty string, at most 256 chars"]
        INFO["SessionInfo { id, piSessionId?, cwd, name … }"]
        V --> INFO
    end
    INFO -- "list → roster" --> PEERS["peers resolve by intercom id<br/>or by piSessionId"]
```

With a stable id or an identity claim, the intercom id is not the Pi session id, but a host can only reopen a session by its Pi session id. The field is self-asserted by the local client, like `cwd` and `pid`.

## 3. Protocol negotiation and compatibility

`INTERCOM_PROTOCOL_VERSION` stays **1**: the health check compares it for equality, so a bump would make every older broker look unhealthy. New behavior is negotiated with additive features in `registered.features`, like `exact-send-v1`.

```mermaid
sequenceDiagram
    participant C as Client (extension)
    participant B as Broker
    C->>B: register { session: { …, piSessionId? }, sessionId }
    alt broker of this fork
        B-->>C: registered { features: [extension-bus-v1, exact-send-v1, pi-session-id-v1, wake-v1] }
    else older broker
        B-->>C: registered { features: [extension-bus-v1, exact-send-v1] }
        Note over C: no wake-v1 → wake sends are refused before anything is sent
    end
```

| Client | Broker | Result |
|---|---|---|
| new | new | `piSessionId` in the roster; wake available |
| new | old | the old broker ignores the new fields; wake refused with a clear error; ordinary sends unchanged |
| old | new | no `piSessionId`; behavior identical to upstream |

| Protocol element | Where |
|---|---|
| `pi-session-id-v1`, `SessionRegistration.piSessionId?`, `SessionInfo.piSessionId?` (≤ 256 chars) | `types.ts`, `broker/protocol.ts`, `broker/broker.ts` |
| `wake-v1`, `WakeTarget { piSessionId, cwd }`, `send.wake?` | `types.ts`, `broker/protocol.ts` (`isWakeTarget`), `broker/broker.ts` (`handleWakeSend`) |
| `delivered.code = "wake_pending"` (also on replays) | `broker/broker.ts` |
| errors `E_INVALID_WAKE`, `E_WAKE_UNSUPPORTED`, `E_WAKE_SELF` | `broker/broker.ts`, `broker/client.ts` |
| delivery fingerprint includes the wake target | `broker/protocol.ts` |

## 4. End-to-end flow

```mermaid
sequenceDiagram
    autonumber
    participant U as User / model
    participant S as Sender (extension)
    participant B as Broker
    participant P as WakeProvider (pi-web-sessiond)
    participant D as Session daemon
    participant T as Target (persisted → reopened)

    U->>S: intercom send { to, cwd, message, wakeIfDisconnected: true }
    S->>S: target connected? (roster: piSessionId, intercom id, or exact name in cwd)
    alt connected
        S->>B: ordinary send
    else not connected
        S->>S: checks: wake.enabled, wake-v1, allowCwds, message, confirmation available
        S->>P: list(cwd)
        P->>D: GET /health, GET /sessions?cwd= (read-only)
        P-->>S: exact Pi session id (full id, or exact name unique in cwd; never archived)
        S->>S: not self, duplicate window, rate limits (shared audit)
        S->>U: confirmation dialog
        S->>S: audit: reservation
        S->>B: send { wake: { piSessionId, cwd } }
        B->>B: hold ONCE in the mailbox (target = piSessionId + cwd + scope)
        B-->>S: delivered: queued, code wake_pending
        S->>P: wake(target, messageId)
        P->>D: POST /sessions/:id/commands/run { cwd, text: "/intercom-wake <messageId>" }
        D->>T: open → bind extensions (session_start) → run the command
        Note over T: extension commands run before input handlers and the model: no model call
        T->>B: register { piSessionId, cwd }
        B->>T: mailbox flush: the message
        T->>B: receipts (receiver_received, injected …)
        B-->>S: receipt
        Note over T: normal idle wake: one model turn, caused by the message
        S->>S: audit: outcome (hash and length of the text, never the text)
    end
```

No double execution:
- the wake command is consumed by Pi as a command (no model turn);
- the message exists once (mailbox) and is delivered once (receiver duplicate suppression, broker replay guard);
- if the target reconnects on its own meanwhile, the flush happens once and the command is a no-op;
- the decision to wake comes from the broker's answer (`queued`), not from an earlier roster read, so a race cannot deliver twice.

### 4.1 Broker: `handleWakeSend`

```mermaid
flowchart TD
    A[send with wake] --> B{"valid wake target?<br/>piSessionId ≤ 256, absolute cwd ≤ 4096,<br/>to == piSessionId, no targetId"}
    B -- no --> E1[/"E_INVALID_WAKE"/]
    B -- yes --> C{"replyTo / expectsReply / supersedes?"}
    C -- yes --> E2[/"E_WAKE_UNSUPPORTED"/]
    C -- no --> D{target == sender?}
    D -- yes --> E3[/"E_WAKE_SELF"/]
    D -- no --> F{"replay guard on the fingerprint<br/>(text + wake target)"}
    F -- "same id, other content" --> E4[/"E_MESSAGE_ID_REUSE"/]
    F -- "same send again" --> R[/"previous answer (queued, wake_pending)"/]
    F -- new --> G{"connected sessions with the same<br/>piSessionId + cwd + scope?"}
    G -- "more than one" --> E5[/"E_AMBIGUOUS_TARGET"/]
    G -- "one" --> H["ordinary delivery + receipts<br/>nothing held"]
    G -- "none" --> I["hold in the mailbox<br/>target = piSessionId + cwd + scope"]
    I --> J[/"delivered: queued, code wake_pending"/]
```

Matching at flush (`matchesWakeTarget`): same scope **and** same directory (`sameCwd`) **and** equal `piSessionId`; for an older client that reports no `piSessionId`, its intercom id must equal the Pi session id. Never by name, never in another directory.

### 4.2 Lifecycle of a held message

```mermaid
stateDiagram-v2
    [*] --> Held: send {wake} accepted (wake_pending)
    Held --> Delivered: target registers (piSessionId + cwd) → flush
    Held --> Withdrawn: host refused the wake (not found, archived, rejected) → cancel_message
    Held --> Expired: 24 h without delivery
    Held --> Evicted: mailbox full (256)
    Held --> Lost: broker restart (memory only)
    Delivered --> Injected: receipt injected
    Injected --> [*]
    Withdrawn --> [*]
    Expired --> [*]
    Evicted --> [*]
    Lost --> [*]
```

## 5. Sender decision tree

```mermaid
flowchart TD
    A([send with wakeIfDisconnected]) --> B{target connected?}
    B -- yes --> Z1[ordinary send, nothing woken]
    B -- no --> C{"wake.enabled, wake-v1,<br/>provider, cwd in allowCwds?"}
    C -- no --> F1[/blocked/]
    C -- yes --> M{"message: not empty, ≤ 32 KiB,<br/>no recognizable secret"}
    M -- no --> F1
    M -- yes --> E[provider: catalog of cwd]
    E --> G{daemon reachable and recognized?}
    G -- no --> F3[/blocked: provider unavailable or unsupported/]
    G -- yes --> H{"exact, unique, not archived, not self?"}
    H -- no --> F4[/blocked/]
    H -- yes --> I{duplicate or rate limit?}
    I -- yes --> F5[/blocked/]
    I -- no --> J{user confirms?}
    J -- no --> F6[/refused/]
    J -- yes --> K["audit reservation (if it cannot be written: stop)"]
    K --> L[hold in broker → provider.wake → wait for receipt]
    L --> N{result}
    N -- receipt --> Z2[/delivered/]
    N -- definitive refusal --> W[withdraw held message] --> F7[/failed/]
    N -- unknown --> O[/uncertain or unconfirmed: still held, do not resend/]
```

## 6. Receiver: `/intercom-wake`

```mermaid
sequenceDiagram
    participant D as Session daemon
    participant X as Extension in the reopened session
    participant B as Broker
    D->>X: open → bind extensions → session_start (deferred broker connection)
    D->>X: run command "/intercom-wake <messageId>"
    X->>X: message id safe? otherwise notice and stop
    X->>B: ensureConnected, bounded by receiveTimeoutMs
    B-->>X: registered + mailbox flush: message
    X->>X: handleIncomingMessage (duplicates, receipts, idle wake: one model turn)
    loop every 50 ms until receiveTimeoutMs
        X->>X: message id seen?
    end
    X->>X: appendEntry intercom_wake { outcome: received | not_received | connect_failed }
```

The command is registered unconditionally, even with intercom or wake disabled, so a reopened session always consumes the prompt as a command.

## 7. The `pi-web-sessiond` provider (experimental)

```mermaid
flowchart LR
    EP["endpoint: wake.sessiondSocket / wake.sessiondUrl<br/>or PI_WEB_SESSIOND_SOCKET / PI_WEB_SESSIOND_URL<br/>never guessed"] --> L["list(cwd)"]
    EP --> W["wake(target, messageId)"]
    L --> H["GET /health: ok and component sessiond"]
    H --> C["GET /sessions?cwd= (read-only, loads nothing)"]
    W --> P["POST /sessions/:id/commands/run<br/>{ cwd, text: '/intercom-wake id' }"]
    P --> M{answer}
    M -- "200 type done" --> OK[/accepted/]
    M -- "200 type unsupported (command missing)" --> E0[/rejected: definitive, nothing sent/]
    M -- "404 / Session not found" --> E1[/not_found: definitive/]
    M -- "400 archived" --> E2[/archived: definitive/]
    M -- "other 4xx" --> E3[/rejected: definitive/]
    M -- "5xx" --> E4[/server_error: UNKNOWN/]
    M -- "timeout after sending" --> E5[/timeout: UNKNOWN/]
    M -- "other 200 shape" --> E6[/unsupported: definitive/]
```

- These are **internal, unsupported** PI WEB routes. Any unexpected answer is a refusal.
- No other session route is called: status, messages and snapshots also open a session.
- `commands/run` is used instead of `/prompt` because it runs only commands the session has. With `/prompt`, a session whose intercom is missing or too old would receive `/intercom-wake …` as a prompt for its model. It also does not echo the command in the UI.
- A definitive error withdraws the held message (`cancel_message`); an unknown outcome leaves it held and tells the caller not to resend.
- Another host can register its own provider (`registerWakeProvider`).

## 8. Policy, limits and audit

- Off by default (`wake.enabled`), restricted to `wake.allowCwds`, confirmed by the user (`wake.confirm: "always"` blocks without a UI).
- Messages that look like secrets (tokens, private keys, password assignments) or exceed 32 KiB are refused.
- Duplicate window and per-session / global rate limits are computed from the **audit file**, which every session of the user shares, so they hold across processes. A reservation is written before the wake and the limits are checked again with it counted, which closes the race between two sessions. A reservation whose attempt ends `failed` (the host refused, nothing happened) does not count.
- Audit: `wake-audit.jsonl` next to `config.json`, mode 0600, bounded by entries and age. It records time, outcome, ids, directory, daemon version, text length and SHA-256 — **never the text**. If it cannot be written, nothing is woken.

## 8.1 Trusted senders: `/wake-trust`

```mermaid
sequenceDiagram
    participant U as User
    participant G as Session to trust (e.g. a coordinator)
    participant F as wake-trust.json (0600)
    participant A as wake-audit.jsonl
    U->>G: /wake-trust on
    G->>U: dialog "Allow this session to wake others without asking?"
    U-->>G: confirm
    G->>F: grant { piSessionId (read in-process), name and cwd for display, expiry = trustDays }
    G->>A: trust_granted
    Note over G: later wakes: trust.find(own piSessionId) → no dialog, even without a UI
    U->>G: /wake-trust off (or from another session: /wake-trust revoke <id>)
    G->>U: confirmation dialog
    G->>F: remove
    G->>A: trust_revoked
```

- Identity is the sender's Pi session id, read by the extension in its own process: another session cannot use it, and a name does not count (names are self-declared). A replacement coordinator is granted again; the old one is revoked or simply expires.
- A grant removes only the dialog. Allowlist, secret check, duplicates, limits and audit still apply; every wake records `confirmedBy` (`user`, `trust`, `config`).
- An unreadable or unknown file grants nothing (the dialog comes back); a new confirmed grant repairs it.
- Limit: it does not defend against a hostile local process with shell access, which could also answer dialogs through PI WEB's API (same trust model as the confirmation itself).

## 9. Sessions that are already open and busy

A session can be loaded in PI WEB but missing from the intercom roster (opened a moment ago, or with its intercom disconnected), so the sender treats it as persisted. Verified on an isolated daemon with a scripted local model (`scripts/e2e/run.sh busy`):

| Session state | `commands/run` (used) | `/prompt` (not used) |
|---|---|---|
| model turn in progress | command runs at once (~1 s), no model call, turn completes | same |
| compaction in progress | command runs right after the compaction, no model call | same |
| `ask_user` form open | **the form is closed as unanswered** (PI WEB does this before running any prompt or command); no turn | same |
| command not registered (intercom missing or old) | refused (`unsupported`), nothing reaches the model | **the text reaches the model as a prompt** |
| archived / missing session | 400 / 404 | 400 / 404 |

The closed form is the one side effect that cannot be avoided from intercom; the confirmation dialog mentions it.

## 10. Files

| File | Content |
|---|---|
| `types.ts` | features, `WakeTarget`, `wake_pending`, limits |
| `broker/protocol.ts` | `piSessionId` validation, `isWakeTarget`, fingerprint |
| `broker/broker.ts` | roster `piSessionId`, features, `handleWakeSend`, `matchesWakeTarget`, exact flush |
| `broker/client.ts` | `send({ wake })`, fail-closed without `wake-v1` |
| `config.ts` | `wake` section (off by default), strict validation |
| `wake/provider.ts` | `WakeProvider`, `WakeError` (definitive vs unknown), registry, command constants |
| `wake/resolve.ts` | exact resolution: full id, or exact unique name; never prefixes; archived refused |
| `wake/policy.ts` | allowlist, secret-like content, size, duplicates, rate limits |
| `wake/audit.ts` | JSONL 0600, hash and length, retention, tolerant reader |
| `wake/trust.ts` | `/wake-trust` grants: 0600, atomic writes, expiry, fail closed |
| `wake/controller.ts` | `performWake`, `findLiveWakeTarget` |
| `wake/sessiond.ts`, `wake/builtin.ts` | PI WEB provider and its registration |
| `index.ts` | tool option `wakeIfDisconnected`, `sendWithWake`, `/intercom-wake`, `/intercom-wake-status` |
| `scripts/test-isolated.sh` | runs the suite without touching a live broker |
| `scripts/e2e/` | end-to-end checks on an isolated PI WEB daemon and broker (`wake`, `busy`) |
| `scripts/ops/` | broker swap under the spawn lock, broker probe, production wake check |

## 11. Testing

- Unit: `broker/protocol.test.ts`, `config.test.ts`, `wake/*.test.ts` (including a fake session daemon on a UNIX socket).
- Integration: `intercom.integration.test.ts` — real broker, two extension harnesses, fake provider.
- End to end: `scripts/e2e/run.sh` starts a PI WEB session daemon and a broker in a throwaway directory with a cleaned environment, writes a persisted session that was never loaded, and checks the whole flow (23 checks); `scripts/e2e/run.sh busy` covers sessions that are already open and busy. Each run stops only the processes it started and removes its directory.
- Run the suite with `scripts/test-isolated.sh`: inside a Pi session, `PI_CODING_AGENT_DIR` would otherwise point the tests at the live broker.

## 16. Creare una sessione in un altro progetto: `spawn` ✅

```mermaid
sequenceDiagram
    participant S as Sessione mittente
    participant C as controller (performWake, spawn: true)
    participant U as Utente
    participant D as sessiond
    participant B as Broker
    participant N as Nuova sessione
    S->>C: intercom spawn { cwd, message }
    C->>C: enabled, cwd in allowCwds, segreti, nessuna catena, deduplica, limite spawnMax
    C->>U: dialog (default: sempre, anche per /wake-trust)
    U-->>C: conferma
    C->>C: audit attempting (kind spawn)
    C->>D: POST /sessions { cwd }  → id Pi
    C->>B: send al nuovo id con wake target (tenuto una sola volta)
    C->>D: POST /sessions/:id/commands/run "/intercom-wake <id>"
    D->>N: esegue il comando (nessuna chiamata al modello)
    N->>B: si registra; il broker consegna il messaggio
    B-->>C: ricevuta → delivered
```

- **Stesso flusso del wake**, senza il catalogo: la sessione nuova non è salvata finché il modello non risponde, quindi non è elencabile; il suo id arriva direttamente da `POST /sessions`.
- **Permesso:** `wake.spawnConfirm` = `always` (default; chiede sempre e blocca senza UI), `trusted` (i mittenti con `/wake-trust` non vengono richiesti) o `never`. Distinto da `wake.confirm` perché creare una sessione è più forte di svegliarne una.
- **Nessuna catena:** una sessione che compare come destinazione di uno `spawn` nell'audit non può usarlo.
- **Limiti:** `wake.spawnMax` per `wake.spawnWindowMs` (5 per ora), oltre ai limiti globali del wake e alla deduplica (chiave `spawn + cwd + testo`).
- **Esiti incerti:** se la creazione scade, una sessione vuota potrebbe esistere e il messaggio non viene inviato. Se la consegna viene rifiutata, il messaggio in coda è ritirato e la sessione vuota resta (nessun cleanup automatico).
- **Verifica:** `scripts/e2e/run.sh` (37 controlli, undici sullo spawn) su daemon isolato; il modello non c'è, quindi si controlla il messaggio via API del daemon invece del file di storia.

## 17. Archiviare una sessione creata da `spawn`: `archive` ✅

- **Conferma umana sempre.** Nessuna configurazione e nessun `/wake-trust` tolgono il dialogo; senza UI l'azione si blocca (`confirmation_unavailable`). Diverso da `wake.confirm` e `wake.spawnConfirm`, che si possono allentare.
- **Solo sessioni proprie.** L'audit deve contenere uno `spawn` non bloccato né rifiutato con `target.piSessionId` uguale, cartella uguale e `sender.piSessionId` uguale al mittente. Un mittente diverso, un wake, un'altra cartella → `not_created_by_you`, senza nemmeno disturbare l'utente. Mai sé stessi.
- **Provider sessiond:** solo `POST /sessions/bulk/archive` (archivia senza caricare una sessione dormiente). Il daemon risponde **200 anche per le sessioni che rifiuta**: il successo vale solo se l'id è in `archivedSessionIds`; altrimenti si legge `failures`.
- **Sessione al lavoro:** il daemon rifiuta («Stop current session activity before archiving»); il provider lo traduce in `busy`. Verificato su daemon isolato con una sessione in streaming: turno completato normalmente, nessuna archiviazione; riprovando a sessione ferma funziona.
- **Reversibile:** la sessione viene chiusa e spostata nell'archivio di PI WEB; non si cancella nulla. Un wake successivo è rifiutato («archived»).
- **Limite noto:** una sessione che non ha mai risposto non ha ancora un file salvato; il daemon risponde con errore (ENOENT) e l'azione fallisce senza dichiarare successo.
- **Limiti:** `wake.archiveMax` per `wake.spawnWindowMs` (10 per ora); audit `kind: "archive"`, `confirmedBy: "user"`, senza testo.
- **Dialoghi :** PI WEB rifiuta un dialogo oltre 1000 caratteri; tutti i dialoghi (wake, spawn, archive) sono costruiti con `dialogBody` entro 900 caratteri e un dialogo che fallisce è `confirmation_failed`, mai `user_declined`.
- **Verifica:** unit test (controller, policy, provider), E2E isolato `run.sh` (44 controlli) e `run.sh busy` (idle, al lavoro, mai risposta).

