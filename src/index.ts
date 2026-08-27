/**
 * webrobot-agentic-studio — the WebRobot Agent Studio as host-agnostic React.
 *
 * A visual DAG editor (React Flow) for authoring the agent_definition
 * { crews, orchestration:{entry,edges,type} } — the graph of agents/crews that execute on Ray.
 *
 * configureAgentStudio() once with an apiBase + token provider, then mount <AgentCanvas />.
 * A host can pass a `chatSlot` (e.g. a "design with chat" panel) — the package does not bundle
 * a chat component; the same slot serves the pipeline studio.
 */
export * from './client';
export { default as AgentCanvas } from './components/AgentCanvas';
export { default as AgentStudio, type AgentStudioProps } from './components/AgentStudio';
