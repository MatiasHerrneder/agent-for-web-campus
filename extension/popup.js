const BACKEND_URL = "http://localhost:8000";
const MAX_HISTORY_TURNS = 5; // keep last 5 exchanges (10 messages)

let sessionCookies = {};
let conversationHistory = [];

// On load, fetch the user's session cookies via the background service worker.
async function init() {
  const response = await chrome.runtime.sendMessage({ type: "GET_COOKIES" });
  sessionCookies = response.cookies;

  if (Object.keys(sessionCookies).length === 0) {
    document.getElementById("not-logged-in").classList.remove("hidden");
    document.getElementById("send-btn").disabled = true;
  }
}

async function sendQuery() {
  const textarea = document.getElementById("query");
  const query = textarea.value.trim();
  if (!query) return;

  textarea.value = "";
  setStatus("");

  appendMessage("user", query);

  const assistantEl = appendMessage("assistant", "");
  assistantEl.classList.add("streaming");

  document.getElementById("send-btn").disabled = true;

  try {
    const res = await fetch(`${BACKEND_URL}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        cookies: sessionCookies,
        datetime: new Date().toLocaleString("es-AR", { dateStyle: "full", timeStyle: "short" }),
        history: conversationHistory.slice(-(MAX_HISTORY_TURNS * 2)),
      }),
    });

    if (!res.ok) {
      const isServerDown = res.status === 0 || res.status >= 500;
      throw new Error(isServerDown ? "server_down" : "server_error");
    }

    await consumeSSE(res.body, assistantEl);

    conversationHistory.push({ role: "user", content: query });
    conversationHistory.push({ role: "assistant", content: assistantEl.textContent });
  } catch (err) {
    console.error("[AulaAssistant] query failed:", err);
    const isNetworkError = err instanceof TypeError;
    if (isNetworkError || err.message === "server_down") {
      assistantEl.textContent =
        "No se pudo conectar con el servidor. Asegurate de que el backend esté corriendo.";
    } else {
      assistantEl.textContent =
        "Ocurrió un error al procesar tu consulta. Por favor, intentá de nuevo.";
    }
    setStatus("");
  } finally {
    assistantEl.classList.remove("streaming");
    document.getElementById("send-btn").disabled = false;
  }
}

/**
 * Parses the SSE stream and updates the assistant message element in real time.
 * Event types: token | tool_start | tool_end | done | error
 */
async function consumeSSE(body, assistantEl) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "message";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // last partial line stays in buffer

    for (const line of lines) {
      if (line === "") {
        // blank line = end of event block, reset event type
        currentEvent = "message";
        continue;
      }

      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
        continue;
      }

      if (line.startsWith("data: ")) {
        const raw = line.slice(6).trim();
        handleSSEEvent(currentEvent, raw, assistantEl);
      }
    }
  }
}

function handleSSEEvent(eventType, raw, assistantEl) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }

  if (eventType === "token") {
    assistantEl.textContent += data.content;
    scrollToBottom();
  } else if (eventType === "tool_start") {
    setStatus(`🔍 Buscando: ${friendlyToolName(data.tool)}…`);
  } else if (eventType === "tool_end") {
    setStatus("");
  } else if (eventType === "error") {
    console.error("[AulaAssistant] server error:", data.error);
    const isQuota = data.error && data.error.includes("quota");
    assistantEl.textContent = isQuota
      ? "Se alcanzó el límite de consultas por hoy. Por favor, intentá más tarde."
      : "Ocurrió un error al procesar tu consulta. Por favor, intentá de nuevo.";
  }
}

function appendMessage(role, text) {
  const messages = document.getElementById("messages");
  const el = document.createElement("div");
  el.className = `message ${role}`;
  el.textContent = text;
  messages.appendChild(el);
  scrollToBottom();
  return el;
}

function scrollToBottom() {
  const messages = document.getElementById("messages");
  messages.scrollTop = messages.scrollHeight;
}

function setStatus(text) {
  document.getElementById("status").textContent = text;
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

// Allow Ctrl+Enter / Cmd+Enter to submit
document.addEventListener("DOMContentLoaded", () => {
  init();

  document.getElementById("send-btn").addEventListener("click", sendQuery);

  document.getElementById("query").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      sendQuery();
    }
  });
});
