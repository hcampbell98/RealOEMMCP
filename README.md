# RealOEM MCP

A TypeScript MCP server for the BMW catalog at https://www.realoem.com/bmw/enUS/. It resolves a VIN to a catalog vehicle, browses groups and diagrams, and returns part numbers, quantities, production limits, option notes, companion rows and replacement history.

VIN lookup alone does not resolve every part alternative. The E88 catalog lists both manual and automatic drive shafts. This server preserves those alternatives and the conditions an agent must check before recommending a purchase.

## Deploy to Cloudflare Workers

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hcampbell98/RealOEMMCP)

The button creates a copy of this public repository in your GitHub account and deploys it to your Cloudflare account. Cloudflare provisions the `CATALOG` Durable Object and `OAUTH_KV` namespace, then configures automatic deployments from your new repository. No external identity provider or OAuth application registration is needed.

During setup, supply `MCP_AUTH_TOKEN`, a random token you generate with `openssl rand -hex 32`. Keep it private. This is the password for your deployment's OAuth login page. The Worker refuses requests when the secret is missing.

After deployment, add `https://<your-worker>.<your-subdomain>.workers.dev/mcp` to an MCP client that supports Streamable HTTP and OAuth. For ChatGPT, create a custom connector or app with that URL and choose OAuth. Leave OAuth client ID and client secret blank so the client can discover and register itself. When the Worker login page opens, check the client and return destination, paste your deployment token, and select **Allow access**.

The token goes only to your Worker over HTTPS. The client receives separate OAuth access and refresh tokens. Access tokens last one hour; refresh credentials last 30 days. The server supports OAuth discovery, dynamic client registration, client ID metadata documents, S256 PKCE, resource-bound tokens, and revocation. Static `Authorization: Bearer <MCP_AUTH_TOKEN>` headers are no longer accepted. Cross-origin browser requests to `/mcp` are rejected; native MCP clients can connect without an `Origin` header.

This is a single-owner deployment. Anyone with the deployment token can approve clients with the same catalog permissions. Changing `MCP_AUTH_TOKEN` invalidates existing OAuth credentials on their next use or refresh, so each client must reconnect. Revocation and token state use Workers KV and can take time to propagate across Cloudflare locations.

The Worker uses direct HTTP on the default RealOEM host. Its Durable Object serializes catalog requests across clients, persists the last request time, and keeps a bounded in-memory page cache. Cached pages may be discarded when the object restarts. Each deployment has its own coordinator; separate deployments do not share request limits or cached data. Worker requests are stateless, so no MCP session or vehicle state is stored between calls. Pass `vehicleId` on each catalog request.

To deploy manually:

```bash
npm ci
npx wrangler login
npx wrangler secret put MCP_AUTH_TOKEN
npm run deploy
```

Cloudflare resource usage is charged to the account hosting the deployment according to its plan. RealOEM access from a Worker was verified, but upstream availability and access policies can change.

## Run locally

Requires Node.js 22 or later.

```bash
npm ci
npm run build
```

Add this to an MCP client's configuration, adjusting the absolute path:

```json
{
  "mcpServers": {
    "realoem": {
      "command": "node",
      "args": ["/absolute/path/to/RealOEMMCP/dist/index.js"]
    }
  }
}
```

The local server uses stdio and defaults to HTTP on `https://new-ui.realoem.com/bmw/enUS/`, requesting the classic layout with `ui=v1`. No browser installation, authentication token or environment overrides are needed for this configuration. Diagnostics and protocol errors do not write ordinary text to stdout. Both deployments serialize catalog requests, space them by at least one second, cache up to 100 successful pages for 15 minutes within a 16 MB HTML memory budget, and retry HTTP 429/502/503/504 at most twice. Responses are limited to 2 MB of HTML. The request queue holds at most 20 requests and rejects requests that have waited longer than 30 seconds. The local cache belongs to the running process.

## Tools

- `identify_vehicle(vin)`: accepts a full VIN or its last seven characters; returns catalog candidates and vehicle attributes.
- `select_vehicle(...)`: browse without a VIN using returned choice values. Pass the upstream selections on each call. `prod` uses `YYYYMM00`.
- `list_part_groups(vehicleId)`: retrieve major groups.
- `list_diagrams(vehicleId, groupId, query?)`: retrieve a group's diagrams; `query` filters their titles without more requests.
- `get_diagram_parts(vehicleId, diagramId)`: retrieve the image URL, part rows and ordered condition rows.
- `get_diagram_image(vehicleId, diagramId)`: download the exploded diagram and return it as an inline MCP image, with its source URL and retrieval time. Uses the original image bytes and MIME type.
- `search_parts(vehicleId, query, diagramId?)`: search an 11-character BMW part number, including numbers containing letters, with optional spaces; retrieve matching diagrams and available supersession notes.

Use the returned `vehicleId` on every catalog call. Results include `sourceUrl`, `retrievedAt` and `source: "live"`.

An example request to an agent:

