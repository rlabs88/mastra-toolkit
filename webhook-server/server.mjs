import http from "node:http";
const host = process.env.WEBHOOK_SERVER_HOST || "0.0.0.0";
const port = Number(process.env.WEBHOOK_SERVER_PORT || "8080");
const upstreamUrl = new URL(process.env.MASTRA_UPSTREAM_URL || "http://host.docker.internal:4111");
const timeoutMs = Number(process.env.WEBHOOK_FORWARD_TIMEOUT_MS || "30000");

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function upstreamRequestUrl(requestUrl = "/") {
  const incoming = new URL(requestUrl, "http://webhook.local");
  const target = new URL(upstreamUrl);
  target.pathname = `${target.pathname.replace(/\/+$/, "")}${incoming.pathname}`;
  target.search = incoming.search;
  return target;
}

function forwardedHeaders(req, target) {
  const headers = new Headers();

  for (const [name, value] of Object.entries(req.headers)) {
    if (!value || hopByHopHeaders.has(name.toLowerCase())) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }

  headers.set("host", target.host);
  headers.set("x-forwarded-host", req.headers.host || "");
  headers.set("x-forwarded-proto", req.headers["x-forwarded-proto"] || "https");
  headers.set("x-forwarded-for", [req.socket.remoteAddress, req.headers["x-forwarded-for"]]
    .filter(Boolean)
    .join(", "));

  return headers;
}

function writeResponseHeaders(res, upstreamResponse) {
  for (const [name, value] of upstreamResponse.headers) {
    if (hopByHopHeaders.has(name.toLowerCase())) continue;
    res.setHeader(name, value);
  }
}

function writeJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function proxy(req, res) {
  if (req.url === "/healthz") {
    writeJson(res, 200, {
      ok: true,
      upstream: upstreamUrl.origin,
    });
    return;
  }

  const target = upstreamRequestUrl(req.url);
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`upstream timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    const upstreamResponse = await fetch(target, {
      method: req.method,
      headers: forwardedHeaders(req, target),
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req,
      duplex: "half",
      redirect: "manual",
      signal: controller.signal,
    });

    res.statusCode = upstreamResponse.status;
    res.statusMessage = upstreamResponse.statusText;
    writeResponseHeaders(res, upstreamResponse);

    if (req.method === "HEAD" || !upstreamResponse.body) {
      res.end();
      return;
    }

    for await (const chunk of upstreamResponse.body) {
      res.write(chunk);
    }
    res.end();
  } catch (error) {
    writeJson(res, 502, {
      error: "webhook upstream unavailable",
      upstream: upstreamUrl.origin,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timeout);
  }
}

const server = http.createServer((req, res) => {
  proxy(req, res).catch((error) => {
    writeJson(res, 500, {
      error: "webhook proxy failed",
      message: error instanceof Error ? error.message : String(error),
    });
  });
});

server.listen(port, host, () => {
  console.log(`webhook server listening on http://${host}:${port}`);
  console.log(`forwarding webhook requests to ${upstreamUrl.origin}`);
});
