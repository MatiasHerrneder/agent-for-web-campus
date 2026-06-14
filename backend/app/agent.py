import os
from datetime import datetime as dt
from zoneinfo import ZoneInfo

from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.tools import tool
from langgraph.prebuilt import create_react_agent
from .crawler import crawl_page, get_courses_context

SYSTEM_PROMPT = """Eres un asistente del Aula Virtual de la Universidad Nacional de Luján (UNLu).
La plataforma es platdig.unlu.edu.ar (Educativa).

Tenés acceso a herramientas para navegar el aula virtual del usuario.
Usá estas herramientas para responder consultas sobre cursos, fechas de exámenes, tareas, foros, etc.

Estructura general de URLs de la plataforma (puede haber más o solo algunas de estas):
- Dashboard / escritorio:  /escritorio.cgi
- Inicio de un curso:      /index.cgi?id_curso=XXXX
- Presentación:            /presentacion.cgi?id_curso=XXXX
- Programa/Contenidos:     /programas.cgi?id_curso=XXXX
- Noticias:                /news.cgi?id_curso=XXXX
- Mail interno:            /webmail.cgi?id_curso=XXXX
- Contactos:               /contactos.cgi?id_curso=XXXX
- Calendario:              /calendario.cgi?id_curso=XXXX
- Calificaciones:          /calificaciones.cgi?id_curso=XXXX
- Archivos:                /archivos.cgi?id_curso=XXXX
- Foros:                   /foros.cgi?id_curso=XXXX
- Anuncios:                /anuncios.cgi?id_curso=XXXX
- FAQs:                    /faqs.cgi?id_curso=XXXX
- Sitios:                  /links.cgi?id_curso=XXXX
- Wikis:                   /wiki.cgi?id_curso=XXXX

Estrategia:
1. Ya tenés la lista de cursos del usuario en este prompt.
2. Identificá los cursos que son relevantes para la consulta. Para consultas generales, priorizá los de ultimo_acceso más reciente.
3. Usá get_course(id_curso) para ver qué secciones tiene ese curso disponibles.
4. Una vez tenés las secciones del curso, navegá directamente a la sección adecuada con crawl_url (ej: /anuncios.cgi?id_curso=XXXX para avisos, /calificaciones.cgi?id_curso=XXXX para exámenes).
5. Si una URL devuelve error, ignorala y continuá con el resto.
6. Crawleá hasta que consideres que podés responder la consulta del usuario con la información obtenida, o en su defecto que no podés responderla.
7. NO generes texto de respuesta mientras estés usando herramientas. Primero ejecutá todas las herramientas necesarias, luego respondé con la información completa.
8. Respondé de forma clara y concisa.

Respondé siempre en español."""


async def create_agent(cookies: dict[str, str], datetime: str | None = None):
    courses_context = await get_courses_context(cookies)
    system_prompt = SYSTEM_PROMPT
    now = datetime or dt.now(ZoneInfo("America/Argentina/Buenos_Aires")).strftime("%A, %d de %B de %Y, %H:%M")
    system_prompt += f"\n\nFecha y hora actual: {now}"
    if courses_context:
        system_prompt += f"\n\n{courses_context}"

    llm = ChatGoogleGenerativeAI(
        model="gemini-2.5-flash",
        google_api_key=os.getenv("GEMINI_API_KEY"),
        streaming=True,
        max_retries=0,
    )

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
