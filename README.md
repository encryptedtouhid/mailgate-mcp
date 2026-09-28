# mailgate-mcp

**Give Claude or ChatGPT access to any mailbox, with limits that you set.**

mailgate-mcp is a Model Context Protocol (MCP) server that works with any IMAP/SMTP email account. Presets are included for Namecheap PrivateEmail, Zoho, Gmail, Fastmail, iCloud, Yahoo, Titan, Hostinger, GoDaddy, and Migadu, and any custom-domain mail server works too. The AI can search, read, send, reply to, forward, and organize your mail. Flags in `.env` decide which of those actions it may take and who it may send to.

- **Any provider:** plain IMAP and SMTP, so there's no vendor API or OAuth app to set up
- **Works with Claude and ChatGPT:** stdio for Claude Desktop and Claude Code, Streamable HTTP for ChatGPT and claude.ai connectors
- **Guardrails:** turn each action on or off, limit recipients with an allowlist, and keep permanent delete off by default
- **Multiple accounts** from one server

## Tools

| Tool | What it does |
|---|---|
| `list_accounts` | Lists the configured accounts |
| `list_folders` | Lists folders with total and unread counts |
| `search_emails` | Filters by text, from, to, subject, dates, unread, or flagged; returns the newest matches |
| `read_email` | Shows headers, the plain-text body (HTML is converted to text), and the attachment list |
| `get_attachment` | Downloads an attachment (text, image, or base64) |
| `send_email` | Sends mail with cc, bcc, HTML, and attachments; saves a copy to Sent |
| `reply_to_email` | Replies in the same thread with the original quoted; supports reply-all or saving as a draft |
| `forward_email` | Forwards a message, with its attachments by default |
| `save_draft` | Saves a message to Drafts |
| `mark_emails` | Marks messages read, unread, flagged, or unflagged |
| `move_emails` | Moves messages to a folder, `\Archive`, `\Junk`, or `\Trash` |
| `delete_emails` | Moves messages to Trash, or deletes them permanently |
| `search` / `fetch` | The search and fetch format that ChatGPT deep research expects |

## Guardrails

The flags in `.env` decide what the AI may do. The server enforces them, not the AI. A disabled tool is never shown to the AI, and every action is checked again before it runs.

| Flag | Default | Controls |
|---|---|---|
| `EMAIL_READ_ONLY` | `false` | Master switch. `true` turns off every flag below |
| `EMAIL_ALLOW_SEND` | `true` | `send_email`, sending replies |
| `EMAIL_ALLOW_FORWARD` | `true` | `forward_email` (also needs send) |
| `EMAIL_ALLOW_DRAFTS` | `true` | `save_draft`, replies saved as drafts |
| `EMAIL_ALLOW_MARK` | `true` | `mark_emails`, `read_email` with `markAsRead` |
| `EMAIL_ALLOW_MOVE` | `true` | `move_emails` (moving to Trash also needs delete) |
| `EMAIL_ALLOW_DELETE` | `true` | `delete_emails` (moves mail to Trash) |
| `EMAIL_ALLOW_PERMANENT_DELETE` | `false` | Erasing mail permanently (also needs delete) |
| `EMAIL_ALLOWED_RECIPIENTS` | anyone | Comma-separated domains or addresses the AI may send to, e.g. `navo.health,partner@x.com`. Each recipient the AI passes must be a single address |
| `EMAIL_MAX_RECIPIENTS` | `20` | Largest number of to + cc + bcc recipients in one email |

`list_accounts` reports the current guardrails, so the AI knows its limits before it tries anything. A blocked action returns an error that names the flag. The server logs its guardrails at startup, and it refuses to start if a flag has a value it doesn't recognize. Restart the server after changing a flag; for Claude Desktop, quit it (Cmd+Q) and reopen it.

## Quick start

Fill in `.env`, then:

```bash
./run.sh            # frees the port, installs, builds, starts on http://127.0.0.1:3000/mcp
./run.sh --tunnel   # the same, plus a public HTTPS connector URL for ChatGPT / claude.ai
```

## 1. Install

```bash
npm install
npm run build
cp .env.example .env   # then edit .env
```

## 2. Configure your mailbox

