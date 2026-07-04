import { render, screen, fireEvent } from '@testing-library/react'
import { describe, test, expect, vi } from 'vitest'
import React from 'react'
import Button from '../src/components/ui/Button.jsx'

describe('Button Component', () => {
  test('renders children correctly', () => {
    render(<Button>Click me</Button>)
    expect(screen.getByText('Click me')).toBeInTheDocument()
  })

  test('calls onClick handler when clicked', () => {
    const handleClick = vi.fn()
    render(<Button onClick={handleClick}>Click me</Button>)
    
    fireEvent.click(screen.getByText('Click me'))
    expect(handleClick).toHaveBeenCalledTimes(1)
  })

  test('does not call onClick when disabled', () => {
    const handleClick = vi.fn()
    render(<Button onClick={handleClick} disabled>Click me</Button>)
    
    fireEvent.click(screen.getByText('Click me'))
    expect(handleClick).not.toHaveBeenCalled()
    expect(screen.getByRole('button')).toBeDisabled()
  })

  test('shows loading spinner and disables button when loading', () => {
    const handleClick = vi.fn()
    render(<Button onClick={handleClick} loading>Click me</Button>)
    
    // Spinner should render, which is a span
    const button = screen.getByRole('button')
    expect(button).toBeDisabled()
    
    // Let's click it and make sure callback is not fired
    fireEvent.click(button)
    expect(handleClick).not.toHaveBeenCalled()
  })
})
