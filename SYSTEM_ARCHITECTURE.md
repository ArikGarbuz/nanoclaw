# NanoClaw System Architecture

**Current Environment:** Local Machine

**Last Updated:** 2026-06-01 (Layer 3: 2026-06-01)

**Layer:** Layer 3 (Claude LLM Integration, System Prompt, Context & Token Logging)

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

## 9. Telegram Integration (Layer 2)

### Overview

Layer 2 adds Telegram Bot connectivity with **long polling** (no webhooks) for local development. The bot responds to all messages with an "echo" of the user's message. This layer introduces observable logging for every inbound and outbound message, setting the foundation for future Claude LLM integration.

### Architecture

#### Telegram Adapter (`src/channels/telegram.ts`)

The TelegramAdapter implements the NanoClaw `ChannelAdapter` interface:

```typescript
class TelegramAdapter implements ChannelAdapter {
  name = 'Telegram'
  channelType = 'telegram'
  supportsThreads = false  // Telegram has no thread concept
}
```

**Key Properties:**
- **Bot Token:** Read from `TELEGRAM_BOT_TOKEN` environment variable
- **Long Polling:** Updates fetched via Telegram Bot API every 1 second
- **Timeout:** 5-second timeout on each poll request (server-side holds the connection)
- **State:** Maintains `lastUpdateId` to avoid re-processing updates

#### Connection Flow

```
1. Setup Phase:
   - Verify bot token via getMe() API call
   - Log bot identity (@username, ID)
   - Start long polling loop

2. Polling Loop (every 1 second):
   - Call getUpdates(offset=lastUpdateId+1, timeout=5s)
   - For each message received:
     a) Log inbound message details
     b) Generate echo response ("Echo: [user's message]")
     c) Send echo via sendMessage() API
     d) Forward to NanoClaw router for future integration

3. Teardown Phase:
   - Stop polling interval
   - Clear setup callback
```

### Echo Bot Behavior (Layer 2)

**For each user message:**
1. **Inbound Logging:** Log message text, user ID, chat ID, timestamp
2. **Echo Generation:** Create response: `Echo: [original message]`
3. **Outbound Logging:** Log the echo response being sent
4. **Delivery:** Send via Telegram API `sendMessage()` method

**Example:**
```
User: "Hello"
Bot: "Echo: Hello"
```

**Logs:**
```
[Telegram] Received message from chat 123456789 (user 987654321): { text: "Hello" }
[Telegram] Echo response for chat 123456789: { text: "Echo: Hello" }
[Telegram] Sending message to chat 123456789 { text: "Echo: Hello" }
[Telegram] Message sent (ID: 42) to chat 123456789
```

### Observability & Logging

Every Telegram event is logged with structured output using NanoClaw's centralized logger.

#### Log Levels

| Event | Level | Example |
|-------|-------|---------|
| Adapter initialization | `info` | `[Telegram] Adapter initialized: @bot_username (ID: 123)` |
| Incoming message | `info` | `[Telegram] Received message from chat 123 (user 456): { text: "..." }` |
| Echo response | `info` | `[Telegram] Echo response for chat 123: { text: "..." }` |
| Message delivery | `info` | `[Telegram] Sending message to chat 123 { text: "..." }` |
| Message delivery success | `info` | `[Telegram] Message sent (ID: 42) to chat 123` |
| API errors | `error` | `[Telegram] API error: 401 Unauthorized` |
| Configuration errors | `warn` | `[Telegram] No bot token configured, adapter unavailable` |

#### Log Output

Logs are written to:
- **Console:** Real-time observability during development
- **File:** `logs/nanoclaw.log` (host-level aggregation)
- **Format:** Structured JSON with timestamps

### Configuration

#### Environment Variables

| Variable | Purpose | Required | Default |
|----------|---------|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot API token from @BotFather | Yes | (empty) |
| `LOG_LEVEL` | Logging verbosity (debug, info, warn, error) | No | `info` |

