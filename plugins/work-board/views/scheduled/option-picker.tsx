import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";

export interface PickerOption<Value extends string> {
  value: Value;
  label: string;
  hint?: string;
}

/** Searchable single-choice dropdown built from the house popover + command list. */
export function OptionPicker<Value extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  className,
  placeholder,
}: {
  label: string;
  value: Value | null;
  options: ReadonlyArray<PickerOption<Value>>;
  onChange: (value: Value) => void;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={label}
          disabled={disabled}
          className={cn("h-8 w-full justify-between gap-1.5 border-input px-2 text-xs font-normal", className)}
        >
          <span className={cn("truncate", !selected && "text-muted-foreground")}>{selected?.label ?? placeholder ?? label}</span>
          <Icon name="ChevronDown" className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder={`Search ${label.toLowerCase()}…`} />
          <CommandList>
            <CommandEmpty>No matching options.</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  keywords={[option.label, option.hint ?? ""]}
                  onSelect={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.hint ? <span className="shrink-0 text-xs text-muted-foreground">{option.hint}</span> : null}
                  {option.value === value ? <Icon name="Check" className="size-3.5" /> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
