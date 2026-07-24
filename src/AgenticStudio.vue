<template>
  <div class="agentic-studio">

    <!-- Banner: production-ready since 2026-05-22, but with caveats. -->
    <div class="status-banner">
      🟢 The agentic Ray runtime is <strong>in production</strong> (since 2026-05-22).
      The browser-grounding profile (Camoufox + browser-use fork)
      ships as a separate profile and is still being collaudata
      end-to-end &mdash; expect the LLM-only path
      (<code>webrobot-etl-builder</code>) to be the most stable
      choice for now.
    </div>

    <!-- Top toolbar: API config + tab nav -->
    <div class="toolbar">
      <div class="api-config">
        <label class="api-label">
          <span class="lbl">API base</span>
          <input
            v-model="apiBase"
            type="text"
            class="api-input"
            placeholder="https://api.webrobot.eu/api"
            @change="persistConfig"
          />
        </label>
        <label class="api-label">
          <span class="lbl">API key</span>
          <input
            v-model="apiKey"
            type="password"
            class="api-input"
            placeholder="super-admin-dev:..."
            @change="persistConfig"
          />
        </label>
        <label class="api-label small">
          <span class="lbl">Org</span>
          <input
            v-model="orgId"
            type="text"
            class="api-input narrow"
            @change="persistConfig"
          />
        </label>
        <button class="btn btn-secondary" :disabled="loadingProfiles" @click="reloadAll">
          <span v-if="loadingProfiles" class="spinner"></span>
          <span v-else>↻</span>
          Reload
        </button>
      </div>

      <nav class="tabs">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="tab-btn"
          :class="{ active: activeTab === tab.id }"
          @click="activeTab = tab.id"
        >
          {{ tab.label }}
          <span v-if="tab.count != null" class="badge">{{ tab.count }}</span>
        </button>
      </nav>
    </div>

    <!-- Global error -->
    <div v-if="globalError" class="error-box">
      <strong>Error:</strong> {{ globalError }}
      <button class="dismiss" @click="globalError = ''">✕</button>
    </div>

    <!-- ============================ PROFILES TAB ============================ -->
    <section v-if="activeTab === 'profiles'" class="tab-pane">

      <div class="profiles-layout">

        <!-- Left: list -->
        <aside class="profiles-list">
          <div class="list-header">
            <h3>Profiles</h3>
            <button class="btn btn-primary btn-sm" @click="openNewProfile">+ New</button>
          </div>
          <div v-if="loadingProfiles" class="loading-row">
            <span class="spinner"></span> Loading…
          </div>
          <div v-else-if="profiles.length === 0" class="empty-state">
            No profiles found for org <code>{{ orgId }}</code>.
            <button class="btn btn-secondary btn-sm" @click="seedFromTemplate">
              Seed from template
            </button>
          </div>
          <ul v-else class="profile-items">
            <li
              v-for="p in profiles"
              :key="p.id"
              class="profile-item"
              :class="{ active: editing?.id === p.id }"
              @click="loadProfile(p.id)"
            >
              <div class="profile-name">
                {{ p.name }}
                <span v-if="!p.enabled" class="disabled-pill">disabled</span>
              </div>
              <div class="profile-meta">
                <code>id={{ p.id }}</code> · v{{ p.version }}
              </div>
              <div class="profile-desc">{{ p.description || '—' }}</div>
            </li>
          </ul>
        </aside>

        <!-- Right: editor -->
        <main class="profile-editor">
          <div v-if="!editing" class="empty-pick">
            Pick a profile on the left, or <button class="btn btn-link" @click="openNewProfile">create a new one</button>.
          </div>

          <template v-else>
            <header class="editor-header">
              <div class="meta-fields">
                <label>
                  <span class="lbl">Name</span>
                  <input v-model="editing.name" type="text" class="meta-input" />
                </label>
                <label>
                  <span class="lbl">Version</span>
                  <input v-model="editing.version" type="text" class="meta-input narrow" />
                </label>
                <label>
                  <span class="lbl">Enabled</span>
                  <input v-model="editing.enabled" type="checkbox" />
                </label>
              </div>
              <div class="editor-actions">
                <button class="btn btn-secondary btn-sm" @click="validateYaml">
                  Validate YAML
                </button>
                <button class="btn btn-primary btn-sm" :disabled="saving" @click="saveProfile">
                  <span v-if="saving" class="spinner"></span>
                  {{ editing.id ? 'Save' : 'Create' }}
                </button>
                <button v-if="editing.id" class="btn btn-success btn-sm" @click="openRunModal">
                  ▶ Run
                </button>
                <button v-if="editing.id" class="btn btn-secondary btn-sm" @click="cloneProfile">
                  Clone
                </button>
                <button v-if="editing.id" class="btn btn-danger btn-sm" @click="deleteProfile">
                  Delete
                </button>
              </div>
            </header>

            <label class="desc-label">
              <span class="lbl">Description</span>
              <textarea v-model="editing.description" rows="2" class="desc-input"></textarea>
            </label>

            <div class="yaml-wrapper">
              <div class="yaml-header">
                <span class="yaml-label">spec_yaml ({{ yamlByteCount }} bytes, {{ yamlLineCount }} lines)</span>
                <span v-if="yamlWarnings.length" class="yaml-warning">
                  ⚠ {{ yamlWarnings.length }} warning{{ yamlWarnings.length === 1 ? '' : 's' }}
                </span>
              </div>
              <textarea
                v-model="editing.specYaml"
                class="yaml-editor"
                spellcheck="false"
                wrap="off"
              ></textarea>
              <div v-if="yamlWarnings.length" class="yaml-warnings">
                <div v-for="(w, i) in yamlWarnings" :key="i" class="yaml-warn-item">
                  <code>line {{ w.line }}</code>: {{ w.msg }}
                </div>
              </div>
            </div>
          </template>
        </main>
      </div>
    </section>

    <!-- ============================ EXECUTIONS TAB ============================ -->
    <section v-if="activeTab === 'executions'" class="tab-pane">
      <div class="exec-layout">

        <!-- Left: list -->
        <aside class="exec-list">
          <div class="list-header">
            <h3>Recent runs</h3>
            <button class="btn btn-secondary btn-sm" @click="loadExecutions">↻</button>
          </div>
          <div v-if="loadingExecutions" class="loading-row">
            <span class="spinner"></span> Loading…
          </div>
          <div v-else-if="executions.length === 0" class="empty-state">
            No runs yet for org <code>{{ orgId }}</code>.
          </div>
          <ul v-else class="exec-items">
            <li
              v-for="e in executions"
              :key="e.executionId"
              class="exec-item"
              :class="['status-' + (e.status || 'PENDING').toLowerCase(), { active: selectedExec?.executionId === e.executionId }]"
              @click="selectExecution(e)"
            >
              <div class="exec-id"><code>{{ e.executionId }}</code></div>
              <div class="exec-meta">
                <span class="status-pill" :class="'pill-' + (e.status || 'PENDING').toLowerCase()">
                  {{ e.status }}
                </span>
                <span class="exec-time">{{ formatTime(e.startedAt) }}</span>
              </div>
              <div v-if="e.llmProvider" class="exec-llm">{{ e.llmProvider }}</div>
            </li>
          </ul>
        </aside>

        <!-- Right: detail -->
        <main class="exec-detail">
          <div v-if="!selectedExec" class="empty-pick">
            Pick a run on the left.
          </div>
          <template v-else>
            <header class="exec-detail-header">
              <h3>
                <code>{{ selectedExec.executionId }}</code>
                <span class="status-pill" :class="'pill-' + (selectedExec.status || 'PENDING').toLowerCase()">
                  {{ selectedExec.status }}
                </span>
              </h3>
              <div class="exec-actions">
                <button class="btn btn-secondary btn-sm" @click="refreshSelectedExec">↻ Refresh</button>
                <button
                  v-if="!isTerminalStatus(selectedExec.status)"
                  class="btn btn-danger btn-sm"
                  @click="cancelExecution(selectedExec.executionId)"
                >
                  Cancel
                </button>
              </div>
            </header>

            <div class="exec-grid">
              <div class="exec-field">
                <span class="lbl">Profile</span>
                <span>{{ selectedExec.profileId ? `id=${selectedExec.profileId}` : '—' }}</span>
              </div>
              <div class="exec-field">
                <span class="lbl">LLM</span>
                <span>{{ selectedExec.llmProvider || '—' }}</span>
              </div>
              <div class="exec-field">
                <span class="lbl">Started</span>
                <span>{{ formatTime(selectedExec.startedAt) }}</span>
              </div>
              <div class="exec-field">
                <span class="lbl">Completed</span>
                <span>{{ formatTime(selectedExec.completedAt) }}</span>
              </div>
              <div class="exec-field">
                <span class="lbl">Tokens</span>
                <span>{{ parseTokens(selectedExec.tokens) }}</span>
              </div>
              <div v-if="selectedExec.errorMessage" class="exec-field full error-line">
                <span class="lbl">Error</span>
                <span>{{ selectedExec.errorMessage }}</span>
              </div>
            </div>

            <div class="json-block">
              <h4>Inputs</h4>
              <pre>{{ formatJsonString(selectedExec.inputs) }}</pre>
            </div>

            <div class="json-block">
              <h4>Result</h4>
              <pre>{{ formatJsonString(selectedExec.result) }}</pre>
            </div>
          </template>
        </main>
      </div>
    </section>

    <!-- ============================ RUN MODAL ============================ -->
    <div v-if="runModalOpen" class="modal-backdrop" @click.self="runModalOpen = false">
      <div class="modal">
        <header>
          <h3>Run profile: {{ runModalProfile?.name }}</h3>
          <button class="dismiss" @click="runModalOpen = false">✕</button>
        </header>
        <div class="modal-body">
          <label class="modal-field">
            <span class="lbl">LLM provider</span>
            <select v-model="runConfig.llmProvider" class="meta-input">
              <option value="groq">groq</option>
              <option value="openai">openai</option>
              <option value="anthropic">anthropic</option>
              <option value="togetherai">togetherai</option>
            </select>
          </label>
          <label class="modal-field">
            <span class="lbl">Inputs (JSON)</span>
            <textarea
              v-model="runConfig.inputsRaw"
              rows="10"
              class="json-editor"
              spellcheck="false"
            ></textarea>
            <small v-if="runConfig.parseError" class="error-line">
              {{ runConfig.parseError }}
            </small>
          </label>
          <label class="modal-field">
            <span class="lbl">Deadline (seconds)</span>
            <input v-model.number="runConfig.activeDeadlineSeconds" type="number" min="60" max="3600" class="meta-input narrow" />
          </label>
        </div>
        <footer>
          <button class="btn btn-secondary" @click="runModalOpen = false">Cancel</button>
          <button class="btn btn-primary" :disabled="running" @click="submitRun">
            <span v-if="running" class="spinner"></span>
            ▶ Submit
          </button>
        </footer>
      </div>
    </div>

  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'

