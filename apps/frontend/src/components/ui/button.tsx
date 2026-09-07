import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  // No font-family here — buttons inherit the one Latin family from `body`. This used to
  // pin 'DM_Sans', which the reskin removed; the declaration survived and quietly resolved
  // to the generic sans-serif on any machine without DM Sans installed, so buttons rendered
  // in Helvetica while every other element rendered in Poppins.
  "group/button inline-flex shrink-0 items-center justify-center gap-2 border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition outline-none select-none cursor-pointer focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:text-disabled-fg disabled:border-transparent aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // .submit-btn / .save-btn / .auth-btn / .voucher-apply-btn — oxblood primary fill
        // Only the FILLED variants take the grey disabled fill. ghost / link / outline /
        // dashed keep their transparent background — a grey slab where a text link used to
        // be reads as broken layout, not as a disabled control.
        default:
          "bg-primary text-primary-foreground hover:bg-brand-600 disabled:bg-disabled-bg",
        // .cust-account-btn / .lang-btn — clay-border outline pill
        outline:
          "border-[0.5px] border-border bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
        // .add-btn / .admin-toggle button — dashed clay border
        dashed:
          "border border-dashed border-border bg-transparent text-muted-foreground hover:border-primary hover:text-primary hover:bg-brand-wash",
        // Generic ghost — no border, subtle hover
        ghost:
          "bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
        // .del-btn — rose-tinted destructive (border-rose, oxblood-tint bg)
        destructive:
          "border border-border bg-brand-wash text-primary hover:bg-ink-200 disabled:bg-disabled-bg",
        // .invoice-btn — white bg / clay-rose text, inverts on hover + self-encodes geometry (use size="none")
        invoice:
          "w-full px-[14px] py-[10px] text-[13px] rounded-sm border border-border bg-white text-muted-foreground font-semibold hover:bg-ink-600 hover:text-white hover:border-ink-600 disabled:bg-disabled-bg",
        // .qty-btn — cream bg, clay border, oxblood text (use size="iconRound")
        soft:
          "border border-border bg-background text-primary hover:bg-muted disabled:bg-disabled-bg",
        /* Text-style link button. Pair with size="none".
           `inline` and `border-0` undo the base's inline-flex + transparent border, which
           would otherwise add 2px of width and break wrapping when the link sits inside a
           sentence. `font-normal` undoes the base's font-medium; a link in running copy
           should weigh the same as the text around it. Colour is NOT forced — these appear
           in primary, muted and foreground across the app — so pass it in className.
           `text-[length:inherit]` undoes the base's text-sm, which is the 16px body floor:
           a link sitting inside 13px copy must not jump to 16px. Caught in the browser
           after the first four conversions -- "Create an account" rendered visibly larger
           than the "New here?" beside it. Pass an explicit text-[Npx] to opt out.
           What the variant is really for is the parts nobody remembers to hand-roll: the
           focus ring and the disabled treatment. */
        link:
          "inline border-0 font-normal text-[length:inherit] underline underline-offset-2 text-primary",
      },
      // ONE corner for every rectangular button: `rounded-lg` (8 px), the radius `default`
      // already used. `md`, `sm` and `icon` each carried the 4 px `rounded-md` instead, so a
      // single pane showed two button radii at once — an 8 px submit above a 4 px Save above
      // a 4 px icon button — which reads as a squarish slab rather than a deliberate scale.
      // Sizes below now vary in DIMENSION only; the exceptions are the two that are round on
      // purpose (`pill`, `iconRound`). Inputs are still 4 px and deliberately not touched
      // here — a control the user types into is not the control they press.
      size: {
        // .submit-btn — full-width, 14 px pad all sides, 15 px text, letter-spacing
        default:
          "w-full p-[14px] text-[15px] rounded-lg tracking-[0.01em] pointer-coarse:min-h-11",
        // .save-btn — full-width, 10 px pad all sides, 14 px text
        // Note: .auth-btn uses padding: 12 px; screens should pass className="py-3" override
        md:
          "w-full p-[10px] text-sm rounded-lg pointer-coarse:min-h-11",
        // .voucher-apply-btn — inline, 18 px H / 10 px V, 14 px text
        // Note: .add-btn uses py-[7px] px-[14px] w-full rounded-sm; screens must override
        sm:
          "px-[18px] py-[10px] text-sm rounded-lg pointer-coarse:min-h-11",
        // .cust-account-btn — pill, 14 px H / 7 px V, 13 px text, pill radius (9999 px = stadium)
        // Note: .lang-btn uses py-[5px] + bg-card; screens must override those
        pill:
          "px-[14px] py-[7px] text-[13px] rounded-pill pointer-coarse:min-h-10",
        // .hamburger-btn / .notif-bell — 36×36 px square (dimension only)
        // Pair with variant="outline" for the hairline border + hover muted-surface appearance
        // Every icon and round button grows to 44px under a coarse pointer, HERE rather than
        // at each call site: the sheet/dialog close, the month steppers, the carousel arrows
        // and the option steppers all forgot to, and each was a 26–36px target under a thumb.
        icon:
          "size-9 rounded-lg pointer-coarse:size-11",
        // .qty-btn / .del-btn — 26×26 px round icon button (dimension only)
        // Pair with variant="soft" for qty-btn; variant="destructive" + className="size-[30px]" for del-btn
        iconRound:
          "size-[26px] rounded-round pointer-coarse:size-11",
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
