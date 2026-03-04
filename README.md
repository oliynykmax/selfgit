# Self-hosted Git Server on Railway

A minimal Git server with HTTP authentication, deployable on Railway. Part of my Railway-hosted ecosystem alongside my translation bot.

## Why?

I use this for school courses where I need to submit weekly assignments. Instead of creating a new repo on my personal GitHub every week, I push to this server. Everyone can clone to see my work, but only I can push.

**Use case:** Course repositories that I don't want polluting my GitHub profile.

## Features

- 10 bare Git repositories (repo1.git - repo10.git)
- Public read (clone/fetch) - anyone can clone
- Private write (push) - requires token authentication
- Minimal Docker image (~50MB)

⚠️ **Important:** Railway free tier has ephemeral storage - repositories reset on each deploy. Do not rely on this for long-term storage. It's intended for temporary course work.

## Quick Deploy

```bash
# 1. Clone this repo
git clone https://github.com/oliynykmax/selfgit.git
cd selfgit

# 2. Create Railway project
railway init --name your-git-server

# 3. Set your token (generate with: openssl rand -hex 16)
railway variables set GIT_TOKEN=$(openssl rand -hex 16)

# 4. Deploy
railway up

# 5. Get your domain
railway domain
```

## Usage

### Clone (public)
```bash
git clone https://your-domain.up.railway.app/repo1.git
```

### Push (requires token)

**Option A:** URL with credentials
```bash
git push https://git:YOUR_TOKEN@your-domain.up.railway.app/repo1.git main
```

**Option B:** Store credentials (recommended)
```bash
git config --global credential.helper store
echo "https://git:YOUR_TOKEN@your-domain.up.railway.app" >> ~/.git-credentials

# Now push works without prompts
git push origin main
```

**Option C:** Using netrc
```bash
echo -e "machine your-domain.up.railway.app\nlogin git\npassword YOUR_TOKEN" >> ~/.netrc
chmod 600 ~/.netrc
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GIT_TOKEN` | Yes | Token for push authentication (generate with `openssl rand -hex 16`) |

## Repositories

The server creates 10 bare repos on startup:
- `repo1.git` - `repo10.git`

Note: Railway free tier has ephemeral storage - repos reset on each deploy.

## Files

```
.
├── Dockerfile       # Alpine + git + nginx + fcgiwrap
├── nginx.conf       # Nginx config with auth for push
├── git.conf         # FastCGI git config
├── start.sh         # Startup script
├── .env.example     # Environment template
└── README.md
```
