import { useCallback, useEffect } from "react";
import { useBbNavigate, useSdk, useSettings } from "@get-bb/plugin-sdk/app";

type Sdk = ReturnType<typeof useSdk>;
let answersCheck: { at: number; installed: Promise<boolean> } | null = null;

/** Whether the Answers plugin is installed and enabled; rechecked at most once a minute. */
function answersInstalled(sdk: Sdk): Promise<boolean> {
  if (!answersCheck || Date.now() - answersCheck.at > 60_000) {
    answersCheck = {
      at: Date.now(),
      installed: sdk.plugins.list().then(({ plugins }) => plugins.some((plugin) => plugin.id === "answers" && plugin.enabled), () => false),
    };
  }
  return answersCheck.installed;
}

/**
 * Opens the conversation in Answers. Plugins can only navigate to their own panels, so this clicks
 * an app link inside the plugin root, where bb routes it in place; outside a root it loads the page.
 */
function openInAnswers(threadId: string, origin: Element | null) {
  const link = document.createElement("a");
  link.href = `/plugins/answers/answers?thread=${encodeURIComponent(threadId)}`;
  link.hidden = true;
  (origin ?? document.querySelector('[data-bb-plugin-root][data-bb-plugin="work-board"]') ?? document.body).append(link);
  link.click();
  link.remove();
}

/** Opens a thread in bb chat, or in Answers when the "Open thread links in" setting asks for it and Answers is installed. */
export function useOpenThread(): (threadId: string) => void {
  const navigate = useBbNavigate(), sdk = useSdk();
  const viaAnswers = useSettings().values?.openThreadsIn === "answers";
  useEffect(() => { if (viaAnswers) void answersInstalled(sdk); }, [viaAnswers, sdk]);
  return useCallback((threadId: string) => {
    if (!viaAnswers) return navigate.toThread(threadId);
    // The clicked element's plugin root, read before the await below ends the click event.
    const target = window.event?.target;
    const origin = target instanceof Element ? target.closest("[data-bb-plugin-root]") : null;
    void answersInstalled(sdk).then((installed) => installed ? openInAnswers(threadId, origin) : navigate.toThread(threadId));
  }, [navigate, sdk, viaAnswers]);
}