#### OneCLI Integration

Telegram bot token is registered in `config-onecli/onecli.config.yaml`:

```yaml
credentials:
  telegram:
    synthetic_key: "tg_synthetic_local_dev"
    vault_path: "telegram/bot_token"
    fallback_env: "TELEGRAM_BOT_TOKEN"
    required: false
    description: "Telegram Bot Token for bot connection"
```

**Credential Flow (Development):**
1. User creates bot via @BotFather → receives token
2. Token stored in host `.env` file as `TELEGRAM_BOT_TOKEN`
3. Token passed to container via docker-compose environment
4. Adapter reads from `process.env.TELEGRAM_BOT_TOKEN`
5. OneCLI config provides vault path for future production migration

#### Docker Compose Setup

```yaml
environment:
  TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN:-}
```

### Bot Setup (User Steps)

1. **Create bot via @BotFather on Telegram:**
   ```
   /start
   /newbot
   → Follow prompts
   → Receive token (e.g., 5123456789:ABCDefGhIjKlMnOpQrStUvWxYzAbCdEfGhI)
   ```

2. **Store token in `.env`:**
   ```bash
   cp .env.example .env
   # Edit .env and set:
   TELEGRAM_BOT_TOKEN=5123456789:ABCDefGhIjKlMnOpQrStUvWxYzAbCdEfGhI
   ```

3. **Start container:**
   ```bash
   docker-compose up -d
   ```

4. **Verify adapter:**
   ```bash
   docker-compose logs -f | grep Telegram
   # Expected: [Telegram] Adapter initialized: @your_bot_name (ID: ...)
   ```

5. **Test echo bot:**
   - Open Telegram
   - Find your bot (`@your_bot_name`)
   - Send a message: "Hello"
   - Expect response: "Echo: Hello"

### Implementation Details

#### Long Polling vs Webhooks

| Aspect | Long Polling | Webhooks |
|--------|--------------|----------|
| Connection | Adapter pulls from Telegram | Telegram pushes to adapter |
| Firewall | Outbound only (≥ firewall-friendly) | Inbound (requires open port) |
| Latency | ~1-5 seconds (polling interval) | <100ms (instant push) |
| Complexity | Simple, no server setup | Requires HTTPS, certificate |
| Local Dev | ✅ Supported | ❌ Requires ngrok/tunnel |

**Layer 2 Choice:** Long polling for simplicity and local development compatibility.

#### API Endpoints Used

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `getMe` | Returns bot info | Verify token on startup |
| `getUpdates` | Fetch pending updates | Polling for messages |
| `sendMessage` | Send text message | Echo responses |

#### Error Handling

| Scenario | Behavior |
|----------|----------|
| Invalid token | Adapter skips initialization; logged as `warn` |
| Network error | Poll gracefully continues; error logged |
| Rate limit (429) | Polling backoff handled by `timeout: 5s` |
| Message send fails | Error logged; session continues |

### Data Structures

#### Inbound Message (from Telegram → NanoClaw)

```typescript
InboundMessage {
  id: "telegram-{message_id}",
  kind: "chat",
  content: {
    text: string,
    userId: string,
    chatId: string,
    chatTitle: string,
    chatType: "private" | "group" | "supergroup" | "channel",
    senderName: string,
    senderUsername?: string,
  },
  timestamp: ISO8601,
  isGroup: boolean,
}
```

#### Outbound Message (from NanoClaw → Telegram)

```typescript
OutboundMessage {
  kind: string,
  content: string | object,  // Formatted as Markdown
}
```

### Future Enhancements (Layer 3+)

- [ ] **LLM Integration:** Route echo handler to Claude API instead of echoing
- [ ] **Webhook Support:** Optional HTTPS webhook delivery for production
- [ ] **Media Support:** Handle photos, files, voice messages
- [ ] **Conversation State:** Track user sessions across messages
- [ ] **Group Management:** Handle group commands, mentions
- [ ] **Inline Buttons:** Add interactive keyboard layouts
- [ ] **File Upload:** Send documents, images from agent