For a single account, set these in `.env`:

```env
EMAIL_PROVIDER=privateemail        # or zoho, zoho-pro, gmail, custom, ...
EMAIL_ADDRESS=you@yourdomain.com
EMAIL_PASSWORD=your-password
```

| Provider | `EMAIL_PROVIDER` | Notes |
|---|---|---|
| Namecheap PrivateEmail | `privateemail` | Use your normal mailbox password |
| Zoho, free or personal | `zoho` (`zoho-eu`, `zoho-in` for EU/India) | Turn on IMAP under Zoho Mail → Settings → Mail Accounts. If 2FA is on, use an app password |
| Zoho, paid or custom domain | `zoho-pro` | Same as above |
| Gmail / Workspace | `gmail` | Needs an [App Password](https://myaccount.google.com/apppasswords) |
| iCloud, Yahoo, Fastmail | `icloud`, `yahoo`, `fastmail` | Need an app password |
| Anything else | `custom` | Also set `IMAP_HOST`, `SMTP_HOST`, and the ports |

Ports default to 993 for IMAP (TLS) and 465 for SMTP (TLS). For SMTP on 587, set `SMTP_PORT=587` and `SMTP_SECURE=false` (STARTTLS).

**Multiple accounts:** copy `accounts.example.json` to `accounts.json` and set `EMAIL_ACCOUNTS_FILE=./accounts.json`. A password written as `"env:NAME"` is read from that environment variable, so secrets can stay out of the file. Each tool takes an optional `account` argument; the first account is the default.

## 3. Connect it

### Claude Desktop (local, stdio)

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mailgate": {
      "command": "node",
      "args": ["/absolute/path/to/mailgate-mcp/dist/index.js"]
    }
  }
}
```

The server reads `.env` from the project folder. You can also put the variables in an `"env": { ... }` block here. Restart Claude Desktop afterwards.

If Claude Desktop can't find `node` (common with nvm or Homebrew), set `"command"` to the full path that `which node` prints.

#### Claude Desktop with Docker

If the compose container is running (see [Docker](#docker)), run mailgate inside it. Claude Desktop can start an MCP server more than once, so this avoids a new container for each launch, and it uses the container's guardrail settings:

```json
{
  "mcpServers": {
    "mailgate": {
      "command": "/usr/local/bin/docker",
      "args": [
        "exec", "-i", "-e", "MCP_TRANSPORT=stdio",
        "mailgate-mcp-mailgate-1", "node", "dist/index.js"
      ]
    }
  }
}
```

The container must be running whenever you use Claude Desktop. After recreating it (`docker compose up -d`), restart Claude Desktop so it reconnects.

Without compose, Claude Desktop can start its own container each time instead. Build the image once (`docker build -t mailgate-mcp .`) and use:

```json
{
  "mcpServers": {
    "mailgate": {
      "command": "/usr/local/bin/docker",
      "args": [
        "run", "-i", "--rm", "--init",
        "--env-file", "/absolute/path/to/mailgate-mcp/.env",
        "-e", "MCP_TRANSPORT=stdio",
        "mailgate-mcp"
      ]
    }
  }
}
```

Add `"-e", "EMAIL_ALLOW_DELETE=false"` (or any other flag) before `"mailgate-mcp"` to override `.env` for Claude Desktop only.

#### Using it in a chat

1. Use the **Chat** tab of the Claude Desktop app. Local servers aren't available in claude.ai on the web or on your phone; those need the HTTP connector below.
2. Start a new chat and open the **+ / tools** menu in the message box. Check that **mailgate** is listed and switched on.
3. If another email connector such as Gmail is also on, name the tool so Claude picks the right one: *"Use mailgate to show my unread emails from today."* Turning the other connector off for that chat also works.
4. Approve the permission prompt the first time a tool runs. Keeping send, forward and delete on "Allow once" gives you a final check before anything leaves your mailbox.

Each step Claude takes shows which tool it used (`search_emails`, `read_email` and so on, from mailgate).

### Claude Code

```bash
claude mcp add mailgate -- node /absolute/path/to/mailgate-mcp/dist/index.js
```

### ChatGPT and claude.ai web (remote, HTTP)

Both of these connect to a public HTTPS URL, so run the server in HTTP mode and expose it.

```bash
# add to .env:  MCP_AUTH_TOKEN=$(openssl rand -hex 32)
npm run start:http                                # http://127.0.0.1:3000/mcp
cloudflared tunnel --url http://localhost:3000    # quick public HTTPS URL (brew install cloudflared)
```

Your connector URL has the token in the path:

```
https://<your-tunnel-or-domain>/mcp/<MCP_AUTH_TOKEN>
```

- **claude.ai:** Settings → Connectors → Add custom connector, then paste the URL.
- **ChatGPT:** Settings → Apps & Connectors → Advanced → turn on Developer mode, then create a connector with the URL and choose **No authentication**. The token in the URL is the authentication.

Clients that can send headers can use `https://host/mcp` with `Authorization: Bearer <token>` instead.

