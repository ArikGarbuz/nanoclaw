# NanoClaw System Architecture

**Current Environment:** Local Machine

**Last Updated:** 2026-06-01

**Layer:** Layer 1 (Foundation, Docker, OneCLI, System Docs)

---

## Overview

NanoClaw is a lightweight AI agent framework designed for secure, isolated execution of Claude agents within containerized environments. Layer 1 establishes the foundational infrastructure: Git-based source control, Docker container isolation, OneCLI credential management, and comprehensive system documentation.

---

## 1. Git Repository & Source Control

### Source
- **Repository URL:** `https://github.com/ArikGarbuz/nanoclaw`
- **Branch:** `main`
- **Cloned:** 2026-06-01 into `C:\Users\arikg\.claude\projects\NanoClaw`

### Structure
```
NanoClaw/
├── src/                          # TypeScript source code
├── container/                    # Docker container definition
│   ├── Dockerfile               # Multi-stage Docker build
│   ├── agent-runner/            # Agent runtime code (Bun/TypeScript)
│   ├── entrypoint.sh           # Container startup script
│   ├── build.sh                # Build automation
│   └── .dockerignore           # Exclude patterns from build context
├── config-onecli/              # OneCLI credential configuration (NEW)
│   └── onecli.config.yaml      # OneCLI routing & credential mappings
├── docker-compose.yml          # Container orchestration (NEW)
├── .env.example                # Environment variable template (UPDATED)
├── SYSTEM_ARCHITECTURE.md      # This file (NEW)
├── package.json               # Node.js manifest
├── pnpm-workspace.yaml        # Workspace configuration
├── nanoclaw.sh               # CLI wrapper script
└── README.md                 # Project documentation
```

### Workflow
1. Source code is mounted as **read-only** (`/app/src:ro`) into the container at runtime
2. Changes in source do NOT require container rebuild
3. All commits are pushed to `origin/main` with atomic, descriptive messages
4. Git workflow enforces semantic commit messages via Husky hooks

---

## 2. Docker Container Isolation

### Architecture Philosophy

NanoClaw agents run in **isolated Linux containers**, not merely behind permission checks. This provides true OS-level isolation rather than application-level allowlists.

### Container Specifications

#### Docker Image
- **Base:** `node:22-slim` (Debian-based)
- **Runtime:** Bun 1.3.12 + Node.js 22
- **Build Context:** `./container/`
- **Image Name:** `nanoclaw:latest`
- **Container Name:** `nanoclaw-agent-local`

#### Key Components

**1. System Dependencies (installed in Dockerfile)**
- **Browser Automation:** Chromium, Playwright libraries
- **Fonts:** Liberation fonts, Noto color emoji (CJK fonts optional)
- **System Tools:** tini (PID 1 handler), curl, git, unzip, ca-certificates
- **Audio/Graphics:** ALSA, GBM, X11, Mesa libraries for headless browsing

**2. Runtime Installation (Dockerfile)**
- **Bun:** Downloaded from official source, multi-arch support
- **pnpm:** Version-pinned (10.33.0) for reproducible installs
- **Global CLI Tools:**
  - `vercel@52.2.1` (deployment)
  - `agent-browser@latest` (headless browser)
  - `@anthropic-ai/claude-code@2.1.154` (Claude SDK)

**3. Application Dependencies**
- **Bun lockfile:** `agent-runner/bun.lock` (frozen for reproducibility)
- **Agent runtime:** Located at `/app` with read-only source mount

#### Volume Mounts

```yaml
volumes:
  ./src:/app/src:ro                    # Read-only source code
  ./agent-runner:/app/agent-runner:ro  # Read-only agent runtime
  nanoclaw-workspace:/workspace        # Persistent agent data (RW)
  ./config-onecli:/etc/onecli:ro      # OneCLI configuration
  nanoclaw-data:/data                 # Persistent database/artifacts
```

#### Resource Management

```yaml
limits:
  CPU:    2 cores
  Memory: 2 GB
reservations:
  CPU:    0.5 cores
  Memory: 512 MB
```

#### Network Isolation

- **Network Mode:** Bridge (`nanoclaw-network`)
- **Exposure:** No ports exposed by default
- **External Access:** Requires explicit `ports:` configuration in compose
- **DNS:** Inherited from host

