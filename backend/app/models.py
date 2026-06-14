from pydantic import BaseModel


class HistoryMessage(BaseModel):
    role: str   # "user" or "assistant"
    content: str


class QueryRequest(BaseModel):
    query: str
    cookies: dict[str, str]
    datetime: str | None = None
    history: list[HistoryMessage] = []
