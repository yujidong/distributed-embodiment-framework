/**
 * FilePickButton — R2-UX-22a: native `<input type="file">` renders its
 * trigger text in the BROWSER locale ("Choose File / 选择文件" mixed into a
 * zh-CN UI). This wraps it: a visually hidden input + a localized trigger
 * button + the picked file's name (or a localized empty note).
 */

import { useRef } from 'react';

export interface FilePickButtonProps {
  /** Trigger button text (localized by the caller). */
  label: string;
  /** Empty-state note shown where the file name will appear. */
  emptyLabel: string;
  accept: string;
  /** Picked file label to display; null/undefined → emptyLabel. */
  pickedName?: string | null;
  /** aria-label for the hidden input (the FIELD's label, for a11y/tests). */
  inputAriaLabel?: string;
  disabled?: boolean;
  onPick: (file: File | undefined) => void;
}

export function FilePickButton({
  label,
  emptyLabel,
  accept,
  pickedName = null,
  inputAriaLabel,
  disabled = false,
  onPick,
}: FilePickButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="file-pick">
      <button
        type="button"
        className="file-pick__button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        {label}
      </button>
      <span className="file-pick__name">{pickedName ?? emptyLabel}</span>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="file-pick__input"
        aria-label={inputAriaLabel ?? label}
        onChange={event => {
          onPick(event.currentTarget.files?.[0]);
          // Re-picking the same file must fire onChange again.
          event.currentTarget.value = '';
        }}
      />
    </div>
  );
}
