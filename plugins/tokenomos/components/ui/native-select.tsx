import * as React from "react";

import { cn } from "../../lib/utils";
import { COARSE_POINTER_INPUT_HEIGHT_CLASS, COARSE_POINTER_TEXT_BASE_CLASS } from "./coarse-pointer-sizing.js";
import { CONTROL_HOVER_TRANSITION } from "./motion.js";

/** Native select dressed like the host Input: the host ships no Select for plugins, and a native list stays accessible and mobile-friendly. */
const NativeSelect = React.forwardRef<HTMLSelectElement, React.ComponentProps<"select">>(({ className, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      `h-9 max-w-56 truncate rounded-md border border-input bg-transparent px-2 py-1 text-sm text-foreground ${CONTROL_HOVER_TRANSITION} [&>option]:bg-popover [&>option]:text-popover-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50`,
      COARSE_POINTER_INPUT_HEIGHT_CLASS,
      COARSE_POINTER_TEXT_BASE_CLASS,
      className,
    )}
    {...props}
  />
));
NativeSelect.displayName = "NativeSelect";

export { NativeSelect };
