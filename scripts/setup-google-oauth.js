require("dotenv").config();

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { google } = require("googleapis");

const ENV_PATH = path.resolve(process.cwd(), ".env");
const SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
const DEFAULT_REDIRECT_URI = "http://localhost:53682";
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

async function main() {
  const oauthClientType = resolveOauthClientType();
  const clientId = (process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || "").trim();
  const redirectUri = await resolveRedirectUri(oauthClientType);

  if (!clientId) {
    throw new Error("Set GOOGLE_CLIENT_ID in .env before running oauth helper.");
  }

  if (oauthClientType === "web" && !clientSecret) {
    throw new Error(
      "Set GOOGLE_CLIENT_SECRET in .env when GOOGLE_OAUTH_CLIENT_TYPE=web."
    );
  }

  ensureEnvFileExists();

  const redirect = parseAndValidateRedirectUri(redirectUri);
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret || undefined, redirectUri);
  const pkce = await oauth2Client.generateCodeVerifierAsync();

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [SCOPE],
    include_granted_scopes: true,
    code_challenge_method: "S256",
    code_challenge: pkce.codeChallenge,
  });

  console.log("\nStarting Google OAuth helper for YouTube private playlist access...");
  console.log(`Client type mode: ${oauthClientType}`);
  console.log(`Redirect URI: ${redirectUri}`);
  console.log("\nIf browser does not open automatically, open this URL manually:");
  console.log(authUrl);
  console.log("\nIf Google shows 'Access blocked / Authorization error', check troubleshooting in terminal output after this command exits.");
  console.log("For Web OAuth client, Authorized redirect URI must exactly match GOOGLE_REDIRECT_URI.");

  const opened = tryOpenBrowser(authUrl);
  if (opened) {
    console.log("\nBrowser launch attempted. Complete consent in the opened page.");
  }

  const code = await waitForAuthCode(redirect, AUTH_TIMEOUT_MS);
  const tokenResponse = await oauth2Client.getToken({ code, codeVerifier: pkce.codeVerifier, redirect_uri: redirectUri });
  const tokens = tokenResponse && tokenResponse.tokens ? tokenResponse.tokens : {};

  const refreshToken = (tokens.refresh_token || "").trim();
  if (!refreshToken) {
    throw new Error(
      "Google did not return a refresh token. Remove previous app access and run again so consent returns refresh_token."
    );
  }

  await upsertEnvValues({
    GOOGLE_REFRESH_TOKEN: refreshToken,
    PLAYLIST_FETCH_MODE: "youtube-api",
  });

  console.log("\nSuccess: GOOGLE_REFRESH_TOKEN saved to .env");
  console.log("PLAYLIST_FETCH_MODE set to youtube-api");
  console.log("Now run: npm run status");
}

function ensureEnvFileExists() {
  if (!fs.existsSync(ENV_PATH)) {
    throw new Error(".env file not found. Create it from .env.example first.");
  }
}

function resolveOauthClientType() {
  const raw = (process.env.GOOGLE_OAUTH_CLIENT_TYPE || "auto").trim().toLowerCase();
  if (!["auto", "desktop", "web"].includes(raw)) {
    throw new Error("GOOGLE_OAUTH_CLIENT_TYPE must be one of: auto, desktop, web");
  }
  return raw;
}

async function resolveRedirectUri(oauthClientType) {
  const configured = (process.env.GOOGLE_REDIRECT_URI || "").trim();

  if (oauthClientType === "desktop") {
    return getFreeLoopbackRedirectUri();
  }

  if (configured) {
    return configured;
  }

  return DEFAULT_REDIRECT_URI;
}

async function getFreeLoopbackRedirectUri() {
  const host = "127.0.0.1";
  const port = await findFreePort(host);
  return `http://${host}:${port}`;
}

function findFreePort(host) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();

    server.on("error", (err) => reject(err));
    server.listen(0, host, () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : null;
      server.close(() => {
        if (!port) {
          reject(new Error("Could not allocate a free local port for OAuth callback."));
          return;
        }
        resolve(port);
      });
    });
  });
}

