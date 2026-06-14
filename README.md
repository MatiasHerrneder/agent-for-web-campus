# AI agent for online campus

## Project structure
```
root/
├── docker-compose.yml
├── backend/
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── .env.example          ← copy to .env and add GEMINI_API_KEY
│   └── app/
│       ├── main.py           ← FastAPI + SSE endpoint POST /query
│       ├── agent.py          ← LangGraph ReAct agent with 4 crawling tools
│       ├── crawler.py        ← httpx + BeautifulSoup page fetcher
│       └── models.py         ← QueryRequest { query, cookies }
└── extension/
    ├── manifest.json         ← MV3, requests cookies permission
    ├── background.js         ← service worker, reads chrome.cookies
    ├── popup.html / .css / .js
```

## Running the project
### 1. Set up env
```bash
cp backend/.env.example backend/.env
```
### edit backend/.env 
```
GEMINI_API_KEY=...
```
### 2. Start backend
```bash
docker compose up --build
```
### 3. Load extension in Chrome
Go to chrome://extensions → Enable Developer mode → Load unpacked → select extension/

(You'll need to add placeholder PNGs to extension/icons/ first)


## How streaming works
POST /query returns an SSE stream. The backend pipes astream_events from LangGraph, emitting:

* token — each LLM output chunk (user sees text appearing progressively)
* tool_start / tool_end — while the agent is crawling (shows "🔍 Buscando...")
* done / error

The extension uses fetch + ReadableStream (not EventSource, which only supports GET) to consume this stream.


## How session cookies work
The extension declares "permissions": ["cookies"] and "host_permissions": ["https://platdig.unlu.edu.ar/*"]. The popup asks the background service worker for chrome.cookies.getAll(...), which returns all cookies including HttpOnly ones (accessible to extensions, not to document.cookie). Those cookies are sent to the backend with each request, which uses them with httpx to crawl authenticated pages