---

## 10. Claude LLM Integration (Layer 3)

### Overview

Layer 3 replaces the Telegram echo bot with Claude-powered intelligent responses. The agent now processes inbound messages through the Anthropic Claude API, maintains conversational context across interaction loops, and logs token usage for cost monitoring.

### Architecture

#### Model Configuration

**Default Model:** `claude-haiku-4-5-20251001`
- **Why Haiku:** Optimized for speed and cost-efficiency (~4x cheaper than Opus)
- **Context Window:** 200k tokens
- **Inference Speed:** ~1000 tokens/second
- **Use Case:** Real-time mobile operations assistant

**Configuration Flow:**
```typescript
// container/agent-runner/src/providers/claude.ts
const sdkResult = sdkQuery({
  // ...
  model: this.model || 'claude-haiku-4-5-20251001',  // Default to Haiku
});
```

#### System Prompt (Operations Assistant)

The agent is configured with a **specialized system prompt** that instructs it to act as a direct, pragmatic operations assistant optimized for mobile use:

```
Role: You are a highly effective, direct, and pragmatic operations assistant
optimized for mobile use. Your primary objective is to process raw web and
social media data into immediate, actionable operational clarity with zero
cognitive overload.

Communication Style: ZERO FLUFF. No greetings, compliments, or apologies.
Output exactly in Hebrew (keep technical terms in English). Direct, factual,
results-driven.

Structure your final output exactly as follows:
<thought> [Internal reasoning] </thought>
1. **שורה תחתונה (BLUF):** One clear sentence stating the core trend.
2. **תובנות מפתח מהשטח:** Up to 3 bullet points on pains/trends.
3. **משמעות אופרטיבית:** Implications for supply chain, time, cost, resources.
4. **מקורות מרכזיים:** Links or data sources backing the analysis.

Constraints: Keep outputs short and scannable for mobile. Never ask follow-ups.
```

**Injection Point:** `container/agent-runner/src/providers/claude.ts:398-417`

#### Session Tracking & Context Retention

**Continuation Persistence:**
```typescript
// container/agent-runner/src/poll-loop.ts:84-97
let continuation: string | undefined = migrateLegacyContinuation(config.providerName);

// Before resuming, check if continuation is too large/old
if (continuation) {
  const rotateReason = config.provider.maybeRotateContinuation?.(continuation, config.cwd);
  if (rotateReason) {
    log(`Rotating session — ${rotateReason}`);
    continuation = undefined;
  }
}
```

**Per-Session Storage:**
- **Location:** `data/v2-sessions/<session_id>/`
  - `inbound.db` — host writes, container reads (messages from Telegram)
  - `outbound.db` — container writes, host reads (responses to send)
- **Session ID:** Unique per (agent_group + messaging_group + thread)
- **Continuation:** Claude SDK session ID stored in `container_state` table

**Session Lifecycle:**
1. **Init:** Container starts, checks for prior continuation
2. **Resume:** If continuation exists and is valid, resume prior session
3. **Rotate:** If transcript exceeds size/age limits, archive and start fresh
4. **Process:** Agent receives message, context includes entire prior transcript
5. **Persist:** After each result, continuation ID is persisted to `session_state`

#### Token Observability

Every LLM response now logs exact token usage for cost monitoring:

**Log Format:**
```
[TOKEN-USAGE] Prompt: 1234, Completion: 567, Cache-Creation: 100
```

**Token Types Tracked:**
| Type | Description | Impact on Cost |
|------|-------------|-----------------|
| `Prompt` | Input tokens (including from transcript cache) | Standard billing |
| `Completion` | Output tokens generated by model | Standard billing |
| `Cache-Creation` | Tokens used to create prompt cache | Billed at 25% of input rate |
| `Cache-Read` | Tokens read from prompt cache | Billed at 10% of input rate |

