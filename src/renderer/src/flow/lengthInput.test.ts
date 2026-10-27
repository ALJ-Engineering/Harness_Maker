import { describe, it, expect } from 'vitest'
import { parseLengthInput, resolveLengthCommit } from './lengthInput'

describe('parseLengthInput (formboard label length field)', () => {
  it('a positive number commits that number', () => {
    expect(parseLengthInput('370', false)).toBe(370)
    expect(parseLengthInput(' 12.5 ', false)).toBe(12.5)
  })

  it('an empty field clears the typed length', () => {
    expect(parseLengthInput('', false)).toBeNull()
    expect(parseLengthInput('   ', false)).toBeNull()
  })

  it('a partial entry ("-", "1e", "+") reports "" with badInput — cancel, never clear', () => {
    expect(parseLengthInput('', true)).toBe('cancel')
  })

  it('zero, negatives and non-numbers cancel (the store refuses them anyway)', () => {
    expect(parseLengthInput('0', false)).toBe('cancel')
    expect(parseLengthInput('-5', false)).toBe('cancel')
    expect(parseLengthInput('abc', false)).toBe('cancel')
    expect(parseLengthInput('Infinity', false)).toBe('cancel')
  })
})

describe('resolveLengthCommit (Enter and blur share one rule)', () => {
  it('an unchanged draft commits nothing, even on Enter', () => {
    expect(resolveLengthCommit('185', '185', false)).toBe('skip')
    expect(resolveLengthCommit(' 185 ', '185', false)).toBe('skip')
    expect(resolveLengthCommit('', '', false)).toBe('skip')
  })
  it('a changed draft commits the number; emptied clears; partial entry cancels', () => {
    expect(resolveLengthCommit('190', '185', false)).toBe(190)
    expect(resolveLengthCommit('', '185', false)).toBeNull()
    expect(resolveLengthCommit('', '185', true)).toBe('cancel')
    expect(resolveLengthCommit('', '', true)).toBe('cancel')
  })
})
