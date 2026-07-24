# webrobot-agentic-studio

The **WebRobot Agent Studio** as a host-agnostic React component: a visual **DAG editor**
(React Flow) for authoring the agent/crew graph that executes on Ray. Extracted from the
WebRobot dashboard so the same studio can be embedded elsewhere (for example a WordPress
plugin), the same way as [`webrobot-pipeline-studio`](https://github.com/WebRobot-Ltd/webrobot-pipeline-studio).

## What it does

Author an agent team as a graph — each agent is a node, edges are the orchestration flow —
and produce the `agent_definition { crews, orchestration: { entry, edges, type } }` the backend
consumes.

- Node kinds: **RAG assistant**, **tool agent** (MCP), **HITL gate** (`ask_human`), **publisher**.
- Approaches: `rag` (single), `sequential` (forward DAG), `loop` (feedback edge).
- Build by hand, or **describe it in natural language** and have the backend model the graph
  (`/api/agents/generate`), then review on the canvas.
- Save a draft and submit for approval (agent-template routes).

## Install

```bash
npm install webrobot-agentic-studio react @xyflow/react lucide-react
```

`react`, `@xyflow/react` and `lucide-react` are peer dependencies.

## Configure

Host-agnostic: inject the API base and a token provider once. The core imports neither a token
helper nor `process.env`.

```ts
import { configureAgentStudio } from 'webrobot-agentic-studio';

configureAgentStudio({
  apiBase: '',                                   // '' keeps same-origin BFF paths; a full origin points elsewhere
  getToken: () => localStorage.getItem('jwt'),   // a function, so a rotated token is picked up
});
```

## Use

```tsx
import { AgentCanvas } from 'webrobot-agentic-studio';

export function Studio() {
  return <AgentCanvas />;
}
```

### Design-with-chat slot

The canvas exposes an optional `chatSlot`. The package does **not** bundle a chat component —
the host injects one, so the same "design with chat" panel serves both this studio and the
pipeline studio:

```tsx
<AgentCanvas chatSlot={<DesignWithChat context="agentic:agent-studio" />} />
```

## Endpoints

Prefixed with the configured `apiBase`:

- `POST /api/agents/generate` — natural-language → `agent_definition`
- `POST/PUT /api/admin/agent-templates(/:id)`, `POST /api/admin/agent-templates/:id/submit`
- `GET/POST/PUT /api/admin/agentic/profiles(/:id)`

Auth is sent as `Authorization: Bearer <token>`.

## Build

```bash
npm run build      # tsc → dist/
npm run typecheck
```

The core (`configureAgentStudio` + the client) typechecks with no React present; the components
need `@xyflow/react` + `lucide-react`.

## License

MIT © WebRobot Ltd
