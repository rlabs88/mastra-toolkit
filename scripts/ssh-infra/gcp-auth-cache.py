#!/usr/bin/env python3
"""
GCP Auth Cache - Centralized Auth Storage with Local Encrypted Cache

Similar to 1Password CLI but backed by GCP Secret Manager.
Stores API keys across projects and provides local encrypted caching.

Features:
- Store all dev environment API keys on GCP Secret Manager
- Label keys across projects
- Use central GCP auth instance
- Encrypt and cache credentials locally

Usage:
    gcp-auth-cache.py store <project> <key-name> <value>
    gcp-auth-cache.py get <project> <key-name>
    gcp-auth-cache.py list <project>
    gcp-auth-cache.py env <project>        # Output .env format
    gcp-auth-cache.py sync                # Sync local cache with GCP
"""

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

CACHE_DIR = Path.home() / ".gcp-auth-cache"
CACHE_FILE = CACHE_DIR / "secrets.enc"
MASTER_KEY_FILE = CACHE_DIR / ".master.key"
GCP_PROJECT = os.environ.get("GCP_AUTH_PROJECT", "")

DEFAULT_GCP_PROJECT = "your-gcp-project-id"


def get_default_project() -> str:
    """Get default GCP project from environment or config."""
    if GCP_PROJECT:
        return GCP_PROJECT

    try:
        result = subprocess.run(
            ["gcloud", "config", "get-value", "project"],
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.strip() or DEFAULT_GCP_PROJECT
    except (subprocess.CalledProcessError, FileNotFoundError):
        return DEFAULT_GCP_PROJECT


def get_master_key() -> bytes:
    """Get or create master encryption key."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    if MASTER_KEY_FILE.exists():
        return MASTER_KEY_FILE.read_bytes()

    key = Fernet.generate_key()
    MASTER_KEY_FILE.write_bytes(key)
    os.chmod(MASTER_KEY_FILE, 0o600)
    return key


def get_fernet() -> Fernet:
    """Get Fernet instance for encryption/decryption."""
    key = get_master_key()
    return Fernet(key)


def load_cache() -> dict:
    """Load encrypted cache from disk."""
    if not CACHE_FILE.exists():
        return {}

    try:
        encrypted = CACHE_FILE.read_bytes()
        fernet = get_fernet()
        decrypted = fernet.decrypt(encrypted)
        return json.loads(decrypted)
    except Exception:
        return {}


def save_cache(cache: dict):
    """Save encrypted cache to disk."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    fernet = get_fernet()
    data = json.dumps(cache).encode()
    encrypted = fernet.encrypt(data)
    CACHE_FILE.write_bytes(encrypted)
    os.chmod(CACHE_FILE, 0o600)


def gcp_secret_name(project: str, key_name: str) -> str:
    """Generate GCP secret name."""
    safe_name = key_name.replace("/", "-").replace("_", "-").lower()
    return f"dev-secrets-{project}-{safe_name}"


def store_secret_gcp(project: str, key_name: str, value: str):
    """Store secret in GCP Secret Manager."""
    secret_name = gcp_secret_name(project, key_name)

    try:
        subprocess.run(
            [
                "gcloud", "secrets",
                gcp_secret_name(project, key_name),
                "add",
                "--data=-",
                f"--project={project}",
            ],
            input=value.encode(),
            check=True,
        )
    except subprocess.CalledProcessError as e:
        print(f"Failed to store secret in GCP: {e}", file=sys.stderr)
        sys.exit(1)


def get_secret_gcp(project: str, key_name: str) -> str | None:
    """Retrieve secret from GCP Secret Manager."""
    secret_name = gcp_secret_name(project, key_name)

    try:
        result = subprocess.run(
            [
                "gcloud", "secrets",
                secret_name,
                "versions", "latest",
                "access",
                f"--project={project}",
            ],
            capture_output=True,
            check=True,
        )
        return result.stdout.strip()
    except subprocess.CalledProcessError:
        return None


def store(project: str, key_name: str, value: str, use_gcp: bool = True):
    """Store a secret."""
    cache = load_cache()

    if project not in cache:
        cache[project] = {}
    cache[project][key_name] = value
    save_cache(cache)

    if use_gcp:
        store_secret_gcp(project, key_name, value)

    print(f"Stored: {project}/{key_name}")


def get(project: str, key_name: str, use_cache: bool = True) -> str | None:
    """Retrieve a secret."""
    cache = load_cache()

    if use_cache and project in cache and key_name in cache[project]:
        return cache[project][key_name]

    value = get_secret_gcp(project, key_name)
    if value:
        if use_cache:
            if project not in cache:
                cache[project] = {}
            cache[project][key_name] = value
            save_cache(cache)
        return value

    return None


def list_secrets(project: str):
    """List all secrets for a project."""
    cache = load_cache()

    if project in cache:
        print(f"Secrets in cache for project '{project}':")
        for key_name in cache[project]:
            print(f"  {key_name}")
    else:
        print(f"No cached secrets for project '{project}'")


def delete(project: str, key_name: str):
    """Delete a secret."""
    cache = load_cache()

    if project in cache and key_name in cache[project]:
        del cache[project][key_name]
        if not cache[project]:
            del cache[project]
        save_cache(cache)
        print(f"Deleted: {project}/{key_name}")
    else:
        print(f"Secret not found: {project}/{key_name}", file=sys.stderr)
        sys.exit(1)


def sync_with_gcp(project: str):
    """Sync local cache with GCP secrets."""
    print(f"Syncing with GCP project '{project}'...")

    cache = load_cache()

    try:
        result = subprocess.run(
            [
                "gcloud", "secrets", "list",
                f"--project={project}",
                "--filter=name:dev-secrets-",
                "--format=json",
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        secrets = json.loads(result.stdout)
    except subprocess.CalledProcessError as e:
        print(f"Failed to list GCP secrets: {e}", file=sys.stderr)
        sys.exit(1)

    synced = 0
    for secret in secrets:
        name = secret.get("name", "")
        if not name.startswith(f"projects/{project}/secrets/"):
            continue

        key_name = name.split("/")[-1].replace("dev-secrets-", "").replace(project + "-", "")
        value = get_secret_gcp(project, key_name)
        if value:
            if project not in cache:
                cache[project] = {}
            cache[project][key_name] = value
            synced += 1

    save_cache(cache)
    print(f"Synced {synced} secrets from GCP")


def output_env(project: str, prefix: str = ""):
    """Output secrets in .env format."""
    cache = load_cache()

    if project not in cache:
        print(f"No secrets found for project '{project}'", file=sys.stderr)
        sys.exit(1)

    for key_name, value in cache[project].items():
        env_key = f"{prefix}{key_name}".upper().replace("-", "_")
        print(f"{env_key}={value}")


def clear_cache():
    """Clear local cache (not GCP)."""
    if CACHE_FILE.exists():
        CACHE_FILE.unlink()
        print("Local cache cleared")


def main():
    parser = argparse.ArgumentParser(
        description="GCP Auth Cache - Centralized auth storage with local encrypted cache",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    gcp-auth-cache.py store myproject API_KEY "secret123"
    gcp-auth-cache.py get myproject API_KEY
    gcp-auth-cache.py list myproject
    gcp-auth-cache.py env myproject
    gcp-auth-cache.py sync myproject
        """,
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    store_parser = subparsers.add_parser("store", help="Store a secret")
    store_parser.add_argument("project", help="Project name")
    store_parser.add_argument("key", help="Secret key name")
    store_parser.add_argument("value", help="Secret value")
    store_parser.add_argument("--no-gcp", action="store_true", help="Store locally only, not in GCP")

    get_parser = subparsers.add_parser("get", help="Retrieve a secret")
    get_parser.add_argument("project", help="Project name")
    get_parser.add_argument("key", help="Secret key name")
    get_parser.add_argument("--no-cache", action="store_true", help="Read from GCP only, not cache")

    list_parser = subparsers.add_parser("list", help="List secrets for a project")
    list_parser.add_argument("project", help="Project name")

    delete_parser = subparsers.add_parser("delete", help="Delete a secret")
    delete_parser.add_argument("project", help="Project name")
    delete_parser.add_argument("key", help="Secret key name")

    sync_parser = subparsers.add_parser("sync", help="Sync local cache with GCP")
    sync_parser.add_argument("project", nargs="?", default=None, help="GCP project (uses default if not specified)")

    env_parser = subparsers.add_parser("env", help="Output secrets in .env format")
    env_parser.add_argument("project", help="Project name")
    env_parser.add_argument("--prefix", default="", help="Prefix for env var names")

    clear_parser = subparsers.add_parser("clear", help="Clear local cache")

    args = parser.parse_args()

    project = getattr(args, "project", None) or get_default_project()

    if args.command == "store":
        store(args.project, args.key, args.value, use_gcp=not args.no_gcp)
    elif args.command == "get":
        value = get(args.project, args.key, use_cache=not args.no_cache)
        if value:
            print(value)
        else:
            print(f"Secret not found: {args.project}/{args.key}", file=sys.stderr)
            sys.exit(1)
    elif args.command == "list":
        list_secrets(args.project)
    elif args.command == "delete":
        delete(args.project, args.key)
    elif args.command == "sync":
        sync_with_gcp(args.project or get_default_project())
    elif args.command == "env":
        output_env(args.project, args.prefix)
    elif args.command == "clear":
        clear_cache()


if __name__ == "__main__":
    main()
