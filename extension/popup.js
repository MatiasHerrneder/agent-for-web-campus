const BACKEND_URL = "http://localhost:8000";
const MAX_HISTORY_TURNS = 10; // keep last 10 exchanges (20 messages)
const MAX_STORED_SESSIONS = 20;
const MAX_MESSAGES_PER_SESSION = 40; // cap per chat so storage stays bounded
const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
const OLLAMA_MODELS = ["qwen2.5", "llama3.1", "qwen3:14b"];
const DEFAULT_SETTINGS = {
  provider: "gemini",
  geminiModel: GEMINI_MODELS[0],
  geminiApiKey: "",
  useOwnKey: false,
  ollamaModel: OLLAMA_MODELS[0],
};
const STORAGE_KEYS = {
  activeSessionId: "activeChatSessionId",
  sessions: "chatSessions",
  settings: "assistantSettings",
  geminiApiKey: "sessionGeminiApiKey",
};

let sessionCookies = {};
let chatSessions = [];
let activeSessionId = null;
let assistantSettings = { ...DEFAULT_SETTINGS };
let persistTimer = null;

async function init() {
  bindEvents();

  const sessionStorageArea = getSessionStorageArea();
  const [response, localState, sessionState] = await Promise.all([
    chrome.runtime.sendMessage({ type: "GET_COOKIES" }),
    storageGet(chrome.storage.local, [
      STORAGE_KEYS.sessions,
      STORAGE_KEYS.activeSessionId,
      STORAGE_KEYS.settings,
    ]),
    storageGet(sessionStorageArea, [STORAGE_KEYS.geminiApiKey]),
  ]);

  sessionCookies = response?.cookies || {};
  hydrateSessions(localState);
  hydrateSettings(localState, sessionState);
  renderSettings();
  renderSessionPicker();
  renderMessages();
  syncLoginState();
}

function bindEvents() {
  document.getElementById("send-btn").addEventListener("click", sendQuery);
  document.getElementById("new-chat-btn").addEventListener("click", createNewChat);
  document.getElementById("delete-chat-btn").addEventListener("click", deleteActiveChat);
  document.getElementById("session-select").addEventListener("change", handleSessionChange);
  document.getElementById("provider-select").addEventListener("change", handleProviderChange);
  document.getElementById("gemini-model").addEventListener("change", handleTextSettingsChange);
  document.getElementById("use-own-key").addEventListener("change", handleUseOwnKeyChange);
  document.getElementById("gemini-api-key").addEventListener("input", handleTextSettingsChange);
  document.getElementById("ollama-model").addEventListener("change", handleTextSettingsChange);
  document.getElementById("query").addEventListener("keydown", (event) => {
    // Enter sends; Shift+Enter inserts a newline.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendQuery();
    }
  });
}

function syncLoginState() {
  const isLoggedIn = Object.keys(sessionCookies).length > 0;
  document.getElementById("not-logged-in").classList.toggle("hidden", isLoggedIn);
  document.getElementById("send-btn").disabled = !isLoggedIn;
}

function getSessionStorageArea() {
  return chrome.storage.session || chrome.storage.local;
}

async function storageGet(storageArea, keys) {
  return new Promise((resolve) => {
    storageArea.get(keys, (result) => resolve(result));
  });
}

async function storageSet(storageArea, payload) {
  return new Promise((resolve, reject) => {
    storageArea.set(payload, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve();
    });
  });
}

async function persistState() {
  const localPayload = {
    [STORAGE_KEYS.sessions]: limitStoredSessions(chatSessions),
    [STORAGE_KEYS.activeSessionId]: activeSessionId,
    [STORAGE_KEYS.settings]: {
      provider: assistantSettings.provider,
      geminiModel: assistantSettings.geminiModel,
      useOwnKey: assistantSettings.useOwnKey,
      ollamaModel: assistantSettings.ollamaModel,
    },
  };
  const sessionPayload = {
    [STORAGE_KEYS.geminiApiKey]: assistantSettings.geminiApiKey,
  };

  chatSessions = localPayload[STORAGE_KEYS.sessions];

  await Promise.all([
    storageSet(chrome.storage.local, localPayload),
    storageSet(getSessionStorageArea(), sessionPayload),
  ]);
}

