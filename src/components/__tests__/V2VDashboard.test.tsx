import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { V2VDashboard } from '../v2v/V2VDashboard';

describe('V2VDashboard', () => {
  it('renders without crashing when no data', () => {
    const { container } = render(<V2VDashboard />);
    // Should render empty state or nothing when no v2v data
    expect(container).toBeTruthy();
  });
});