// ── Config + persistence ──────────────────────────────────────────────
const STORAGE_KEY = 'webrobot.agentic.studio.config'
const defaults = {
  apiBase: 'https://api.webrobot.eu/api',
  apiKey:  '',
  orgId:   '2',
}
const apiBase = ref(defaults.apiBase)
const apiKey  = ref(defaults.apiKey)
const orgId   = ref(defaults.orgId)

function loadConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    apiBase.value = saved.apiBase || defaults.apiBase
    apiKey.value  = saved.apiKey  || defaults.apiKey
    orgId.value   = saved.orgId   || defaults.orgId
  } catch (_) { /* ignore */ }
}
function persistConfig() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      apiBase: apiBase.value,
      apiKey:  apiKey.value,
      orgId:   orgId.value,
    }))
  } catch (_) { /* ignore */ }
}

// ── HTTP helper ───────────────────────────────────────────────────────
async function api(method, path, body) {
  const url = `${apiBase.value.replace(/\/$/, '')}${path}`
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey.value) {
    headers['Authorization'] = `ApiKey ${apiKey.value}`
    headers['X-API-Key']     = apiKey.value
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const txt = await res.text()
  let data = null
  try { data = txt ? JSON.parse(txt) : null } catch (_) { data = { _raw: txt } }
  if (!res.ok) {
    const msg = (data && (data.exception || data.message)) || `HTTP ${res.status}`
    throw new Error(msg)
  }
  return data
}

