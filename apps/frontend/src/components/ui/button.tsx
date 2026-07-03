import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center gap-2 border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap [font-family:'DM_Sans',sans-serif] transition-all outline-none select-none cursor-pointer focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // .submit-btn / .save-btn / .auth-btn / .voucher-apply-btn — oxblood primary fill
        default:
          "bg-oxblood text-cream hover:bg-oxblood-deep",
        // .cust-account-btn / .lang-btn — clay-border outline pill
        outline:
          "border-[1.5px] border-clay-border bg-transparent text-rose-muted hover:bg-surface-sunken hover:text-ink",
        // .add-btn / .admin-toggle button — dashed clay border
        dashed:
          "border border-dashed border-clay-border bg-transparent text-rose-muted hover:border-oxblood hover:text-oxblood hover:bg-oxblood-tint",
        // Generic ghost — no border, subtle hover
        ghost:
          "bg-transparent text-rose-muted hover:bg-surface-sunken hover:text-ink",
        // .del-btn — rose-tinted destructive (border-rose, oxblood-tint bg)
        destructive:
          "border border-rose-border bg-oxblood-tint text-oxblood hover:bg-rose-hover",
        // .invoice-btn — white bg / clay-rose text, inverts on hover + self-encodes geometry (use size="none")
        invoice:
          "w-full px-[14px] py-[10px] text-[13px] rounded-sm border border-rose-border bg-white text-clay-rose font-semibold hover:bg-clay-rose hover:text-white hover:border-clay-rose",
        // .qty-btn — cream bg, clay border, oxblood text (use size="iconRound")
        soft:
          "border border-clay-border bg-cream text-oxblood hover:bg-surface-warm-alt",
        // Text-style link button
        link:
          "text-oxblood underline-offset-4 hover:underline",
      },
      size: {
        // .submit-btn — full-width, 14 px pad all sides, 15 px text, lg radius (12 px), letter-spacing
        default:
          "w-full p-[14px] text-[15px] rounded-lg tracking-[0.01em] pointer-coarse:min-h-11",
        // .save-btn — full-width, 10 px pad all sides, 14 px text, md radius (10 px)
        // Note: .auth-btn uses padding: 12 px; screens should pass className="py-3" override
        md:
          "w-full p-[10px] text-sm rounded-md pointer-coarse:min-h-11",
        // .voucher-apply-btn — inline, 18 px H / 10 px V, 14 px text, md radius
        // Note: .add-btn uses py-[7px] px-[14px] w-full rounded-sm; screens must override
        sm:
          "px-[18px] py-[10px] text-sm rounded-md",
        // .cust-account-btn — pill, 14 px H / 7 px V, 13 px text, pill radius (20 px)
        // Note: .lang-btn uses py-[5px] + bg-surface-raised; screens must override those
        pill:
          "px-[14px] py-[7px] text-[13px] rounded-pill",
        // .hamburger-btn / .notif-bell — 36×36 px square, md radius (dimension only)
        // Pair with variant="outline" for the 1.5px clay border + hover surface-sunken appearance
        icon:
          "size-9 rounded-md",
        // .qty-btn / .del-btn — 26×26 px round icon button (dimension only)
        // Pair with variant="soft" for qty-btn; variant="destructive" + className="size-[30px]" for del-btn
        iconRound:
          "size-[26px] rounded-round",
        // Geometry-neutral: suppresses defaultVariants.size so variant="invoice" controls all geometry
        none:
          "",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