function schedulePersist(delay = 250) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistState().catch((error) => {
      console.error("[AulaAssistant] failed to persist extension state:", error);
    });
  }, delay);
}

async function flushPersist() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  await persistState();
}

function hydrateSessions(storedState) {
  chatSessions = Array.isArray(storedState[STORAGE_KEYS.sessions])
    ? storedState[STORAGE_KEYS.sessions].map(normalizeSession).filter(Boolean)
    : [];

  activeSessionId = storedState[STORAGE_KEYS.activeSessionId] || null;

  if (!chatSessions.length) {
    const session = buildEmptySession();
    chatSessions = [session];
    activeSessionId = session.id;
    schedulePersist(0);
    return;
  }

  if (!chatSessions.some((session) => session.id === activeSessionId)) {
    activeSessionId = sortSessionsByRecent(chatSessions)[0].id;
    schedulePersist(0);
  }
}

function hydrateSettings(localState, sessionState) {
  const rawSettings = localState[STORAGE_KEYS.settings] || {};
  const geminiApiKey = normalizeSettingValue(
    sessionState[STORAGE_KEYS.geminiApiKey],
    DEFAULT_SETTINGS.geminiApiKey
  );
  assistantSettings = {
    provider: rawSettings.provider === "ollama" ? "ollama" : DEFAULT_SETTINGS.provider,
    geminiModel: pickAllowedModel(rawSettings.geminiModel, GEMINI_MODELS, DEFAULT_SETTINGS.geminiModel),
    geminiApiKey,
    // Show the key field if the user opted in before, or if a key is already stored.
    useOwnKey: rawSettings.useOwnKey === true || Boolean(geminiApiKey),
    ollamaModel: pickAllowedModel(rawSettings.ollamaModel, OLLAMA_MODELS, DEFAULT_SETTINGS.ollamaModel),
  };
}