> Identify my BMW using VIN suffix VM52466. Find the drive shaft diagram, ask me about any unresolved transmission options, and give me the applicable part number with the source link.

For this example, identification returns `UM92-EUR-01-2011-E88-BMW-118d`, January 2011, N47, right hand drive. Diagram `26_0216` contains manual shaft `26107567953` and automatic shaft `26117526136`, with `S205A=Yes` before the automatic row.

The image tool follows the [MCP image content specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#image-content): it returns a content block with `type: "image"`, base64 `data`, and `mimeType`, plus text and structured source metadata. Clients decide how to display or pass image blocks to their model.

Image downloads use HTTP on the configured RealOEM host in both local transport modes. Only catalog diagram paths on the official hosts are accepted. Redirects, non-image responses, MIME/signature mismatches, and images larger than 2 MB are rejected. Image requests share the catalog queue and one-second request pacing. Successful images are cached for 15 minutes, up to 20 entries within an additional 8 MB memory budget. Workers shares this cache across clients through the same Durable Object.

## Fitment and repair scope

`get_diagram_parts` returns `fitmentStatus: "requires_confirmation"`. Its `rows` preserve table order, `positionGroup`, indentation `depth`, and note cells. `parts` is a convenience list of the catalog part rows, including reference rows. Interpret it together with `rows`.

Do not combine alternatives or repeated part numbers into a purchase list. Quantity `X` identifies a reference in catalog diagrams. Position `--` can mark a required companion or a compatibility reference. Read "only in conjunction with", "only applies to", option conditions, dates and `ENDED` notes before choosing parts. A diagram does not establish a complete repair procedure or every item needed for a job. `get_diagram_parts` returns image URLs as links. Call `get_diagram_image` to view the image itself alongside the part rows. Images do not establish fitment by themselves.

## Live access

The `www.realoem.com` host returned Cloudflare HTTP 403 challenges for live VIN queries in this environment. The official `new-ui.realoem.com` host was accessible: live VIN identification, rear-axle browsing, bearing diagrams and replacement searches were verified through the MCP for VM52466. That host and HTTP transport are now the defaults. The server requests the classic layout with `ui=v1` on live requests. It reports access errors with configuration guidance instead of presenting empty results or guessing fitment. MCP initialization instructions also explain the defaults to agents without this conversation's context.

These optional environment variables override the local server's defaults. Browser transport is available only locally. For browser mode, first run `npm run browser:install` or supply an existing browser executable:

- `REALOEM_HEADLESS=false`: open a visible Chromium window on a machine with a desktop. A challenged page waits up to 60 seconds for you to complete normal site interaction. Configure the MCP client for a timeout above 90 seconds if using this mode.
- `REALOEM_BROWSER_EXECUTABLE`: use an existing Chromium or Chrome executable instead of Playwright's installed browser.
- `REALOEM_CDP_URL`: connect to an existing local Chrome debugging endpoint, such as `http://127.0.0.1:9222`, using that browser's session. The server creates and closes its own pages. Keep the debugging endpoint local.
- `REALOEM_TRANSPORT=browser`: use Chromium instead of the default HTTP transport.
- `REALOEM_BASE_URL=https://www.realoem.com/bmw/enUS/`: use the original host instead of the verified default. Only the two official RealOEM hosts and the English catalog path are accepted.

A local Chrome session can be started separately with a dedicated profile:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/realoem-chrome
```

Open RealOEM normally in that browser, then set `REALOEM_TRANSPORT=browser` and `REALOEM_CDP_URL` in the MCP configuration's `env` object. Browser session access is also subject to the site's availability and access controls. The server does not bypass challenges.

## Development

```bash
npm run build
npm test
npm run worker:check
npm run test:worker
```

Run `npm run format` to format TypeScript and JSON files, or `npm run format:check` to check their formatting.

Sanitized HTML fixtures support offline tests for VIN attributes, navigation, conditional alternatives, companion rows, reference quantities, replacement notes, challenge detection, caching and MCP tool calls.

Worker integration tests run the deployed bundle in Miniflare with fixture-backed upstream responses. They check remote MCP discovery and tool calls, OAuth discovery, consent, browser binding, PKCE, authorization-code replay, resource audiences, refresh, revocation, scope enforcement, login throttling, Origin checks, inline image content, shared page and image caching, and request pacing across concurrent calls. They make no live RealOEM requests.

For local Worker development, copy `.dev.vars.example` to `.dev.vars`, set a random `MCP_AUTH_TOKEN`, and run `npm run worker:dev`. Connect an OAuth-capable client to `http://localhost:8787/mcp` and enter the token on the local login page. `npm run worker:build` validates the Worker bundle without deploying; `npm run worker:types` regenerates binding types after configuration changes.

All seven tools were verified against live RealOEM pages through a deployed Worker on 2026-10-11, including manual selection of the January 2011 E88 118d and rear bearing `33416762317` and the JPEG returned by `get_diagram_image` for diagram `33_1231`. Local stdio discovery and live VIN lookup were also verified. Cross-model applicability and VIN equipment decoding are not implemented.
