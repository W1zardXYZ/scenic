import * as React from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

/** How long a toast with an Undo action stays up. */
export const UNDO_MS = 10_000

const Toaster = ({ ...props }: ToasterProps) => {
  // Sonner pauses its timers on hover but not on focus, so focus stands in for the pointer.
  React.useEffect(() => {
    const relay = (type: string) => (event: FocusEvent) => {
      const list = (event.target as Element).closest?.("[data-sonner-toaster]")
      list?.dispatchEvent(new MouseEvent(type, { bubbles: true }))
    }
    const enter = relay("mouseover")
    const leave = relay("mouseout")
    document.addEventListener("focusin", enter)
    document.addEventListener("focusout", leave)
    return () => {
      document.removeEventListener("focusin", enter)
      document.removeEventListener("focusout", leave)
    }
  }, [])
  return (
    <Sonner
      theme="system"
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast pointer-events-auto",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
