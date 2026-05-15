# SSH Infrastructure Scripts

This directory contains scripts for SSH infrastructure setup on sandbox environments.

## Scripts

### 1. Daytona Sandbox SSH Wrapper (`ssh-daytona-wrapper.py`)

Provides seamless SSH access to Daytona sandbox environments via a Python wrapper script.

**Features:**
- Configures SSH for Daytona sandbox access
- Supports custom ports and identity files
- Proxy command support for tunneled connections

**Usage:**
```bash
# Configure SSH for Daytona sandbox
python3 ssh-daytona-wrapper.py configure --port 2222

# Connect to sandbox
python3 ssh-daytona-wrapper.py connect
python3 ssh-daytona-wrapper.py connect --user admin --sandbox-id abc123
```

### 2. Cloudflare Tunnel Setup (`cloudflare-tunnel-setup.sh`)

Sets up Cloudflare tunnel (cloudflared) to expose sandbox SSH to the internet without requiring specific network configuration.

**Features:**
- Tunnel authentication and configuration
- SSH over Cloudflare Access
- Automatic SSH config generation

**Prerequisites:**
- cloudflared installed
- Cloudflare Zero Trust account with a tunnel created

**Usage:**
```bash
# Configure tunnel with auth token
./cloudflare-tunnel-setup.sh configure <tunnel-token>

# Start tunnel
./cloudflare-tunnel-setup.sh start

# Start SSH tunnel
./cloudflare-tunnel-setup.sh start-ssh

# Generate SSH config
./cloudflare-tunnel-setup.sh setup-ssh ssh-sandbox.example.com
```

### 3. GCP Auth Cache (`gcp-auth-cache.py`)

Centralized auth storage with local encrypted cache, similar to 1Password CLI but backed by GCP Secret Manager.

**Features:**
- Store API keys across projects in GCP Secret Manager
- Local encrypted cache (Fernet encryption)
- Sync between local cache and GCP
- Output in .env format for easy integration

**Prerequisites:**
- GCP project with Secret Manager API enabled
- `gcloud` CLI authenticated

**Usage:**
```bash
# Install dependencies
pip install -r requirements.txt

# Store a secret
python3 gcp-auth-cache.py store myproject API_KEY "secret123"

# Retrieve a secret
python3 gcp-auth-cache.py get myproject API_KEY

# List secrets
python3 gcp-auth-cache.py list myproject

# Output as .env
python3 gcp-auth-cache.py env myproject > .env

# Sync with GCP
python3 gcp-auth-cache.py sync myproject
```

## Environment Variables

- `DAYTONA_TARGET` - Daytona target region (default: us)
- `DAYTONA_API_URL` - Daytona API URL
- `GCP_AUTH_PROJECT` - Default GCP project for auth storage
