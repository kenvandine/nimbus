import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, test, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import ScreenLock from '../src/components/ScreenLock.jsx'
import { TranslationProvider } from '../src/i18n.jsx'

describe('ScreenLock Component', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  test('successfully unlocks when correct PIN is entered', async () => {
    window.localStorage.setItem('nimbus_lock_pin', '1234')
    const handleUnlock = vi.fn()
    const handleFail = vi.fn()

    render(
      <TranslationProvider>
        <ScreenLock
          deviceName="Nimbus-Test"
          onUnlock={handleUnlock}
          onFail={handleFail}
        />
      </TranslationProvider>
    )

    // Click buttons "1", "2", "3", "4" on the PinPad
    fireEvent.click(screen.getByText('1'))
    fireEvent.click(screen.getByText('2'))
    fireEvent.click(screen.getByText('3'))
    fireEvent.click(screen.getByText('4'))

    await waitFor(() => {
      expect(handleUnlock).toHaveBeenCalled()
      expect(handleFail).not.toHaveBeenCalled()
    })
  })

  test('calls onFail when incorrect PIN is entered', async () => {
    window.localStorage.setItem('nimbus_lock_pin', '1234')
    const handleUnlock = vi.fn()
    const handleFail = vi.fn()

    render(
      <TranslationProvider>
        <ScreenLock
          deviceName="Nimbus-Test"
          onUnlock={handleUnlock}
          onFail={handleFail}
        />
      </TranslationProvider>
    )

    // Click incorrect PIN buttons: "1", "1", "1", "1"
    fireEvent.click(screen.getByText('1'))
    fireEvent.click(screen.getByText('1'))
    fireEvent.click(screen.getByText('1'))
    fireEvent.click(screen.getByText('1'))

    await waitFor(() => {
      expect(handleFail).toHaveBeenCalled()
      expect(handleUnlock).not.toHaveBeenCalled()
    })
  })

  test('supports backspace button to delete characters', async () => {
    window.localStorage.setItem('nimbus_lock_pin', '1234')
    const handleUnlock = vi.fn()

    render(
      <TranslationProvider>
        <ScreenLock
          deviceName="Nimbus-Test"
          onUnlock={handleUnlock}
        />
      </TranslationProvider>
    )

    // Type 1, then backspace, then 1, 2, 3, 4
    fireEvent.click(screen.getByText('1'))
    fireEvent.click(screen.getByText('⌫'))
    fireEvent.click(screen.getByText('1'))
    fireEvent.click(screen.getByText('2'))
    fireEvent.click(screen.getByText('3'))
    fireEvent.click(screen.getByText('4'))

    await waitFor(() => {
      expect(handleUnlock).toHaveBeenCalled()
    })
  })
})