function pickAllowedModel(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function normalizeSettingValue(value, fallback) {
  if (typeof value !== "string") return fallback;

  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeSession(session) {
  if (!session || typeof session !== "object") return null;

  const messages = Array.isArray(session.messages)
    ? session.messages
        .filter((message) => message && typeof message.content === "string")
        .map((message) => ({
          id: message.id || buildId("msg"),
          role: message.role === "assistant" ? "assistant" : "user",
          content: message.content,
          createdAt: Number(message.createdAt) || Date.now(),
        }))
    : [];

  const createdAt = Number(session.createdAt) || Date.now();
  const updatedAt = Number(session.updatedAt) || createdAt;

  return {
    id: session.id || buildId("chat"),
    createdAt,
    updatedAt,
    messages,
    title: buildSessionTitle(messages, createdAt),
  };
}

function buildEmptySession() {
  const now = Date.now();
  return {
    id: buildId("chat"),
    title: buildSessionTitle([], now),
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

function buildId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildSessionTitle(messages, fallbackTimestamp) {
  const firstUserMessage = messages.find(
    (message) => message.role === "user" && message.content.trim()
  );

  if (firstUserMessage) {
    const oneLine = firstUserMessage.content.replace(/\s+/g, " ").trim();
    return oneLine.length > 48 ? `${oneLine.slice(0, 48)}...` : oneLine;
  }

  return `Chat ${new Date(fallbackTimestamp).toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function limitStoredSessions(sessions) {
  return sortSessionsByRecent(sessions)
    .slice(0, MAX_STORED_SESSIONS)
    .map(capSessionMessages);
}

function capSessionMessages(session) {
  if (session.messages.length > MAX_MESSAGES_PER_SESSION) {
    session.messages = session.messages.slice(-MAX_MESSAGES_PER_SESSION);
  }
  return session;
}

function sortSessionsByRecent(sessions) {
  return [...sessions].sort((left, right) => right.updatedAt - left.updatedAt);
}

function getActiveSession() {
  return chatSessions.find((session) => session.id === activeSessionId) || null;
}

function renderSessionPicker() {
  const select = document.getElementById("session-select");
  const sessions = sortSessionsByRecent(chatSessions);

  select.innerHTML = "";

  for (const session of sessions) {
    const option = document.createElement("option");
    option.value = session.id;
    option.textContent = session.title;
    option.selected = session.id === activeSessionId;
    select.appendChild(option);
  }
}

function renderSettings() {
  document.getElementById("provider-select").value = assistantSettings.provider;
  document.getElementById("gemini-model").value = assistantSettings.geminiModel;
  document.getElementById("gemini-api-key").value = assistantSettings.geminiApiKey;
  document.getElementById("ollama-model").value = assistantSettings.ollamaModel;
  document.getElementById("use-own-key").checked = assistantSettings.useOwnKey;

  const isGemini = assistantSettings.provider === "gemini";
  document.getElementById("gemini-settings").classList.toggle("hidden", !isGemini);
  document.getElementById("ollama-settings").classList.toggle("hidden", isGemini);
  document.getElementById("api-key-wrap").classList.toggle("hidden", !assistantSettings.useOwnKey);
  document.getElementById("api-key-hint").textContent = chrome.storage.session
    ? "La key escrita acá se guarda sólo mientras el navegador siga abierto."
    : "La key escrita acá se guarda en el navegador para reutilizarla.";
}

function renderMessages() {
  const messagesContainer = document.getElementById("messages");
  const session = getActiveSession();

  messagesContainer.innerHTML = "";

  if (!session || session.messages.length === 0) {
    appendMessage(
      "empty",
      "Empezá un chat nuevo. La conversación va a quedar guardada en este navegador."
    );
    return;
  }

  for (const message of session.messages) {
    appendMessage(message.role, message.content, message.id);
  }

  scrollToBottom();
}

function appendMessage(role, text, messageId = "") {
  const messages = document.getElementById("messages");
  const el = document.createElement("div");
  el.className = `message ${role}`;
  setMessageContent(el, role, text);

  if (messageId) {
    el.dataset.messageId = messageId;
  }

  messages.appendChild(el);
  scrollToBottom();
  return el;
}

// Assistant replies arrive as markdown; render them as HTML. User and system
// messages are rendered as plain text to avoid interpreting their input.
function setMessageContent(el, role, text) {
  if (role === "assistant") {
    el.innerHTML = renderMarkdown(text);
  } else {
    el.textContent = text;
  }
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sanitizeUrl(url) {
  const trimmed = url.trim();
  return /^(https?:|mailto:)/i.test(trimmed) ? trimmed.replace(/"/g, "%22") : null;
}

// Inline formatting: code, bold, italic, links. HTML is escaped first, so the
// only tags that can appear are the ones we emit here. Code spans are split out
// first so emphasis markers inside them are left untouched.
function renderInline(text) {
  return escapeHtml(text)
    .split(/(`[^`]+`)/)
    .map((part) =>
      part.startsWith("`") && part.endsWith("`") && part.length > 1
        ? `<code>${part.slice(1, -1)}</code>`
        : applyEmphasis(part)
    )
    .join("");
}

function applyEmphasis(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/(^|[^\w])_([^_]+)_/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
      const safe = sanitizeUrl(url);
      return safe
        ? `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`
        : label;
    });
}

// Minimal block-level markdown: fenced code, headings, lists, blockquotes,
// paragraphs. Good enough for the assistant's output without a dependency.
function renderMarkdown(src) {
  const lines = String(src).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let listType = null;
  let i = 0;

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  const isBlockStart = (line) =>
    /^```/.test(line) ||
    /^#{1,6}\s/.test(line) ||
    /^>\s?/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line);

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      closeList();
      i++;
      const code = [];
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++; // skip closing fence (or run off the end)
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      closeList();
      out.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
      i++;
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.*)$/);
    if (unordered) {
      if (listType !== "ul") {
        closeList();
        out.push("<ul>");
        listType = "ul";
      }
      out.push(`<li>${renderInline(unordered[1])}</li>`);
      i++;
      continue;
    }

    const ordered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ordered) {
      if (listType !== "ol") {
        closeList();
        out.push("<ol>");
        listType = "ol";
      }
      out.push(`<li>${renderInline(ordered[1])}</li>`);
      i++;
      continue;
    }

    if (line.trim() === "") {
      closeList();
      i++;
      continue;
    }

    closeList();
    const paragraph = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i])) {
      paragraph.push(lines[i++]);
    }
    out.push(`<p>${paragraph.map(renderInline).join("<br>")}</p>`);
  }

  closeList();
  return out.join("");
}

function scrollToBottom() {
  const messages = document.getElementById("messages");
  messages.scrollTop = messages.scrollHeight;
}

function setStatus(text) {
  document.getElementById("status").textContent = text;
}

function handleSessionChange(event) {
  activeSessionId = event.target.value;
  renderSessionPicker();
  renderMessages();
  schedulePersist(0);
}

function handleProviderChange() {
  assistantSettings.provider = document.getElementById("provider-select").value === "ollama"
    ? "ollama"
    : "gemini";
  handleTextSettingsChange();
  renderSettings();
  schedulePersist(0);
}

function handleUseOwnKeyChange() {
  assistantSettings.useOwnKey = document.getElementById("use-own-key").checked;
  renderSettings();
  schedulePersist(0);
}

function handleTextSettingsChange() {
  assistantSettings.geminiModel = pickAllowedModel(
    document.getElementById("gemini-model").value,
    GEMINI_MODELS,
    DEFAULT_SETTINGS.geminiModel
  );
  assistantSettings.geminiApiKey = document.getElementById("gemini-api-key").value.trim();
  assistantSettings.ollamaModel = pickAllowedModel(
    document.getElementById("ollama-model").value,
    OLLAMA_MODELS,
    DEFAULT_SETTINGS.ollamaModel
  );
  schedulePersist();
}

function deleteActiveChat() {
  const session = getActiveSession();
  if (!session) return;

  if (session.messages.length && !confirm("¿Eliminar este chat? No se puede deshacer.")) {
    return;
  }

  chatSessions = chatSessions.filter((item) => item.id !== activeSessionId);

  if (!chatSessions.length) {
    const fresh = buildEmptySession();
    chatSessions = [fresh];
    activeSessionId = fresh.id;
  } else {
    activeSessionId = sortSessionsByRecent(chatSessions)[0].id;
  }

  renderSessionPicker();
  renderMessages();
  setStatus("");
  schedulePersist(0);
}

function createNewChat() {
  const session = buildEmptySession();
  chatSessions = [session, ...chatSessions];
  activeSessionId = session.id;
  renderSessionPicker();
  renderMessages();
  setStatus("");
  document.getElementById("query").focus();
  schedulePersist(0);
}

async function sendQuery() {
  const textarea = document.getElementById("query");
  const query = textarea.value.trim();

  if (!query) return;

  const session = getActiveSession();
  if (!session) return;

  textarea.value = "";
  setStatus("");
  toggleComposerDisabled(true);

  const userMessage = {
    id: buildId("msg"),
    role: "user",
    content: query,
    createdAt: Date.now(),
  };

  const assistantMessage = {
    id: buildId("msg"),
    role: "assistant",
    content: "",
    createdAt: Date.now(),
  };

  session.messages.push(userMessage, assistantMessage);
  session.updatedAt = Date.now();
  session.title = buildSessionTitle(session.messages, session.createdAt);

  renderSessionPicker();

  const shouldRerenderList = session.messages.length === 2;
  if (shouldRerenderList) {
    renderMessages();
  } else {
    appendMessage("user", query, userMessage.id);
    appendMessage("assistant", "", assistantMessage.id);
  }

  const assistantEl = findMessageElement(assistantMessage.id);
  assistantEl?.classList.add("streaming");
  await flushPersist();

  try {
    const res = await fetch(`${BACKEND_URL}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        cookies: sessionCookies,
        datetime: new Date().toLocaleString("es-AR", {
          dateStyle: "full",
          timeStyle: "short",
        }),
        history: buildConversationHistory(session),
        llm: buildLLMRequestPayload(),
      }),
    });

    if (!res.ok) {
      const isServerDown = res.status === 0 || res.status >= 500;
      throw new Error(isServerDown ? "server_down" : "server_error");
    }

    await consumeSSE(res.body, assistantEl, assistantMessage);
  } catch (err) {
    console.error("[AulaAssistant] query failed:", err);
    const isNetworkError = err instanceof TypeError;

    assistantMessage.content =
      isNetworkError || err.message === "server_down"
        ? "No se pudo conectar con el servidor. Asegurate de que el backend y Ollama estén corriendo si elegiste ese motor."
        : "Ocurrió un error al procesar tu consulta. Por favor, intentá de nuevo.";

    if (assistantEl) {
      assistantEl.textContent = assistantMessage.content;
    }
    setStatus("");
  } finally {
    assistantEl?.classList.remove("streaming");
    session.updatedAt = Date.now();
    session.title = buildSessionTitle(session.messages, session.createdAt);
    renderSessionPicker();
    await flushPersist();
    toggleComposerDisabled(false);
  }
}

