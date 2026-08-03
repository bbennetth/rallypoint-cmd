import { useState, type ReactNode } from 'react'
import { Dialog } from './Dialog.js'
import { Button, Spinner } from './primitives.js'

// Destructive-action confirm, replacing the three native confirm() calls
// (delete backup, delete mod, delete schedule). A native confirm blocks
// the event loop, cannot be styled, and on mobile renders as a browser
// chrome sheet that looks nothing like the panel.

export function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Delete',
  onConfirm,
  onCancel,
}: {
  title: ReactNode
  body: ReactNode
  confirmLabel?: string
  /** Awaited — the dialog stays up, disabled, until it settles. */
  onConfirm: () => void | Promise<void>
  onCancel: () => void
}) {
  const [busy, setBusy] = useState(false)

  async function confirm() {
    setBusy(true)
    try {
      await onConfirm()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={title}
      onClose={busy ? () => {} : onCancel}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void confirm()} disabled={busy}>
            {busy ? <Spinner /> : null} {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="cmd-dialog-body">{body}</p>
    </Dialog>
  )
}
