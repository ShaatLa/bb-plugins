// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CompactViewportOverrideProvider } from "./hooks/use-compact-viewport.js";
import { Dialog, DialogContent, DialogScope, DialogTitle } from "./dialog.js";

afterEach(cleanup);
it("portals compact dialogs into their owning scope", () => {
  const { container } = render(<CompactViewportOverrideProvider isCompactViewport><DialogScope><Dialog open><DialogContent><DialogTitle>Scoped</DialogTitle></DialogContent></Dialog></DialogScope></CompactViewportOverrideProvider>);
  expect(screen.getByRole("dialog").parentElement).toBe(container.querySelector("[data-dialog-scope]"));
});