function parseAndValidateRedirectUri(value) {
  let redirect;
  try {
    redirect = new URL(value);
  } catch (err) {
    throw new Error("GOOGLE_REDIRECT_URI must be a valid URL.");
  }

  if (redirect.protocol !== "http:") {
    throw new Error("GOOGLE_REDIRECT_URI must use http protocol for local callback server.");
  }

  const host = redirect.hostname;
  if (!["127.0.0.1", "localhost"].includes(host)) {
    throw new Error("GOOGLE_REDIRECT_URI host must be localhost or 127.0.0.1.");
  }

  if (!redirect.port) {
    throw new Error("GOOGLE_REDIRECT_URI must include an explicit port, e.g. http://127.0.0.1:53682/oauth2callback");
  }

  return {
    uri: redirect,
    host,
    port: Number.parseInt(redirect.port, 10),
    path: redirect.pathname || "/",
  };
}

function tryOpenBrowser(url) {
  try {
    if (process.platform === "win32") {
      const child = spawn("cmd", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return true;
    }

    if (process.platform === "darwin") {
      const child = spawn("open", [url], { detached: true, stdio: "ignore" });
      child.unref();
      return true;
    }

    const child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function waitForAuthCode(redirect, timeoutMs) {
  return new Promise((resolve, reject) => {
    let finished = false;

    const server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url, redirect.uri.toString());

      if (requestUrl.pathname !== redirect.path) {
        res.statusCode = 404;
        res.end("Not Found");
        return;
      }

      const error = requestUrl.searchParams.get("error");
      if (error) {
        const description = requestUrl.searchParams.get("error_description") || "";
        respondHtml(res, "Authorization failed", `Google returned error: ${error}`);
        const details = description ? `${error} (${description})` : error;
        finish(new Error(`Google OAuth error: ${details}`));
        return;
      }

      const code = requestUrl.searchParams.get("code");
      if (!code) {
        respondHtml(res, "Missing code", "No authorization code was found in callback.");
        finish(new Error("OAuth callback received without code."));
        return;
      }

      respondHtml(res, "Authorization received", "You can close this tab and return to the terminal.");
      finish(null, code);
    });

    const timeout = setTimeout(() => {
      finish(new Error("Timed out waiting for OAuth callback. Try again and complete browser consent sooner."));
    }, timeoutMs);

    const finish = (err, code) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);

      try {
        server.close();
      } catch {
      }

      if (err) {
        reject(err);
      } else {
        resolve(code);
      }
    };

    server.on("error", (err) => {
      finish(new Error(`Failed to start callback server: ${err.message}`));
    });

    server.listen(redirect.port, redirect.host, () => {
      console.log(`\nListening for OAuth callback on ${redirect.uri.toString()}`);
    });
  });
}

function respondHtml(res, title, message) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(
    title
  )}</h1><p>${escapeHtml(message)}</p></body></html>`);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function upsertEnvValues(entries) {
  let content = await fsp.readFile(ENV_PATH, "utf8");

  for (const [key, value] of Object.entries(entries)) {
    content = upsertEnvLine(content, key, String(value));
  }

  await fsp.writeFile(ENV_PATH, content, "utf8");
}

function upsertEnvLine(content, key, value) {
  const escapedKey = escapeRegExp(key);
  const lineRegex = new RegExp(`^${escapedKey}=.*$`, "m");
  const newLine = `${key}=${value}`;

  if (lineRegex.test(content)) {
    return content.replace(lineRegex, newLine);
  }

  if (!content.endsWith("\n")) {
    content += "\n";
  }
  return `${content}${newLine}\n`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

main().catch((err) => {
  const message = err && err.message ? err.message : String(err);

  console.error("\nOAuth helper failed:");
  console.error(message);

  if (message.includes("EADDRINUSE")) {
    console.error("\nTroubleshooting:");
    console.error("- Callback port is already in use.");
    console.error("- Find process: netstat -ano | findstr :53682");
    console.error("- Stop process: taskkill /PID <PID> /F");
    console.error("- Or change GOOGLE_REDIRECT_URI port in .env and in Google OAuth redirect settings.");
  }

  if (message.includes("Timed out waiting for OAuth callback") || message.includes("Google OAuth error")) {
    console.error("\nGoogle OAuth checklist for 'Access blocked / Authorization error':");
    console.error("1) Google Cloud -> APIs & Services -> Library: enable YouTube Data API v3.");
    console.error("2) OAuth consent screen: set app to Testing and add your Google account as a Test user.");
    console.error("3) Credentials: use OAuth client ID (Web or Desktop), not service account.");
    console.error("4) If using Web client: add exact Authorized redirect URI from .env GOOGLE_REDIRECT_URI.");
    console.error("5) If using Desktop client: use GOOGLE_REDIRECT_URI=http://127.0.0.1:53682/oauth2callback.");
  }

  process.exit(1);
});
