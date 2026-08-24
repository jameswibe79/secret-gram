import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { VideoPreview } from './VideoPreview'

const requestFullscreen = vi.fn<() => Promise<void>>()

beforeEach(() => {
  requestFullscreen.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
    configurable: true,
    value: requestFullscreen,
  })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    fireEvent.play(this)
    return Promise.resolve()
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    fireEvent.pause(this)
  })
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('VideoPreview', () => {
  it('provides styled playback, seeking, mute, and full-screen controls', async () => {
    const user = userEvent.setup()
    render(<VideoPreview url="blob:video" name="recording.mp4" variant="viewer" />)
    const video = screen.getByLabelText('recording.mp4 video preview')
    Object.defineProperty(video, 'duration', { configurable: true, value: 65 })

    fireEvent.loadedMetadata(video)
    expect(screen.getByText('0:00 / 1:05')).toBeInTheDocument()
    expect(video).not.toHaveAttribute('controls')

    await user.click(screen.getByRole('button', { name: 'Play recording.mp4' }))
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Pause video' })).toBeInTheDocument()

    fireEvent.change(screen.getByRole('slider', { name: 'recording.mp4 playback position' }), {
      target: { value: '12.5' },
    })
    expect(video).toHaveProperty('currentTime', 12.5)
    expect(screen.getByText('0:12 / 1:05')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Mute video' }))
    expect(video).toHaveProperty('muted', true)
    expect(screen.getByRole('button', { name: 'Unmute video' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: 'Enter full screen' }))
    expect(requestFullscreen).toHaveBeenCalledOnce()
  })

  it('auto-hides during playback and supports pinning and manual visibility', () => {
    vi.useFakeTimers()
    render(<VideoPreview url="blob:video" name="recording.mp4" variant="viewer" />)
    const video = screen.getByLabelText('recording.mp4 video preview')
    const controls = screen.getByLabelText('recording.mp4 playback controls')
    const player = video.closest('.video-preview')
    expect(player).not.toBeNull()

    fireEvent.play(video)
    act(() => vi.advanceTimersByTime(2_500))
    expect(controls).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByRole('button', { name: 'Show video controls' })).toBeInTheDocument()

    fireEvent.pointerMove(player!)
    fireEvent.click(screen.getByRole('button', { name: 'Pin controls' }))
    act(() => vi.advanceTimersByTime(5_000))
    expect(controls).toHaveAttribute('aria-hidden', 'false')
    expect(screen.getByRole('button', { name: 'Use auto-hide controls' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Hide video controls' }))
    expect(controls).toHaveAttribute('aria-hidden', 'true')
    fireEvent.pointerMove(player!)
    expect(controls).toHaveAttribute('aria-hidden', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Show video controls' }))
    expect(controls).toHaveAttribute('aria-hidden', 'false')

    fireEvent.click(screen.getByRole('button', { name: 'Use auto-hide controls' }))
    act(() => vi.advanceTimersByTime(2_500))
    expect(controls).toHaveAttribute('aria-hidden', 'true')
  })

  it('shows a fail-safe message when the browser rejects the video', () => {
    render(<VideoPreview url="blob:broken" name="broken.mp4" variant="modal" />)

    fireEvent.error(screen.getByLabelText('broken.mp4 video preview'))

    expect(screen.getByRole('alert')).toHaveTextContent('This MP4 could not be played by this browser.')
    expect(screen.queryByRole('button', { name: 'Play broken.mp4' })).not.toBeInTheDocument()
  })
})
