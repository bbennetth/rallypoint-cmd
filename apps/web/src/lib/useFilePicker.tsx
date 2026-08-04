import { useRef, type ReactElement } from 'react'

// Hidden-file-input primitive for the panel's two upload surfaces (mod
// .pak/.zip, backup .tar.gz). Adapted from @rallypoint/ui's useFilePicker —
// see apps/web/src/ui/ink/VENDORED.md. It exists to make "one tap opens the
// OS picker" safe to write: the caller owns the button, this owns the input
// and the rules that are easy to get wrong.
//
// Signature differs from upstream's (positional `onPick` + an options bag
// without the image-specific defaults) since the panel never picks images.

export interface FilePicker {
  /**
   * Opens the OS picker.
   *
   * MUST be called synchronously from inside a user-gesture handler. Any
   * `await` or `setTimeout` between the gesture and this call drops
   * Safari's user-activation token and the picker silently never opens.
   */
  open: () => void
  /**
   * Render this ONCE and UNCONDITIONALLY in the component that owns the
   * trigger — never inside a conditional branch. An unmounted input never
   * fires `change`, so the user picks a file and nothing happens.
   */
  input: ReactElement
}

export function useFilePicker(
  onPick: (file: File) => void,
  { accept, ariaLabel = 'Choose a file' }: { accept?: string; ariaLabel?: string } = {},
): FilePicker {
  const ref = useRef<HTMLInputElement | null>(null)

  return {
    open: () => ref.current?.click(),
    input: (
      <input
        ref={ref}
        className="sr-only"
        type="file"
        {...(accept ? { accept } : {})}
        aria-label={ariaLabel}
        onChange={(event) => {
          const next = event.currentTarget.files?.[0] ?? null
          // Browsers suppress `change` for the same path unless the native
          // value is cleared after every selection — reset BEFORE handing
          // off so re-picking the same file still fires, and so an early
          // return in onPick cannot skip the reset.
          event.currentTarget.value = ''
          if (next) onPick(next)
        }}
      />
    ),
  }
}
