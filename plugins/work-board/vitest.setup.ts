import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { configure } from "@testing-library/react";
import { resetTaskDatasetCachesForTest } from "./shell/task-dataset";
import { beforeEach } from "vitest";

if (typeof window !== "undefined") installTestPluginRuntime();

configure({ asyncUtilTimeout: 8_000 });

if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {},
  });
}

if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  });
}

beforeEach(() => {
  // Thread panel routes are remembered per app session; each test starts fresh.
  if (typeof sessionStorage !== "undefined") sessionStorage.clear();
  resetTaskDatasetCachesForTest();
  if (typeof window !== "undefined") window.localStorage.clear();
});