// ── Tabs ──────────────────────────────────────────────────────────────
const activeTab = ref('profiles')
const tabs = computed(() => ([
  { id: 'profiles',   label: 'Profiles',   count: profiles.value.length },
  { id: 'executions', label: 'Executions', count: executions.value.length },
]))

// ── Profiles ──────────────────────────────────────────────────────────
const profiles        = ref([])
const loadingProfiles = ref(false)
const editing         = ref(null)   // { id, name, version, description, enabled, specYaml }
const saving          = ref(false)

async function loadProfiles() {
  loadingProfiles.value = true
  try {
    const data = await api('GET', `/webrobot/api/agentic/profiles?organizationId=${encodeURIComponent(orgId.value)}`)
    profiles.value = data.profiles || data || []
  } catch (e) {
    globalError.value = `Failed to load profiles: ${e.message}`
  } finally {
    loadingProfiles.value = false
  }
}

async function loadProfile(id) {
  try {
    const p = await api('GET', `/webrobot/api/agentic/profiles/${id}`)
    editing.value = {
      id:           p.id,
      name:         p.name,
      version:      p.version,
      description:  p.description,
      enabled:      !!p.enabled,
      organizationId: p.organizationId || orgId.value,
      specYaml:     p.specYaml || '',
    }
  } catch (e) {
    globalError.value = `Failed to load profile ${id}: ${e.message}`
  }
}

