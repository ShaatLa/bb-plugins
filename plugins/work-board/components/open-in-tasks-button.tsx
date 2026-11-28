import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { PANEL_PATH } from "../shell/routes.js";

/** The arrow icon that opens a location in the main Tasks area, from a side panel. */
export function OpenInTasksButton({
  label,
  subPath,
}: {
  label: string;
  subPath?: string;
}) {
  const navigate = useBbNavigate();
  return (
    <Button
      className="size-6 shrink-0"
      size="icon"
      variant="ghost"
      aria-label={label}
      onClick={() =>
        navigate.toPluginPanel(
          PANEL_PATH,
          subPath === undefined ? {} : { subPath },
        )
      }
    >
      <Icon name="ArrowUpRight" className="size-4" />
    </Button>
  );
}
