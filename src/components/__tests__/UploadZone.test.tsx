import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UploadZone } from '../UploadZone';
import { ToastProvider } from '../Toast';

describe('UploadZone', () => {
  it('renders without crashing', () => {
    render(
      <ToastProvider>
        <UploadZone />
      </ToastProvider>
    );
    // Check for drop zone text or upload instruction
    expect(screen.getByText(/drop your files here/i)).toBeTruthy();
  });
});
