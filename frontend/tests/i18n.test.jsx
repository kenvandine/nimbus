import { render, screen, fireEvent } from '@testing-library/react'
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { TranslationProvider, useTranslation, LanguageSelector } from '../src/i18n.jsx'

function Probe() {
  const { t, currentLanguage, changeLanguage } = useTranslation()
  return (
    <div>
      <span data-testid="lang">{currentLanguage}</span>
      <span data-testid="known">{t('cancel')}</span>
      <span data-testid="missing-with-default">{t('nonexistent_key_xyz', 'Fallback Text')}</span>
      <span data-testid="missing-no-default">{t('another_missing_key_xyz')}</span>
      <span data-testid="interpolated">{t('signed_in_as', 'Signed in as {{username}}', { username: 'admin' })}</span>
      <span data-testid="interpolated-shorthand">{t('signed_in_as', { username: 'admin' })}</span>
      <button onClick={() => changeLanguage('es')}>go-es</button>
      <button onClick={() => changeLanguage('not-a-real-language')}>go-invalid</button>
    </div>
  )
}

function renderProbe() {
  return render(
    <TranslationProvider>
      <Probe />
    </TranslationProvider>
  )
}

describe('i18n', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  test('useTranslation throws when used outside a TranslationProvider', () => {
    // Suppress the expected React error boundary console noise for this assertion.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Probe />)).toThrow('useTranslation must be used within a TranslationProvider')
    spy.mockRestore()
  })

  test('defaults to English and resolves known keys from the dictionary', () => {
    renderProbe()
    expect(screen.getByTestId('lang')).toHaveTextContent('en')
    expect(screen.getByTestId('known')).toHaveTextContent('Cancel')
  })

  test('falls back to the provided default value when a key is missing', () => {
    renderProbe()
    expect(screen.getByTestId('missing-with-default')).toHaveTextContent('Fallback Text')
  })

  test('falls back to the key itself when missing and no default is given', () => {
    renderProbe()
    expect(screen.getByTestId('missing-no-default')).toHaveTextContent('another_missing_key_xyz')
  })

  test('substitutes {{placeholder}} tokens with replacement values', () => {
    renderProbe()
    expect(screen.getByTestId('interpolated')).toHaveTextContent('Signed in as admin')
  })

  test('supports calling t(key, replacements) without a default value', () => {
    renderProbe()
    expect(screen.getByTestId('interpolated-shorthand')).toHaveTextContent('Signed in as admin')
  })

  test('changeLanguage switches the active language and re-resolves keys', () => {
    renderProbe()
    fireEvent.click(screen.getByText('go-es'))
    expect(screen.getByTestId('lang')).toHaveTextContent('es')
    expect(screen.getByTestId('known')).toHaveTextContent('Cancelar')
  })

  test('changeLanguage persists the chosen language to localStorage', () => {
    renderProbe()
    fireEvent.click(screen.getByText('go-es'))
    expect(window.localStorage.getItem('nimbus_lang')).toBe('es')
  })

  test('changeLanguage ignores unsupported language codes', () => {
    renderProbe()
    fireEvent.click(screen.getByText('go-invalid'))
    expect(screen.getByTestId('lang')).toHaveTextContent('en')
    expect(window.localStorage.getItem('nimbus_lang')).toBeNull()
  })

  test('initializes from a previously stored valid language', () => {
    window.localStorage.setItem('nimbus_lang', 'fr')
    renderProbe()
    expect(screen.getByTestId('lang')).toHaveTextContent('fr')
    expect(screen.getByTestId('known')).toHaveTextContent('Annuler')
  })

  test('ignores an invalid stored language and falls back to English', () => {
    window.localStorage.setItem('nimbus_lang', 'klingon')
    renderProbe()
    expect(screen.getByTestId('lang')).toHaveTextContent('en')
  })
})

describe('i18n with unavailable localStorage', () => {
  test('falls back to English when reading the stored language throws', () => {
    const spy = vi.spyOn(window.localStorage.__proto__, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    renderProbe()
    expect(screen.getByTestId('lang')).toHaveTextContent('en')
    spy.mockRestore()
  })

  test('still switches language in memory when persisting it throws', () => {
    const spy = vi.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    renderProbe()
    fireEvent.click(screen.getByText('go-es'))
    expect(screen.getByTestId('lang')).toHaveTextContent('es')
    expect(screen.getByTestId('known')).toHaveTextContent('Cancelar')
    spy.mockRestore()
  })
})

describe('LanguageSelector', () => {
  afterEach(() => {
    window.localStorage.clear()
  })

  test('renders an option for every supported language', () => {
    render(
      <TranslationProvider>
        <LanguageSelector />
      </TranslationProvider>
    )
    expect(screen.getByRole('option', { name: 'English' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Español' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Français' })).toBeInTheDocument()
  })

  test('changing the select value switches the active language', () => {
    render(
      <TranslationProvider>
        <LanguageSelector />
        <Probe />
      </TranslationProvider>
    )
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'fr' } })
    expect(screen.getByTestId('lang')).toHaveTextContent('fr')
    expect(screen.getByTestId('known')).toHaveTextContent('Annuler')
  })
})
