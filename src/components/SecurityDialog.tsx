import { useRef, type ReactNode } from 'react'

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'

interface SecurityDialogProps {
  title: string
  onClose: () => void
  children: ReactNode
  className?: string
  backdropClassName?: string
}

export function SecurityIcon() {
  return (
    <svg
      className="security-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3 19 6v5c0 4.6-2.8 8-7 10-4.2-2-7-5.4-7-10V6l7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}

export function SecurityDialog({
  title,
  onClose,
  children,
  className = '',
  backdropClassName = '',
}: SecurityDialogProps) {
  const previouslyFocusedRef = useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (open) return
        const previouslyFocused = previouslyFocusedRef.current
        onClose()
        queueMicrotask(() => previouslyFocused?.focus())
      }}
    >
      <DialogContent
        className={className ? `modal ${className}` : 'modal'}
        overlayClassName={backdropClassName}
      >
        <DialogHeader className="modal-header">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  )
}