function openNewProfile() {
  editing.value = {
    id:             null,
    name:           'new-profile',
    version:        '0.1.0',
    description:    '',
    enabled:        true,
    organizationId: orgId.value,
    specYaml:       NEW_PROFILE_TEMPLATE,
  }
}

async function saveProfile() {
  if (!editing.value) return
  saving.value = true
  try {
    const body = {
      name:           editing.value.name,
      version:        editing.value.version,
      description:    editing.value.description,
      enabled:        editing.value.enabled,
      organizationId: editing.value.organizationId,
      specYaml:       editing.value.specYaml,
      // We don't synthesize the `spec` JSONB client-side; Jersey
      // accepts specYaml alone and parses it.
    }
    if (editing.value.id) {
      body.id = editing.value.id
      const saved = await api('PUT', `/webrobot/api/agentic/profiles/${editing.value.id}`, body)
      // Refresh in place
      Object.assign(editing.value, { name: saved.name, version: saved.version, description: saved.description, enabled: saved.enabled })
    } else {
      const created = await api('POST', `/webrobot/api/agentic/profiles`, body)
      editing.value.id = created.id
    }
    await loadProfiles()
  } catch (e) {
    globalError.value = `Save failed: ${e.message}`
  } finally {
    saving.value = false
  }
}

async function deleteProfile() {
  if (!editing.value?.id) return
  if (!confirm(`Delete profile "${editing.value.name}" (id=${editing.value.id})?`)) return
  try {
    await api('DELETE', `/webrobot/api/agentic/profiles/${editing.value.id}`)
    editing.value = null
    await loadProfiles()
  } catch (e) {
    globalError.value = `Delete failed: ${e.message}`
  }
}

function cloneProfile() {
  if (!editing.value) return
  editing.value = {
    ...editing.value,
    id:      null,
    name:    `${editing.value.name}-copy`,
    version: '0.1.0',
  }
}

function seedFromTemplate() {
  openNewProfile()
}

// ── YAML inspection (no parser dep; surface common .format() traps) ───
const yamlByteCount = computed(() => editing.value ? new Blob([editing.value.specYaml || '']).size : 0)
const yamlLineCount = computed(() => editing.value ? (editing.value.specYaml || '').split('\n').length : 0)

