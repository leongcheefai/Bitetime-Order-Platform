"use client"

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox"

import { cn } from "@/lib/utils"
import { CheckIcon } from "lucide-react"

/**
 * Checkbox — themed to `.cookie-check-badge`.
 * Default size is 16px (size-4). Cookie-card usage passes className="size-[22px]"
 * to match the exact 22px badge size from the CSS.
 */
function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        // .cookie-check-badge — xs radius (4px), 1.5px clay border, white bg
        "peer relative flex size-4 shrink-0 items-center justify-center rounded-xs border-[1.5px] border-clay-border bg-white transition-colors outline-none",
        "after:absolute after:-inset-x-3 after:-inset-y-2",
        "focus-visible:border-oxblood focus-visible:ring-3 focus-visible:ring-oxblood/10",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "group-has-disabled/field:opacity-50",
        "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
        // checked: .cookie-card.selected .cookie-check-badge — oxblood fill
        "data-checked:border-oxblood data-checked:bg-oxblood data-checked:text-cream",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none [&>svg]:size-3.5"
      >
        <CheckIcon />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
