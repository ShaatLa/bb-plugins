import type { ComponentPropsWithoutRef } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";

/**
 * An http(s) link that bb opens through `openUrl`, which honours the user's
 * built-in browser preference; the SDK UrlLink was observed to bypass it.
 * Modified clicks keep normal anchor behaviour.
 */
export function BbLink({ href, onClick, ...props }: Omit<ComponentPropsWithoutRef<"a">, "href"> & { href: string }) {
  const navigate = useBbNavigate();
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (navigate.openUrl(href)) event.preventDefault();
      }}
    />
  );
}
