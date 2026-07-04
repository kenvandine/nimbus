import { render, screen, fireEvent } from '@testing-library/react'
import { describe, test, expect, vi } from 'vitest'
import React from 'react'

// Mock react-router-dom useNavigate hook
const mockNavigate = vi.fn()
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}))

import Home from '../src/components/Home.jsx'
import { TranslationProvider } from '../src/i18n.jsx'

describe('Home Component', () => {
  test('renders empty state message when no apps are running', () => {
    window.localStorage.clear()
    render(
      <TranslationProvider>
        <Home
          apps={[]}
          loading={false}
          error={null}
          errorMessage=""
          setupState={null}
          onOpenDetail={vi.fn()}
          onOpenLogs={vi.fn()}
          onServiceAction={vi.fn()}
          onUninstall={vi.fn()}
        />
      </TranslationProvider>
    )

    expect(screen.getByText('No apps running yet')).toBeInTheDocument()
    expect(screen.getByText('Browse the App Store')).toBeInTheDocument()
  })

  test('clicking Browse the App Store navigates to /app-store', () => {
    window.localStorage.clear()
    render(
      <TranslationProvider>
        <Home
          apps={[]}
          loading={false}
          error={null}
          errorMessage=""
          setupState={null}
          onOpenDetail={vi.fn()}
          onOpenLogs={vi.fn()}
          onServiceAction={vi.fn()}
          onUninstall={vi.fn()}
        />
      </TranslationProvider>
    )
    
    const browseButton = screen.getByText('Browse the App Store')
    fireEvent.click(browseButton)
    
    expect(mockNavigate).toHaveBeenCalledWith('/app-store')
  })
})
