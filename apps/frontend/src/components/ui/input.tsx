import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

/**
 * Input — brand-themed to `.field input`.
 *
 * Props:
 *   variant="compact"  →  matches `.product-row input` / `.admin-field input`
 *                         (px-2.5 py-[7px] text-[13px] bg-cream)
 *   (default)          →  `.field input` (px-[13px] py-2.5 text-[14px] bg-surface-raised)
 */
function Input({
  className,
  type,
  variant,
  ...props
}: React.ComponentProps<"input"> & { variant?: "default" | "compact" }) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      data-variant={variant}
      className={cn(
        // .field input — full-width, 13px H-pad, raised bg, clay border, md radius
        "w-full min-w-0 rounded-md border border-clay-border bg-surface-raised px-[13px] py-2.5 text-[14px] text-ink transition-colors outline-none",
        "placeholder:text-text-tertiary",
        "focus-visible:border-oxblood focus-visible:ring-3 focus-visible:ring-oxblood/10",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
        "file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-ink",
        // compact: .product-row input / .admin-field input
        "data-[variant=compact]:px-2.5 data-[variant=compact]:py-[7px] data-[variant=compact]:text-[13px] data-[variant=compact]:bg-cream data-[variant=compact]:rounded-sm",
        className
      )}
      {...props}
    />
  )
}

export { Input }
