import { describe, it, expect } from 'vitest'
import { resolveNumberCommit } from './numberCommit'

describe('resolveNumberCommit', () => {
  it('commits a changed in-range number, keeps an unchanged one', () => {
    expect(resolveNumberCommit('12', 10, {})).toEqual({ action: 'commit', value: 12 })
    expect(resolveNumberCommit(' 10 ', 10, {})).toEqual({ action: 'keep' })
  })

  it('empty: optional clears (only when something is set), required reverts', () => {
    expect(resolveNumberCommit('', 5, { optional: true })).toEqual({ action: 'commit', value: undefined })
    expect(resolveNumberCommit('  ', undefined, { optional: true })).toEqual({ action: 'keep' })
    expect(resolveNumberCommit('', 5, {})).toEqual({ action: 'revert' })
  })

  it('min / max are inclusive by default', () => {
    expect(resolveNumberCommit('0', 5, { min: 0 })).toEqual({ action: 'commit', value: 0 })
    expect(resolveNumberCommit('-1', 5, { min: 0 })).toEqual({ action: 'revert' })
    expect(resolveNumberCommit('11', 5, { max: 10 })).toEqual({ action: 'revert' })
  })

  it('minExclusive refuses the bound itself — a typed length of 0 never leaves the field', () => {
    expect(resolveNumberCommit('0', 5, { min: 0, minExclusive: true })).toEqual({ action: 'revert' })
    expect(resolveNumberCommit('0.1', 5, { min: 0, minExclusive: true })).toEqual({ action: 'commit', value: 0.1 })
  })

  it('non-numbers revert', () => {
    expect(resolveNumberCommit('abc', 5, {})).toEqual({ action: 'revert' })
    expect(resolveNumberCommit('Infinity', 5, {})).toEqual({ action: 'revert' })
  })

  it('a partial entry the browser reports as "" (badInput) reverts, never clears', () => {
    // <input type="number"> holding "-" / "1e" / "+" has value === "" and validity.badInput.
    expect(resolveNumberCommit('', 850, { optional: true, badInput: true })).toEqual({ action: 'revert' })
  })
})
