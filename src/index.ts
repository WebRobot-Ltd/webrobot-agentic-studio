/**
 * webrobot-agentic-studio — the WebRobot Agentic Studio as a standalone Vue component.
 *
 * Define, edit and run agentic profiles: the DAG of agents/crews that execute on Ray. Talks
 * to the /api/agentic surface (profiles CRUD, start, executions). Config (apiBase, apiKey,
 * orgId) is held by the component and persisted to localStorage, so a host mounts it and the
 * user configures the endpoint + key from its settings panel — no build-time coupling.
 */
import AgenticStudio from './AgenticStudio.vue';

export { AgenticStudio };
export default AgenticStudio;