function buildLLMRequestPayload() {
  if (assistantSettings.provider === "ollama") {
    return {
      provider: "ollama",
      model: assistantSettings.ollamaModel || DEFAULT_SETTINGS.ollamaModel,
    };
  }

  return {
    provider: "gemini",
    model: assistantSettings.geminiModel || DEFAULT_SETTINGS.geminiModel,
    api_key: assistantSettings.useOwnKey ? assistantSettings.geminiApiKey || null : null,
  };
}

function buildConversationHistory(session) {
  return session.messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-(MAX_HISTORY_TURNS * 2 + 2), -2)
    .map(({ role, content }) => ({ role, content }));
}

function findMessageElement(messageId) {
  return document.querySelector(`[data-message-id="${messageId}"]`);
}

function toggleComposerDisabled(disabled) {
  document.getElementById("send-btn").disabled = disabled || !Object.keys(sessionCookies).length;
  document.getElementById("new-chat-btn").disabled = disabled;
  document.getElementById("delete-chat-btn").disabled = disabled;
  document.getElementById("session-select").disabled = disabled;
  document.getElementById("provider-select").disabled = disabled;
  document.getElementById("gemini-model").disabled = disabled;
  document.getElementById("use-own-key").disabled = disabled;
  document.getElementById("gemini-api-key").disabled = disabled;
  document.getElementById("ollama-model").disabled = disabled;
}

