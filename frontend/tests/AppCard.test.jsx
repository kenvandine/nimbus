import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, test, expect, vi } from 'vitest'
import React from 'react'
import AppCard from '../src/components/AppCard.jsx'

// Mock the api module used in AppCard
vi.mock('../src/api.js', () => ({
  installApp: vi.fn(() => Promise.resolve()),
  uninstallApp: vi.fn(() => Promise.resolve()),
  updateApp: vi.fn(() => Promise.resolve()),
  startApp: vi.fn(() => Promise.resolve()),
  stopApp: vi.fn(() => Promise.resolve()),
  restartApp: vi.fn(() => Promise.resolve()),
}))

import { installApp } from '../src/api.js'

describe('AppCard Component', () => {
  const mockApp = {
    id: 'test-app',
    name: 'Test Application',
    tagline: 'A cool test app',
    icon: '',
    installed: false,
    running: false,
    update_available: false,
    confinement: 'strict',
  }

  const mockRefresh = vi.fn()
  const mockOpenDetail = vi.fn()

  test('renders app details correctly', () => {
    render(
      <AppCard 
        app={mockApp} 
        onRefresh={mockRefresh} 
        onOpenDetail={mockOpenDetail} 
      />
    )
    
    expect(screen.getByText('Test Application')).toBeInTheDocument()
    expect(screen.getByText('A cool test app')).toBeInTheDocument()
    expect(screen.getByText('Available')).toBeInTheDocument()
    expect(screen.getByText('Install')).toBeInTheDocument()
  })

  test('calls installApp and onRefresh when Install is clicked', async () => {
    render(
      <AppCard 
        app={mockApp} 
        onRefresh={mockRefresh} 
        onOpenDetail={mockOpenDetail} 
      />
    )
    
    const installButton = screen.getByText('Install')
    fireEvent.click(installButton)
    
    expect(installApp).toHaveBeenCalledWith('test-app')
    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalled()
    })
  })
})
