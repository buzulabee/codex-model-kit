// Test-only host, not a replacement for the Codex plugin. No provider credentials.
import {
  AppBridge,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
const iframe = document.querySelector<HTMLIFrameElement>("iframe")!;
let displayMode = "fullscreen";
const fileSyncOnly = new URL(location.href).searchParams.has("fileSyncOnly");
const bridge = new AppBridge(
  null,
  { name: "离线测试宿主", version: "1.0.0" },
  { serverTools: {}, logging: {} },
  {
    hostContext: {
      theme: "light",
      displayMode: "fullscreen",
      availableDisplayModes: ["inline", "fullscreen"],
    },
  },
);
bridge.oncalltool = async (params) => {
  const response = await fetch("/tool", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!response.ok) throw new Error("Fixture bridge failed");
  const result = await response.json();
  if (fileSyncOnly) {
    for (const receipt of [
      result.structuredContent?.catalogReceipt,
      result.structuredContent?.snapshot?.catalogWrite,
    ]) {
      if (receipt?.durability === "synced") receipt.durability = "file_synced";
    }
  }
  return result;
};
bridge.onrequestdisplaymode = async ({ mode }) => {
  displayMode = mode;
  bridge.sendHostContextChange({ displayMode: mode });
  return { mode };
};
bridge.onsizechange = ({ height }) => {
  // Fullscreen hosts constrain the iframe to the visible panel; only inline
  // cards negotiate content height. Otherwise a fixed dialog can be offscreen.
  if (height && displayMode === "inline")
    iframe.style.height = `${Math.max(600, height)}px`;
};
bridge.oninitialized = () => {
  void bridge.sendToolInput({ arguments: {} });
};
(
  globalThis as unknown as { fixtureTheme: (theme: "dark" | "light") => void }
).fixtureTheme = (theme) => {
  bridge.sendHostContextChange({ theme });
  document.documentElement.dataset.theme = theme;
};
await bridge.connect(
  new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!),
);
iframe.src = "/main.html";