/**
 * Parses the SSE stream and updates the assistant message element in real time.
 * Event types: token | tool_start | tool_end | done | error
 */
async function consumeSSE(body, assistantEl, assistantMessage) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "message";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (line === "") {
        currentEvent = "message";
        continue;
      }

      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
        continue;
      }

      if (line.startsWith("data: ")) {
        const raw = line.slice(6).trim();
        handleSSEEvent(currentEvent, raw, assistantEl, assistantMessage);
      }
    }
  }
}

function handleSSEEvent(eventType, raw, assistantEl, assistantMessage) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }

  if (eventType === "token") {
    assistantMessage.content += data.content;
    if (assistantEl) {
      assistantEl.innerHTML = renderMarkdown(assistantMessage.content);
    }
    scrollToBottom();
    schedulePersist();
  } else if (eventType === "tool_start") {
    setStatus(`Buscando: ${friendlyToolName(data.tool)}...`);
  } else if (eventType === "tool_end") {
    setStatus("");
  } else if (eventType === "error") {
    console.error("[AulaAssistant] server error:", data.error);
    const isQuota = data.error && data.error.includes("quota");
    assistantMessage.content = isQuota
      ? "Se alcanzó el límite de consultas por hoy. Por favor, intentá más tarde."
      : data.error || "Ocurrió un error al procesar tu consulta. Por favor, intentá de nuevo.";

    if (assistantEl) {
      assistantEl.textContent = assistantMessage.content;
    }
    schedulePersist(0);
  }
}

function friendlyToolName(name) {
  const map = {
    get_dashboard: "cursos disponibles",
    get_calendar: "calendario",
    get_course: "contenido del curso",
    crawl_url: "aula virtual",
  };
  return map[name] || name;
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch((error) => {
    console.error("[AulaAssistant] failed to initialize extension:", error);
    setStatus("No se pudo inicializar la extensión.");
  });
});
