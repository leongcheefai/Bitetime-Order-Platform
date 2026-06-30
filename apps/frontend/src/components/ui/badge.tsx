import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  // Base: pill shape, 11px semibold — matches `.order-status-badge` / `.cust-status-badge`
  "group/badge inline-flex h-fit w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-pill border border-transparent px-[9px] py-[3px] text-[11px] font-semibold whitespace-nowrap transition-all focus-visible:border-oxblood focus-visible:ring-[3px] focus-visible:ring-oxblood/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        // Default: oxblood fill (same as --primary)
        default:
          "bg-oxblood text-cream [a]:hover:bg-oxblood-deep",
        secondary:
          "bg-surface-sunken text-rose-muted [a]:hover:bg-surface-sunken-hover",
        destructive:
          "bg-danger-bg text-danger-fg border-danger-border [a]:hover:bg-danger-bg/80",
        outline:
          "border-clay-border text-ink [a]:hover:bg-surface-sunken",
        ghost:
          "hover:bg-surface-sunken hover:text-ink",
        link:
          "text-oxblood underline-offset-4 hover:underline",

        // ── Brand status variants (CONTRACT — used by screen tasks 5–16) ──────
        // Maps to `.status-pending` / `.cust-status-received`
        success:
          "bg-success-bg text-success-fg border-success-border",
        // Maps to `.status-confirmed` / `.cust-status-confirmed`
        info:
          "bg-info-bg text-info-fg border-transparent",
        // Blue variant (tracking, etc.)
        infoBlue:
          "bg-info-blue-bg text-info-blue-fg border-transparent",
        // Maps to `.status-preparing` / `.cust-status-preparing`
        prep:
          "bg-prep-bg text-prep-fg border-transparent",
        // Maps to `.status-ready` / `.cust-status-ready`
        warn:
          "bg-warn-bg text-warn-fg border-transparent",
        // Maps to `.status-completed` — done/taupe
        done:
          "bg-surface-sunken text-status-done-fg border-transparent",
        // Maps to `.status-cancelled` / `.cust-status-cancelled`
        danger:
          "bg-danger-bg text-danger-fg border-danger-border",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
