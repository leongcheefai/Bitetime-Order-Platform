import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  // Base: pill shape, 11px semibold — matches `.order-status-badge` / `.cust-status-badge`
  "group/badge inline-flex h-fit w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-pill border border-transparent px-[9px] py-[3px] text-[11px] font-semibold whitespace-nowrap transition focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-primary/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        // Default: oxblood fill (same as --primary)
        default:
          "bg-primary text-primary-foreground [a]:hover:bg-brand-600",
        secondary:
          "bg-muted text-muted-foreground [a]:hover:bg-ink-200",
        destructive:
          "bg-danger-100 text-danger-fg border-danger-500 [a]:hover:bg-danger-100/80",
        outline:
          "border-border text-foreground [a]:hover:bg-muted",
        ghost:
          "hover:bg-muted hover:text-foreground",
        link:
          "text-primary underline-offset-4 hover:underline",

        // ── Brand status variants (CONTRACT — used by screen tasks 5–16) ──────
        // Maps to `.status-pending` / `.cust-status-received`
        success:
          "bg-success-100 text-success-fg border-success-500",
        // Maps to `.status-confirmed` / `.cust-status-confirmed`
        info:
          "bg-info-100 text-info-fg border-transparent",
        // Blue variant (tracking, etc.)
        infoBlue:
          "bg-info-100 text-info-fg border-transparent",
        // Maps to `.status-preparing` / `.cust-status-preparing`
        prep:
          "bg-info-100 text-info-fg border-transparent",
        // Maps to `.status-ready` / `.cust-status-ready`
        warn:
          "bg-warning-100 text-warning-fg border-transparent",
        // Maps to `.status-completed` — done/taupe
        done:
          "bg-muted text-neutral-fg border-transparent",
        // Maps to `.status-cancelled` / `.cust-status-cancelled`
        danger:
          "bg-danger-100 text-danger-fg border-danger-500",
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
