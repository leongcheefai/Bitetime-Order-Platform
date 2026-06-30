import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

/**
 * Toaster — brand-themed to surface-high, clay border, lg radius, z-toast (500).
 * NOTE: Do NOT wire this into the app here — the existing AppToastContext/Toaster
 * handles app-level toasts. This file is the shadcn primitive; wiring is done
 * separately in the shell (Task 5) if sonner replaces the existing toast system.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info:    <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error:   <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          // Brand surface/border — matches `.notif-panel` floating surface
          "--normal-bg":     "var(--color-surface-high)",
          "--normal-text":   "var(--color-ink)",
          "--normal-border": "var(--color-clay-border)",
          "--border-radius": "var(--radius-lg)",
          // z-toast (500) — above all overlays/modals
          "--z-index":       "var(--z-toast)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
