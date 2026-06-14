import json
import re

import httpx
from bs4 import BeautifulSoup

BASE_URL = "https://platdig.unlu.edu.ar"
DASHBOARD_URL = "/escritorio.cgi"
MAX_CONTENT_LENGTH = 8000

# Noise elements that add no readable content
_NOISE_IDS = {"function_bar", "encabezado", "nav", "fondo-negro", "ajax_indicator", "actions"}
_NOISE_TAGS = ["script", "style", "head", "footer", "template"]


async def crawl_page(url: str, cookies: dict[str, str]) -> str:
    if not url.startswith("http"):
        url = BASE_URL + url

    async with httpx.AsyncClient(
        cookies=cookies,
        follow_redirects=True,
        timeout=30.0,
        headers={"User-Agent": "Mozilla/5.0"},
    ) as client:
        response = await client.get(url)

    if response.status_code != 200:
        return f"[No se pudo acceder a {url}: HTTP {response.status_code}]"

    soup = BeautifulSoup(response.text, "html.parser")

    # Remove non-content elements
    for tag in soup(_NOISE_TAGS):
        tag.decompose()
    for noise_id in _NOISE_IDS:
        el = soup.find(id=noise_id)
        if el:
            el.decompose()

    # Extract available section links before removing nav (provides context to LLM)
    nav_links = _extract_nav_links(soup)

    # The platform puts content in <div id="main">, not a <main> tag
    main = (
        soup.find("div", id="main")
        or soup.find("div", id="section")
        or soup.body
    )

    if not main:
        return nav_links

    text = main.get_text(separator="\n", strip=True)
    lines = [line for line in text.splitlines() if line.strip()]
    content = "\n".join(lines)

    if nav_links:
        content = nav_links + "\n\n" + content

    return content[:MAX_CONTENT_LENGTH]


async def get_courses_context(cookies: dict[str, str]) -> str:
    """Fetch the dashboard and return a formatted course list for the system prompt."""
    url = BASE_URL + DASHBOARD_URL
    async with httpx.AsyncClient(
        cookies=cookies,
        follow_redirects=True,
        timeout=30.0,
        headers={"User-Agent": "Mozilla/5.0"},
    ) as client:
        response = await client.get(url)
        response.raise_for_status()

    # Course data lives in JS: items: $A( [{...}, ...] ), page_size:
    match = re.search(r"items: \$A\( (\[.*?\]) \),\s*\n\s*page_size:", response.text, re.DOTALL)
    if not match:
        return ""

    try:
        courses = json.loads(match.group(1))
    except json.JSONDecodeError:
        return ""

    lines = ["Cursos inscriptos del usuario:"]
    for c in courses:
        name = c.get("nombre", "")
        cid = c.get("id", "")
        avance = c.get("avance")
        avance_str = f", avance: {avance}%" if avance is not None else ""
        lines.append(f"  - {name} (id_curso: {cid}{avance_str})")

    return "\n".join(lines)


def _extract_nav_links(soup: BeautifulSoup) -> str:
    """Extract course section links from the sidebar navigation."""
    menu = soup.find("div", id="menu_secciones")
    if not menu:
        return ""

    links = []
    for a in menu.find_all("a", href=True):
        name = a.get_text(strip=True)
        href = str(a["href"])
        if name and not href.startswith("javascript:"):
            links.append(f"  - {name}: {href}")

    if not links:
        return ""

    return "Secciones disponibles:\n" + "\n".join(links)
