// Service worker: handles privileged APIs (cookies) on behalf of the popup.

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
