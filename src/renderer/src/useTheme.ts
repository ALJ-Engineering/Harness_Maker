import { useCallback, useEffect, useRef, useState } from 'react'

export type ThemeName = 'dark' | 'light'

/**
 * The UI theme, mirrored onto `<html data-theme>` so the CSS token layer
 * switches, and persisted through `window.api` into userData/settings.json.
 * Dark until the stored value arrives, so there is no light flash on boot.
 */
export function useTheme(): {
  theme: ThemeName
  setTheme: (t: ThemeName) => void
  toggleTheme: () => void
} {
  const [theme, setThemeState] = useState<ThemeName>('dark')

  // Set the instant the user picks a theme locally (setTheme/toggleTheme),
  // before the persisted value round-trips. Guards against the initial
  // getTheme() fetch — which can still be in flight — clobbering that choice
  // if it resolves afterwards with the (now stale) previously-persisted value.
  const userChosenRef = useRef(false)

  useEffect(() => {
    let live = true
    void window.api.getTheme().then((t) => {
      if (live && !userChosenRef.current) setThemeState(t)
    })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  const setTheme = useCallback((t: ThemeName) => {
    userChosenRef.current = true
    setThemeState(t)
    void window.api.setTheme(t)
  }, [])

  const toggleTheme = useCallback(() => {
    userChosenRef.current = true
    const next = theme === 'dark' ? 'light' : 'dark'
    setThemeState(next)
    void window.api.setTheme(next)
  }, [theme])

  return { theme, setTheme, toggleTheme }
}

/** The theme as currently applied to <html>. For render paths too deep to prop-thread. */
export function currentTheme(): ThemeName {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
}
