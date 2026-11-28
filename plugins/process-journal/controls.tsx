import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import * as Select from "@radix-ui/react-select";
import type { ComponentPropsWithoutRef } from "react";

declare const __BB_PLUGIN_ID__: string | undefined;

type Choice<T extends string> = { value: T; label: string; disabled?: boolean };

export function JournalSelect<T extends string>({ label, value, options, onChange, disabled, className = "" }: {
  label: string; value: T; options: readonly Choice<T>[]; onChange: (value: T) => void; disabled?: boolean; className?: string;
}) {
  const available = options.some(option => option.value === value);
  return <Select.Root value={`choice:${value}`} disabled={disabled} onValueChange={key => {
    const choice = options.find(option => `choice:${option.value}` === key);
    if (choice) onChange(choice.value);
  }}>
    <Select.Trigger aria-label={label} className={`inline-flex h-8 min-w-0 max-w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-sm font-normal text-foreground hover:bg-state-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 ${className}`}>
      <span className="truncate"><Select.Value>{available ? undefined : "Unavailable"}</Select.Value></span>
      <Select.Icon asChild><Icon name="ChevronDown" className="size-3.5 shrink-0 text-muted-foreground" /></Select.Icon>
    </Select.Trigger>
    <Select.Portal>
      <Select.Content position="popper" align="start" sideOffset={4}
        data-bb-portaled-overlay="" data-bb-plugin-root="" data-bb-plugin={typeof __BB_PLUGIN_ID__ === "string" ? __BB_PLUGIN_ID__ : undefined}
        className="z-50 max-h-[var(--radix-select-content-available-height)] min-w-[max(8rem,var(--radix-select-trigger-width))] max-w-[var(--radix-select-content-available-width)] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lift">
        <Select.ScrollUpButton className="flex h-5 items-center justify-center"><Icon name="ChevronUp" className="size-3.5" /></Select.ScrollUpButton>
        <Select.Viewport className="p-1">
          {options.map(option => <Select.Item key={option.value} value={`choice:${option.value}`} disabled={option.disabled}
            className="relative flex min-h-8 cursor-default items-center rounded-sm py-1.5 pl-2.5 pr-8 text-sm outline-none data-highlighted:bg-state-hover data-disabled:opacity-50">
            <Select.ItemText>{option.label}</Select.ItemText>
            <Select.ItemIndicator className="absolute right-2.5 flex items-center">
              <Icon name="Check" className="size-3.5" />
            </Select.ItemIndicator>
          </Select.Item>)}
        </Select.Viewport>
        <Select.ScrollDownButton className="flex h-5 items-center justify-center"><Icon name="ChevronDown" className="size-3.5" /></Select.ScrollDownButton>
      </Select.Content>
    </Select.Portal>
  </Select.Root>;
}

export function JournalCheckbox(props: Omit<ComponentPropsWithoutRef<"input">, "type" | "className">) {
  return <>
    <input {...props} type="checkbox" className="peer sr-only" />
    <span aria-hidden="true"
      className="grid size-4 shrink-0 place-items-center rounded border border-input bg-background text-transparent peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring peer-disabled:opacity-50">
      <Icon name="Check" className="size-3" />
    </span>
  </>;
}
