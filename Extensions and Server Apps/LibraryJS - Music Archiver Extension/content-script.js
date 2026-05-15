
(() => {
  const PAGE_SOURCE = "UD_PAGE";
  const EXT_SOURCE = "UD_EXT";
  const REQUEST_TYPE = "UD_PROXY_REQUEST";
  const DOWNLOAD_TYPE = "UD_PROXY_DOWNLOAD";
  const FLOW_TRANSFER_TYPE = "UD_FLOW_TRANSFER";
  const FLOW_READY_TYPE = "UD_FLOW_READY";
  const ACTIVITY_STATE_TYPE = "UD_ACTIVITY_STATE";
  const SETTINGS_UPDATE_TYPE = "UD_SETTINGS_UPDATE";

  function postToPage(message) {
    window.postMessage(message, "*");
  }

  async function requestFlowPayload() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: FLOW_READY_TYPE,
        payload: {
          pageUrl: location.href
        }
      });

      if (response && response.ok && response.payload) {
        postToPage({
          source: EXT_SOURCE,
          type: "UD_FLOW_IMPORT",
          payload: response.payload
        });
      }
    } catch (error) {
      postToPage({
        source: EXT_SOURCE,
        type: "UD_FLOW_IMPORT_ERROR",
        payload: {
          ok: false,
          error: error?.message || String(error)
        }
      });
    }
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== PAGE_SOURCE) return;
    if (data.type !== REQUEST_TYPE && data.type !== DOWNLOAD_TYPE && data.type !== FLOW_TRANSFER_TYPE && data.type !== ACTIVITY_STATE_TYPE && data.type !== SETTINGS_UPDATE_TYPE) return;

    try {
      const response = await chrome.runtime.sendMessage({
        type: data.type,
        payload: data.payload
      });

      postToPage({
        source: EXT_SOURCE,
        type:
          data.type === DOWNLOAD_TYPE
            ? "UD_PROXY_DOWNLOAD_RESPONSE"
            : data.type === FLOW_TRANSFER_TYPE
              ? "UD_FLOW_TRANSFER_RESPONSE"
              : data.type === ACTIVITY_STATE_TYPE
                ? "UD_ACTIVITY_STATE_RESPONSE"
                : "UD_PROXY_RESPONSE",
        requestId: data.requestId,
        response
      });
    } catch (error) {
      postToPage({
        source: EXT_SOURCE,
        type:
          data.type === DOWNLOAD_TYPE
            ? "UD_PROXY_DOWNLOAD_RESPONSE"
            : data.type === FLOW_TRANSFER_TYPE
              ? "UD_FLOW_TRANSFER_RESPONSE"
              : data.type === ACTIVITY_STATE_TYPE
                ? "UD_ACTIVITY_STATE_RESPONSE"
                : "UD_PROXY_RESPONSE",
        requestId: data.requestId,
        response: {
          ok: false,
          error: error?.message || String(error)
        }
      });
    }
  });

  window.addEventListener("load", () => {
    try {
      const params = new URLSearchParams(location.search || "");
      if (params.get("flow") === "1") {
        requestFlowPayload();
      }
    } catch {
      // ignore
    }
  });
})();