**Implementation:**
```typescript
// container/agent-runner/src/poll-loop.ts:481-494
if ('tokenUsage' in event && event.tokenUsage) {
  const usage = event.tokenUsage as TokenUsage;
  const promptTokens = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  const completionTokens = usage.output_tokens || 0;
  const cacheCreation = usage.cache_creation_input_tokens || 0;
  log(`[TOKEN-USAGE] Prompt: ${promptTokens}, Completion: ${completionTokens}${cacheCreation > 0 ? `, Cache-Creation: ${cacheCreation}` : ''}`);
}
```

**Token Extraction Path:**
```typescript
// In Claude provider's translateEvents():
const tokenUsage = message.usage;  // From SDK result event
yield { type: 'result', text, tokenUsage };  // Pass to poll-loop
```

### Data Flow: Telegram → Claude → Telegram

```
User Message (Telegram)
    ↓ [adapter registers inbound message]
Inbound DB (messages_in table)
    ↓ [poll-loop detects new message]
Claude API (with continuation = prior transcript)
    ↓ [SDK yields result event with token usage]
Poll-loop logs [TOKEN-USAGE], writes message_out
    ↓ [host delivery polls outbound.db]
Telegram Adapter
    ↓ [sendMessage API]
User Response (Telegram)
```

### Conversation Flow Example

**User:** "מה עושים עם זביעות המיקדצ'ים?"
(What do we do about the Zenitcz outages?)

**Agent Thinking:**
```
<thought>
Zenitcz is a tech vendor. Outages = operational disruption. Need to:
1. Check if this is widespread or user-specific
2. Impact = potential revenue loss + customer churn
3. Decision = escalate to DevOps + notify customers
</thought>
```

**Agent Response (Hebrew):**
```
**שורה תחתונה:** זביעות Zenitcz מהשעות 14:00-16:30, התאם מ-vendor בנתב לצעיד מותנה.

**תובנות מפתח:**
• כ-40 חברות דיווחו דליפות נתונים תחת Zenitcz v7.2.1
• Patch זמין ב-Zenitcz changelog; אפשר להגדר ידני
• פקודים ארוכים לא לוחצים אבל צריך Reset

**משמעות אופרטיבית:**
- Supply chain: 1-2 שעות downtime max
- עלות: ~$5K per hour
- Action: Escalate → Zenitcz Support, Patch v7.2.2 ביום שישי

**מקורות:**
- Zenitcz Status: https://status.zenitcz.io/
- Internal: [link to internal incident report]
```

**Token Cost:**
- Prompt tokens: ~450 (prior context + new message)
- Completion tokens: ~120 (Hebrew response)
- Total cost: ~$0.0009 (Haiku @ $0.80/$2.40 per 1M tokens)

### Configuration Files

#### `container/agent-runner/package.json`
- `@anthropic-ai/claude-agent-sdk@latest` (uses internal Haiku default)
- Bun runtime includes agent-runner source compiled via tsc

#### `src/providers/claude.ts`
- Haiku default: `model: this.model || 'claude-haiku-4-5-20251001'`
- System prompt injection at line 398-417
- Token extraction from SDK result events

#### `container/agent-runner/src/poll-loop.ts`
- Session continuation resume/rotation logic (lines 84-97)
- Token logging in handleEvent() (lines 481-494)

### Observability & Monitoring

**Log Entries Per Turn:**
```
[poll-loop] Processing 1 message(s), kinds: chat
[poll-loop] Session: <uuid>                          # Init event
[TOKEN-USAGE] Prompt: 450, Completion: 120          # Token event
[poll-loop] Result: השורה התחתונה: ...              # Result text
[poll-loop] Completed 1 message(s)
```

