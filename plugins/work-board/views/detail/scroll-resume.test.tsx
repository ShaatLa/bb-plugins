// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it } from "vitest";
import { useTaskScrollResume } from "./scroll-resume.js";

afterEach(() => { cleanup(); window.sessionStorage.clear(); });

function Page({ taskKey, height }: { taskKey: string; height: { value: number } }) {
  const ref = useRef<HTMLDivElement>(null);
  useTaskScrollResume(ref, taskKey);
  return (
    <div
      data-testid="scroller"
      ref={(el) => {
        ref.current = el;
        if (el && !Object.getOwnPropertyDescriptor(el, "scrollHeight")) {
          Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => height.value });
          Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 500 });
        }
      }}
    />
  );
}

const frame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

it("returns to a task's scroll offset once its content has grown, and starts other tasks at the top", async () => {
  const height = { value: 3000 };
  const first = render(<Page taskKey="TSK-4" height={height} />);
  const el = first.getByTestId("scroller");
  el.scrollTop = 1200;
  el.dispatchEvent(new Event("scroll"));
  first.unmount();

  height.value = 600; // comments not loaded yet
  const again = render(<Page taskKey="TSK-4" height={height} />);
  const resumed = again.getByTestId("scroller");
  expect(resumed.scrollTop).toBe(100);
  height.value = 3000;
  await frame();
  expect(resumed.scrollTop).toBe(1200);

  again.rerender(<Page taskKey="TSK-5" height={height} />);
  expect(resumed.scrollTop).toBe(0);
});

it("stops restoring when the user scrolls first", async () => {
  const height = { value: 3000 };
  const first = render(<Page taskKey="TSK-4" height={height} />);
  const el = first.getByTestId("scroller");
  el.scrollTop = 1200;
  el.dispatchEvent(new Event("scroll"));
  first.unmount();

  height.value = 600;
  const again = render(<Page taskKey="TSK-4" height={height} />);
  const resumed = again.getByTestId("scroller");
  resumed.dispatchEvent(new Event("wheel"));
  height.value = 3000;
  await frame();
  expect(resumed.scrollTop).toBe(100);
});
