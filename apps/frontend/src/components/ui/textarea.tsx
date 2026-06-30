import * as React from "react"

import { cn } from "@/lib/utils"

// Themed to `.field input` — same raised bg, clay border, md radius, 14px text.
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-md border border-clay-border bg-surface-raised px-[13px] py-2.5 text-[14px] text-ink transition-colors outline-none",
        "placeholder:text-text-tertiary",
        "focus-visible:border-oxblood focus-visible:ring-3 focus-visible:ring-oxblood/10",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