**Cost Tracking:**
```bash
# Extract token usage from logs
grep "\[TOKEN-USAGE\]" logs/nanoclaw.log | \
  awk '{print $3, $5}' | \
  awk -F: '{sum_prompt+=$2; sum_comp+=$4} END {
    print "Total Prompt: " sum_prompt " tokens"
    print "Total Completion: " sum_comp " tokens"
    print "Cost: $" (sum_prompt*0.80 + sum_comp*2.40)/1000000
  }'
```

### Future Enhancements

- [ ] Prompt caching for repeated queries (10x cost savings)
- [ ] Multi-turn reasoning with `extended_thinking` model
- [ ] Dynamic model selection based on query complexity
- [ ] Cost budgets per user/group with quota enforcement
- [ ] A/B testing different system prompts per agent group

---

## 11. Next Steps (Layer 4+)

- [x] **Layer 1:** Foundation, Docker, OneCLI
- [x] **Layer 2:** Telegram Integration, Echo Bot, Observability
- [x] **Layer 3:** Claude LLM Integration, System Prompt, Context & Token Logging
- [ ] **Layer 4:** Multi-agent orchestration
- [ ] **Layer 5:** Integration hooks (WhatsApp, Gmail, Slack, etc.)
- [ ] **Layer 6:** Advanced security (vault, RBAC, audit)
- [ ] **Layer 7:** Deployment (K8s, cloud platforms)

---

## 12. Troubleshooting

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

### Telegram adapter not connecting
```bash
# Check bot token
docker-compose config | grep TELEGRAM_BOT_TOKEN

# View adapter initialization logs
docker-compose logs nanoclaw-agent | grep -i telegram

# Verify token format (should be digits:alphabetic)
# Example: 5123456789:ABCDefGhIjKlMnOpQrStUvWxYzAbCdEfGhI
```

### No echo responses from Telegram bot
```bash
# Check polling logs
docker-compose logs -f | grep "Received message"

# Verify bot can be found on Telegram
# Should be listed in: https://t.me/YourBotNameHere

# Test API connectivity
curl -X POST https://api.telegram.org/bot<YOUR_TOKEN>/getMe
```

---

## 12. Security Checklist

- [x] Source code mounted read-only
- [x] OneCLI synthetic keys in development
- [x] Credentials stored outside container
- [x] No-new-privileges security opt enabled
- [x] Unprivileged user (node)
- [x] Secrets masked in logs
- [x] Audit logging configured
- [x] Telegram bot token passed securely via OneCLI
- [ ] Production vault integration (TODO)
- [ ] HTTPS for external APIs (TODO)
- [ ] Rate limiting enforcement (TODO)

---

## 13. Git Commit Record

### Layer 1 (Foundation, Docker, OneCLI)
```
feat: Layer 1 - Foundation, Docker, OneCLI, and System Docs
```

Files:
- Docker Compose orchestration (`docker-compose.yml`)
- OneCLI credential routing (`config-onecli/`)
- Environment template (`.env.example`)
- System architecture documentation (`SYSTEM_ARCHITECTURE.md`)

### Layer 2 (Telegram Integration, Echo Bot, Observability)
```
feat: Layer 2 - Telegram Integration, Echo Bot, and Observability
```

Files:
- Telegram adapter (`src/channels/telegram.ts`) — Long polling, echo handler, logging
- Channel registration (`src/channels/index.ts`) — Register Telegram adapter
- Environment configuration (`.env.example`) — Add `TELEGRAM_BOT_TOKEN`
- Docker compose (`docker-compose.yml`) — Pass `TELEGRAM_BOT_TOKEN` to container
- OneCLI config (`config-onecli/onecli.config.yaml`) — Register Telegram credential
- System architecture (`SYSTEM_ARCHITECTURE.md`) — Document Layer 2 integration and logging

---

**Current Status:** Layer 2 Complete ✅

For updates, edit this file and commit with reference to the relevant layer.
