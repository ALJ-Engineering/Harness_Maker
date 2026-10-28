import { describe, it, expect, vi } from 'vitest'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ViewPicker, type ViewPickerProps } from './ViewPicker'

type Btn = ReactElement<{ 'aria-pressed': boolean; onClick: () => void; children: unknown[] }>

/** The toggle's buttons, straight from the element tree (the component has no hooks). */
function buttons(props: ViewPickerProps): Btn[] {
  const root = ViewPicker(props) as ReactElement<{ children: unknown[] }>
  return root.props.children.flat().filter((c): c is Btn => !!c && (c as ReactElement).type === 'button')
}
const label = (b: Btn): string => b.props.children.filter((c) => typeof c === 'string').join('')

describe('ViewPicker', () => {
  it('shows every view as a button, the current one pressed', () => {
    const b = buttons({ view: 'formboard', onChange: () => {} })
    expect(b.map(label)).toEqual(['Schematic', 'Formboard'])
    expect(b.map((x) => x.props['aria-pressed'])).toEqual([false, true])
  })

  it('one click on the other view switches; clicking the current one does nothing', () => {
    const onChange = vi.fn()
    const [schematic, formboard] = buttons({ view: 'schematic', onChange })
    schematic.props.onClick()
    expect(onChange).not.toHaveBeenCalled()
    formboard.props.onClick()
    expect(onChange).toHaveBeenCalledWith('formboard')
  })

  it('names the pane only while the canvas is split', () => {
    const single = renderToStaticMarkup(createElement(ViewPicker, { view: 'schematic', onChange: () => {} }))
    const split = renderToStaticMarkup(createElement(ViewPicker, { view: 'schematic', onChange: () => {}, side: 'Left' }))
    expect(single).not.toContain('seg__side')
    expect(split).toContain('<span class="seg__side">Left</span>')
    expect(split).toContain('aria-label="Left pane view"')
  })
})