const yamlWarnings = computed(() => {
  if (!editing.value) return []
  const yaml = editing.value.specYaml || ''
  const lines = yaml.split('\n')
  const warns = []
  // Known input keys for canonical profiles + any {var} appearing in orchestration.edges[*].pass values
  const knownInputs = new Set(['goal', 'seed_url', 'fields', 'pipeline_yaml', 'stage_chain', 'name', 'plan', 'yaml_pipeline'])
  // The .format trap: single-brace placeholder where the var isn't an input
  const re = /(?<!\{)\{([A-Za-z_][A-Za-z_0-9]*|"[^"]+")\}(?!\})/g
  let inBlockScalar = false
  let blockIndent = -1
  let goalLikeContext = false
  lines.forEach((line, idx) => {
    // Heuristic: lines like `goal: >` / `description: >` / `backstory: >` start block scalars
    if (/^\s*(goal|description|expected_output|backstory)\s*:\s*[>|]/.test(line)) {
      inBlockScalar = true
      goalLikeContext = true
      blockIndent = line.search(/\S/) + 2
      return
    }
    if (inBlockScalar) {
      const indent = line.search(/\S/)
      if (indent !== -1 && indent < blockIndent) {
        inBlockScalar = false
        goalLikeContext = false
      }
    }
    if (!goalLikeContext) return
    let m
    while ((m = re.exec(line)) !== null) {
      const key = m[1]
      if (!knownInputs.has(key)) {
        warns.push({ line: idx + 1, msg: `single-brace {${key}} in a goal/description scalar will hit Python .format(**inputs). Use {{${key}}} for a literal.` })
      }
    }
  })
  return warns
})

function validateYaml() {
  if (!editing.value) return
  if (yamlWarnings.value.length === 0) {
    alert('No client-side warnings detected.\nServer-side validation runs at Save time.')
  } else {
    alert(`${yamlWarnings.value.length} warning(s) — scroll the editor to see them inline.`)
  }
}

// ── Run modal ─────────────────────────────────────────────────────────
const runModalOpen   = ref(false)
const runModalProfile = ref(null)
const runConfig = ref({
  llmProvider:           'groq',
  inputsRaw:             '{\n  "goal": "Scrape title and price from books.toscrape.com"\n}',
  activeDeadlineSeconds: 600,
  parseError:            '',
})
const running = ref(false)

function openRunModal() {
  if (!editing.value?.id) return
  runModalProfile.value = editing.value
  runModalOpen.value = true
}

async function submitRun() {
  // Parse inputs JSON
  let inputs
  try {
    inputs = JSON.parse(runConfig.value.inputsRaw)
  } catch (e) {
    runConfig.value.parseError = `Invalid JSON: ${e.message}`
    return
  }
  runConfig.value.parseError = ''
  running.value = true
  try {
    const body = {
      profileId:             runModalProfile.value.id,
      llmProvider:           runConfig.value.llmProvider,
      organizationId:        orgId.value,
      inputs,
      activeDeadlineSeconds: runConfig.value.activeDeadlineSeconds,
    }
    const resp = await api('POST', '/webrobot/api/agentic/start', body)
    runModalOpen.value = false
    activeTab.value = 'executions'
    await loadExecutions()
    selectedExec.value = executions.value.find(e => e.executionId === resp.executionId) || resp
    startPollingSelected()
  } catch (e) {
    globalError.value = `Run failed: ${e.message}`
  } finally {
    running.value = false
  }
}

// ── Executions ────────────────────────────────────────────────────────
const executions        = ref([])
const loadingExecutions = ref(false)
const selectedExec      = ref(null)
let pollTimer = null

async function loadExecutions() {
  loadingExecutions.value = true
  try {
    const data = await api('GET', `/webrobot/api/agentic/executions?organizationId=${encodeURIComponent(orgId.value)}&limit=50`)
    executions.value = data.executions || []
  } catch (e) {
    globalError.value = `Failed to load executions: ${e.message}`
  } finally {
    loadingExecutions.value = false
  }
}

function selectExecution(e) {
  selectedExec.value = e
  startPollingSelected()
}

async function refreshSelectedExec() {
  if (!selectedExec.value) return
  try {
    const fresh = await api('GET', `/webrobot/api/agentic/${encodeURIComponent(selectedExec.value.executionId)}`)
    // The /{eid} endpoint returns status + ray info, NOT the full row.
    // Merge into the cached row so result/tokens stay visible if we already had them.
    selectedExec.value = { ...selectedExec.value, ...fresh }
  } catch (e) {
    globalError.value = `Refresh failed: ${e.message}`
  }
}

function startPollingSelected() {
  stopPollingSelected()
  if (!selectedExec.value || isTerminalStatus(selectedExec.value.status)) return
  pollTimer = setInterval(async () => {
    if (!selectedExec.value || isTerminalStatus(selectedExec.value.status)) {
      stopPollingSelected()
      // Refresh exec list to pull updated row (result/tokens populated by webhook)
      await loadExecutions()
      const updated = executions.value.find(e => e.executionId === selectedExec.value?.executionId)
      if (updated) selectedExec.value = updated
      return
    }
    await refreshSelectedExec()
  }, 4000)
}
function stopPollingSelected() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

async function cancelExecution(eid) {
  if (!confirm(`Cancel execution ${eid}?`)) return
  try {
    await api('DELETE', `/webrobot/api/agentic/${encodeURIComponent(eid)}`)
    await loadExecutions()
  } catch (e) {
    globalError.value = `Cancel failed: ${e.message}`
  }
}

function isTerminalStatus(s) {
  return s === 'COMPLETED' || s === 'FAILED' || s === 'CANCELLED'
}

// ── Formatting helpers ────────────────────────────────────────────────
function formatTime(ts) {
  if (!ts) return '—'
  try { return new Date(ts).toLocaleString() } catch (_) { return String(ts) }
}
function formatJsonString(s) {
  if (!s) return '—'
  try { return JSON.stringify(JSON.parse(s), null, 2) } catch (_) { return String(s) }
}
function parseTokens(tokensJson) {
  if (!tokensJson) return '—'
  try {
    const t = JSON.parse(tokensJson)
    return `${t.total_tokens || 0} (${t.prompt_tokens || 0} prompt + ${t.completion_tokens || 0} completion)`
  } catch (_) {
    return String(tokensJson)
  }
}

// ── Global ────────────────────────────────────────────────────────────
const globalError = ref('')

async function reloadAll() {
  await Promise.all([loadProfiles(), loadExecutions()])
}

// ── Lifecycle ─────────────────────────────────────────────────────────
onMounted(() => {
  loadConfig()
  reloadAll()
})
onUnmounted(() => {
  stopPollingSelected()
})

// Reload when org changes
watch(orgId, () => { reloadAll() })

// ── Constants ─────────────────────────────────────────────────────────
const NEW_PROFILE_TEMPLATE = `# Minimal single-crew agentic profile. Edit + Save + Run.
# See PROFILE-webrobot-etl-builder.md for the full builder/validator pattern.

profile: my-new-profile
version: 0.1.0
description: >
  Single-crew profile that takes an NL goal and replies with a one-line answer.

tools: []

crews:
  - id: hello
    description: "Echo the goal in a single sentence."
    process: sequential
    llm_default: groq/llama-3.3-70b-versatile
    agents:
      - id: echo
        role: "Echo agent"
        goal: >
          Restate the user's goal in one polite sentence.
        backstory: >
          You are concise and friendly.
        tools: []
    tasks:
      - id: echo_task
        agent: echo
        description: >
          The user goal is: {goal}
        expected_output: "A single sentence."
        output_field: reply

orchestration:
  type: dag
  nodes:
    - id: hello
      crew: hello
  edges: []

runtime:
  ray:
    address: auto
    namespace: webrobot.session
  timeouts:
    per_crew_sec: 120
    per_session_sec: 300
  budget:
    max_tokens_per_session: 20000
`
</script>

<style scoped>
.agentic-studio {
  font-family: var(--vp-font-family-base, system-ui);
  color: var(--vp-c-text-1, #1f2328);
}

.status-banner {
  background: linear-gradient(90deg, #ecfdf5 0%, #f0fdf4 100%);
  border-left: 4px solid #10b981;
  color: #064e3b;
  padding: 0.9rem 1.1rem;
  border-radius: 6px;
  margin-bottom: 1.25rem;
  font-size: 0.92rem;
  line-height: 1.5;
}
.status-banner code {
  background: rgba(16, 185, 129, 0.15);
  padding: 0.1rem 0.35rem;
  border-radius: 3px;
}

.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  margin-bottom: 1rem;
  flex-wrap: wrap;
}
.api-config {
  display: flex;
  gap: 0.75rem;
  align-items: flex-end;
  flex-wrap: wrap;
}
.api-label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.api-label.small { width: 80px; }
.lbl {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--vp-c-text-2, #57606a);
  font-weight: 600;
}
.api-input {
  padding: 0.45rem 0.6rem;
  font-size: 0.9rem;
  font-family: var(--vp-font-family-mono, monospace);
  border: 1px solid var(--vp-c-border, #d0d7de);
  border-radius: 4px;
  background: var(--vp-c-bg, #fff);
  color: inherit;
  min-width: 230px;
}
.api-input.narrow { min-width: 60px; width: 60px; }

.tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--vp-c-border, #d0d7de);
}
.tab-btn {
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 0.5rem 1rem;
  cursor: pointer;
  font-size: 0.95rem;
  font-weight: 500;
  color: var(--vp-c-text-2, #57606a);
}
.tab-btn.active {
  border-bottom-color: var(--vp-c-brand-1, #0969da);
  color: var(--vp-c-text-1, #1f2328);
}
.badge {
  background: var(--vp-c-bg-soft, #f6f8fa);
  border: 1px solid var(--vp-c-border, #d0d7de);
  border-radius: 10px;
  padding: 0 0.5rem;
  font-size: 0.75rem;
  margin-left: 0.4rem;
}

.error-box {
  background: #fef2f2;
  border: 1px solid #fecaca;
  color: #991b1b;
  padding: 0.7rem 1rem;
  border-radius: 4px;
  margin: 0.75rem 0;
  position: relative;
}
.error-box .dismiss {
  position: absolute;
  right: 0.5rem; top: 0.5rem;
  background: transparent; border: none;
  cursor: pointer; color: inherit; font-size: 1rem;
}

.tab-pane { padding-top: 1rem; }

/* Profiles layout */
.profiles-layout, .exec-layout {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 1rem;
  min-height: 600px;
}
@media (max-width: 900px) {
  .profiles-layout, .exec-layout {
    grid-template-columns: 1fr;
  }
}

.profiles-list, .exec-list {
  border: 1px solid var(--vp-c-border, #d0d7de);
  border-radius: 6px;
  background: var(--vp-c-bg-soft, #f6f8fa);
  overflow-y: auto;
  max-height: 80vh;
}
.list-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--vp-c-border, #d0d7de);
  background: var(--vp-c-bg, #fff);
  position: sticky; top: 0; z-index: 1;
}
.list-header h3 { margin: 0; font-size: 0.95rem; }

.profile-items, .exec-items {
  list-style: none;
  padding: 0; margin: 0;
}
.profile-item, .exec-item {
  padding: 0.6rem 0.75rem;
  border-bottom: 1px solid var(--vp-c-border, #e1e4e8);
  cursor: pointer;
  transition: background 80ms;
}
.profile-item:hover, .exec-item:hover {
  background: var(--vp-c-bg-elv, #fff);
}
.profile-item.active, .exec-item.active {
  background: #dbeafe;
  border-left: 3px solid #0969da;
}
.profile-name {
  font-weight: 600;
  font-size: 0.95rem;
}
.profile-meta {
  font-size: 0.78rem;
  color: var(--vp-c-text-2);
}
.profile-meta code { font-size: 0.78rem; background: rgba(0,0,0,0.05); padding: 0 0.3rem; border-radius: 2px; }
.profile-desc {
  font-size: 0.82rem;
  color: var(--vp-c-text-2);
  margin-top: 0.3rem;
  display: -webkit-box;
  -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden;
}
.disabled-pill {
  background: #fde68a;
  color: #92400e;
  font-size: 0.7rem;
  font-weight: 600;
  padding: 0 0.35rem;
  border-radius: 2px;
  margin-left: 0.4rem;
}

/* Editor */
.profile-editor, .exec-detail {
  border: 1px solid var(--vp-c-border, #d0d7de);
  border-radius: 6px;
  padding: 1rem;
  background: var(--vp-c-bg, #fff);
  display: flex;
  flex-direction: column;
}
.editor-header {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: flex-end;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--vp-c-border);
}
.meta-fields { display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: flex-end; }
.meta-fields label { display: flex; flex-direction: column; gap: 0.2rem; }
.meta-input {
  padding: 0.4rem 0.55rem;
  font-size: 0.9rem;
  border: 1px solid var(--vp-c-border);
  border-radius: 4px;
  background: var(--vp-c-bg);
  color: inherit;
}
.meta-input.narrow { width: 90px; }
.desc-label { display: flex; flex-direction: column; gap: 0.25rem; margin-bottom: 0.75rem; }
.desc-input {
  padding: 0.4rem 0.55rem;
  border: 1px solid var(--vp-c-border);
  border-radius: 4px;
  background: var(--vp-c-bg);
  color: inherit;
  font-family: var(--vp-font-family-base, system-ui);
  font-size: 0.9rem;
  resize: vertical;
}
.editor-actions { display: flex; gap: 0.4rem; flex-wrap: wrap; }
.yaml-wrapper { flex: 1; display: flex; flex-direction: column; }
.yaml-header {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 0.78rem;
  color: var(--vp-c-text-2);
  margin-bottom: 0.3rem;
}
.yaml-warning { color: #ca8a04; font-weight: 600; }
.yaml-editor {
  width: 100%;
  min-height: 500px;
  font-family: var(--vp-font-family-mono, ui-monospace, "SFMono-Regular", monospace);
  font-size: 0.84rem;
  line-height: 1.5;
  border: 1px solid var(--vp-c-border);
  border-radius: 4px;
  padding: 0.6rem;
  background: var(--vp-c-bg-soft, #f6f8fa);
  color: inherit;
  white-space: pre;
  overflow: auto;
  tab-size: 2;
  -moz-tab-size: 2;
}
.yaml-editor:focus {
  outline: 2px solid var(--vp-c-brand-1, #0969da);
  outline-offset: -2px;
}
.yaml-warnings {
  margin-top: 0.4rem;
  border: 1px solid #fef3c7;
  background: #fffbeb;
  border-radius: 4px;
  padding: 0.4rem 0.6rem;
  font-size: 0.82rem;
  color: #92400e;
  max-height: 140px;
  overflow-y: auto;
}
.yaml-warn-item { padding: 0.15rem 0; }
.yaml-warn-item code {
  background: #fde68a;
  padding: 0 0.3rem;
  border-radius: 2px;
}

/* Executions */
.exec-id code { font-size: 0.85rem; }
.exec-meta { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.3rem; flex-wrap: wrap; }
.exec-time { font-size: 0.78rem; color: var(--vp-c-text-2); }
.exec-llm { font-size: 0.78rem; color: var(--vp-c-text-2); margin-top: 0.15rem; }
.status-pill {
  display: inline-block;
  font-size: 0.72rem;
  padding: 0.05rem 0.45rem;
  border-radius: 8px;
  font-weight: 600;
  text-transform: uppercase;
}
.pill-completed { background: #d1fae5; color: #065f46; }
.pill-failed    { background: #fee2e2; color: #991b1b; }
.pill-cancelled { background: #fef3c7; color: #92400e; }
.pill-running   { background: #dbeafe; color: #1e40af; }
.pill-pending   { background: #e5e7eb; color: #374151; }

.exec-detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 0.75rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--vp-c-border);
}
.exec-detail-header h3 { margin: 0; display: flex; align-items: center; gap: 0.6rem; }
.exec-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 0.6rem;
  margin-bottom: 1rem;
}
.exec-field { display: flex; flex-direction: column; gap: 0.15rem; }
.exec-field.full { grid-column: 1 / -1; }
.error-line { color: #b91c1c; }
.json-block { margin-bottom: 1rem; }
.json-block h4 { margin: 0 0 0.3rem; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vp-c-text-2); }
.json-block pre {
  background: var(--vp-c-bg-soft, #f6f8fa);
  border: 1px solid var(--vp-c-border);
  border-radius: 4px;
  padding: 0.6rem;
  font-size: 0.8rem;
  max-height: 280px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

/* Modal */
.modal-backdrop {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.5);
  display: flex; align-items: center; justify-content: center;
  z-index: 1000;
}
.modal {
  background: var(--vp-c-bg, #fff);
  border-radius: 8px;
  padding: 0;
  width: 90%; max-width: 640px;
  max-height: 88vh;
  display: flex; flex-direction: column;
}
.modal > header, .modal > footer {
  padding: 0.8rem 1.2rem;
  display: flex; justify-content: space-between; align-items: center;
}
.modal > header { border-bottom: 1px solid var(--vp-c-border); }
.modal > footer { border-top: 1px solid var(--vp-c-border); gap: 0.5rem; }
.modal > header h3 { margin: 0; font-size: 1rem; }
.modal-body {
  padding: 1rem 1.2rem;
  overflow-y: auto;
  display: flex; flex-direction: column; gap: 0.8rem;
}
.modal-field { display: flex; flex-direction: column; gap: 0.25rem; }
.json-editor {
  font-family: var(--vp-font-family-mono, monospace);
  font-size: 0.84rem;
  padding: 0.5rem;
  border: 1px solid var(--vp-c-border);
  border-radius: 4px;
  background: var(--vp-c-bg-soft, #f6f8fa);
  color: inherit;
  resize: vertical;
}
.dismiss {
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 1.1rem;
  color: var(--vp-c-text-2);
}

/* Buttons */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.45rem 0.85rem;
  font-size: 0.88rem;
  font-weight: 500;
  border-radius: 4px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background 80ms, opacity 80ms;
}
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-sm { padding: 0.3rem 0.6rem; font-size: 0.82rem; }
.btn-primary { background: #0969da; color: #fff; }
.btn-primary:hover:not(:disabled) { background: #0860c4; }
.btn-secondary { background: #f6f8fa; color: #24292f; border-color: #d0d7de; }
.btn-secondary:hover:not(:disabled) { background: #eaeef2; }
.btn-success { background: #1f883d; color: #fff; }
.btn-success:hover:not(:disabled) { background: #1a7f37; }
.btn-danger { background: #cf222e; color: #fff; }
.btn-danger:hover:not(:disabled) { background: #b8202b; }
.btn-link {
  background: transparent;
  color: #0969da;
  text-decoration: underline;
  border: none;
  padding: 0;
  font-size: inherit;
  cursor: pointer;
}

/* Spinner */
.spinner {
  display: inline-block;
  width: 0.8rem; height: 0.8rem;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.loading-row, .empty-state, .empty-pick {
  padding: 1rem;
  text-align: center;
  color: var(--vp-c-text-2);
  font-size: 0.9rem;
}
.empty-state { padding: 1.5rem 1rem; display: flex; flex-direction: column; gap: 0.6rem; align-items: center; }
.empty-pick { padding: 3rem 1rem; }

/* Dark mode tweaks */
.dark .status-banner {
  background: linear-gradient(90deg, rgba(16, 185, 129, 0.1) 0%, rgba(34, 197, 94, 0.1) 100%);
  color: #6ee7b7;
  border-left-color: #10b981;
}
.dark .yaml-editor,
.dark .json-editor,
.dark .json-block pre {
  background: rgba(255, 255, 255, 0.04);
}
.dark .yaml-warnings {
  background: rgba(245, 158, 11, 0.1);
  border-color: rgba(245, 158, 11, 0.3);
  color: #fcd34d;
}
.dark .error-box {
  background: rgba(220, 38, 38, 0.1);
  border-color: rgba(220, 38, 38, 0.3);
  color: #fca5a5;
}
.dark .btn-secondary { background: rgba(255,255,255,0.06); color: #c9d1d9; border-color: rgba(255,255,255,0.12); }
.dark .profile-item.active, .dark .exec-item.active {
  background: rgba(56, 139, 253, 0.18);
  border-left-color: #58a6ff;
}
.dark .pill-completed { background: rgba(16, 185, 129, 0.2); color: #6ee7b7; }
.dark .pill-failed    { background: rgba(220, 38, 38, 0.2); color: #fca5a5; }
.dark .pill-running   { background: rgba(56, 139, 253, 0.2); color: #79c0ff; }
.dark .pill-pending   { background: rgba(255,255,255,0.1); color: #c9d1d9; }
.dark .pill-cancelled { background: rgba(245, 158, 11, 0.2); color: #fcd34d; }
</style>
