/**
 * DetailSection — progressive disclosure for long detail content
 * (capabilities, state JSON, descriptions…): the section collapses behind a
 * toggle so the detail view opens with just the one-line summary rows.
 * Closed by default; per-section local state. Shared by the device/agent
 * details (WorldSidebar) and the service detail (ServicesPanel).
 */

import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { Icon } from '../ui/Icon';

export function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="object-detail__section object-detail__collapsible">
      <button
        className="link-button object-detail__toggle"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <Icon icon={open ? ChevronDown : ChevronRight} size={13} /> {title}
      </button>
      {open && <div className="object-detail__collapsible-body">{children}</div>}
    </div>
  );
}
