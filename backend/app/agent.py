import os
from datetime import datetime as dt
from zoneinfo import ZoneInfo

from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_ollama import ChatOllama
from langchain_core.tools import tool
from langgraph.prebuilt import create_react_agent

from .crawler import crawl_page, get_courses_context
from .models import LLMConfig

SYSTEM_PROMPT = """Eres un asistente del Aula Virtual de la Universidad Nacional de Luján (UNLu).
La plataforma es platdig.unlu.edu.ar (Educativa).

Tenés acceso a herramientas para navegar el aula virtual del usuario.
Usá estas herramientas para responder consultas sobre cursos, fechas de exámenes, tareas, foros, etc.

Secciones de la plataforma (un curso puede tener todas, algunas o ninguna).
Formato: sección | URL | qué consultar ahí.
- Escritorio      | /escritorio.cgi                  | todos los cursos del usuario.
- Inicio curso    | /index.cgi?id_curso=XXXX         | portada del curso; información general (leer siempre que exista).
- Presentación    | /presentacion.cgi?id_curso=XXXX  | descripción del curso, docentes, metodología (leer siempre que exista).
- Programa        | /programas.cgi?id_curso=XXXX     | contenidos, unidades temáticas, bibliografía (leer siempre que exista).
- Noticias        | /news.cgi?id_curso=XXXX          | novedades y avisos generales del curso (leer siempre que exista).
- Mail interno    | /webmail.cgi?id_curso=XXXX       | mensajería interna del aula (leer siempre que exista).
- Contactos       | /contactos.cgi?id_curso=XXXX     | datos de docentes y compañeros.
- Calendario      | /calendario.cgi?id_curso=XXXX    | fechas: clases, entregas, exámenes, eventos (no siempre los usuarios lo completan).
- Calificaciones  | /calificaciones.cgi?id_curso=XXXX| notas, exámenes rendidos, devoluciones.
- Archivos        | /archivos.cgi?id_curso=XXXX      | material de estudio descargable (apuntes, PDFs, prácticos).
- Foros           | /foros.cgi?id_curso=XXXX         | debates, consultas y discusiones entre alumnos/docentes.
- Anuncios        | /anuncios.cgi?id_curso=XXXX      | avisos importantes y comunicados del docente.
- FAQs            | /faqs.cgi?id_curso=XXXX          | preguntas frecuentes del curso.
- Sitios          | /links.cgi?id_curso=XXXX         | enlaces externos recomendados.
- Wikis           | /wiki.cgi?id_curso=XXXX          | páginas colaborativas del curso.

En muchos casos, la información no está completa en la sección que debería estar y se agrupa en las secciones de Inicio, Presentación, Programa, Noticias y Anuncios, SIEMPRE revisarlas antes de responder.

Estrategia:
1. Tenés a continuación la lista de cursos del usuario en este prompt.
2. Identificá los cursos que son relevantes para la consulta. Para consultas generales, priorizá los de ultimo_acceso más reciente.
3. Usá get_course(id_curso) para ver qué secciones tiene ese curso disponibles.
4. Una vez tenés las secciones del curso, navegá a las secciónes adecuadas con crawl_url para realizar la búsqueda de la información solicitada (ej: /anuncios.cgi?id_curso=XXXX para avisos, /calificaciones.cgi?id_curso=XXXX para exámenes).
5. Si una URL devuelve error, ignorala y continuá con el resto.
6. Accedé a links dentro de las secciones que vas crawleando en tanto sean útiles para responder la consulta del usuario.
7. Crawleá secciones hasta que consideres que podés responder correctamente la consulta del usuario con la información obtenida.
8. NO generes texto de respuesta mientras estés usando herramientas. Primero ejecutá todas las herramientas necesarias, luego respondé con la información completa.
9. Respondé de forma clara y concisa.

Respondé siempre en español."""

DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"
DEFAULT_OLLAMA_MODEL = "qwen2.5"
DEFAULT_OLLAMA_BASE_URL = "http://ollama:11434"


async def create_agent(
    cookies: dict[str, str],
    datetime: str | None = None,
    llm_config: LLMConfig | None = None,
):
    courses_context = await get_courses_context(cookies)
    system_prompt = SYSTEM_PROMPT
    now = datetime or dt.now(ZoneInfo("America/Argentina/Buenos_Aires")).strftime("%A, %d de %B de %Y, %H:%M")
    system_prompt += f"\n\nFecha y hora actual: {now}"
    if courses_context:
        system_prompt += f"\n\n{courses_context}"

    llm = build_llm(llm_config)

    @tool
    async def get_course(id_curso: str) -> str:
        """Obtiene la página de inicio de un curso. Muestra las secciones disponibles.
        Parámetro: id_curso, ej: '9563'"""
        return await crawl_page(f"/index.cgi?id_curso={id_curso}", cookies)

    @tool
    async def crawl_url(url: str) -> str:
        """Navega a cualquier URL relativa del aula virtual para obtener información.
        Parámetro: URL relativa, ej: /programas.cgi?id_curso=9563"""
        return await crawl_page(url, cookies)

    return create_react_agent(
        llm,
        tools=[get_course, crawl_url],
        state_modifier=system_prompt,
    )


def build_llm(llm_config: LLMConfig | None):
    llm_config = llm_config or LLMConfig()

    if llm_config.provider == "gemini":
        api_key = first_non_empty(llm_config.api_key, os.getenv("GEMINI_API_KEY"))
        if not api_key:
            raise ValueError(
                "No hay una API key de Gemini configurada. Cargala en la extensión o definí GEMINI_API_KEY en el backend."
            )

        return ChatGoogleGenerativeAI(
            model=first_non_empty(llm_config.model, os.getenv("GEMINI_MODEL"), DEFAULT_GEMINI_MODEL),
            google_api_key=api_key,
            streaming=True,
            max_retries=0,
        )

    if llm_config.provider == "ollama":
        # keep_alive controls how long Ollama keeps the model in VRAM after a
        # request. Models are loaded on demand per request, so only the model
        # actually being used occupies memory; combined with
        # OLLAMA_MAX_LOADED_MODELS=1 on the server, at most one is ever loaded.
        return ChatOllama(
            model=first_non_empty(llm_config.model, os.getenv("OLLAMA_MODEL"), DEFAULT_OLLAMA_MODEL) or DEFAULT_OLLAMA_MODEL,
            base_url=os.getenv("OLLAMA_BASE_URL", DEFAULT_OLLAMA_BASE_URL),
            temperature=0,
            keep_alive=os.getenv("OLLAMA_KEEP_ALIVE", "5m"),
            reasoning=False,
        )

    raise ValueError(f"Proveedor de LLM no soportado: {llm_config.provider}")


def first_non_empty(*values: str | None) -> str | None:
    for value in values:
        if value is None:
            continue

        normalized = value.strip()
        if normalized:
            return normalized

    return None
