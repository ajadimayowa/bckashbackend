# Cooperative Loan Backend

Backend API for a cooperative society's group business loan management platform.
Modular monolith (NestJS + MongoDB/Mongoose + BullMQ/Redis), TypeScript strict mode.
No frontend here — this serves a mobile app and web frontend to be built separately.

## Tech stack

- **Language**: TypeScript (strict)
- **Framework**: NestJS 11 / Node 20+
- **Database**: MongoDB via Mongoose, targeting a MongoDB Atlas replica set (multi-document transactions are used for money-moving operations)
- **Queue**: BullMQ on Redis — notifications, penalty sweeps, funding reminders
- **Validation**: class-validator / class-transformer on every DTO
- **Auth**: JWT (short-lived access token + refresh token)
- **Currency**: single currency, NGN — **every monetary amount is stored as an integer in kobo**, never a float
- **Hosting**: Render (see [render.yaml](./render.yaml))

## Architecture

Modular monolith. NestJS module boundaries enforce domain separation; no module reaches into
another module's schemas/repositories directly.

```
src/
  platform/            # cross-cutting engine used by every domain module
    workflow-engine/    # generic maker-checker-approver engine
    rbac/                # role + module-permission guard
    audit/                # append-only audit log
    jobs/                  # BullMQ processors
    integrations/           # NIBSS, Rekognition, Brevo, Termii, S3 adapters
  modules/              # domain modules (identity, branches, customers, groups,
                         # loan-products, loans, repayments, accounting, hr, notifications)
  common/               # shared DTOs, enums, decorators, guards, interceptors, config
```

Each `platform/` and `modules/` subfolder currently holds a `README.md` stub noting which
build phase implements it — see the project brief for the full phase plan. This keeps the
target structure visible in git from the start rather than materializing folders ad hoc.

## Getting started

```bash
npm install
cp .env.example .env   # then fill in real values — see below
npm run start:dev
```

Requires a reachable MongoDB (replica set) and Redis instance — the app validates and
connects to both at boot (see `src/common/config/env.validation.ts`, `src/app.module.ts`).
For local development, a single-node Mongo replica set and a local Redis both work fine.

### Scripts

| Script | Purpose |
| --- | --- |
| `npm run start:dev` | Watch-mode dev server |
| `npm run build` | Production build (`dist/`) |
| `npm run start:prod` | Run the built app |
| `npm run lint` / `lint:fix` | ESLint (flat config, typescript-eslint, zero warnings allowed) |
| `npm run format` / `format:check` | Prettier |
| `npm test` | Unit tests (Jest, colocated `*.spec.ts`) |
| `npm run test:cov` | Unit tests with coverage |
| `npm run test:e2e` | e2e tests (`test/*.e2e-spec.ts`) |
| `npm run typecheck` | `tsc --noEmit` |

## Environment variables

See [.env.example](./.env.example) for the full list (app, Mongo, Redis, JWT, PII field-level
encryption key, NIBSS, AWS S3 + Rekognition, Brevo, Termii). All are validated at boot via a
Joi schema (`src/common/config/env.validation.ts`) — the app refuses to start if required
values are missing or malformed. Third-party provider credentials (NIBSS/AWS/Brevo/Termii)
are optional at the schema level so the app can boot locally without sandbox credentials;
the adapters built in later phases will no-op/stub behind their interfaces when a key is absent.

## Conventions

- **Money**: integers in kobo, never floats. Fee/penalty/interest math lives in pure,
  fully unit-tested functions (`loan-products` module).
- **Approvals**: any approvable entity creates a `WorkflowRequest` via the generic
  workflow engine (`platform/workflow-engine`) rather than implementing bespoke
  approval logic — see the engine's own README once built (Phase 2).
- **Config**: read via `ConfigService`, never `process.env` directly outside
  `src/common/config/configuration.ts`.
- **Path aliases**: `@platform/*`, `@modules/*`, `@common/*` (see `tsconfig.json`).

## Deployment (Render)

`render.yaml` defines the API web service. MongoDB is Atlas (external — not provisioned by
Render); point `MONGO_URI` at it. Redis should be a managed instance (e.g. Render Key Value)
— set `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`/`REDIS_TLS`. A separate `worker` service for
BullMQ processors will be added once `platform/jobs` exists.

## Status

Phase 1 (project scaffold) complete. See the project brief for the full phase plan;
each phase's summary (assumptions made, open questions) will be added here or communicated
inline as work proceeds.
