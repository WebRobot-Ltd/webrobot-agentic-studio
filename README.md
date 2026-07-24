# webrobot-agentic-studio

The **WebRobot Agentic Studio** as a standalone Vue 3 component. Define, edit and run *agentic
profiles* — the DAG of agents/crews that execute on Ray — against the WebRobot `/api/agentic`
surface. Extracted from the WebRobot portal so the same studio can be embedded elsewhere.

## What it does

- List / create / edit / delete agentic profiles (the profile YAML is the DAG definition:
  agents, crews, orchestration).
- Start a run and monitor executions (status + logs).
- Live YAML byte/line/warning feedback while editing a profile.

## Install

```bash
npm install webrobot-agentic-studio vue
```

`vue` (^3.3) is a peer dependency.

## Use

```vue
<script setup>
import { AgenticStudio } from 'webrobot-agentic-studio';
</script>

<template>
  <AgenticStudio />
</template>
```

The component holds its own config — `apiBase`, `apiKey`, `orgId` — with a settings panel, and
persists it to `localStorage` (`webrobot.agentic.studio.config`). Defaults target
`https://api.webrobot.eu/api`. There is no build-time coupling: a host mounts the component and
the user points it at an endpoint and supplies an API key.

## Endpoints

Targets the `/api/agentic` surface:

- `GET/POST /api/agentic/profiles`, `GET/PUT/DELETE /api/agentic/profiles/:id`
- `POST /api/agentic/start`
- `GET /api/agentic/executions`, and per-execution status/logs

Auth is sent as `Authorization: ApiKey <key>` and `X-API-Key: <key>`.

## Build

`main` points at the `.vue` source, so a host with a Vue bundler can consume it directly. A
compiled library build is also available:

```bash
npm run build   # vite lib build → dist/
```

## License

MIT © WebRobot Ltd
