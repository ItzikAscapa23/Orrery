# Orrery

Spec-Driven Development orchestrator. Orrery automates the full coding cycle — spec writing, planning, implementation, code review, and testing — using a multi-agent loop built on Anthropic Claude.

A human operator writes a requirement. Orrery produces a spec, negotiates it with the operator, fans tasks out across one or more git repos, opens PRs, and parks at each gate until the operator approves. The operator stays in the loop at every decision point; no code ships without approval.

---

## Prerequisites

- **Node.js 20+**
- **Docker** (for Postgres, Redis, and the isolated agent containers)
- An **Anthropic API key** (direct API) or **AWS Bedrock credentials** (corporate Bedrock mode)

---

## Quick start

### 1. Clone and install

```bash
git clone <repo-url>
cd orrery
npm install
```

### 2. Configure environment

```bash
cp env.template .env
# Edit .env — at minimum set ANTHROPIC_API_KEY (or Bedrock vars) and ARTIFACTS_REPO_PATH
```

Key variables:

| Variable | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes (direct API mode) | Anthropic API key |
| `ANTHROPIC_PROVIDER` | No | `anthropic` (default) or `bedrock` |
| `AWS_PROFILE` | Bedrock mode | AWS SSO profile name |
| `BEDROCK_MODEL_ID` | Bedrock mode | Application inference profile ARN |
| `ARTIFACTS_REPO_PATH` | Yes | Absolute path to a local git repo for specs/plans |
| `DATABASE_URL` | No | Defaults to `postgresql://orrery:orrery@localhost:5432/orrery` |
| `REDIS_URL` | No | Defaults to `redis://localhost:6379` |
| `AZURE_DEVOPS_PAT` | PR creation only | Azure DevOps PAT with Code: Read & Write |
| `BOT_GIT_NAME` | No | Git author name for agent commits (default: `Orrery`) |
| `BOT_GIT_EMAIL` | No | Git author email (default: `orrery-bot@example.com`) |
| `CONTAINER_PREFIX` | No | Docker container name prefix (default: `orrery-agent`) |
| `VITE_PRODUCT_NAME` | No | Product name in the UI (default: `Orrery`) |
| `VITE_TENANT_LINE` | No | Subtitle in the UI header (default: `AGENT SOLAR SYSTEM`) |

See `env.template` for the full list with comments.

### 3. Start infrastructure

```bash
docker compose up -d          # starts Postgres 16 + Redis 7
```

### 4. Set up the database

```bash
npx prisma migrate deploy -w apps/server
# One-time: create the test database (needed for npm test)
docker compose exec postgres psql -U orrery -c "CREATE DATABASE orrery_test OWNER orrery"
DATABASE_URL="postgresql://orrery:orrery@localhost:5432/orrery_test" \
  npx prisma migrate deploy -w apps/server
```

### 5. Configure the repo manifest

Orrery dispatches dev-agent jobs to repos listed in `docs/agents/repo-manifest.yaml`. Copy the example and fill in your repos:

```bash
cp docs/agents/repo-manifest.example.yaml docs/agents/repo-manifest.yaml
# Edit docs/agents/repo-manifest.yaml — add your ADO/GitHub repo URLs and set active: true
```

See `docs/agents/repo-manifest.example.yaml` for the full field reference and the repo readiness checklist that must pass before setting a repo active.

### 6. Run

```bash
npm run dev                   # starts server (port 3001) + web UI (port 5173)
```

Open [http://localhost:5173](http://localhost:5173).

---

## Corporate network / AWS Bedrock mode

When running through a TLS-inspecting proxy, set `NODE_EXTRA_CA_CERTS` in your shell (not in `.env` — Node reads it at bootstrap before the env file is loaded):

```bash
export NODE_EXTRA_CA_CERTS=/path/to/corporate-ca.pem
npm run dev
```

Verify the cert before starting:

```bash
curl --cacert "$NODE_EXTRA_CA_CERTS" -s -o /dev/null -w "%{http_code}\n" \
  https://bedrock-runtime.eu-west-1.amazonaws.com
# Expected: 404 (TLS OK, AWS rejected the unsigned request)
```

Bedrock credentials refresh via `aws sso login --profile <your-profile>` then restart the server.

---

## Tests

```bash
npm test          # runs all Vitest suites (server + web + shared)
npm run typecheck # TypeScript check across all workspaces
npm run lint      # ESLint + Prettier check
```

---

## Architecture

See `docs/specs/` for the phase specs (source of truth for each subsystem).

The server (`apps/server`) is a Fastify API with:
- A state-machine orchestrating feature lifecycle
- BullMQ job queue driving agent runs
- Git-backed artifact storage for spec/plan/contract files
- All LLM calls routed through `src/lib/anthropic.ts`

The web UI (`apps/web`) is a React SPA that derives all state from an append-only event log via `src/lib/eventFold.ts`.

Shared types live in `packages/shared` (`@orrery/shared`) — the single source of truth for event payload shapes consumed by both server and web.
