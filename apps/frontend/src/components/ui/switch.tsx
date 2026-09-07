"use client"

import { Switch as SwitchPrimitive } from "@base-ui/react/switch"

import { cn } from "@/lib/utils"

/**
 * Switch — the on/off toggle. Extracted from two identical hand-rolled `role="switch"` buttons
 * (the product's "visible in storefront" and the voucher's "active at checkout"), which had the
 * same 44×24 track, the same thumb travel and the same class string, copied verbatim.
 *
 * Base UI owns the role, `aria-checked`, Space/Enter and the disabled state; this file owns the
 * look: accent track when on, hairline-grey track when off, a white thumb on `--elev-1`, and the
 * app's focus ring. 44×24 is the visual size; the `after:` pseudo pads the hit area to 44px tall
 * under a thumb without moving anything on screen.
 */
function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer relative inline-flex h-6 w-11 shrink-0 items-center rounded-pill bg-border transition-colors outline-none cursor-pointer",
        "after:absolute after:-inset-y-2.5 after:-inset-x-1",
        "focus-visible:ring-3 focus-visible:ring-primary/20",
        "data-checked:bg-primary",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none inline-block size-5 rounded-pill bg-white shadow-elev-1 transition-transform translate-x-0.5 data-checked:translate-x-[22px]"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
