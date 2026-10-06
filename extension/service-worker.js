// Voxmark — Manifest V3 Background Service Worker

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'QF_TOGGLE' });
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
      await chrome.tabs.sendMessage(tab.id, { type: 'QF_TOGGLE' });
    } catch (err) {
      console.warn('Voxmark: Unable to inject onto restricted tab', err);
    }
  }
});
