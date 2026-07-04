import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, test, expect, vi } from 'vitest'
import React from 'react'
import Login from '../src/components/Login.jsx'
import { TranslationProvider } from '../src/i18n.jsx'

// Mock api login
vi.mock('../src/api.js', () => ({
  login: vi.fn(),
}))

import { login } from '../src/api.js'

function renderLogin(props) {
  return render(
    <TranslationProvider>
      <Login {...props} />
    </TranslationProvider>
  )
}

describe('Login Component', () => {
  test('submit button is disabled when fields are empty', () => {
    renderLogin({ onLogin: vi.fn() })

    const submitButton = screen.getByRole('button', { name: 'Sign in' })
    expect(submitButton).toBeDisabled()
  })

  test('enables submit button when inputs are filled', () => {
    renderLogin({ onLogin: vi.fn() })
    
    const usernameInput = screen.getByPlaceholderText('Username')
    const passwordInput = screen.getByPlaceholderText('Password')
    const submitButton = screen.getByRole('button', { name: 'Sign in' })

    fireEvent.change(usernameInput, { target: { value: 'admin' } })
    fireEvent.change(passwordInput, { target: { value: 'password123' } })

    expect(submitButton).not.toBeDisabled()
  })

  test('calls login API and onLogin handler upon successful form submission', async () => {
    login.mockResolvedValueOnce({ status: 'ok', username: 'admin' })
    const handleLoginSuccess = vi.fn()

    renderLogin({ onLogin: handleLoginSuccess })

    const usernameInput = screen.getByPlaceholderText('Username')
    const passwordInput = screen.getByPlaceholderText('Password')
    const submitButton = screen.getByRole('button', { name: 'Sign in' })

    fireEvent.change(usernameInput, { target: { value: 'admin' } })
    fireEvent.change(passwordInput, { target: { value: 'password123' } })
    fireEvent.click(submitButton)

    expect(login).toHaveBeenCalledWith('admin', 'password123')
    
    await waitFor(() => {
      expect(handleLoginSuccess).toHaveBeenCalled()
    })
  })

  test('displays error message when login API fails', async () => {
    login.mockRejectedValueOnce(new Error('Invalid username or password'))
    const handleLoginSuccess = vi.fn()

    renderLogin({ onLogin: handleLoginSuccess })

    const usernameInput = screen.getByPlaceholderText('Username')
    const passwordInput = screen.getByPlaceholderText('Password')
    const submitButton = screen.getByRole('button', { name: 'Sign in' })

    fireEvent.change(usernameInput, { target: { value: 'admin' } })
    fireEvent.change(passwordInput, { target: { value: 'wrong-password' } })
    fireEvent.click(submitButton)

    await waitFor(() => {
      expect(screen.getByText('Invalid username or password')).toBeInTheDocument()
      expect(handleLoginSuccess).not.toHaveBeenCalled()
    })
  })
})
