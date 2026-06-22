# AI agent for online campus

## Project structure
```text
root/
├── docker-compose.yml
├── backend/
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── .env.example
│   └── app/
│       ├── main.py
│       ├── agent.py
│       ├── crawler.py
│       └── models.py
└── extension/
    ├── manifest.json
    ├── background.js
    ├── popup.html / .css / .js
    └── icons/
```

## LLM modes
The extension can now send the LLM configuration with each request:

- `Gemini`: the user can load a Gemini API key from the extension UI. If it is left empty, the backend falls back to `GEMINI_API_KEY`.
- `Ollama`: the backend routes the request to the Ollama service from `docker-compose`.

The extension persists chats and provider preferences locally in the browser. The Gemini API key entered from the extension is stored only for the current browser session when `chrome.storage.session` is available.

## Environment
Copy the example file:

```bash
cp backend/.env.example backend/.env
```

Available variables:

```dotenv
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
OLLAMA_BASE_URL=http://ollama:11434
OLLAMA_MODEL=llama3.1
```

`GEMINI_API_KEY` is optional if you plan to provide the key from the extension.

## Run the stack
Start backend plus Ollama:

```bash
docker compose up --build
```

Notes:

- The `ollama` service exposes port `11434`.
- The `ollama-pull` service downloads the model configured in `backend/.env` through `OLLAMA_MODEL`, or `llama3.1` if that variable is empty.
- The first startup can take a while because the model download is large.

## Load the extension
1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose `Load unpacked`.
4. Select the `extension/` folder.

When you click the extension icon, Chrome opens the side panel. From there you can:

- switch between `Gemini` and `Ollama`
- set the Gemini model and optionally a Gemini API key
- set the Ollama model name
- keep and reopen previous chats from local browser storage

## Streaming
`POST /query` returns an SSE stream. The backend forwards LangGraph events as:

- `token`
- `tool_start`
- `tool_end`
- `done`
- `error`

The extension consumes that stream with `fetch + ReadableStream`.

## Cookies
The extension uses the `cookies` permission and reads the user session from `platdig.unlu.edu.ar` through the background service worker. Those cookies are sent to the backend with each request so the crawler can navigate the authenticated campus pages.
