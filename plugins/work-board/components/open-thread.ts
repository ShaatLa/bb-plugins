import { useCallback, useEffect } from "react";
import { useBbNavigate, useSdk, useSettings } from "@get-bb/plugin-sdk/app";

type Sdk = ReturnType<typeof useSdk>;
const HUB_ID = "agent-hub";
type HubId = typeof HUB_ID;
let hubCheck: { at: number; hub: Promise<HubId | null> } | null = null;

/** Agent Hub when it is installed and enabled; rechecked at most once a minute. */
function installedHub(sdk: Sdk): Promise<HubId | null> {
  if (!hubCheck || Date.now() - hubCheck.at > 60_000) {
    hubCheck = {
      at: Date.now(),
      hub: sdk.plugins.list().then(
        ({ plugins }) => (plugins.some((plugin) => plugin.id === HUB_ID && plugin.enabled) ? HUB_ID : null),
        () => null,
      ),
    };
  }
  return hubCheck.hub;
}

/**
 * Opens the conversation in the hub plugin. Plugins can only navigate to their own panels, so this clicks
 * an app link inside the plugin root, where bb routes it in place; outside a root it loads the page.
 */
function openInHub(hub: HubId, threadId: string, origin: Element | null) {
  const link = document.createElement("a");
  link.href = `/plugins/${hub}/${hub}?thread=${encodeURIComponent(threadId)}`;
  link.hidden = true;
  (origin ?? document.querySelector('[data-bb-plugin-root][data-bb-plugin="work-board"]') ?? document.body).append(link);
  link.click();
  link.remove();
}

/** Opens a thread in bb chat, or in Agent Hub when the "Open thread links in" setting asks for it and the hub is installed. */
export function useOpenThread(): (threadId: string) => void {
  const navigate = useBbNavigate(), sdk = useSdk();
  const setting = useSettings().values?.openThreadsIn;
  const viaHub = setting === "agent-hub";
  useEffect(() => { if (viaHub) void installedHub(sdk); }, [viaHub, sdk]);
  return useCallback((threadId: string) => {
    if (!viaHub) return navigate.toThread(threadId);
    // The clicked element's plugin root, read before the await below ends the click event.
    const target = window.event?.target;
    const origin = target instanceof Element ? target.closest('[data-bb-plugin-root][data-bb-plugin="work-board"]') : null;
    void installedHub(sdk).then((hub) => hub ? openInHub(hub, threadId, origin) : navigate.toThread(threadId));
  }, [navigate, sdk, viaHub]);
}
