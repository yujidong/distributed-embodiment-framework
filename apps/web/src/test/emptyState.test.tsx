/**
 * UX-W1 EmptyState tests — icon slot, title + description, optional CTA
 * button, and the compact variant class.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Inbox } from 'lucide-react';

import { EmptyState } from '../components/ui/EmptyState';

afterEach(cleanup);

describe('EmptyState', () => {
  it('renders title + description and the icon slot', () => {
    const { container } = render(
      <EmptyState icon={Inbox} title="No notifications" description="You're all caught up." />,
    );
    screen.getByText('No notifications');
    screen.getByText("You're all caught up.");
    expect(container.querySelector('.empty-state__icon')).not.toBeNull();
  });

  it('renders the CTA button and wires its onClick', () => {
    const onClick = vi.fn();
    render(<EmptyState title="Nothing here" action={{ label: 'Create one', onClick }} />);
    screen.getByRole('button', { name: 'Create one' }).click();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('omits icon/description/actions when not given; compact adds the modifier', () => {
    const { container } = render(<EmptyState title="Empty" compact />);
    expect(container.querySelector('.empty-state__icon')).toBeNull();
    expect(container.querySelector('.empty-state__note')).toBeNull();
    expect(container.querySelector('.empty-state__actions')).toBeNull();
    expect(container.querySelector('.empty-state--compact')).not.toBeNull();
  });
});
