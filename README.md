# selfgit

Git server on Railway. Used for school courses - push weekly assignments here instead of creating new repos on GitHub.

## Deploy

```bash
git clone https://github.com/oliynykmax/selfgit.git
cd selfgit
railway init
railway variables set GIT_TOKEN=$(openssl rand -hex 16)
railway up
railway domain
```

## Usage

Clone (public):
```bash
git clone https://your-domain.up.railway.app/repo1.git
```

Push (needs token):
```bash
# Store credentials once
git config --global credential.helper store
echo "https://git:TOKEN@your-domain.up.railway.app" >> ~/.git-credentials

# Push
git push origin main
```

## Repos

- repo1.git through repo10.git

## Warning

Railway free tier = ephemeral storage. Repos reset on deploy. Don't store anything important here.
