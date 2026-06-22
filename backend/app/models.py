from typing import Literal

from pydantic import BaseModel, Field


class HistoryMessage(BaseModel):
    role: str   # "user" or "assistant"
    content: str


class LLMConfig(BaseModel):
    provider: Literal["gemini", "ollama"] = "gemini"
    model: str | None = None
    api_key: str | None = None


class QueryRequest(BaseModel):
    query: str
    cookies: dict[str, str]
    datetime: str | None = None
    history: list[HistoryMessage] = Field(default_factory=list)
    llm: LLMConfig = Field(default_factory=LLMConfig)