For an always-on setup, run it in Docker (see below).

> **Security:** anyone who has the URL and token can read and send your email. Keep the token secret, always use HTTPS, and consider `EMAIL_READ_ONLY=true` for remote use. The server refuses to listen on a public interface when no token is set, and without a token it only accepts requests addressed to `localhost`/`127.0.0.1`, so websites can't reach it through DNS rebinding.

## Docker

The image runs the HTTP transport on port 3000 by default. It holds no credentials; `.env` and `accounts.json` are passed in at runtime.

```bash
# add MCP_AUTH_TOKEN to .env first: the server refuses to listen on 0.0.0.0 without it
docker compose up -d --build     # http://127.0.0.1:3000/mcp/<MCP_AUTH_TOKEN>
docker compose logs -f
docker compose down
```

`docker-compose.yml` publishes the port on `127.0.0.1` only, so put a tunnel (`cloudflared tunnel --url http://localhost:3000`) or an HTTPS reverse proxy in front. Set `MAILGATE_PORT` to use another host port. The container runs as a non-root user on a read-only filesystem, with a healthcheck on `/health`.

For multiple accounts, set `EMAIL_ACCOUNTS_FILE=/app/accounts.json` in `.env` and uncomment the `volumes` block to mount `accounts.json`.

To change guardrails for the container without touching `.env`, create `docker-compose.override.yml` (compose loads it automatically, and it is git-ignored):

```yaml
services:
  mailgate:
    environment:
      EMAIL_ALLOW_DELETE: 'false'
```

Then run `docker compose up -d` to recreate the container.

Without compose:

```bash
docker build -t mailgate-mcp .
docker run -d --init --restart unless-stopped --env-file .env \
  -e HOST=0.0.0.0 -p 127.0.0.1:3000:3000 mailgate-mcp
```

The same image runs on a VPS, Fly.io, Railway, or Render: set the environment variables there and expose port 3000.

> `docker run --env-file` does not strip comments at the end of a line, so keep `.env` values free of trailing `# ...` comments.

## Troubleshooting

- **"The mail server is temporarily refusing logins"** (the server says *Temporary authentication failure*): your provider is throttling logins after too many in a short time. Your password is fine. Wait a few minutes and try again. Running fewer copies of the server (for example one Docker container instead of several) keeps logins down.
- **"Authentication failed … check the username/password"**: the login was rejected. Gmail, iCloud, Yahoo and Fastmail need an app password, and Zoho needs IMAP turned on.
- **mailgate is missing in Claude Desktop**: look under Settings → Developer, and read `~/Library/Logs/Claude/mcp-server-mailgate.log`. `spawn node ENOENT` means Claude Desktop can't find `node`; use its full path (`which node`).
- **Claude answers from Gmail or says mailgate isn't connected**: see [Using it in a chat](#using-it-in-a-chat).
- **Changes don't take effect**: rebuild (`npm run build`, or `docker compose up -d --build`), then restart Claude Desktop.

## Development

```bash
npm test          # unit tests (vitest)
npm run typecheck
npm run dev       # stdio via tsx
npm run dev:http  # HTTP via tsx
```

Each account has one IMAP connection that is reused across tool calls and closed after 60 seconds idle, so a busy chat costs one login instead of one per call. Calls for the same account run one at a time, and a dropped connection is reopened on the next call.
