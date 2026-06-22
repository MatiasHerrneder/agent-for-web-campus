import json
import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse
from dotenv import load_dotenv

from .agent import create_agent
from .models import QueryRequest

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("aula_agent")

app = FastAPI(title="Aula Virtual Agent")

# Allow requests from the browser extension (chrome-extension://) and localhost
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.post("/query")
async def query(request: QueryRequest):
    """
    Receives a user query + session cookies and streams the agent response via SSE.

    SSE event types:
      - token:      partial LLM output  { content: str }
      - tool_start: agent called a tool { tool: str, input: any }
      - tool_end:   tool returned       { tool: str }
      - done:       stream finished     {}
      - error:      something failed    { error: str }
    """
    logger.info(
        "New query received | provider=%s | model=%s | query=%r",
        request.llm.provider,
        request.llm.model or "default",
        request.query,
    )

    async def event_stream():
        try:
            agent = await create_agent(request.cookies, request.datetime, request.llm)
            messages = [(m.role, m.content) for m in request.history]
            messages.append(("user", request.query))
            async for event in agent.astream_events(
                {"messages": messages},
                version="v2",
            ):
                kind = event["event"]

                if kind == "on_chat_model_stream":
                    chunk = (event.get("data") or {}).get("chunk")
                    if chunk is not None and getattr(chunk, "content", None):
                        yield {
                            "event": "token",
                            "data": json.dumps({"content": chunk.content}),
                        }

                elif kind == "on_tool_start":
                    logger.info("Tool call: %s | input: %s", event["name"], event["data"].get("input", {}))
                    yield {
                        "event": "tool_start",
                        "data": json.dumps({
                            "tool": event["name"],
                            "input": event["data"].get("input", {}),
                        }),
                    }

                elif kind == "on_tool_end":
                    logger.info("Tool done: %s", event["name"])
                    yield {
                        "event": "tool_end",
                        "data": json.dumps({"tool": event["name"]}),
                    }

            logger.info("Query completed: %r", request.query)
            yield {"event": "done", "data": "{}"}

        except Exception as e:
            logger.error("Error processing query %r: %s", request.query, e, exc_info=True)
            yield {
                "event": "error",
                "data": json.dumps({"error": str(e)}),
            }

    return EventSourceResponse(event_stream())


@app.get("/health")
async def health():
    return {"status": "ok"}