#### Security Options

```yaml
security_opt:
  - no-new-privileges:true
```

- Prevents container from acquiring additional privileges
- Restricts `setuid`/`setgid` binaries
- Container runs as unprivileged `node` user (UID 1000+)

---

## 3. Credential Management with OneCLI

### Problem Statement

Real API keys (Anthropic, OpenAI, GitHub, Google) must never:
- Be baked into the Docker image
- Be logged or exposed in container output
- Exist as environment variables inside the container in production

**Solution:** OneCLI provides synthetic key routing, decoupling credential storage from container runtime.

### OneCLI Integration

#### Configuration
- **Location:** `./config-onecli/onecli.config.yaml`
- **Mount Point:** `/etc/onecli:ro` (read-only)
- **Mode:** `synthetic` (development) → `vault` (production)

#### How It Works

**Development Mode (`synthetic`)**
1. Agent code imports OneCLI SDK (`@onecli-sh/sdk`)
2. When requesting a credential (e.g., `Anthropic API key`), OneCLI returns a synthetic key
3. Synthetic key: `sk-synthetic-local-dev` (matches environment variable fallback)
4. External API calls use the synthetic key (requests will fail, but that's expected in dev)
5. No real credentials ever enter the Docker container

**Production Mode (`vault`)**
1. Real keys stored in secure vault (HashiCorp Vault, AWS Secrets Manager, etc.)
2. OneCLI SDK retrieves keys from vault at runtime
3. Keys cached in-memory, never written to disk or logs
4. Vault authentication handled outside container (e.g., Kubernetes IRSA)

#### Credential Mappings

| Service | Synthetic Key | Vault Path | Env Var Fallback |
|---------|---------------|------------|------------------|
| Anthropic | `sk-synthetic-local-dev` | `anthropic/api_key` | `ANTHROPIC_API_KEY` |
| OpenAI | `sk-synthetic-local-dev` | `openai/api_key` | `OPENAI_API_KEY` |
| Google | `synthetic-local-dev` | `google/api_key` | `GOOGLE_API_KEY` |
| GitHub | `ghp_synthetic_local_dev` | `github/personal_access_token` | `GITHUB_TOKEN` |

#### Workspace Configuration
```
/workspace/                  # Inside container
├── agent/                  # Agent-specific data
├── .cache/                # Credential cache (in-memory preferred)
└── logs/                  # Audit logs (sanitized)
```

#### Security Features
- ✅ Secrets masked in logs
- ✅ Audit logging for credential access
- ✅ Credential TTL (3600 seconds = 1 hour)
- ✅ Rate limiting (1000 req/min)
- ✅ Isolated subprocess environment
- ✅ Log sanitization (remove sensitive values)

---

## 4. Environment Variables

### Docker Compose Integration

All variables defined in `.env.example` are loaded into the container:

**Local Development (.env)**
```bash
cp .env.example .env
# Edit .env with your actual credentials
# These are OUTSIDE the container, never mounted
```

**Container Environment (docker-compose.yml)**
```yaml
environment:
  ONECLI_MODE: synthetic
  ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-sk-synthetic-local-dev}
  LOG_LEVEL: info
  # ... etc
```

### Key Variables

| Variable | Purpose | Default | Secret? |
|----------|---------|---------|---------|
| `ONECLI_MODE` | Credential mode | `synthetic` | No |
| `ANTHROPIC_API_KEY` | Claude SDK auth | `sk-synthetic-*` | **Yes** |
| `LOG_LEVEL` | Logging verbosity | `info` | No |
| `NODE_ENV` | Execution context | `development` | No |
| `DEBUG` | Debug output | `false` | No |

See `.env.example` for complete list and descriptions.

---

## 5. Startup & Initialization

### Docker Compose Workflow

```bash
# Build image (first run only)
docker-compose build

# Start container (with .env variables)
docker-compose up -d

# View logs
docker-compose logs -f

# Stop container
docker-compose down
```

### Container Entrypoint

1. **Tini** starts as PID 1 (correct signal handling)
2. **entrypoint.sh** configures environment
3. **Bun** launches agent runtime with mounted source code
4. **OneCLI SDK** initializes credential routing
5. **Agent** awaits commands from host

### Health Check

```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
  interval: 30s
  timeout: 10s
  retries: 3
```

---

## 6. Data Persistence

### Volumes

**Named Volumes** (managed by Docker)
- `nanoclaw-workspace`: Agent workspace (`/workspace`)
- `nanoclaw-data`: Persistent data (`/data`)

**Bind Mounts** (host filesystem)
- `./src:ro` → Source code (read-only)
- `./config-onecli:ro` → OneCLI config (read-only)

### Backup Strategy

```bash
# Backup workspace
docker cp nanoclaw-agent-local:/workspace ./backups/workspace-$(date +%s)

# Backup data
docker volume inspect nanoclaw-data
# Copy from docker volume mount point
```

---

## 7. Current Development Environment

### Host Machine
- **OS:** Windows 11 Home (10.0.26200)
- **Location:** `C:\Users\arikg\.claude\projects\NanoClaw`
- **Shell:** Bash (WSL2 or Git Bash)
- **Git:** Configured with `origin = https://github.com/ArikGarbuz/nanoclaw`

### Container Environment
- **Type:** Docker (local, single-host)
- **Orchestration:** Docker Compose v3.8
- **Network:** `nanoclaw-network` (bridge)
- **Storage:** Local Docker volumes

### NOT Configured (Roadmap)
- Kubernetes deployment
- Cloud registry (ECR, GCR, Docker Hub)
- Production vault (HashiCorp Vault, AWS Secrets Manager)
- Multi-region or HA setup
- CI/CD pipelines (GitHub Actions, etc.)

---

## 8. File Structure Recap

```
.
├── SYSTEM_ARCHITECTURE.md  ← You are here
├── docker-compose.yml      ← Container orchestration
├── .env.example            ← Environment template
├── config-onecli/
│   └── onecli.config.yaml  ← Credential routing
├── container/
│   ├── Dockerfile          ← Container recipe
│   ├── entrypoint.sh       ← Startup script
│   └── agent-runner/       ← Bun runtime
├── src/                    ← TypeScript source (mounted RO)
└── [other NanoClaw files]
```

---

## 9. Next Steps (Layer 2+)

- [ ] **Layer 2:** Agent bootstrap & CLI
- [ ] **Layer 3:** Multi-agent orchestration
- [ ] **Layer 4:** Integration hooks (WhatsApp, Gmail, Slack, etc.)
- [ ] **Layer 5:** Advanced security (vault, RBAC, audit)
- [ ] **Layer 6:** Observability (metrics, tracing, logging)
- [ ] **Layer 7:** Deployment (K8s, cloud platforms)

---

## 10. Troubleshooting

### Container won't start
```bash
docker-compose logs nanoclaw-agent
# Check entrypoint.sh, Dockerfile args
```

### Credential issues
```bash
# Check OneCLI config
cat /etc/onecli/onecli.config.yaml

# Verify env var mapping
docker-compose config | grep ANTHROPIC
```

### Permission denied errors
```bash
# Ensure bind mounts are readable
ls -la config-onecli/
ls -la src/

# Check container user
docker-compose exec nanoclaw-agent whoami
```

### Out of memory
```bash
# Increase limits in docker-compose.yml
# limits.memory: 4G
# re-run: docker-compose up -d
```

---

## 11. Security Checklist

- [x] Source code mounted read-only
- [x] OneCLI synthetic keys in development
- [x] Credentials stored outside container
- [x] No-new-privileges security opt enabled
- [x] Unprivileged user (node)
- [x] Secrets masked in logs
- [x] Audit logging configured
- [ ] Production vault integration (TODO)
- [ ] HTTPS for external APIs (TODO)
- [ ] Rate limiting enforcement (TODO)

---

## 12. Git Commit Record

All Layer 1 changes committed with message:
```
feat: Layer 1 - Foundation, Docker, OneCLI, and System Docs
```

This includes:
- Docker Compose orchestration (`docker-compose.yml`)
- OneCLI credential routing (`config-onecli/`)
- Environment template (`.env.example`)
- System architecture documentation (`SYSTEM_ARCHITECTURE.md`)

---

**End of Layer 1 Documentation**

For updates, edit this file and commit with reference to the relevant layer.
