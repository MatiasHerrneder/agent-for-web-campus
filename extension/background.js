// Service worker: handles privileged APIs and side panel behavior.

async function enableSidePanelOnActionClick() {
  if (!chrome.sidePanel?.setPanelBehavior) return;

  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.error("[AulaAssistant] failed to enable side panel:", error);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  enableSidePanelOnActionClick();
});

chrome.runtime.onStartup?.addListener(() => {
  enableSidePanelOnActionClick();
});

enableSidePanelOnActionClick();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_COOKIES") {
    chrome.cookies.getAll({ domain: "platdig.unlu.edu.ar" }, (cookies) => {
      const cookieMap = {};
      cookies.forEach((c) => {
        cookieMap[c.name] = c.value;
      });
      sendResponse({ cookies: cookieMap });
    });
    return true; // keep the channel open for the async response
  }
});
