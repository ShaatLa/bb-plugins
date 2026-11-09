// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { StatusIcon, StatusColorDot } from "./status-icon";
afterEach(cleanup);
it.each(["search", "canceled", "done"] as const)("uses the BB theme foreground for monochrome %s icons", icon => {
  const { container } = render(<StatusIcon status="in_review" icon={icon} color="black" />);
  expect((container.querySelector("[data-status-icon]") as SVGElement).style.color).toBe("var(--foreground)");
  if (icon !== "search") expect(container.querySelector("path")?.getAttribute("stroke")).toBe("var(--background)");
});
it("matches monochrome palette dots to the icon while retaining other palette colors and defaults", () => {
  const { container, rerender } = render(<StatusColorDot status="todo" color="black" />);
  expect((container.firstElementChild as HTMLElement).style.color).toBe("var(--foreground)");
  rerender(<StatusIcon status="todo" color="indianred" />);
  expect((container.firstElementChild as SVGElement).style.color).toBe("indianred");
  rerender(<StatusIcon status="todo" color="slategray" />);
  expect((container.firstElementChild as SVGElement).style.color).toBe("darkgray");
  rerender(<StatusIcon status="todo" />);
  expect((container.firstElementChild as SVGElement).style.color).toBe("");
  expect(container.firstElementChild?.classList.contains("text-subtle-foreground")).toBe(true);
});
