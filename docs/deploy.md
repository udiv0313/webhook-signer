# Deploying

In production one Node process serves everything from one origin: the web app
(the built `frontend/dist`), the API under `/api`, and `GET /health`. There is
no separate frontend server and no CORS.

> **Not yet run here.** The Dockerfile and `fly.toml` were written on a machine
> without Docker or the Fly CLI. The production mode itself (built frontend,
> headers, `/health`, shutdown) is tested locally. Expect the first deploy to
> surface something; the checklist at the end says what to look at.

## 1. Check production mode locally first

```bash
npm run build                       # builds frontend/dist
npm start                           # now also serves the web app
```

Open **http://localhost:3000** (not 5173): the app, the API and webhooks all on
one port. The startup log says `Web app: serving frontend/dist (N files)`.

```bash
curl -s http://localhost:3000/health
# {"status":"ok","checks":{"database":"ok"},"uptimeSeconds":3}
```

## 2. Deploy to Fly.io

Why Fly: one small machine with a persistent volume (SQLite needs a disk),
HTTPS included, and health checks against `/health`.

```bash
# Once
brew install flyctl                 # or see fly.io/docs/flyctl/install
fly auth login

# Pick a unique app name and put it in fly.toml (app = "...")
fly apps create <your-app-name>

# Persistent disk for the SQLite database (same region as primary_region)
fly volumes create webhook_data --size 1 --region iad --app <your-app-name>

# The master secret. Never put it in fly.toml or the repo.
# Keep a copy somewhere safe: without it, stored endpoint secrets cannot be read.
fly secrets set WEBHOOK_SECRET=$(openssl rand -hex 32) --app <your-app-name>

fly deploy
```

**Exactly one machine.** SQLite lives on one volume attached to one machine. If
Fly ever starts a second one, run `fly scale count 1`.

Then check:

```bash
curl -s https://<your-app-name>.fly.dev/health
fly logs                            # startup lines, as in step 1
```

Open `https://<your-app-name>.fly.dev` and click **Start the guided demo**.

### What fly.toml sets

| Setting | Why |
| --- | --- |
| `COOKIE_SECURE=true` | Fly serves HTTPS, so the workspace cookie is `Secure`, and HSTS is sent |
| `TRUST_PROXY=true` | Requests arrive through Fly's proxy; the client IP for rate limits comes from `X-Forwarded-For` |
| `WEBHOOK_TEST_SENDER_ENABLED=true` | The demo and the UI tester need it. It only signs for the caller's own endpoints and is rate limited |
| `DATABASE_PATH=/data/...` | On the mounted volume, so data survives deploys and restarts |
| `auto_stop_machines` | Stops when idle, starts on the next request (a few seconds). Rate-limit counters reset then; data does not |
| health check on `/health` | Fly restarts the machine if the database stops responding |

## 3. Deploy to Render (free)

Free plan: no card, HTTPS included, deploys from GitHub. Limits: the service
sleeps after 15 minutes without traffic (the next visit takes about a minute),
and **free services have no persistent disk**, so the database starts empty
after every deploy or restart.

1. Sign up at render.com with GitHub.
2. **New → Web Service** → connect this repository → branch `main`.
   Render detects the Dockerfile (runtime: Docker).
3. **Instance type: Free.**
4. Environment variables:

   | Name | Value |
   | --- | --- |
   | `WEBHOOK_SECRET` | output of `openssl rand -hex 32` |
   | `COOKIE_SECURE` | `true` |
   | `TRUST_PROXY` | `2` (Cloudflare + Render's proxy) |
   | `WEBHOOK_TEST_SENDER_ENABLED` | `true` |

5. **Advanced → Health Check Path:** `/health`. Create the service.

Render sets `PORT` itself. Optional: a free uptime monitor calling `/health`
every 10 minutes keeps the service awake (and its data, until the next deploy).

## 4. Any other Docker host

The image needs one environment variable and one volume:

```bash
docker build -t webhook-signer .
docker run -p 3000:3000 \
  -e WEBHOOK_SECRET=$(openssl rand -hex 32) \
  -e WEBHOOK_TEST_SENDER_ENABLED=true \
  -v webhook-data:/data \
  webhook-signer
```

Behind HTTPS and a reverse proxy, also set `COOKIE_SECURE=true` and
`TRUST_PROXY=true`. Without a persistent volume at `/data`, everything is lost
on each restart.

## How the image works

- **Two stages.** The first builds the web app with Vite; the second contains
  only Node, `src/`, and the built files. The backend has no npm dependencies,
  so nothing is installed at runtime.
- **Not root.** `docker-entrypoint.sh` gives the data folder to the `node` user
  (volumes are often mounted owned by root), then drops root before starting.
- **Shutdown.** On `SIGTERM` (every deploy) the server stops taking new
  connections, finishes requests in progress, closes the database and exits.
- `.dockerignore` keeps `.env`, `frontend/.env`, `data/` and `node_modules` out
  of the image.

## First-deploy checklist

If something fails, these are the likely places:

1. **Build fails at `npm ci`** in the frontend stage: the lockfile and
   `package.json` disagree. Run `npm --prefix frontend install` locally and commit
   the lockfile.
2. **Machine starts, then exits**: `fly logs`. `WEBHOOK_SECRET is not set` means
   step 2's `fly secrets set` was skipped.
3. **`EACCES` / cannot open database**: the volume is not writable. Check that
   the entrypoint ran (`setpriv` must exist in the image) and that the mount
   destination is `/data`.
4. **Health check failing**: `curl https://<app>.fly.dev/health` and compare
   `internal_port` (3000) with the port in the logs.
5. **Rate limits hit everyone at once**: the client IP is wrong. Every request
   then looks like it comes from the proxy. Check `TRUST_PROXY=true`.
6. **Webhook URLs in the UI show `localhost`**: `VITE_WEBHOOK_BASE_URL` was set
   when the frontend was built. Leave it unset for production; the page then
   uses its own address.
