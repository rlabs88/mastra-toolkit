FROM cloudflare/cloudflared@sha256:e39ee8da81ad5e05d77f38d2f51c60ca51bf2a8450ac3abab50c17fdb91d91bf

LABEL org.opencontainers.image.title="mastra-toolkit-local-factory-webhook-ingress" \
      org.opencontainers.image.description="Temporary Cloudflare Quick Tunnel to the local signature-verifying Factory webhook route"

ENTRYPOINT ["cloudflared", "tunnel", "--no-autoupdate"]
CMD ["--url", "http://host.docker.internal:4111"]
