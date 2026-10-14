# RealOEM MCP

An MCP server for the [BMW parts catalog on RealOEM](https://new-ui.realoem.com/bmw/enUS/). Identify a vehicle by VIN, browse exploded diagrams, and look up part numbers, quantities, option conditions, and replacement history.

Run locally over stdio or deploy to Cloudflare Workers for remote access with OAuth.

If you find this MCP useful, consider [donating to RealOEM](https://new-ui.realoem.com/bmw/donate).

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hcampbell98/RealOEMMCP)

1. Click the button to copy this repository and deploy it to your Cloudflare account. Setup provisions the required Durable Object and KV namespace.
2. Generate a private token with `openssl rand -hex 32` and supply it as `MCP_AUTH_TOKEN` during setup.
3. Add `https://<your-worker>.<your-subdomain>.workers.dev/mcp` to an MCP client that supports Streamable HTTP and OAuth.
4. On the Worker's login page, check the client and return destination, enter your token, and select **Allow access**.

For ChatGPT, create a custom connector or app with the MCP URL and choose OAuth. Leave the OAuth client ID and client secret blank; the client registers itself. No external identity provider is needed.

The deployment token approves client access; it is not a bearer token for MCP requests. Anyone with it can approve clients. Changing `MCP_AUTH_TOKEN` invalidates existing OAuth credentials, so connected clients must reconnect. Cloudflare usage is billed to the hosting account.

<details>
<summary>Manual deployment</summary>

```bash
npm ci
npx wrangler login
npx wrangler secret put MCP_AUTH_TOKEN
npm run deploy
```

</details>

## Run locally

Requires Node.js 22 or later.

```bash
npm ci
npm run build
```

Add this to your MCP client's configuration, replacing the path with your checkout's absolute path:

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

The local server uses stdio. It fetches catalog pages over HTTP from `new-ui.realoem.com` with the classic layout. No browser installation or authentication token is needed.

## Available tools

| Tool | What it does |
| --- | --- |
| `identify_vehicle(vin)` | Find catalog candidates from a full VIN or its last seven characters. |
| `select_vehicle(...)` | Browse vehicle choices without a VIN. Pass the returned selections on each call; `prod` uses `YYYYMM00`. |
| `list_part_groups(vehicleId)` | List a vehicle's major part groups. |
| `list_diagrams(vehicleId, groupId, query?)` | List diagrams in a group, optionally filtering by title. |
| `get_diagram_parts(vehicleId, diagramId)` | Get part rows, ordered conditions, and the diagram image URL. |
| `get_diagram_image(vehicleId, diagramId)` | Return the exploded diagram as an inline MCP image. |
| `search_parts(vehicleId, query, diagramId?)` | Search an 11-character BMW part number, including letters and optional spaces, and retrieve matching diagrams and available supersession notes. |

Use the returned `vehicleId` on every subsequent catalog call. Results include a source URL and retrieval time. Image display depends on your MCP client.

Try asking your agent:

> Identify my BMW using VIN suffix VM52466. Find the drive shaft diagram, ask me about any unresolved transmission options, and give me the applicable part number with the source link.

## Before choosing parts

A VIN identifies the catalog vehicle but does not confirm every equipment option. `get_diagram_parts` returns `fitmentStatus: "requires_confirmation"`; read its ordered `rows` alongside the `parts` list before choosing an alternative.

- Check transmission, option conditions, production dates, and `ENDED` notes.
- Read "only in conjunction with" and "only applies to" conditions. Position `--` can identify a companion part or compatibility reference; quantity `X` identifies a reference.
- Keep alternatives and repeated part numbers separate when building a purchase list.
- Use `get_diagram_image` to view the diagram alongside its rows. An image alone does not confirm fitment, and a diagram is not a complete repair procedure.

VIN equipment decoding and cross-model applicability are not implemented.

## Optional browser access

If RealOEM blocks HTTP requests, the local server can use Chromium. Access still depends on RealOEM's availability and access controls.

<details>
<summary>Browser setup and environment options</summary>

Install Chromium with `npm run browser:install`, then add an `env` object to the local MCP configuration:

```json
"env": {
  "REALOEM_TRANSPORT": "browser",
  "REALOEM_HEADLESS": "false"
}
```

A visible browser requires a desktop. Challenged pages wait up to 60 seconds for normal site interaction; configure your MCP client with a timeout above 90 seconds.

Other local options:

- `REALOEM_BROWSER_EXECUTABLE`: path to an existing Chrome or Chromium executable.
- `REALOEM_CDP_URL`: local Chrome debugging endpoint, such as `http://127.0.0.1:9222`, to use an existing browser session. Keep the endpoint local.
- `REALOEM_BASE_URL`: override the catalog host with `https://www.realoem.com/bmw/enUS/` or `https://new-ui.realoem.com/bmw/enUS/`.

Browser transport is available only locally. Cloudflare deployments use HTTP.

</details>

## Development

```bash
npm run build
npm test
npm run worker:check
npm run test:worker
```

Tests use sanitized catalog fixtures and make no live RealOEM requests. Run `npm run format:check` to check TypeScript and JSON formatting, or `npm run format` to apply it.

For local Worker development, copy [.dev.vars.example](.dev.vars.example) to `.dev.vars`, set a random `MCP_AUTH_TOKEN`, and run `npm run worker:dev`. Connect an OAuth-capable client to `http://localhost:8787/mcp` and enter the token on the login page.
