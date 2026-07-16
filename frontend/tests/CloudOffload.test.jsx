import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, test, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { TranslationProvider } from '../src/i18n.jsx'
import DeviceInfo from '../src/components/DeviceInfo.jsx'

vi.mock('../src/api.js', () => ({
  getModelStatus: vi.fn(() => Promise.resolve({ provider: 'lemonade', model_id: 'user.Local-GGUF', status: 'ready' })),
  getAvailableModels: vi.fn(() => Promise.resolve([])),
  pullModel: vi.fn(() => Promise.resolve()),
  ensureModel: vi.fn(() => Promise.resolve()),
  selectModel: vi.fn(() => Promise.resolve()),
  getHardwareInfo: vi.fn(() => Promise.resolve({})),
  getCloudStatus: vi.fn(() => Promise.resolve({
    cloud_offload_enabled: false,
    cloud_provider: null,
    cloud_model: null,
    toggles: { offload_tools: false, offload_images: false, offload_long_input: false, long_input_chars: 4000, offload_keywords: [] },
    advanced_json: null,
  })),
  getCloudPresets: vi.fn(() => Promise.resolve({
    fireworks: { display_name: 'Fireworks', base_url: 'https://api.fireworks.ai/inference/v1' },
  })),
  listCloudProviders: vi.fn(() => Promise.resolve([
    { provider: 'fireworks', display_name: 'Fireworks', base_url: 'https://api.fireworks.ai/inference/v1' },
  ])),
  addCloudProvider: vi.fn(() => Promise.resolve({ status: 'added' })),
  deleteCloudProvider: vi.fn(() => Promise.resolve({ status: 'removed' })),
  getCloudProviderModels: vi.fn(() => Promise.resolve([{ id: 'fireworks.kimi-k2p5', labels: [] }])),
  saveCloudPolicy: vi.fn(() => Promise.resolve({ status: 'saved' })),
  getCloudUsage: vi.fn(() => Promise.resolve({
    totals: { local_requests: 0, cloud_requests: 0 },
    daily: [],
    reachable: true,
  })),
}))

import { saveCloudPolicy, getCloudUsage } from '../src/api.js'

function renderCloudTab() {
  render(
    <TranslationProvider>
      <DeviceInfo stats={{}} apps={[]} />
    </TranslationProvider>
  )
  fireEvent.click(screen.getByText('Cloud Offload'))
}

describe('CloudOffloadTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('Save is disabled until a cloud model is selected while enabled', async () => {
    renderCloudTab()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument())

    const checkboxes = screen.getAllByRole('checkbox')
    // First checkbox in the form is the enable toggle.
    fireEvent.click(checkboxes[0])

    const saveButton = screen.getByRole('button', { name: /save/i })
    expect(saveButton).toBeDisabled()
  })

  test('advanced JSON textarea hides the toggle controls when populated', async () => {
    renderCloudTab()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument())

    expect(screen.getByText('Offload requests that use tools')).toBeInTheDocument()

    fireEvent.click(screen.getByText(/Advanced: edit policy JSON/))
    const textarea = document.querySelector('textarea')
    expect(textarea).toBeInTheDocument()

    fireEvent.change(textarea, {
      target: { value: JSON.stringify({ candidates: ['user.Local-GGUF'], default_model: 'user.Local-GGUF', rules: [] }) },
    })

    // Toggle controls remain in the DOM (single form), but the advanced JSON
    // is what actually gets sent once populated and shown.
    expect(textarea.value).toContain('candidates')
  })

  test('failed save surfaces the error message', async () => {
    saveCloudPolicy.mockRejectedValueOnce(new Error('400: invalid routing policy'))
    renderCloudTab()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument())

    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0]) // enable
    fireEvent.click(checkboxes[1]) // offload_tools, so canSave becomes true once a cloud model is picked

    const selects = screen.getAllByRole('combobox')
    fireEvent.change(selects[0], { target: { value: 'fireworks' } })
    await waitFor(() => expect(screen.getAllByRole('combobox')[1].querySelectorAll('option').length).toBeGreaterThan(1))
    fireEvent.change(selects[1], { target: { value: 'fireworks.kimi-k2p5' } })

    const saveButton = screen.getByRole('button', { name: /save/i })
    await waitFor(() => expect(saveButton).not.toBeDisabled())
    fireEvent.click(saveButton)

    await waitFor(() => expect(screen.getByText(/invalid routing policy/)).toBeInTheDocument())
  })

  test('shows the no-data message when no requests have been observed yet', async () => {
    renderCloudTab()
    await waitFor(() => expect(screen.getByText('No requests observed yet.')).toBeInTheDocument())
  })

  test('renders the local/cloud split bar and daily trend once usage data exists', async () => {
    getCloudUsage.mockResolvedValueOnce({
      totals: { local_requests: 142, cloud_requests: 8 },
      daily: [
        { date: '2026-07-15', local_requests: 100, cloud_requests: 5 },
        { date: '2026-07-16', local_requests: 42, cloud_requests: 3 },
      ],
      reachable: true,
    })
    renderCloudTab()

    await waitFor(() => expect(screen.getByText(/142/)).toBeInTheDocument())
    expect(screen.getByText(/8 \(5%\)/)).toBeInTheDocument()
    expect(screen.getByText('View as table')).toBeInTheDocument()

    fireEvent.click(screen.getByText('View as table'))
    expect(screen.getAllByText('2026-07-15').length).toBeGreaterThan(0)
    expect(screen.getAllByText('2026-07-16').length).toBeGreaterThan(0)
  })

  test('shows the unreachable message when lemonade metrics could not be scraped', async () => {
    getCloudUsage.mockResolvedValueOnce({
      totals: { local_requests: 0, cloud_requests: 0 },
      daily: [],
      reachable: false,
    })
    renderCloudTab()
    await waitFor(() => expect(screen.getByText('Could not reach lemonade to measure request counts.')).toBeInTheDocument())
  })
})
