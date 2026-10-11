# RealOEM MCP

A TypeScript MCP server for the BMW catalog at https://www.realoem.com/bmw/enUS/. It resolves a VIN to a catalog vehicle, browses groups and diagrams, and returns part numbers, quantities, production limits, option notes, companion rows and replacement history.

VIN lookup alone does not resolve every part alternative. The captured E88 catalog lists both manual and automatic drive shafts. This server preserves those alternatives and the conditions an agent must check before recommending a purchase.

## Setup

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

The server uses stdio and defaults to HTTP on `https://new-ui.realoem.com/bmw/enUS/`, requesting the classic layout with `ui=v1`. No browser installation or environment overrides are needed for this configuration. Diagnostics and protocol errors do not write ordinary text to stdout. It serialises requests, spaces them by at least one second, caches up to 100 successful pages for 15 minutes, and retries HTTP 429/502/503/504 at most twice. The cache belongs to the running process.

## Tools

- `identify_vehicle(vin)`: accepts a full VIN or its last seven characters; returns catalog candidates and vehicle attributes.
- `select_vehicle(...)`: browse without a VIN using returned choice values. Pass the upstream selections on each call. `prod` uses `YYYYMM00`.
- `list_part_groups(vehicleId)`: retrieve major groups.
- `list_diagrams(vehicleId, groupId, query?)`: retrieve a group's diagrams; `query` filters their titles without more requests.
- `get_diagram_parts(vehicleId, diagramId)`: retrieve the image URL, part rows and ordered condition rows.
- `search_parts(vehicleId, query, diagramId?)`: search an 11-character BMW part number, including numbers containing letters, with optional spaces; retrieve matching diagrams and available supersession notes.

Use the returned `vehicleId` on every catalog call. Results include `sourceUrl`, `retrievedAt` and `source`, which is `live` or `har`. There is no automatic fallback from live data to a capture.

An example request to an agent:

> Identify my BMW using VIN suffix VM52466. Find the drive shaft diagram, ask me about any unresolved transmission options, and give me the applicable part number with the source link.

For the supplied capture, identification returns `UM92-EUR-01-2011-E88-BMW-118d`, January 2011, N47, right hand drive. Diagram `26_0216` contains manual shaft `26107567953` and automatic shaft `26117526136`, with `S205A=Yes` before the automatic row.

## Fitment and repair scope

`get_diagram_parts` returns `fitmentStatus: "requires_confirmation"`. Its `rows` preserve table order, `positionGroup`, indentation `depth`, and note cells. `parts` is a convenience list of the catalog part rows, including reference rows. Interpret it together with `rows`.

Do not combine alternatives or repeated part numbers into a purchase list. Quantity `X` identifies a reference in the captured diagrams. Position `--` can mark a required companion or a compatibility reference. Read "only in conjunction with", "only applies to", option conditions, dates and `ENDED` notes before choosing parts. A diagram does not establish a complete repair procedure or every item needed for a job. Image URLs are returned as links; the server does not download images.

## Live access

The `www.realoem.com` host returned Cloudflare HTTP 403 challenges for live VIN queries in this environment. The official `new-ui.realoem.com` host was accessible: live VIN identification, rear-axle browsing, bearing diagrams and replacement searches were verified through the MCP for VM52466. That host and HTTP transport are now the defaults. The server requests the classic layout with `ui=v1` on live requests. It reports access errors with configuration guidance instead of presenting empty results or guessing fitment. MCP initialization instructions also explain the defaults to agents without this conversation's context.

These optional environment variables override the defaults. For browser mode, first run `npm run browser:install` or supply an existing browser executable:

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

## HAR replay and validation

A locally supplied HAR supports an offline workflow for the vehicle and pages it captured. HAR files are excluded from the repository:

```json
{
  "mcpServers": {
    "realoem": {
      "command": "node",
      "args": ["/absolute/path/to/RealOEMMCP/dist/index.js"],
      "env": {
        "REALOEM_TRANSPORT": "har",
        "REALOEM_HAR_PATH": "/absolute/path/to/www.realoem.com.har"
      }
    }
  }
}
```

HAR mode never requests uncaptured pages. A missing capture returns an error. The recorded part searches include `diagramId`, so provide it when replaying them. The original HAR is ignored by git; extracted HTML fixtures omit scripts and advertising blocks.

```bash
npm test
REALOEM_HAR_PATH=www.realoem.com.har npx tsx scripts/smoke.ts
```

Run `npm run format` to format TypeScript and JSON files, or `npm run format:check` to check their formatting.

Tests cover VIN attributes, navigation, conditional alternatives, companion rows, reference quantities, replacement notes, challenge detection, caching and MCP tool calls. The smoke script starts the built server over stdio and exercises the recorded workflow.

Manual vehicle browsing follows the captured HTML form and JavaScript, but a live manual browsing sequence remains unverified. Cross-model applicability and VIN equipment decoding are not implemented.
